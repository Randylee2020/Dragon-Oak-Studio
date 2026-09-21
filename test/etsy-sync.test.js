const { TEST_SECRET } = require("./_bridge-auth-test-helper"); // also sets the SERVER-side secret for the integration tests
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { classifyListing, mapEtsyListings } = require("../api/_lib/etsy-import");
const { buildSyncReport, formatSyncReport, main, parseSyncArgs, runSync } = require("../tools/etsy-sync");
const { parseArgs, runImport } = require("../tools/import-etsy");

const NOW = new Date("2026-09-21T12:00:00Z");
const SECRET = "Zk3-test-only-secret-0123456789-abcdefghijklmnop";
const ROOT = path.join(__dirname, "..");
const COLLECTION_NAMES = { halloween: "Halloween", christmas: "Christmas", "cute-bookmarks": "Cute Bookmarks", "wine-hill-country": "Wine & Hill Country", "other-seasonal": "Other Seasonal" };

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
  tags: [],
  skus: [],
  listingType: "download",
  taxonomyId: 1,
  images: [],
  ...overrides,
});

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
  tags: [],
  price: { amountCents: 1000, currency: "USD" },
  images: [{ path: "assets/a.webp", alt: "a" }],
  digitalFiles: [],
  etsy: { listingId: null, url: null, state: "not_listed", syncedAt: null },
  siteState: "published",
  featured: false,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  ...overrides,
});

const secretFile = (content) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "do-bridge-secret-"));
  const file = path.join(dir, "bridge-secret");

  fs.writeFileSync(file, `${content}\n`);
  fs.chmodSync(file, 0o600);

  return file;
};

const analyse = (listings, products = []) => {
  const report = mapEtsyListings({ listings, products, now: "2026-09-21T12:00:00Z" });

  return buildSyncReport({ listings, report, collectionNames: COLLECTION_NAMES });
};

const rowFor = (analysis, listingId) => analysis.rows.find((row) => row.listingId === listingId);
const codesFor = (row) => row.problems.map((problem) => problem.code).sort();

// ---- Command-line options ---------------------------------------------------------------------------------------------

test("etsy:sync needs an explicit --dry-run and refuses every write or publish option", () => {
  const options = parseSyncArgs(["--dry-run"]);

  assert.equal(options.dryRun, true);
  assert.deepEqual(options.states, ["active", "inactive", "draft", "sold_out", "expired"], "the FULL catalog by default");
  assert.equal(options.site, "https://dragonoakstudio.com");

  assert.throws(() => parseSyncArgs([]), /Add --dry-run/);
  assert.throws(() => parseSyncArgs(["--json"]), /Add --dry-run/);

  ["--write", "--download-images", "--publish", "--activate"].forEach((flag) => assert.throws(() => parseSyncArgs(["--dry-run", flag]), /read-only/, flag));
  assert.throws(() => parseSyncArgs(["--dry-run", "--secret", "abc"]), /never be given on the command line/);
  assert.throws(() => parseSyncArgs(["--dry-run", "--secret=abc"]), /never be given on the command line/);
  assert.throws(() => parseSyncArgs(["--dry-run", "--bogus"]), /Unknown option/);
  assert.throws(() => parseSyncArgs(["--dry-run", "--states", "active,bogus"]), /--states/);
  assert.throws(() => parseSyncArgs(["--dry-run", "--site"]), /needs a value/);
  assert.deepEqual(parseSyncArgs(["--dry-run", "--trust-host", "A.vercel.app", "--trust-host", "b.vercel.app"]).trustHosts, ["a.vercel.app", "b.vercel.app"]);
});

// ---- The report: what the operator needs to see -------------------------------------------------------------------------

test("classification tells clear, ambiguous and unmatched listings apart (and keeps guessCollection's answers)", () => {
  assert.deepEqual(classifyListing({ title: "Santa Claus Ornament", tags: [] }), { collection: "christmas", confidence: "clear", matches: ["christmas"] });
  assert.deepEqual(classifyListing({ title: "Halloween Bookmark", tags: [] }), { collection: "cute-bookmarks", confidence: "ambiguous", matches: ["cute-bookmarks", "halloween"] });
  assert.deepEqual(classifyListing({ title: "Easter Egg", tags: [] }), { collection: "other-seasonal", confidence: "none", matches: [] });
  assert.equal(classifyListing({ title: "Plain thing", tags: ["wine"] }).collection, "wine-hill-country", "tags count too");
});

