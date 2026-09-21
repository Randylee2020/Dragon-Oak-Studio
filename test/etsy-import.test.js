const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { validateProduct } = require("../api/_lib/catalog");
const { guessCollection, mapEtsyListings, priceToCents, slugify } = require("../api/_lib/etsy-import");
const { downloadImages, fetchAllListings, normalizeSiteUrl, parseArgs, runImport } = require("../tools/import-etsy");

const NOW = "2026-09-21T12:00:00Z";

const product = (overrides = {}) => ({
  schemaVersion: 1,
  id: "prod-do-0001",
  sku: "DO-0001",
  title: "Canonical Title",
  slug: "canonical-title",
  description: "ADRIAN description",
  collection: "halloween",
  subcollection: null,
  productType: "physical_product",
  tags: ["adrian"],
  price: { amountCents: 1000, currency: "USD" },
  images: [{ path: "assets/a.webp", alt: "a" }],
  digitalFiles: [],
  etsy: { listingId: null, url: null, state: "not_listed", syncedAt: null },
  siteState: "published",
  featured: true,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  ...overrides,
});

const listing = (overrides = {}) => ({
  listingId: 111,
  title: "Etsy Title",
  state: "active",
  quantity: 5,
  price: { amount: 1000, divisor: 100, currency: "USD", display: "$10.00" },
  url: "https://www.etsy.com/listing/111/etsy-title",
  createdTimestamp: 1788000000,
  updatedTimestamp: 1788000100,
  description: "Etsy description",
  tags: ["etsy"],
  skus: [],
  listingType: "download",
  taxonomyId: 1,
  images: [{ imageId: 1, url: "https://i.etsystatic.com/1/r/il/abc/1/il_fullxfull.1_x.jpg", altText: "Alt 1", rank: 1 }],
  ...overrides,
});

test("matches by Etsy listing ID first and updates ONLY the etsy block", () => {
  const existing = product({ etsy: { listingId: 111, url: "https://www.etsy.com/listing/111/old", state: "inactive", syncedAt: "2026-09-01T00:00:00Z" } });
  const report = mapEtsyListings({ listings: [listing()], products: [existing], now: NOW });

  assert.equal(report.updates.length, 1);
  assert.equal(report.creates.length, 0);

  const [update] = report.updates;
  assert.equal(update.matchedBy, "listingId");
  assert.equal(update.etsyAfter.state, "active");
  assert.equal(update.etsyAfter.syncedAt, NOW);

  // ADRIAN's canonical fields are untouched even though Etsy's title, description, price, tags differ.
  ["title", "description", "price", "tags", "collection", "siteState", "featured", "images", "sku", "slug", "id"].forEach((field) => {
    assert.deepEqual(update.product[field], existing[field], `${field} must not be overwritten by Etsy`);
  });

  assert.equal(update.product.updatedAt, NOW);
  assert.deepEqual(validateProduct(update.product).errors, []);
});

test("matches by SKU when the listing ID is not mapped yet, and records the listing ID", () => {
  const report = mapEtsyListings({ listings: [listing({ skus: ["DO-0001"] })], products: [product()], now: NOW });

  assert.equal(report.updates.length, 1);
  assert.equal(report.updates[0].matchedBy, "sku");
  assert.equal(report.updates[0].product.etsy.listingId, 111);
  assert.equal(report.creates.length, 0);
});

test("never matches by title", () => {
  const report = mapEtsyListings({ listings: [listing({ title: "Canonical Title" })], products: [product()], now: NOW });

  assert.equal(report.updates.length, 0);
  assert.equal(report.creates.length, 1);
});

test("reports drift (title/price) for ADRIAN to decide instead of applying it", () => {
  const existing = product({ etsy: { listingId: 111, url: "https://www.etsy.com/listing/111/x", state: "active", syncedAt: null } });
  const report = mapEtsyListings({ listings: [listing({ price: { amount: 1500, divisor: 100, currency: "USD" } })], products: [existing], now: NOW });
  const entry = [...report.updates, ...report.unchanged][0];

  assert.deepEqual(entry.drift.map((drift) => drift.field).sort(), ["price", "title"]);
});

