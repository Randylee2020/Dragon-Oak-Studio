// Maps Etsy listings (already READ from the bridge) onto the ADRIAN canonical catalog.
//
// Rules that keep Etsy a sales channel and NOT the product database:
//   * Matching is by Etsy listing ID first, then by SKU. Never by title.
//   * For a product that already exists in the catalog, ONLY its `etsy` block (listing ID, URL, state, sync time) is
//     updated. ADRIAN's title, description, price, tags, images, collection and site state are never overwritten.
//     Where Etsy differs, the difference is reported as "drift" for ADRIAN to decide on.
//   * A listing with no match becomes a NEW product in siteState "draft" (never published automatically) with a
//     guessed collection that a person must confirm.
//
// Pure module: no network, no filesystem, no database, and no way to write to Etsy.
const { ETSY_STATES, LIMITS, isSafeEtsyUrl } = require("./catalog");

const SKU_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,39}$/;

const COLLECTION_KEYWORDS = [
  ["cute-bookmarks", /\bbookmarks?\b/],
  ["halloween", /\b(halloween|spooky|ghost|pumpkin|witch|haunted|graveyard|skeleton|bat|bats)\b/],
  ["christmas", /\b(christmas|xmas|santa|holiday|noel|reindeer|snowflake|nativity)\b/],
  ["wine-hill-country", /\b(wine|winery|vineyard|hill country|fredericksburg|texas|cheers)\b/],
];

const slugify = (value, maxLength = LIMITS.slug) =>
  String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");

const guessCollection = (listing) => {
  const haystack = `${listing.title || ""} ${(listing.tags || []).join(" ")}`.toLowerCase();
  const match = COLLECTION_KEYWORDS.find(([, pattern]) => pattern.test(haystack));

  return match ? match[0] : "other-seasonal";
};

const toProductType = (listing) => {
  const type = String(listing.listingType || "").toLowerCase();

  if (type === "download") {
    return { productType: "digital_download", known: true };
  }

  if (type === "physical") {
    return { productType: "physical_product", known: true };
  }

  // "both" (digital + physical) and unknown types need a human decision.
  return { productType: "physical_product", known: false };
};

const priceToCents = (price) => {
  if (!price || price.amount === undefined || price.divisor === undefined || !price.currency) {
    return null;
  }

  const amount = Number(price.amount);
  const divisor = Number(price.divisor);

  if (!Number.isFinite(amount) || !Number.isFinite(divisor) || divisor <= 0 || !/^[A-Z]{3}$/.test(price.currency)) {
    return null;
  }

  const cents = Math.round((amount / divisor) * 100);

  return cents > 0 ? { amountCents: cents, currency: price.currency } : null;
};

