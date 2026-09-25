// Canonical product catalog model for Dragon Oak Studio.
//
// The ADRIAN canonical catalog is the source of truth. Each product is one JSON file in catalog/products/. This module
// is pure (no network, no database, no Etsy calls): it validates products, loads the catalog from disk, and produces the
// PUBLIC projection that the storefront is allowed to show. Anything not explicitly copied into the public projection
// (digital file references, internal notes, Etsy internals) never reaches a browser.
//
// It lives under api/_lib/ on purpose: files in api/ (outside _lib) each become a Vercel serverless function, and the
// Hobby plan allows 12 per deployment. This module is NOT a function.
const fs = require("fs");
const path = require("path");

const SCHEMA_VERSION = 1;

// Required top-level customer collections. Product type is a SEPARATE field (below).
const REQUIRED_COLLECTION_SLUGS = [
  "halloween",
  "christmas",
  "cute-bookmarks",
  "wine-hill-country",
  "other-seasonal",
];

const PRODUCT_TYPES = ["digital_download", "physical_product"];
const PRODUCT_TYPE_LABELS = {
  digital_download: "Digital Download",
  physical_product: "Physical Product",
};

// Dragon Oak site state. Only "published" products are shown on DragonOakStudio.com.
const SITE_STATES = ["draft", "published", "archived"];

// Etsy sales-channel state (a snapshot from a read-only import; Etsy is a channel, not the database).
const ETSY_STATES = ["not_listed", "draft", "active", "inactive", "sold_out", "expired", "removed"];

// Limits kept compatible with Etsy so the SAME title/tags can later be distributed to Etsy without rewriting.
const LIMITS = {
  title: 140,
  description: 5000,
  tags: 13,
  tagLength: 20,
  slug: 80,
  images: 10,
};

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{5,63}$/;
const SKU_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,39}$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IMAGE_PATH_PATTERN = /^assets\/[A-Za-z0-9._\-/]+\.(?:webp|jpg|jpeg|png)$/;
const TRUSTED_IMAGE_HOSTS = new Set(["i.etsystatic.com"]);
const IMAGE_EXTENSION_PATTERN = /\.(?:webp|jpg|jpeg|png)$/i;
// Digital file references are OPAQUE ADRIAN identifiers (never URLs or file-system paths).
const DIGITAL_REF_PATTERN = /^adrian:[A-Za-z0-9._\-/]+$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

const KNOWN_PRODUCT_KEYS = new Set([
  "schemaVersion",
  "id",
  "sku",
  "title",
  "slug",
  "description",
  "collection",
  "subcollection",
  "productType",
  "tags",
  "price",
  "images",
  "digitalFiles",
  "etsy",
  "siteState",
  "featured",
  "createdAt",
  "updatedAt",
  "notes",
  "provenance",
]);

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;
const isTimestamp = (value) =>
  typeof value === "string" && ISO_TIMESTAMP_PATTERN.test(value) && Number.isFinite(Date.parse(value));

const isSafeRelativePath = (value) =>
  typeof value === "string" &&
  !value.includes("..") &&
  !value.includes("\\") &&
  !value.startsWith("/") &&
  !/^[a-z][a-z0-9+.-]*:/i.test(value);

const isTrustedImageUrl = (value) => {
  if (typeof value !== "string") {
    return false;
  }

  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      TRUSTED_IMAGE_HOSTS.has(url.hostname.toLowerCase()) &&
      IMAGE_EXTENSION_PATTERN.test(url.pathname)
    );
  } catch {
    return false;
  }
};

const isLocalImagePath = (value) => isSafeRelativePath(value) && IMAGE_PATH_PATTERN.test(value);

// Etsy links are only trusted when they are https and on an etsy.com host (blocks javascript:, data:, look-alike hosts).
const isSafeEtsyUrl = (value) => {
  if (typeof value !== "string") {
    return false;
  }

  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();

    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (host === "etsy.com" || host.endsWith(".etsy.com"))
    );
  } catch {
    return false;
  }
};

const formatPrice = (price) => {
  if (!price || !Number.isInteger(price.amountCents)) {
    return null;
  }

  const amount = price.amountCents / 100;

  if (price.currency === "USD") {
    return `$${amount.toFixed(2)}`;
  }

  return `${amount.toFixed(2)} ${price.currency}`;
};