test("every listing gets ID, SKU, title, state, suggested collection and digital/physical", () => {
  const analysis = analyse([
    listing({ listingId: 1, title: "Halloween Ghost Coaster SVG", skus: ["DO-HAL-0100"], listingType: "download" }),
    listing({ listingId: 2, title: "Fredericksburg Wine Coaster", state: "draft", skus: ["DO-WNE-0001"], listingType: "physical" }),
    listing({ listingId: 3, title: "Santa Ornament", state: "sold_out", skus: ["DO-XMS-0001", "DO-XMS-0002"], listingType: "physical" }),
  ]);

  assert.equal(analysis.totals.listings, 3);
  assert.deepEqual(analysis.totals.byState, { active: 1, draft: 1, sold_out: 1 });

  const [one, two, three] = analysis.rows;

  assert.deepEqual([one.listingId, one.sku, one.title, one.state, one.collection, one.collectionName, one.productType], [1, "DO-HAL-0100", "Halloween Ghost Coaster SVG", "active", "halloween", "Halloween", "digital_download"]);
  assert.deepEqual([two.sku, two.state, two.collectionName, two.productType], ["DO-WNE-0001", "draft", "Wine & Hill Country", "physical_product"]);
  assert.deepEqual([three.sku, three.etsySkus, three.collectionName], ["DO-XMS-0001", ["DO-XMS-0001", "DO-XMS-0002"], "Christmas"]);
  assert.deepEqual(analysis.rows.flatMap((row) => row.problems), [], "clean listings have no flags");
});

test("missing SKUs, badly formatted SKUs and duplicate SKUs (any capitalisation) are all reported", () => {
  const analysis = analyse([
    listing({ listingId: 1, title: "Halloween A", skus: ["DO-DUP-0001"] }),
    listing({ listingId: 2, title: "Halloween B", skus: ["do-dup-0001"] }),
    listing({ listingId: 3, title: "Halloween C", skus: [] }),
    listing({ listingId: 4, title: "Halloween D", skus: ["has space"] }),
    listing({ listingId: 5, title: "Halloween E", skus: ["DO-OK-0001"] }),
  ]);

  assert.deepEqual(codesFor(rowFor(analysis, 1)), ["duplicate-sku"]);
  assert.deepEqual(codesFor(rowFor(analysis, 2)), ["duplicate-sku", "invalid-sku"]);
  assert.match(rowFor(analysis, 1).problems[0].message, /also on Etsy listing 2/);
  assert.match(rowFor(analysis, 2).problems.find((problem) => problem.code === "duplicate-sku").message, /also on Etsy listing 1/);
  assert.deepEqual(codesFor(rowFor(analysis, 3)), ["missing-sku"]);
  assert.match(rowFor(analysis, 3).problems[0].message, /temporary SKU ETSY-3/);
  assert.deepEqual(codesFor(rowFor(analysis, 4)), ["invalid-sku"]);
  assert.deepEqual(codesFor(rowFor(analysis, 5)), []);
  assert.deepEqual([analysis.totals.missingSku, analysis.totals.invalidSku, analysis.totals.duplicateSku], [1, 2, 2]);
});