const toIsoFromEtsyTimestamp = (timestamp, fallback) => {
  const seconds = Number(timestamp);

  if (Number.isFinite(seconds) && seconds > 0) {
    return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  return fallback;
};

const cleanTags = (tags) => {
  const seen = new Set();
  const result = [];

  (Array.isArray(tags) ? tags : []).forEach((tag) => {
    const value = String(tag || "").trim();

    if (value && value.length <= LIMITS.tagLength && !seen.has(value.toLowerCase()) && result.length < LIMITS.tags) {
      seen.add(value.toLowerCase());
      result.push(value);
    }
  });

  return result;
};

const etsyBlockFor = (listing, now) => ({
  listingId: listing.listingId,
  url: isSafeEtsyUrl(listing.url) ? listing.url : null,
  state: listing.state,
  syncedAt: now,
});

const sameEtsyBlock = (a, b) =>
  a.listingId === b.listingId && a.url === b.url && a.state === b.state && a.syncedAt === b.syncedAt;

// Differences between Etsy and the canonical product, for ADRIAN to review. Never applied automatically.
const findDrift = (product, listing) => {
  const drift = [];

  if (typeof listing.title === "string" && listing.title.trim() && listing.title.trim() !== product.title) {
    drift.push({ field: "title", canonical: product.title, etsy: listing.title.trim() });
  }

  const etsyPrice = priceToCents(listing.price);

  if (etsyPrice && (!product.price || product.price.amountCents !== etsyPrice.amountCents || product.price.currency !== etsyPrice.currency)) {
    drift.push({ field: "price", canonical: product.price, etsy: etsyPrice });
  }

  return drift;
};

const isValidListing = (listing) =>
  listing && Number.isInteger(listing.listingId) && listing.listingId > 0 && typeof listing.state === "string";

// listings: normalized listings from GET /api/etsy-listings?detail=full
// products: existing canonical products (already parsed from catalog/products/*.json)
const mapEtsyListings = ({ listings, products, now }) => {
  const report = { updates: [], creates: [], unchanged: [], conflicts: [], skipped: [], notSeen: [] };
  const byListingId = new Map();
  const bySku = new Map();
  const usedSkus = new Set();
  const usedSlugs = new Set();
  const usedIds = new Set();

  products.forEach((product) => {
    if (product.etsy && product.etsy.listingId !== null) {
      byListingId.set(product.etsy.listingId, product);
    }

    bySku.set(product.sku, product);
    usedSkus.add(product.sku);
    usedSlugs.add(product.slug);
    usedIds.add(product.id);
  });

  const seenListingIds = new Set();
  const touchedSkus = new Set();

  (Array.isArray(listings) ? listings : []).forEach((listing) => {
    if (!isValidListing(listing)) {
      report.skipped.push({ listingId: listing && listing.listingId, reason: "listing has no usable listingId or state" });
      return;
    }

    if (seenListingIds.has(listing.listingId)) {
      report.skipped.push({ listingId: listing.listingId, reason: "duplicate listing in this import" });
      return;
    }

    seenListingIds.add(listing.listingId);

    if (!ETSY_STATES.includes(listing.state) || listing.state === "not_listed") {
      report.conflicts.push({ listingId: listing.listingId, reason: `unrecognised Etsy state "${listing.state}"` });
      return;
    }

    const etsySkus = (Array.isArray(listing.skus) ? listing.skus : []).map((sku) => String(sku).trim()).filter(Boolean);
    let product = byListingId.get(listing.listingId);
    let matchedBy = product ? "listingId" : null;

    if (!product) {
      const skuMatches = Array.from(new Set(etsySkus.filter((sku) => bySku.has(sku)).map((sku) => bySku.get(sku))));

      if (skuMatches.length > 1) {
        report.conflicts.push({
          listingId: listing.listingId,
          reason: `SKUs on this listing match more than one catalog product (${skuMatches.map((entry) => entry.sku).join(", ")})`,
        });
        return;
      }

      if (skuMatches.length === 1) {
        const candidate = skuMatches[0];

        if (candidate.etsy && candidate.etsy.listingId !== null && candidate.etsy.listingId !== listing.listingId) {
          report.conflicts.push({
            listingId: listing.listingId,
            reason: `SKU ${candidate.sku} is already mapped to Etsy listing ${candidate.etsy.listingId}`,
          });
          return;
        }

        product = candidate;
        matchedBy = "sku";
      }
    }

    if (product) {
      if (touchedSkus.has(product.sku)) {
        report.conflicts.push({ listingId: listing.listingId, reason: `catalog product ${product.sku} matched more than one listing in this import` });
        return;
      }

      touchedSkus.add(product.sku);

      const nextEtsy = etsyBlockFor(listing, now);
      const previousEtsy = product.etsy;
      const drift = findDrift(product, listing);
      const previousComparable = { ...previousEtsy, syncedAt: nextEtsy.syncedAt };

      if (sameEtsyBlock(previousComparable, nextEtsy)) {
        report.unchanged.push({ sku: product.sku, listingId: listing.listingId, matchedBy, drift });
        return;
      }

      report.updates.push({
        sku: product.sku,
        listingId: listing.listingId,
        matchedBy,
        etsyBefore: previousEtsy,
        etsyAfter: nextEtsy,
        drift,
        product: { ...product, etsy: nextEtsy, updatedAt: now },
      });
      return;
    }

    // No match: propose a brand-new DRAFT product.
    const firstEtsySku = etsySkus.find((sku) => SKU_PATTERN.test(sku) && !usedSkus.has(sku));
    const sku = firstEtsySku || `ETSY-${listing.listingId}`;
    const baseSlug = slugify(listing.title) || `listing-${listing.listingId}`;
    const slug = usedSlugs.has(baseSlug) ? slugify(`${baseSlug}-${listing.listingId}`) : baseSlug;
    const id = `etsy-${listing.listingId}`;

    if (usedSkus.has(sku) || usedIds.has(id)) {
      report.conflicts.push({ listingId: listing.listingId, reason: `cannot create a product: SKU ${sku} or id ${id} already exists` });
      return;
    }

    usedSkus.add(sku);
    usedSlugs.add(slug);
    usedIds.add(id);

    const { productType, known } = toProductType(listing);
    const createdAt = toIsoFromEtsyTimestamp(listing.createdTimestamp, now);
    const review = [];

    if (!firstEtsySku) {
      review.push("no usable SKU on the Etsy listing; a temporary ETSY-<listing id> SKU was assigned");
    }

    if (!known) {
      review.push("product type could not be determined from Etsy; confirm digital vs physical");
    }

    review.push("collection was guessed from the title and tags; confirm it");
    review.push("no site images yet; add images (or run the import with --download-images) before publishing");

    report.creates.push({
      sku,
      listingId: listing.listingId,
      etsyImages: Array.isArray(listing.images) ? listing.images : [],
      review,
      product: {
        schemaVersion: 1,
        id,
        sku,
        title: String(listing.title || `Etsy listing ${listing.listingId}`).trim().slice(0, LIMITS.title),
        slug,
        description: typeof listing.description === "string" ? listing.description.slice(0, LIMITS.description) : "",
        collection: guessCollection(listing),
        subcollection: null,
        productType,
        tags: cleanTags(listing.tags),
        price: priceToCents(listing.price),
        images: [],
        digitalFiles: [],
        etsy: etsyBlockFor(listing, now),
        siteState: "draft",
        featured: false,
        createdAt,
        updatedAt: Date.parse(now) >= Date.parse(createdAt) ? now : createdAt,
        notes: `Imported from Etsy listing ${listing.listingId}. Needs review: ${review.join("; ")}.`,
        provenance: "etsy-import (read-only)",
      },
    });
  });

  products.forEach((product) => {
    if (product.etsy && product.etsy.listingId !== null && !seenListingIds.has(product.etsy.listingId)) {
      report.notSeen.push({ sku: product.sku, listingId: product.etsy.listingId });
    }
  });

  return report;
};

module.exports = { guessCollection, mapEtsyListings, priceToCents, slugify };
