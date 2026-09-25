const test = require("node:test");
const assert = require("node:assert/strict");
const {
  REQUIRED_COLLECTION_SLUGS,
  buildPublicCatalog,
  compareProducts,
  formatPrice,
  isSafeEtsyUrl,
  isTrustedImageUrl,
  toPublicProduct,
  validateCollections,
  validateProduct,
  validateUniqueness,
} = require("../api/_lib/catalog");

const baseProduct = (overrides = {}) => ({
  schemaVersion: 1,
  id: "prod-test-0001",
  sku: "TEST-0001",
  title: "Test Product",
  slug: "test-product",
  description: "A test description.",
  collection: "halloween",
  subcollection: null,
  productType: "physical_product",
  tags: ["one", "two"],
  price: { amountCents: 1250, currency: "USD" },
  images: [{ path: "assets/test/1.webp", alt: "Test image" }],
  digitalFiles: [],
  etsy: { listingId: null, url: null, state: "not_listed", syncedAt: null },
  siteState: "published",
  featured: false,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-02T00:00:00Z",
  ...overrides,
});

const errorsOf = (product) => validateProduct(product).errors;

test("a complete product validates with no errors", () => {
  assert.deepEqual(validateProduct(baseProduct()), { errors: [], warnings: [] });
});

test("the five required top-level collections exist and product type is a separate field", () => {
  assert.deepEqual(REQUIRED_COLLECTION_SLUGS, ["halloween", "christmas", "cute-bookmarks", "wine-hill-country", "other-seasonal"]);

  REQUIRED_COLLECTION_SLUGS.forEach((collection) => {
    ["digital_download", "physical_product"].forEach((productType) => {
      assert.deepEqual(errorsOf(baseProduct({ collection, productType })), [], `${collection} + ${productType}`);
    });
  });
});

test("the canonical model supports every field the storefront brief requires", () => {
  const required = [
    "id", "sku", "title", "slug", "description", "collection", "subcollection", "productType", "tags", "price", "images",
    "digitalFiles", "etsy", "siteState", "featured", "createdAt", "updatedAt",
  ];

  required.forEach((field) => {
    const product = baseProduct();
    delete product[field];
    assert.ok(errorsOf(product).length > 0, `missing ${field} should be rejected`);
  });

  ["listingId", "url", "state"].forEach((field) => {
    const product = baseProduct();
    delete product.etsy[field];
    assert.ok(errorsOf(product).length > 0, `missing etsy.${field} should be rejected`);
  });
});

test("rejects bad ids, SKUs, slugs, titles and unknown collections or types", () => {
  assert.ok(errorsOf(baseProduct({ id: "X" })).length);
  assert.ok(errorsOf(baseProduct({ sku: "lowercase-sku" })).length);
  assert.ok(errorsOf(baseProduct({ sku: "A" })).length);
  assert.ok(errorsOf(baseProduct({ slug: "Not A Slug" })).length);
  assert.ok(errorsOf(baseProduct({ slug: "double--hyphen" })).length);
  assert.ok(errorsOf(baseProduct({ title: "" })).length);
  assert.ok(errorsOf(baseProduct({ title: "x".repeat(141) })).length);
  assert.ok(errorsOf(baseProduct({ collection: "easter" })).length);
  assert.ok(errorsOf(baseProduct({ productType: "service" })).length);
  assert.ok(errorsOf(baseProduct({ subcollection: "Bad Sub" })).length);
  assert.ok(errorsOf(baseProduct({ schemaVersion: 2 })).length);
});

test("tags follow Etsy-compatible limits and reject duplicates", () => {
  assert.deepEqual(errorsOf(baseProduct({ tags: Array.from({ length: 13 }, (_, i) => `tag${i}`) })), []);
  assert.ok(errorsOf(baseProduct({ tags: Array.from({ length: 14 }, (_, i) => `tag${i}`) })).length);
  assert.ok(errorsOf(baseProduct({ tags: ["x".repeat(21)] })).length);
  assert.ok(errorsOf(baseProduct({ tags: ["Same", "same"] })).length);
  assert.ok(errorsOf(baseProduct({ tags: [""] })).length);
});

test("price is null or a positive integer number of cents with a currency", () => {
  assert.deepEqual(errorsOf(baseProduct({ price: null })), []);
  assert.ok(errorsOf(baseProduct({ price: { amountCents: 12.5, currency: "USD" } })).length);
  assert.ok(errorsOf(baseProduct({ price: { amountCents: 0, currency: "USD" } })).length);
  assert.ok(errorsOf(baseProduct({ price: { amountCents: 100, currency: "usd" } })).length);
  assert.ok(errorsOf(baseProduct({ price: 4.99 })).length);
});