test("listings that cannot be confidently classified are flagged (no keyword, several collections, or 'both' types)", () => {
  const analysis = analyse([
    listing({ listingId: 1, title: "Easter Egg Ornament", skus: ["DO-A-0001"], listingType: "physical" }),
    listing({ listingId: 2, title: "Halloween Bookmark Set", skus: ["DO-B-0001"], listingType: "physical" }),
    listing({ listingId: 3, title: "Santa Ornament", skus: ["DO-C-0001"], listingType: "both" }),
    listing({ listingId: 4, title: "Santa Ornament 2", skus: ["DO-D-0001"], listingType: undefined }),
    listing({ listingId: 5, title: "Santa Ornament 3", skus: ["DO-E-0001"], listingType: "physical" }),
  ]);

  assert.deepEqual(codesFor(rowFor(analysis, 1)), ["collection-none"]);
  assert.match(rowFor(analysis, 1).problems[0].message, /only a default/);
  assert.deepEqual(codesFor(rowFor(analysis, 2)), ["collection-ambiguous"]);
  assert.match(rowFor(analysis, 2).problems[0].message, /Cute Bookmarks and Halloween/);
  assert.deepEqual(codesFor(rowFor(analysis, 3)), ["type-unknown"]);
  assert.equal(rowFor(analysis, 3).productType, "unknown");
  assert.match(rowFor(analysis, 3).problems[0].message, /"both"/);
  assert.deepEqual(codesFor(rowFor(analysis, 4)), ["type-unknown"]);
  assert.match(rowFor(analysis, 4).problems[0].message, /not provided/);
  assert.deepEqual(codesFor(rowFor(analysis, 5)), []);
  assert.deepEqual([analysis.totals.needsCollectionReview, analysis.totals.needsTypeReview], [2, 2]);
});

test("conflicts with the existing catalog come straight from the existing mapper, and unusable listings are listed as skipped", () => {
  const mapped = product({ sku: "DO-0001", etsy: { listingId: 999, url: "https://www.etsy.com/listing/999/x", state: "active", syncedAt: "2026-09-01T00:00:00Z" } });
  const analysis = analyse(
    [
      listing({ listingId: 111, title: "Halloween Thing", skus: ["DO-0001"] }),
      listing({ listingId: 222, title: "Halloween Odd State", state: "mystery", skus: ["DO-Z-0001"] }),
      { title: "no id at all", state: "active" },
      listing({ listingId: 111, title: "Halloween Thing again", skus: ["DO-0001"] }),
    ],
    [mapped]
  );

  assert.equal(analysis.rows.length, 2, "one row per real listing, duplicates collapsed, unusable ones left out");
  assert.deepEqual(codesFor(rowFor(analysis, 111)), ["catalog-conflict"]);
  assert.match(rowFor(analysis, 111).problems[0].message, /already mapped to Etsy listing 999/);
  assert.deepEqual(codesFor(rowFor(analysis, 222)), ["catalog-conflict"]);
  assert.match(rowFor(analysis, 222).problems[0].message, /unrecognised Etsy state/);
  assert.ok(analysis.problems.some((problem) => problem.code === "skipped" && problem.listingId === null));
  assert.ok(analysis.problems.some((problem) => problem.code === "skipped" && /duplicate listing/.test(problem.message)));
});

test("the printed report shows every requested field, the flags, and says nothing was written", () => {
  const analysis = analyse([
    listing({ listingId: 12345, title: "Halloween Ghost Coaster SVG", skus: ["DO-HAL-0100"], listingType: "download" }),
    listing({ listingId: 67890, title: `Wine Coaster ${String.fromCharCode(27)}[31mRED`, state: "draft", skus: [], listingType: "both" }),
  ]);
  const text = formatSyncReport({ analysis, meta: { source: "https://dragonoakstudio.com", credential: "environment variable ADRIAN_BRIDGE_SECRET (the value is never shown)", generatedAt: "2026-09-21T12:00:00Z", importerSummary: "New draft products to create : 2" } });

  ["Total Etsy listings found: 2", "12345", "67890", "DO-HAL-0100", "(none)", "Halloween Ghost Coaster SVG", "active", "draft", "Halloween", "Wine & Hill Country", "digital", "unknown", "NO-SKU", "CHECK-TYPE"].forEach((needle) =>
    assert.ok(text.includes(needle), needle)
  );
  ["Cannot be confidently classified", "SKU problems", "Conflicts with the existing catalog"].forEach((heading) => assert.ok(text.includes(heading), heading));
  assert.ok(!text.includes(String.fromCharCode(27)), "terminal escape characters in a title are neutralised");
  assert.match(text, /no file was written and no Etsy listing was changed/);
});

// ---- The command end to end, with no network ------------------------------------------------------------------------------

const makeRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "do-sync-"));

  fs.mkdirSync(path.join(root, "catalog", "products"), { recursive: true });
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  fs.writeFileSync(path.join(root, "assets", "a.webp"), "x");
  fs.writeFileSync(
    path.join(root, "catalog", "collections.json"),
    JSON.stringify({ schemaVersion: 1, collections: Object.entries(COLLECTION_NAMES).map(([slug, name], index) => ({ slug, name, tagline: "t", description: "d", order: index + 1 })) })
  );
  fs.writeFileSync(path.join(root, "catalog", "products", "DO-0001.json"), JSON.stringify(product()));

  return root;
};

const snapshot = (dir) => {
  const entries = [];
  const walk = (current) =>
    fs.readdirSync(current, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(current, entry.name);

      if (entry.isDirectory()) {
        entries.push(`${full}/`);
        walk(full);
      } else {
        const stat = fs.statSync(full);

        entries.push(`${full}:${stat.size}:${stat.mtimeMs}`);
      }
    });

  walk(dir);

  return entries.sort();
};

const fakeFetch = (respond) => {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, options });

    const page = respond(url, options, calls.length);

    return { ok: page.status === undefined || page.status < 400, status: page.status || 200, json: async () => page.body };
  };

  impl.calls = calls;

  return impl;
};

const byState = (states) => (url) => {
  const state = new URL(url).searchParams.get("state");
  const results = states[state] || [];

  return { body: { ok: true, connected: true, detail: "full", count: results.length, listings: results } };
};

test("runSync reads every Etsy state with GET only, sends the secret only as a Bearer header, and reports", async () => {
  const root = makeRoot();
  const fetchImpl = fakeFetch(
    byState({
      active: [listing({ listingId: 1, title: "Halloween Ghost Coaster", skus: ["DO-HAL-0100"] })],
      draft: [listing({ listingId: 2, title: "Wine Coaster", state: "draft", skus: [] })],
      expired: [listing({ listingId: 3, title: "Santa Ornament", state: "expired", skus: ["DO-XMS-0001"] })],
    })
  );
  const result = await runSync(parseSyncArgs(["--dry-run", "--root", root]), { fetchImpl, env: { ADRIAN_BRIDGE_SECRET: SECRET }, now: NOW });

  assert.equal(fetchImpl.calls.length, 5, "one request per Etsy state");
  assert.deepEqual(fetchImpl.calls.map((call) => new URL(call.url).searchParams.get("state")), ["active", "inactive", "draft", "sold_out", "expired"]);

  fetchImpl.calls.forEach((call) => {
    assert.equal(call.options.method, "GET");
    assert.equal(call.options.body, undefined);
    assert.equal(call.options.redirect, "manual", "the secret can never follow a redirect elsewhere");
    assert.equal(call.options.headers.Authorization, `Bearer ${SECRET}`);
    assert.ok(!call.url.includes(SECRET), "never in the URL");
    assert.match(call.url, /^https:\/\/dragonoakstudio\.com\/api\/etsy-listings\?detail=full&state=/);
  });

  assert.equal(result.wrote, false);
  assert.equal(result.analysis.totals.listings, 3);
  assert.ok(!result.text.includes(SECRET) && !result.json.includes(SECRET), "the secret is never in the output");
  assert.match(result.text, /environment variable ADRIAN_BRIDGE_SECRET \(the value is never shown\)/);

  const json = JSON.parse(result.json);

  assert.equal(json.dryRun, true);
  assert.equal(json.wroteFiles, false);
  assert.equal(json.listings.length, 3);
  assert.deepEqual(Object.keys(json.listings[0]).sort(), ["catalogAction", "classification", "collection", "collectionName", "etsySkus", "listingId", "listingType", "problems", "productType", "sku", "state", "title"]);
  assert.equal(json.importer.newDrafts, 3);
});