test("an identical Etsy block is reported as unchanged (no needless rewrite)", () => {
  const existing = product({ etsy: { listingId: 111, url: "https://www.etsy.com/listing/111/etsy-title", state: "active", syncedAt: "2026-08-01T00:00:00Z" } });
  const report = mapEtsyListings({ listings: [listing()], products: [existing], now: NOW });

  assert.equal(report.updates.length, 0);
  assert.equal(report.unchanged.length, 1);
});

test("conflicts: SKU already mapped to a different listing, or one listing matching two products", () => {
  const mapped = product({ etsy: { listingId: 999, url: null, state: "active", syncedAt: null } });
  const first = mapEtsyListings({ listings: [listing({ skus: ["DO-0001"] })], products: [mapped], now: NOW });
  assert.equal(first.conflicts.length, 1);
  assert.match(first.conflicts[0].reason, /already mapped to Etsy listing 999/);
  assert.equal(first.updates.length + first.creates.length, 0);

  const second = mapEtsyListings({
    listings: [listing({ skus: ["DO-0001", "DO-0002"] })],
    products: [product(), product({ id: "prod-do-0002", sku: "DO-0002", slug: "two" })],
    now: NOW,
  });
  assert.equal(second.conflicts.length, 1);
  assert.match(second.conflicts[0].reason, /more than one catalog product/);
});

test("unknown Etsy states and malformed or duplicate listings are not imported", () => {
  const report = mapEtsyListings({
    listings: [listing({ state: "mystery" }), { title: "no id" }, listing({ listingId: 5 }), listing({ listingId: 5 })],
    products: [],
    now: NOW,
  });

  assert.equal(report.conflicts.length, 1);
  assert.equal(report.skipped.length, 2);
  assert.equal(report.creates.length, 1);
});

test("unmatched listings become DRAFT products that pass validation and are never published", () => {
  const report = mapEtsyListings({
    listings: [listing({ listingId: 222, title: "Spooky Ghost Bookmark Set", tags: ["ghost", "halloween"], skus: ["GHOST-01"] })],
    products: [],
    now: NOW,
  });

  assert.equal(report.creates.length, 1);

  const [create] = report.creates;
  assert.equal(create.product.siteState, "draft");
  assert.equal(create.product.featured, false);
  assert.equal(create.product.sku, "GHOST-01");
  assert.equal(create.product.etsy.listingId, 222);
  assert.equal(create.product.productType, "digital_download");
  assert.equal(create.product.price.amountCents, 1000);
  assert.deepEqual(create.product.images, [], "site images are never pointed at Etsy's CDN");
  assert.equal(create.product.createdAt, "2026-08-29T10:40:00Z", "Etsy epoch 1788000000 seconds");
  assert.ok(create.review.length >= 2);
  assert.deepEqual(validateProduct(create.product, { fileExists: () => true }).errors, []);
});

test("listing without a usable SKU gets a temporary ETSY-<id> SKU, and unknown type needs review", () => {
  const report = mapEtsyListings({ listings: [listing({ listingId: 333, skus: [], listingType: "both" })], products: [], now: NOW });
  const [create] = report.creates;

  assert.equal(create.sku, "ETSY-333");
  assert.equal(create.product.productType, "physical_product");
  assert.ok(create.review.some((line) => line.includes("temporary")));
  assert.ok(create.review.some((line) => line.includes("digital vs physical")));
});

test("new products never collide with existing SKUs, slugs or ids", () => {
  const existing = product({ slug: "etsy-title" });
  const report = mapEtsyListings({ listings: [listing({ listingId: 444 })], products: [existing], now: NOW });

  assert.equal(report.creates[0].product.slug, "etsy-title-444");
});

test("catalog products absent from this import are listed, not changed", () => {
  const existing = product({ etsy: { listingId: 555, url: null, state: "active", syncedAt: null } });
  const report = mapEtsyListings({ listings: [], products: [existing], now: NOW });

  assert.deepEqual(report.notSeen, [{ sku: "DO-0001", listingId: 555 }]);
});