test("image paths must be relative assets/ paths with alt text, and must exist", () => {
  ["/etc/passwd", "../secret.png", "assets/../x.png", "https://evil.example/x.png", "assets/x.gif", "assets\\x.png"].forEach((bad) => {
    assert.ok(errorsOf(baseProduct({ images: [{ path: bad, alt: "a" }] })).length, bad);
  });

  assert.ok(errorsOf(baseProduct({ images: [{ path: "assets/a.webp", alt: "" }] })).length);

  const missing = validateProduct(baseProduct(), { fileExists: () => false });
  assert.ok(missing.errors.some((message) => message.includes("file not found")));
});

test("product images may use trusted Etsy CDN URLs without requiring local files", () => {
  const trusted = "https://i.etsystatic.com/64473522/r/il/c34365/8549844100/il_fullxfull.8549844100_pf78.jpg";

  assert.equal(isTrustedImageUrl(trusted), true);
  assert.deepEqual(validateProduct(baseProduct({ images: [{ path: trusted, alt: "Etsy image" }] }), { fileExists: () => false }).errors, []);

  [
    "http://i.etsystatic.com/1/a.jpg",
    "https://i.etsystatic.com.evil.example/1/a.jpg",
    "https://user:pw@i.etsystatic.com/1/a.jpg",
    "https://i.etsystatic.com/1/a.gif",
  ].forEach((url) => {
    assert.equal(isTrustedImageUrl(url), false, url);
    assert.ok(errorsOf(baseProduct({ images: [{ path: url, alt: "a" }] })).length, url);
  });
});

test("digital file references must be opaque adrian: identifiers, never URLs or paths", () => {
  const ok = { ref: "adrian:factory/TEST-0001/design.zip", label: "Design files" };
  assert.deepEqual(errorsOf(baseProduct({ productType: "digital_download", digitalFiles: [ok] })), []);

  [
    "https://cdn.example.com/file.zip",
    "C:\\Users\\Randy\\file.zip",
    "/var/data/file.zip",
    "file:///x.zip",
    "adrian:../../etc/passwd",
    "s3://bucket/x.zip",
  ].forEach((ref) => {
    assert.ok(errorsOf(baseProduct({ digitalFiles: [{ ref, label: "x" }] })).length, ref);
  });
});

test("etsy block rules: listing ID, state and URL must agree, and URLs must be https etsy.com", () => {
  const etsy = (overrides) => ({ listingId: 123, url: "https://www.etsy.com/listing/123/x", state: "active", syncedAt: "2026-09-01T00:00:00Z", ...overrides });

  assert.deepEqual(errorsOf(baseProduct({ etsy: etsy() })), []);
  assert.ok(errorsOf(baseProduct({ etsy: etsy({ listingId: null }) })).length, "state without listing ID");
  assert.ok(errorsOf(baseProduct({ etsy: etsy({ state: "not_listed" }) })).length, "listing ID with not_listed");
  assert.ok(errorsOf(baseProduct({ etsy: etsy({ state: "live" }) })).length);
  assert.ok(errorsOf(baseProduct({ etsy: etsy({ listingId: 0 }) })).length);
  assert.ok(errorsOf(baseProduct({ etsy: etsy({ syncedAt: "yesterday" }) })).length);

  ["javascript:alert(1)", "http://www.etsy.com/listing/1", "https://etsy.com.evil.example/x", "https://evil.example/etsy.com", "https://user:pw@www.etsy.com/x", "data:text/html,hi"].forEach((url) => {
    assert.ok(errorsOf(baseProduct({ etsy: etsy({ url }) })).length, url);
    assert.equal(isSafeEtsyUrl(url), false, url);
  });

  assert.equal(isSafeEtsyUrl("https://www.etsy.com/listing/1/x"), true);
  assert.equal(isSafeEtsyUrl("https://etsy.com/listing/1/x"), true);
  assert.equal(isSafeEtsyUrl("https://shop.etsy.com/x"), true);
});

test("published products need a description and at least one image; drafts do not", () => {
  assert.ok(errorsOf(baseProduct({ description: "" })).length);
  assert.ok(errorsOf(baseProduct({ images: [] })).length);
  assert.deepEqual(errorsOf(baseProduct({ siteState: "draft", description: "", images: [] })), []);
  assert.ok(errorsOf(baseProduct({ siteState: "live" })).length);
});

test("timestamps must be ISO 8601 and updatedAt cannot precede createdAt", () => {
  assert.ok(errorsOf(baseProduct({ createdAt: "2026-09-01" })).length);
  assert.ok(errorsOf(baseProduct({ updatedAt: "2026-08-01T00:00:00Z" })).length);
});

test("unknown fields only warn (and are never published)", () => {
  const result = validateProduct(baseProduct({ surprise: "value" }));
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 1);
  assert.ok(!("surprise" in toPublicProduct(baseProduct({ surprise: "value" }))));
});