// Returns { errors: string[], warnings: string[] } for ONE product. `context` provides collection slugs and a file check.
const validateProduct = (product, context = {}) => {
  const errors = [];
  const warnings = [];
  const collectionSlugs = context.collectionSlugs || new Set(REQUIRED_COLLECTION_SLUGS);
  const fileExists = typeof context.fileExists === "function" ? context.fileExists : () => true;
  const label = isPlainObject(product) && product.sku ? String(product.sku) : "(unknown product)";
  const fail = (message) => errors.push(`${label}: ${message}`);
  const warn = (message) => warnings.push(`${label}: ${message}`);

  if (!isPlainObject(product)) {
    return { errors: [`${label}: product must be a JSON object`], warnings };
  }

  Object.keys(product).forEach((key) => {
    if (!KNOWN_PRODUCT_KEYS.has(key)) {
      warn(`unknown field "${key}" (ignored, never published)`);
    }
  });

  if (product.schemaVersion !== SCHEMA_VERSION) {
    fail(`schemaVersion must be ${SCHEMA_VERSION}`);
  }

  if (typeof product.id !== "string" || !ID_PATTERN.test(product.id)) {
    fail("id must be 6-64 chars of a-z, 0-9, _ or - (starting with a letter or number)");
  }

  if (typeof product.sku !== "string" || !SKU_PATTERN.test(product.sku)) {
    fail("sku must be 3-40 chars of A-Z, 0-9 or - (uppercase)");
  }

  if (!isNonEmptyString(product.title) || product.title.length > LIMITS.title) {
    fail(`title is required and must be at most ${LIMITS.title} characters`);
  }

  if (typeof product.slug !== "string" || !SLUG_PATTERN.test(product.slug) || product.slug.length > LIMITS.slug) {
    fail("slug must be lowercase words joined by single hyphens");
  }

  if (typeof product.description !== "string" || product.description.length > LIMITS.description) {
    fail(`description must be text of at most ${LIMITS.description} characters (may be empty for drafts)`);
  }

  if (!collectionSlugs.has(product.collection)) {
    fail(`collection "${product.collection}" is not a defined collection`);
  }

  if (
    product.subcollection !== null &&
    (typeof product.subcollection !== "string" || !SLUG_PATTERN.test(product.subcollection))
  ) {
    fail("subcollection must be null or a lowercase-hyphen slug");
  }

  if (!PRODUCT_TYPES.includes(product.productType)) {
    fail(`productType must be one of: ${PRODUCT_TYPES.join(", ")}`);
  }

  if (!Array.isArray(product.tags) || product.tags.length > LIMITS.tags) {
    fail(`tags must be an array of at most ${LIMITS.tags} items`);
  } else {
    const seen = new Set();

    product.tags.forEach((tag) => {
      if (!isNonEmptyString(tag) || tag.length > LIMITS.tagLength) {
        fail(`each tag must be 1-${LIMITS.tagLength} characters`);
      } else if (seen.has(tag.toLowerCase())) {
        fail(`duplicate tag "${tag}"`);
      } else {
        seen.add(tag.toLowerCase());
      }
    });
  }

  if (product.price !== null) {
    if (
      !isPlainObject(product.price) ||
      !Number.isInteger(product.price.amountCents) ||
      product.price.amountCents <= 0 ||
      typeof product.price.currency !== "string" ||
      !/^[A-Z]{3}$/.test(product.price.currency)
    ) {
      fail("price must be null or { amountCents: positive integer, currency: 3-letter code }");
    }
  }

  if (!Array.isArray(product.images) || product.images.length > LIMITS.images) {
    fail(`images must be an array of at most ${LIMITS.images} items`);
  } else {
    product.images.forEach((image, index) => {
      const path = isPlainObject(image) ? image.path : null;

      if (!isPlainObject(image) || (!isLocalImagePath(path) && !isTrustedImageUrl(path))) {
        fail(`images[${index}].path must be a relative assets/... image path or a trusted https://i.etsystatic.com image URL`);
      } else if (!isNonEmptyString(image.alt)) {
        fail(`images[${index}].alt text is required`);
      } else if (isLocalImagePath(path) && !fileExists(path)) {
        fail(`images[${index}] file not found: ${image.path}`);
      }
    });
  }

  if (!Array.isArray(product.digitalFiles)) {
    fail("digitalFiles must be an array (use [] when there are none)");
  } else {
    product.digitalFiles.forEach((file, index) => {
      if (!isPlainObject(file) || typeof file.ref !== "string" || !DIGITAL_REF_PATTERN.test(file.ref) || file.ref.includes("..")) {
        fail(`digitalFiles[${index}].ref must be an opaque "adrian:..." reference, never a URL or file path`);
      } else if (!isNonEmptyString(file.label)) {
        fail(`digitalFiles[${index}].label is required`);
      }
    });
  }

  if (!isPlainObject(product.etsy)) {
    fail("etsy must be an object");
  } else {
    const { listingId, url, state, syncedAt } = product.etsy;

    if (listingId !== null && !(Number.isInteger(listingId) && listingId > 0)) {
      fail("etsy.listingId must be null or a positive integer");
    }

    if (!ETSY_STATES.includes(state)) {
      fail(`etsy.state must be one of: ${ETSY_STATES.join(", ")}`);
    }

    if (url !== null && !isSafeEtsyUrl(url)) {
      fail("etsy.url must be null or an https://...etsy.com address");
    }

    if (syncedAt !== null && !isTimestamp(syncedAt)) {
      fail("etsy.syncedAt must be null or an ISO 8601 timestamp");
    }

    if (listingId === null && state !== "not_listed") {
      fail('etsy.state must be "not_listed" when there is no etsy.listingId');
    }

    if (listingId !== null && state === "not_listed") {
      fail('etsy.state cannot be "not_listed" when etsy.listingId is set');
    }

    if (state === "active" && !url) {
      warn("etsy.state is active but etsy.url is missing, so no Buy on Etsy button can be shown");
    }
  }

  if (!SITE_STATES.includes(product.siteState)) {
    fail(`siteState must be one of: ${SITE_STATES.join(", ")}`);
  }

  if (typeof product.featured !== "boolean") {
    fail("featured must be true or false");
  }

  if (!isTimestamp(product.createdAt)) {
    fail("createdAt must be an ISO 8601 timestamp");
  }

  if (!isTimestamp(product.updatedAt)) {
    fail("updatedAt must be an ISO 8601 timestamp");
  } else if (isTimestamp(product.createdAt) && Date.parse(product.updatedAt) < Date.parse(product.createdAt)) {
    fail("updatedAt cannot be earlier than createdAt");
  }

  if (product.siteState === "published") {
    if (!isNonEmptyString(product.description)) {
      fail("a published product needs a description");
    }

    if (!Array.isArray(product.images) || product.images.length === 0) {
      fail("a published product needs at least one image");
    }
  }

  if (product.productType === "digital_download" && Array.isArray(product.digitalFiles) && product.digitalFiles.length === 0) {
    warn("digital download has no digitalFiles references yet");
  }

  return { errors, warnings };
};