test("helpers: collection guess, slugify and price conversion", () => {
  assert.equal(guessCollection({ title: "Cute Panda Bookmark", tags: [] }), "cute-bookmarks");
  assert.equal(guessCollection({ title: "Haunted House Ornament", tags: [] }), "halloween");
  assert.equal(guessCollection({ title: "Santa Claus Ornament", tags: [] }), "christmas");
  assert.equal(guessCollection({ title: "Fredericksburg Wine Coaster", tags: [] }), "wine-hill-country");
  assert.equal(guessCollection({ title: "Easter Egg", tags: [] }), "other-seasonal");
  assert.equal(slugify("Wine & Cheese: 100% Fun!"), "wine-and-cheese-100-fun");
  assert.deepEqual(priceToCents({ amount: 499, divisor: 100, currency: "USD" }), { amountCents: 499, currency: "USD" });
  assert.equal(priceToCents({ amount: 0, divisor: 100, currency: "USD" }), null);
  assert.equal(priceToCents(null), null);
});

// ---- The command-line tool --------------------------------------------------------------------------------------

const fakeFetch = (pages) => {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, options });
    const page = pages.shift();
    return { ok: page.status === undefined || page.status < 400, status: page.status || 200, json: async () => page.body };
  };
  impl.calls = calls;
  return impl;
};

test("import only ever issues GET requests, sends the secret only as a Bearer header, and pages through results", async () => {
  const full = Array.from({ length: 100 }, (_, index) => listing({ listingId: index + 1 }));
  const fetchImpl = fakeFetch([
    { body: { ok: true, connected: true, count: 101, listings: full } },
    { body: { ok: true, connected: true, count: 101, listings: [listing({ listingId: 101 })] } },
  ]);
  const listings = await fetchAllListings({ site: "https://dragonoakstudio.com/", secret: "S3CRET-VALUE-0123456789-0123456789", states: ["active"], fetchImpl });

  assert.equal(listings.length, 101);
  assert.equal(fetchImpl.calls.length, 2);

  fetchImpl.calls.forEach((call) => {
    assert.equal(call.options.method, "GET");
    assert.equal(call.options.body, undefined);
    assert.equal(call.options.headers.Authorization, "Bearer S3CRET-VALUE-0123456789-0123456789");
    assert.ok(!call.url.includes("S3CRET"), "secret must never be in the URL");
    assert.match(call.url, /^https:\/\/dragonoakstudio\.com\/api\/etsy-listings\?detail=full&state=active&limit=100&offset=(0|100)$/);
  });
});

test("import fails clearly and never echoes the secret", async () => {
  const secret = "S3CRET-VALUE-0123456789-0123456789";

  await assert.rejects(() => fetchAllListings({ site: "https://x.example", secret: "", states: ["active"], fetchImpl: fakeFetch([]) }), /ADRIAN_BRIDGE_SECRET/);

  await assert.rejects(
    () => fetchAllListings({ site: "https://x.example", secret, states: ["active"], fetchImpl: fakeFetch([{ status: 403, body: { ok: false, message: "Invalid credentials." } }]) }),
    (error) => /HTTP 403/.test(error.message) && !error.message.includes(secret)
  );

  await assert.rejects(
    () => fetchAllListings({ site: "https://x.example", secret, states: ["active"], fetchImpl: fakeFetch([{ body: { ok: true, connected: false, listings: [] } }]) }),
    /not connected/
  );
});

test("import refuses insecure or credentialed site addresses and unknown options", () => {
  assert.equal(normalizeSiteUrl("https://dragonoakstudio.com/anything"), "https://dragonoakstudio.com");
  assert.equal(normalizeSiteUrl("http://localhost:3000"), "http://localhost:3000");
  assert.throws(() => normalizeSiteUrl("http://dragonoakstudio.com"));
  assert.throws(() => normalizeSiteUrl("https://user:pw@dragonoakstudio.com"));
  assert.throws(() => normalizeSiteUrl("not a url"));
  assert.throws(() => parseArgs(["--publish"]), /Unknown option/);
  assert.throws(() => parseArgs(["--download-images"]), /--write/);
  assert.throws(() => parseArgs(["--states", "active,bogus"]));
});

const makeTempRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "do-import-"));
  fs.mkdirSync(path.join(root, "catalog", "products"), { recursive: true });
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  fs.writeFileSync(path.join(root, "assets", "a.webp"), "x");
  fs.writeFileSync(
    path.join(root, "catalog", "collections.json"),
    JSON.stringify({
      schemaVersion: 1,
      collections: ["halloween", "christmas", "cute-bookmarks", "wine-hill-country", "other-seasonal"].map((slug, index) => ({ slug, name: slug, tagline: "t", description: "d", order: index + 1 })),
    })
  );
  fs.writeFileSync(path.join(root, "catalog", "products", "DO-0001.json"), JSON.stringify(product()));
  return root;
};