test("DRY RUN WRITES NOTHING: no file-writing call is made and the folders are unchanged, even if write flags are forced on", async () => {
  const root = makeRoot();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "do-home-"));
  const before = [...snapshot(root), ...snapshot(home)];
  const written = [];
  const names = ["writeFileSync", "appendFileSync", "mkdirSync", "mkdtempSync", "rmSync", "rmdirSync", "unlinkSync", "renameSync", "copyFileSync", "createWriteStream", "writeSync", "truncateSync", "symlinkSync", "linkSync", "chmodSync", "utimesSync"];
  const promiseNames = ["writeFile", "appendFile", "mkdir", "rm", "unlink", "rename", "copyFile", "truncate"];
  const originals = new Map();

  names.forEach((name) => {
    originals.set(fs, { ...(originals.get(fs) || {}), [name]: fs[name] });
    fs[name] = (...args) => {
      written.push(name);
      throw new Error(`dry run tried to call fs.${name}`);
    };
  });
  promiseNames.forEach((name) => {
    originals.set(fs.promises, { ...(originals.get(fs.promises) || {}), [name]: fs.promises[name] });
    fs.promises[name] = () => {
      written.push(`promises.${name}`);
      return Promise.reject(new Error(`dry run tried to call fs.promises.${name}`));
    };
  });

  const imageRequests = [];
  const fetchImpl = fakeFetch((url) => {
    if (!url.includes("/api/etsy-listings")) {
      imageRequests.push(url);
    }

    return byState({ active: [listing({ listingId: 7, title: "Brand New Halloween Thing", skus: [], images: [{ imageId: 1, url: "https://i.etsystatic.com/1/a.jpg", altText: "x", rank: 1 }] })] })(url);
  });
  let result;

  try {
    // Simulate a caller (or a future bug) that tries to switch the write options on: runSync must ignore them.
    const forced = { ...parseSyncArgs(["--dry-run", "--root", root]), write: true, downloadImages: true };

    result = await runSync(forced, { fetchImpl, env: { ADRIAN_BRIDGE_SECRET: SECRET }, now: NOW, homedir: home });
  } finally {
    originals.forEach((saved, target) => Object.assign(target, saved));
  }

  assert.deepEqual(written, [], "no write-type file call was attempted");
  assert.deepEqual([...snapshot(root), ...snapshot(home)], before, "the catalog and assets are byte-for-byte unchanged, nothing was created");
  assert.deepEqual(imageRequests, [], "no photos were downloaded");
  assert.equal(result.analysis.totals.listings, 1);
  assert.ok(!fs.existsSync(path.join(root, "catalog", "import")));
});