const validateCollections = (collectionsFile) => {
  const errors = [];

  if (!isPlainObject(collectionsFile) || collectionsFile.schemaVersion !== SCHEMA_VERSION || !Array.isArray(collectionsFile.collections)) {
    return { errors: ["collections.json must be { schemaVersion: 1, collections: [...] }"], collections: [] };
  }

  const seen = new Set();

  collectionsFile.collections.forEach((collection, index) => {
    const where = `collections[${index}]`;

    if (!isPlainObject(collection) || typeof collection.slug !== "string" || !SLUG_PATTERN.test(collection.slug)) {
      errors.push(`${where}: slug must be a lowercase-hyphen slug`);
      return;
    }

    if (seen.has(collection.slug)) {
      errors.push(`${where}: duplicate slug "${collection.slug}"`);
    }

    seen.add(collection.slug);

    if (!isNonEmptyString(collection.name) || !isNonEmptyString(collection.tagline) || !isNonEmptyString(collection.description)) {
      errors.push(`${where} (${collection.slug}): name, tagline and description are required`);
    }

    if (!Number.isInteger(collection.order)) {
      errors.push(`${where} (${collection.slug}): order must be an integer`);
    }
  });

  REQUIRED_COLLECTION_SLUGS.forEach((slug) => {
    if (!seen.has(slug)) {
      errors.push(`required collection missing: ${slug}`);
    }
  });

  const collections = collectionsFile.collections
    .filter((collection) => isPlainObject(collection) && typeof collection.slug === "string")
    .slice()
    .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));

  return { errors, collections };
};