test("dry run writes nothing; --write creates drafts and updates only the etsy block on disk", async () => {
  const root = makeTempRoot();
  const file = path.join(root, "saved.json");
  fs.writeFileSync(file, JSON.stringify({ listings: [listing({ listingId: 111, skus: ["DO-0001"] }), listing({ listingId: 222, title: "Brand New Thing" })] }));
  const before = fs.readFileSync(path.join(root, "catalog", "products", "DO-0001.json"), "utf8");
  const now = new Date("2026-09-21T12:00:00Z");

  const dry = await runImport({ root, file, states: ["active"], write: false }, { now });
  assert.equal(dry.wrote, false);
  assert.equal(fs.readFileSync(path.join(root, "catalog", "products", "DO-0001.json"), "utf8"), before);
  assert.deepEqual(fs.readdirSync(path.join(root, "catalog", "products")), ["DO-0001.json"]);
  assert.ok(!fs.existsSync(path.join(root, "catalog", "import")));
  assert.match(dry.summary, /New draft products to create : 1/);

  const written = await runImport({ root, file, states: ["active"], write: true }, { now });
  assert.equal(written.wrote, true);

  const updated = JSON.parse(fs.readFileSync(path.join(root, "catalog", "products", "DO-0001.json"), "utf8"));
  assert.equal(updated.title, "Canonical Title");
  assert.equal(updated.siteState, "published");
  assert.equal(updated.etsy.listingId, 111);

  const created = JSON.parse(fs.readFileSync(path.join(root, "catalog", "products", "ETSY-222.json"), "utf8"));
  assert.equal(created.siteState, "draft");
  assert.ok(fs.readdirSync(path.join(root, "catalog", "import")).some((name) => name.startsWith("etsy-import-")));
  assert.ok(!JSON.stringify(fs.readdirSync(path.join(root, "catalog", "import"))).includes("SECRET"));
});

test("downloading photos is GET-only, limited to Etsy's public image host, and to image types", async () => {
  const root = makeTempRoot();
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      headers: { get: () => (url.endsWith("bad.gif") ? "image/gif" : "image/jpeg") },
      arrayBuffer: async () => Buffer.from("fake-image-bytes"),
    };
  };
  const saved = await downloadImages({
    root,
    sku: "ETSY-222",
    title: "Brand New Thing",
    fetchImpl,
    etsyImages: [
      { url: "https://i.etsystatic.com/1/a.jpg", altText: "First" },
      { url: "https://evil.example/steal.jpg", altText: "Blocked host" },
      { url: "http://i.etsystatic.com/insecure.jpg", altText: "Blocked http" },
      { url: "https://i.etsystatic.com/bad.gif", altText: "Blocked type" },
      { url: "javascript:alert(1)" },
      { url: "https://i.etsystatic.com/2/b.jpg" },
    ],
  });

  assert.deepEqual(saved, [
    { path: "assets/products/ETSY-222/1.jpg", alt: "First" },
    { path: "assets/products/ETSY-222/2.jpg", alt: "Brand New Thing" },
  ]);
  assert.ok(calls.every((call) => call.options.method === "GET" && call.url.startsWith("https://i.etsystatic.com/")));
  assert.equal(fs.readFileSync(path.join(root, "assets", "products", "ETSY-222", "1.jpg"), "utf8"), "fake-image-bytes");
});

test("the import code has no way to write to Etsy (static guard)", () => {
  ["tools/import-etsy.js", "api/_lib/etsy-import.js"].forEach((file) => {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");

    assert.ok(!/method:\s*["'`](POST|PUT|PATCH|DELETE)["'`]/i.test(source), `${file} must not issue write requests`);
    assert.ok(!/fetchEtsyApi|fetchEtsyJson|etsy-oauth|api\.etsy\.com/.test(source), `${file} must not talk to the Etsy API directly`);
    assert.ok(!/listings-create|listing-activate|listing-file-upload|listing-image-upload/.test(source.replace(/^\s*\/\/.*$/gm, "")), `${file} must not call the write endpoints`);
  });
});