test("uniqueness: id, sku, slug and Etsy listing ID must each be unique", () => {
  const a = baseProduct({ etsy: { listingId: 5, url: null, state: "draft", syncedAt: null } });
  const b = (overrides) => baseProduct({ id: "prod-test-0002", sku: "TEST-0002", slug: "test-two", ...overrides });

  assert.deepEqual(validateUniqueness([a, b()]), []);
  assert.equal(validateUniqueness([a, b({ id: a.id })]).length, 1);
  assert.equal(validateUniqueness([a, b({ sku: a.sku })]).length, 1);
  assert.equal(validateUniqueness([a, b({ slug: a.slug })]).length, 1);
  assert.equal(validateUniqueness([a, b({ etsy: { listingId: 5, url: null, state: "draft", syncedAt: null } })]).length, 1);
});

test("collections file must define the five required collections", () => {
  const collection = (slug, order) => ({ slug, name: slug, tagline: "t", description: "d", order });
  const full = { schemaVersion: 1, collections: REQUIRED_COLLECTION_SLUGS.map((slug, index) => collection(slug, index + 1)) };

  assert.deepEqual(validateCollections(full).errors, []);
  assert.ok(validateCollections({ ...full, collections: full.collections.slice(1) }).errors.some((message) => message.includes("halloween")));
  assert.ok(validateCollections({ ...full, collections: [...full.collections, collection("halloween", 9)] }).errors.length);
  assert.ok(validateCollections({}).errors.length);
});

test("public projection is an allow-list: no digital files, notes, provenance or Etsy internals", () => {
  const product = baseProduct({
    productType: "digital_download",
    digitalFiles: [{ ref: "adrian:factory/TEST-0001/secret.zip", label: "Secret" }],
    notes: "INTERNAL-NOTE",
    provenance: "INTERNAL-PROVENANCE",
    etsy: { listingId: 777, url: "https://www.etsy.com/listing/777/x", state: "active", syncedAt: "2026-09-01T00:00:00Z" },
  });
  const serialized = JSON.stringify(toPublicProduct(product));

  // (The public Etsy URL itself contains the listing number, so only the private field NAMES are checked for it.)
  ["adrian:", "secret.zip", "INTERNAL", "digitalFiles", "provenance", "notes", "listingId", "syncedAt", "etsy\""].forEach((needle) => {
    assert.ok(!serialized.includes(needle), `public projection must not contain ${needle}`);
  });

  assert.equal(toPublicProduct(product).buyUrl, "https://www.etsy.com/listing/777/x");
});

test("Buy on Etsy link is only exposed for active listings", () => {
  const withState = (state) =>
    toPublicProduct(baseProduct({ etsy: { listingId: 1, url: "https://www.etsy.com/listing/1/x", state, syncedAt: null } })).buyUrl;

  assert.equal(withState("active"), "https://www.etsy.com/listing/1/x");
  ["draft", "inactive", "sold_out", "expired", "removed"].forEach((state) => assert.equal(withState(state), null, state));
  assert.equal(toPublicProduct(baseProduct()).buyUrl, null);
});

test("public catalog contains only published products, sorted featured-first, with collection counts", () => {
  const collections = REQUIRED_COLLECTION_SLUGS.map((slug, index) => ({ slug, name: slug, tagline: "t", description: "d", order: index + 1 }));
  const products = [
    baseProduct({ id: "prod-a-0001", sku: "A-0001", slug: "a", title: "A", updatedAt: "2026-09-05T00:00:00Z" }),
    baseProduct({ id: "prod-b-0001", sku: "B-0001", slug: "b", title: "B", featured: true, updatedAt: "2026-09-01T00:00:00Z" }),
    baseProduct({ id: "prod-c-0001", sku: "C-0001", slug: "c", title: "C", siteState: "draft" }),
    baseProduct({ id: "prod-d-0001", sku: "D-0001", slug: "d", title: "D", siteState: "archived" }),
    baseProduct({ id: "prod-e-0001", sku: "E-0001", slug: "e", title: "E", collection: "christmas" }),
  ];
  const catalog = buildPublicCatalog({ collections, products });

  // Featured first (B), then newest update first (A updated 09-05, E updated 09-02).
  assert.deepEqual(catalog.products.map((product) => product.sku), ["B-0001", "A-0001", "E-0001"]);
  assert.equal(catalog.collections.find((entry) => entry.slug === "halloween").count, 2);
  assert.equal(catalog.collections.find((entry) => entry.slug === "christmas").count, 1);
  assert.equal(catalog.collections.find((entry) => entry.slug === "cute-bookmarks").count, 0);
  assert.ok([...products].sort(compareProducts)[0].featured);
});

test("price formatting", () => {
  assert.equal(formatPrice({ amountCents: 499, currency: "USD" }), "$4.99");
  assert.equal(formatPrice({ amountCents: 1000, currency: "EUR" }), "10.00 EUR");
  assert.equal(formatPrice(null), null);
});