test("only GET requests can ever be made, and the sync sources contain no file-writing or write-to-Etsy code", () => {
  ["tools/etsy-sync.js", "tools/bridge-secret.js"].forEach((file) => {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");

    assert.ok(!/\b(writeFile|writeFileSync|appendFile|appendFileSync|mkdirSync|mkdir|unlinkSync|rmSync|renameSync|copyFileSync|createWriteStream)\b/.test(source.replace(/^\s*\/\/.*$/gm, "")), `${file} has no file-writing calls`);
    assert.ok(!/method:\s*["'](POST|PUT|PATCH|DELETE)["']/i.test(source), `${file} makes no write requests`);
    assert.ok(!/\bfetch\s*\(/.test(source.replace(/^\s*\/\/.*$/gm, "").replace(/fetchImpl = fetch/g, "")), `${file} does not call the network directly`);
  });
});

test("the secret is never sent to an untrusted --site, and the request is not even attempted", async () => {
  const fetchImpl = fakeFetch(byState({}));

  await assert.rejects(
    () => runSync(parseSyncArgs(["--dry-run", "--site", "https://evil.example"]), { fetchImpl, env: { ADRIAN_BRIDGE_SECRET: SECRET }, now: NOW }),
    (error) => /Refusing to send the bridge secret to evil\.example/.test(error.message) && !error.message.includes(SECRET)
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test("a preview address works once it is named with --trust-host, and only that exact host", async () => {
  const host = "dragon-oak-studio-git-storefront-v1-team.vercel.app";
  const fetchImpl = fakeFetch(byState({ active: [listing({ skus: ["DO-A-0001"] })] }));
  const result = await runSync(parseSyncArgs(["--dry-run", "--root", makeRoot(), "--states", "active", "--site", `https://${host}`, "--trust-host", host]), { fetchImpl, env: { ADRIAN_BRIDGE_SECRET: SECRET }, now: NOW });

  assert.equal(fetchImpl.calls.length, 1);
  assert.ok(fetchImpl.calls[0].url.startsWith(`https://${host}/api/etsy-listings`));
  assert.equal(result.analysis.totals.listings, 1);

  await assert.rejects(() => runSync(parseSyncArgs(["--dry-run", "--site", "https://another.vercel.app", "--trust-host", host]), { fetchImpl, env: { ADRIAN_BRIDGE_SECRET: SECRET }, now: NOW }), /Refusing/);
});

test("the existing importer command gets the same protections (trusted hosts only, secret resolved privately)", async () => {
  const fetchImpl = fakeFetch(byState({}));

  await assert.rejects(
    () => runImport({ ...parseArgs([]), site: "https://evil.example", root: makeRoot() }, { fetchImpl, env: { ADRIAN_BRIDGE_SECRET: SECRET }, now: NOW }),
    /Refusing to send the bridge secret/
  );
  assert.equal(fetchImpl.calls.length, 0);
  assert.deepEqual(parseArgs(["--trust-host", "P.vercel.app"]).trustHosts, ["p.vercel.app"]);

  const file = secretFile(SECRET);
  const ok = fakeFetch(byState({ active: [listing({ skus: ["DO-A-0001"] })] }));
  const result = await runImport({ ...parseArgs(["--states", "active"]), root: makeRoot() }, { fetchImpl: ok, env: { ADRIAN_BRIDGE_SECRET_FILE: file }, now: NOW });

  assert.equal(result.wrote, false);
  assert.equal(ok.calls[0].options.headers.Authorization, `Bearer ${SECRET}`);
});

test("with no secret configured it stops with instructions, without contacting anything", async () => {
  const fetchImpl = fakeFetch(byState({}));

  await assert.rejects(() => runSync(parseSyncArgs(["--dry-run"]), { fetchImpl, env: {}, now: NOW, homedir: fs.mkdtempSync(path.join(os.tmpdir(), "do-home-")) }), /No bridge secret is available/);
  assert.equal(fetchImpl.calls.length, 0);
});

test("if a server ever echoes the secret back, it is redacted from the error", async () => {
  const fetchImpl = fakeFetch(() => ({ status: 500, body: { ok: false, message: `Upstream said: Authorization Bearer ${SECRET}` } }));

  await assert.rejects(
    () => runSync(parseSyncArgs(["--dry-run", "--root", makeRoot()]), { fetchImpl, env: { ADRIAN_BRIDGE_SECRET: SECRET }, now: NOW }),
    (error) => /HTTP 500/.test(error.message) && /\[redacted\]/.test(error.message) && !error.message.includes(SECRET)
  );
});

test("a bridge that only returns basic listing data is rejected instead of producing a misleading 'no SKUs' report", async () => {
  const fetchImpl = fakeFetch(() => ({ body: { ok: true, connected: true, count: 1, listings: [{ listingId: 1, title: "Old bridge", state: "active", quantity: 1, price: null, url: null }] } }));

  await assert.rejects(() => runSync(parseSyncArgs(["--dry-run", "--root", makeRoot(), "--states", "active"]), { fetchImpl, env: { ADRIAN_BRIDGE_SECRET: SECRET }, now: NOW }), /not running the storefront-v1 version/);
});

test("--file works offline with no secret and no network", async () => {
  const root = makeRoot();
  const file = path.join(root, "saved.json");

  fs.writeFileSync(file, JSON.stringify({ listings: [listing({ listingId: 5, title: "Christmas Star", skus: ["DO-XMS-0005"] })] }));

  const fetchImpl = fakeFetch(() => assert.fail("no request expected"));
  const result = await runSync(parseSyncArgs(["--dry-run", "--root", root, "--file", file]), { fetchImpl, env: {}, now: NOW });

  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(result.analysis.rows[0].collectionName, "Christmas");
  assert.match(result.text, /not needed \(reading a saved file\)/);
});

test("main prints the report (or JSON) and reports failures with a non-zero exit code", async () => {
  const root = makeRoot();
  const file = path.join(root, "saved.json");

  fs.writeFileSync(file, JSON.stringify({ listings: [listing({ listingId: 5, title: "Christmas Star", skus: ["DO-XMS-0005"] })] }));

  const logs = [];
  const errors = [];
  const original = { log: console.log, error: console.error, exitCode: process.exitCode };

  console.log = (line) => logs.push(line);
  console.error = (line) => errors.push(line);

  try {
    await main(["--dry-run", "--json", "--root", root, "--file", file]);
    assert.equal(JSON.parse(logs[0]).listings[0].listingId, 5);
    assert.equal(process.exitCode, original.exitCode);

    await main(["--dry-run", "--root", root, "--file", file]);
    assert.match(logs[1], /Total Etsy listings found: 1/);

    await main(["--write"]);
    assert.match(errors[0], /^Sync stopped:/);
    assert.equal(process.exitCode, 1);
  } finally {
    console.log = original.log;
    console.error = original.error;
    process.exitCode = original.exitCode;
  }
});

// ---- Through the REAL protected bridge handler (real Bearer check), over a local HTTP connection ----------------------------

const LIB_PATH = require.resolve("../api/_lib/etsy-oauth");
const HANDLER_PATH = require.resolve("../api/etsy-listings");

const rawEtsy = (overrides) => ({
  listing_id: 1,
  title: "Halloween Ghost Coaster",
  state: "active",
  quantity: 3,
  price: { amount: 499, divisor: 100, currency_code: "USD" },
  url: "https://www.etsy.com/listing/1/x",
  created_timestamp: 1788000000,
  updated_timestamp: 1788000100,
  description: "Long description",
  tags: ["halloween"],
  skus: ["DO-HAL-0100"],
  listing_type: "download",
  taxonomy_id: 68887,
  images: [],
  ...overrides,
});

const RAW_BY_STATE = {
  active: [rawEtsy({ listing_id: 1 }), rawEtsy({ listing_id: 2, title: "Cute Panda Bookmark", skus: ["DO-BKM-0001"], listing_type: "physical", tags: [] })],
  draft: [rawEtsy({ listing_id: 3, title: "Fredericksburg Wine Coaster", state: "draft", skus: [], listing_type: "physical", tags: [] })],
  sold_out: [rawEtsy({ listing_id: 4, title: "Easter Egg", state: "sold_out", skus: ["DO-HAL-0100"], listing_type: "both", tags: [] })],
};

const startServer = (handler) =>
  new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((request, response) => {
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
      handler(request, response);
    });

    server.listen(0, "127.0.0.1", () => resolve({ server, requests, site: `http://127.0.0.1:${server.address().port}` }));
  });

const stopServer = ({ server }) => new Promise((resolve) => server.close(resolve));

test("end to end against the real bridge handler: authenticates from a private secret file, GETs the catalog and reports", async (t) => {
  const etsyCalls = [];

  require.cache[LIB_PATH] = {
    id: LIB_PATH,
    filename: LIB_PATH,
    loaded: true,
    exports: {
      getRequiredConfig: () => ({ ok: true, apiKey: "k", sharedSecret: "s", databaseUrl: "postgres://x" }),
      getPgClient: async () => ({ end: async () => {} }),
      getStoredToken: async () => ({ accessToken: "token-123", shopId: 64473522 }),
      fetchEtsyApi: async (...args) => {
        etsyCalls.push(args);

        const results = RAW_BY_STATE[new URL(`https://x${args[0]}`).searchParams.get("state")] || [];

        return { ok: true, status: 200, json: async () => ({ count: results.length, results }) };
      },
    },
  };
  delete require.cache[HANDLER_PATH];

  const handler = require(HANDLER_PATH);
  const bridge = await startServer(handler);

  t.after(async () => {
    delete require.cache[LIB_PATH];
    delete require.cache[HANDLER_PATH];
    await stopServer(bridge);
  });

  const options = parseSyncArgs(["--dry-run", "--root", makeRoot(), "--site", bridge.site]);
  const env = { ADRIAN_BRIDGE_SECRET_FILE: secretFile(TEST_SECRET) };
  const result = await runSync(options, { env, now: NOW });

  // The server (which really checked the Bearer secret) saw only authenticated GET requests.
  assert.equal(bridge.requests.length, 5);
  bridge.requests.forEach((request) => {
    assert.equal(request.method, "GET");
    assert.equal(request.authorization, `Bearer ${TEST_SECRET}`);
    assert.match(request.url, /^\/api\/etsy-listings\?detail=full&state=/);
  });

  // Every call the handler made to Etsy was a plain read (no fetch options such as a method or a body).
  etsyCalls.forEach((call) => {
    assert.equal(call.length, 2);
    assert.match(call[0], /^\/shops\/64473522\/listings\?state=/);
  });

  assert.equal(result.analysis.totals.listings, 4);

  const rows = Object.fromEntries(result.analysis.rows.map((row) => [row.listingId, row]));

  assert.equal(rows[1].sku, "DO-HAL-0100");
  assert.equal(rows[1].collectionName, "Halloween");
  assert.equal(rows[1].productType, "digital_download");
  assert.equal(rows[2].collectionName, "Cute Bookmarks");
  assert.deepEqual(codesFor(rows[3]), ["missing-sku"]);
  assert.deepEqual(codesFor(rows[4]), ["collection-none", "duplicate-sku", "type-unknown"]);
  assert.deepEqual(codesFor(rows[1]), ["duplicate-sku"]);
  assert.match(result.text, /secret file from ADRIAN_BRIDGE_SECRET_FILE \(the value is never shown\)/);
  assert.ok(!result.text.includes(TEST_SECRET) && !result.json.includes(TEST_SECRET));
});

test("end to end: a wrong secret is rejected by the real bridge and never appears in the output", async (t) => {
  delete require.cache[HANDLER_PATH];
  delete require.cache[LIB_PATH];
  require.cache[LIB_PATH] = { id: LIB_PATH, filename: LIB_PATH, loaded: true, exports: { getRequiredConfig: () => assert.fail("must not be reached without valid credentials") } };

  const handler = require(HANDLER_PATH);
  const bridge = await startServer(handler);

  t.after(async () => {
    delete require.cache[LIB_PATH];
    delete require.cache[HANDLER_PATH];
    await stopServer(bridge);
  });

  const wrong = "Qq9-a-different-secret-that-is-long-enough-1234567890";

  await assert.rejects(
    () => runSync(parseSyncArgs(["--dry-run", "--root", makeRoot(), "--states", "active", "--site", bridge.site]), { env: { ADRIAN_BRIDGE_SECRET_FILE: secretFile(wrong) }, now: NOW }),
    (error) => /HTTP 403/.test(error.message) && !error.message.includes(wrong) && !error.message.includes(TEST_SECRET)
  );
});

test("end to end: a redirect is never followed, so the secret cannot be forwarded to another address", async (t) => {
  const elsewhere = await startServer((request, response) => {
    response.statusCode = 200;
    response.end("{}");
  });
  const redirecting = await startServer((request, response) => {
    response.statusCode = 302;
    response.setHeader("Location", `${elsewhere.site}/api/etsy-listings`);
    response.end();
  });

  t.after(async () => {
    await stopServer(elsewhere);
    await stopServer(redirecting);
  });

  await assert.rejects(
    () => runSync(parseSyncArgs(["--dry-run", "--root", makeRoot(), "--states", "active", "--site", redirecting.site]), { env: { ADRIAN_BRIDGE_SECRET_FILE: secretFile(SECRET) }, now: NOW }),
    (error) => /redirected the request \(HTTP 302\)/.test(error.message) && !error.message.includes(SECRET)
  );
  assert.equal(redirecting.requests.length, 1);
  assert.equal(elsewhere.requests.length, 0, "nothing was sent to the redirect target");
});

test("package.json exposes the operator command and adds no dependency", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

  assert.equal(manifest.scripts["etsy:sync"], "node tools/etsy-sync.js");
  assert.equal(manifest.scripts["etsy:import"], "node tools/import-etsy.js");
  assert.deepEqual(Object.keys(manifest.dependencies), ["pg"]);
});