// Cross-product rules: SKU, id, slug and Etsy listing ID must each map to exactly one product.
const validateUniqueness = (products) => {
  const errors = [];
  const seen = { id: new Map(), sku: new Map(), slug: new Map(), listingId: new Map() };

  products.forEach((product) => {
    const checks = [
      ["id", product.id],
      ["sku", product.sku],
      ["slug", product.slug],
      ["listingId", product.etsy && product.etsy.listingId !== null ? product.etsy.listingId : undefined],
    ];

    checks.forEach(([field, value]) => {
      if (value === undefined || value === null) {
        return;
      }

      if (seen[field].has(value)) {
        errors.push(`duplicate ${field} "${value}" on ${product.sku} and ${seen[field].get(value)}`);
      } else {
        seen[field].set(value, product.sku);
      }
    });
  });

  return errors;
};

// The ONLY shape the browser ever receives. Fields are copied one by one (an allow-list), so a new private field added
// to the canonical model later can never leak by accident.
const toPublicProduct = (product) => {
  const buyUrl =
    product.etsy && product.etsy.state === "active" && isSafeEtsyUrl(product.etsy.url) ? product.etsy.url : null;

  return {
    id: product.id,
    sku: product.sku,
    title: product.title,
    slug: product.slug,
    url: `/product/${product.slug}/`,
    description: product.description,
    collection: product.collection,
    subcollection: product.subcollection,
    productType: product.productType,
    tags: product.tags.slice(),
    price: product.price
      ? { amountCents: product.price.amountCents, currency: product.price.currency, display: formatPrice(product.price) }
      : null,
    images: product.images.map((image) => ({ path: image.path, alt: image.alt })),
    featured: product.featured,
    buyUrl,
    updatedAt: product.updatedAt,
  };
};

// Featured first, then most recently updated, then title (stable and deterministic).
const compareProducts = (a, b) =>
  Number(b.featured) - Number(a.featured) ||
  Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
  a.title.localeCompare(b.title) ||
  a.sku.localeCompare(b.sku);

// Reads catalog/collections.json and catalog/products/*.json under `root`.
const loadCatalog = (root, options = {}) => {
  const fileSystem = options.fs || fs;
  const catalogDir = path.join(root, "catalog");
  const errors = [];
  const warnings = [];
  const readJson = (file) => {
    try {
      return JSON.parse(fileSystem.readFileSync(file, "utf8"));
    } catch (error) {
      errors.push(`${path.relative(root, file)}: ${error.message}`);
      return null;
    }
  };

  const collectionsFile = readJson(path.join(catalogDir, "collections.json"));
  const { errors: collectionErrors, collections } = validateCollections(collectionsFile);
  errors.push(...collectionErrors);

  const productsDir = path.join(catalogDir, "products");
  let productFiles = [];

  try {
    productFiles = fileSystem
      .readdirSync(productsDir)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch (error) {
    errors.push(`catalog/products: ${error.message}`);
  }

  const collectionSlugs = new Set(collections.map((collection) => collection.slug));
  const fileExists = (relativePath) => fileSystem.existsSync(path.join(root, relativePath));
  const products = [];

  productFiles.forEach((name) => {
    const product = readJson(path.join(productsDir, name));

    if (product === null) {
      return;
    }

    const result = validateProduct(product, { collectionSlugs, fileExists });
    errors.push(...result.errors);
    warnings.push(...result.warnings);

    if (isPlainObject(product) && typeof product.sku === "string" && name !== `${product.sku}.json`) {
      errors.push(`${name}: file name must be <sku>.json (expected ${product.sku}.json)`);
    }

    products.push(product);
  });

  errors.push(...validateUniqueness(products));

  return { collections, products, errors, warnings };
};

// Public catalog feed: published products only, grouped for the storefront.
const buildPublicCatalog = ({ collections, products }) => {
  const published = products
    .filter((product) => product.siteState === "published")
    .map(toPublicProduct)
    .sort(compareProducts);

  return {
    schemaVersion: SCHEMA_VERSION,
    collections: collections.map((collection) => ({
      slug: collection.slug,
      name: collection.name,
      tagline: collection.tagline,
      description: collection.description,
      url: `/shop/${collection.slug}/`,
      count: published.filter((product) => product.collection === collection.slug).length,
    })),
    products: published,
  };
};

module.exports = {
  ETSY_STATES,
  LIMITS,
  PRODUCT_TYPES,
  PRODUCT_TYPE_LABELS,
  REQUIRED_COLLECTION_SLUGS,
  SCHEMA_VERSION,
  SITE_STATES,
  buildPublicCatalog,
  compareProducts,
  formatPrice,
  isSafeEtsyUrl,
  isTrustedImageUrl,
  loadCatalog,
  toPublicProduct,
  validateCollections,
  validateProduct,
  validateUniqueness,
};
