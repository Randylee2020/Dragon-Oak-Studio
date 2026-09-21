#!/usr/bin/env node
// READ-ONLY Etsy -> ADRIAN catalog import.
//
//   Dry run (default; writes nothing):
//     ADRIAN_BRIDGE_SECRET=... node tools/import-etsy.js --site https://dragonoakstudio.com
//   Write draft products into catalog/products/ (still nothing is sent to Etsy):
//     ... --write
//   Also download each new listing's photos from Etsy's public image CDN into assets/products/<SKU>/:
//     ... --write --download-images
//   Offline, from a saved GET /api/etsy-listings?detail=full response:
//     node tools/import-etsy.js --file saved-listings.json
//
// This tool can only READ: every network request it makes is an HTTP GET (to your own bridge endpoint, and to Etsy's
// public image CDN when --download-images is used). It never creates, edits, deactivates or deletes an Etsy listing.
// The bridge secret is found by tools/bridge-secret.js (the ADRIAN_BRIDGE_SECRET environment variable, or a private secret
// file), sent only as a Bearer header to a trusted host, and is never printed or written to disk by this tool.
// For the one-command report ADRIAN runs, see tools/etsy-sync.js.
const fs = require("fs");
const path = require("path");
const { loadCatalog } = require("../api/_lib/catalog");
const { mapEtsyListings } = require("../api/_lib/etsy-import");
const { assertSiteMaySeeSecret, parseTrustedHost, resolveBridgeSecret } = require("./bridge-secret");

const PAGE_LIMIT = 100;
const MAX_PAGES = 50;
const MAX_IMAGES_PER_LISTING = 5;
const MAX_IMAGE_ATTEMPTS = 20;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_HOSTS = new Set(["i.etsystatic.com"]);
const IMAGE_EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const IMPORT_STATES = ["active", "inactive", "draft", "sold_out", "expired"];

const parseArgs = (argv) => {
  const options = { site: "https://dragonoakstudio.com", states: ["active"], write: false, downloadImages: false, file: null, root: null, trustHosts: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--site") {
      options.site = argv[(index += 1)];
    } else if (arg === "--states") {
      options.states = String(argv[(index += 1)] || "").split(",").map((state) => state.trim()).filter(Boolean);
    } else if (arg === "--file") {
      options.file = argv[(index += 1)];
    } else if (arg === "--root") {
      options.root = argv[(index += 1)];
    } else if (arg === "--trust-host") {
      options.trustHosts.push(parseTrustedHost(argv[(index += 1)]));
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--download-images") {
      options.downloadImages = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.states.length || options.states.some((state) => !IMPORT_STATES.includes(state))) {
    throw new Error(`--states must be a comma list of: ${IMPORT_STATES.join(", ")}`);
  }

  if (options.downloadImages && !options.write) {
    throw new Error("--download-images only works together with --write.");
  }

  return options;
};

const normalizeSiteUrl = (site) => {
  let url;

  try {
    url = new URL(site);
  } catch {
    throw new Error("--site must be a full web address, for example https://dragonoakstudio.com");
  }

  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";

  if (url.username || url.password || (url.protocol !== "https:" && !(isLocal && url.protocol === "http:"))) {
    throw new Error("--site must use https (http is only allowed for localhost) and must not contain a username or password.");
  }

  return `${url.protocol}//${url.host}`;
};

// GET every page of listings for each requested state. `fetchImpl` is injectable so tests never touch the network.
const fetchAllListings = async ({ site, secret, states, fetchImpl = fetch, trustHosts = [] }) => {
  if (!secret) {
    throw new Error("Set the ADRIAN_BRIDGE_SECRET environment variable first (it is never printed or saved).");
  }

  const base = normalizeSiteUrl(site);

  // This function is the ONLY place the secret leaves this program, so this is where the trusted-host rule is enforced
  // (callers check earlier too, but nothing depends on that).
  assertSiteMaySeeSecret(base, trustHosts);
  const listings = [];

  for (const state of states) {
    let offset = 0;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = `${base}/api/etsy-listings?detail=full&state=${encodeURIComponent(state)}&limit=${PAGE_LIMIT}&offset=${offset}`;
      // redirect: "manual" so the secret can never follow a redirect to another address.
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
        redirect: "manual",
      });
      let body = null;

      try {
        body = await response.json();
      } catch {
        // handled below
      }

      if (response.status >= 300 && response.status < 400) {
        throw new Error(`The site redirected the request (HTTP ${response.status}) and it was not followed, so the secret stays with the address you gave. Use the exact final address for --site (for example with or without www).`);
      }

      if (!response.ok || !body || body.ok !== true) {
        throw new Error(`The bridge answered HTTP ${response.status} for state "${state}"${body && body.message ? `: ${body.message}` : ""}`);
      }

      if (body.connected === false) {
        throw new Error("The site says Etsy is not connected. Reconnect Etsy first.");
      }

      const results = Array.isArray(body.listings) ? body.listings : [];
      listings.push(...results);
      offset += PAGE_LIMIT;

      if (results.length < PAGE_LIMIT || offset >= Number(body.count || 0)) {
        break;
      }
    }
  }

  return listings;
};

// The detailed fields (SKU, product type, tags) only exist on a bridge that has the ?detail=full change. Without them every
// listing would look as if it had no SKU, which would be a misleading report, so stop instead.
const assertDetailedListings = (listings) => {
  if (listings.length > 0 && listings.every((listing) => !("skus" in listing) && !("listingType" in listing))) {
    throw new Error(
      "The site answered with basic listing data (no SKUs or product types). It is not running the storefront-v1 version of /api/etsy-listings yet. Point --site at the storefront-v1 preview (with --trust-host <its host name>) or wait until that version is deployed."
    );
  }
};

// Downloads a new listing's photos from Etsy's public image CDN (GET only) into assets/products/<SKU>/.
const downloadImages = async ({ root, sku, title, etsyImages, fetchImpl = fetch }) => {
  const saved = [];
  // Cap the number of ATTEMPTS as well as the number saved, so a listing full of unusable entries cannot cause a flood of
  // requests, while blocked or failed entries do not use up the quota of photos that are actually kept.
  const candidates = (Array.isArray(etsyImages) ? etsyImages : []).filter((image) => image && image.url).slice(0, MAX_IMAGE_ATTEMPTS);

  for (const image of candidates) {
    if (saved.length >= MAX_IMAGES_PER_LISTING) {
      break;
    }

    let url;

    try {
      url = new URL(image.url);
    } catch {
      continue;
    }

    if (url.protocol !== "https:" || !IMAGE_HOSTS.has(url.hostname)) {
      continue;
    }

    const response = await fetchImpl(url.toString(), { method: "GET" });
    const extension = IMAGE_EXTENSIONS[String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase()];

    if (!response.ok || !extension) {
      continue;
    }

    const bytes = Buffer.from(await response.arrayBuffer());

    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
      continue;
    }

    const relativePath = `assets/products/${sku}/${saved.length + 1}.${extension}`;
    const fullPath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, bytes);
    saved.push({ path: relativePath, alt: String(image.altText || title).slice(0, 200) });
  }

  return saved;
};

const writeProduct = (root, product) => {
  const file = path.join(root, "catalog", "products", `${product.sku}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(product, null, 2)}\n`);
};

const summarize = (report) => {
  const lines = [
    `New draft products to create : ${report.creates.length}`,
    `Existing products to update  : ${report.updates.length} (Etsy link/state only)`,
    `Already up to date           : ${report.unchanged.length}`,
    `Conflicts (need a decision)  : ${report.conflicts.length}`,
    `Skipped                      : ${report.skipped.length}`,
    `In catalog, not seen in Etsy : ${report.notSeen.length}`,
  ];

  report.creates.forEach((entry) => lines.push(`  + ${entry.sku} (Etsy ${entry.listingId}) -> ${entry.product.collection}, ${entry.product.productType}, draft`));
  report.updates.forEach((entry) => lines.push(`  ~ ${entry.sku} (Etsy ${entry.listingId}, matched by ${entry.matchedBy}): ${entry.etsyBefore.state} -> ${entry.etsyAfter.state}`));
  report.conflicts.forEach((entry) => lines.push(`  ! Etsy ${entry.listingId}: ${entry.reason}`));

  [...report.updates, ...report.unchanged].forEach((entry) =>
    entry.drift.forEach((drift) => lines.push(`  ? ${entry.sku}: ${drift.field} differs between the catalog and Etsy (catalog is kept)`))
  );

  return lines.join("\n");
};

// deps.secret lets a caller that already resolved the secret (tools/etsy-sync.js) hand it over; otherwise it is resolved here.
const runImport = async (options, { fetchImpl = fetch, env = process.env, now = new Date(), secret, homedir } = {}) => {
  const root = path.resolve(options.root || path.join(__dirname, ".."));
  const loaded = loadCatalog(root);

  if (loaded.errors.length) {
    throw new Error(`The catalog has errors; fix them first:\n  ${loaded.errors.join("\n  ")}`);
  }

  let listings;

  if (options.file) {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(options.file), "utf8"));
    listings = Array.isArray(parsed) ? parsed : parsed.listings;
  } else {
    assertSiteMaySeeSecret(options.site, options.trustHosts || []);

    const bridgeSecret = secret !== undefined ? secret : resolveBridgeSecret({ env, ...(homedir ? { homedir } : {}) }).secret;

    listings = await fetchAllListings({ site: options.site, secret: bridgeSecret, states: options.states, fetchImpl, trustHosts: options.trustHosts || [] });
    assertDetailedListings(listings);
  }

  const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const report = mapEtsyListings({ listings, products: loaded.products, now: timestamp });

  if (options.write) {
    for (const entry of report.creates) {
      if (options.downloadImages) {
        entry.product.images = await downloadImages({
          root,
          sku: entry.sku,
          title: entry.product.title,
          etsyImages: entry.etsyImages,
          fetchImpl,
        });
      }

      writeProduct(root, entry.product);
    }

    report.updates.forEach((entry) => writeProduct(root, entry.product));

    const reportDir = path.join(root, "catalog", "import");
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(
      path.join(reportDir, `etsy-import-${timestamp.replace(/[-:]/g, "")}.json`),
      `${JSON.stringify({ importedAt: timestamp, source: options.file ? "file" : "bridge", ...report, creates: report.creates.map(({ product, etsyImages, ...rest }) => ({ ...rest, productSku: product.sku })), updates: report.updates.map(({ product, ...rest }) => rest) }, null, 2)}\n`
    );
  }

  return { report, summary: summarize(report), wrote: options.write, listings };
};

const main = async () => {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await runImport(options);

    console.log(result.summary);
    console.log(
      result.wrote
        ? "\nFiles written under catalog/products/. New products are drafts and are NOT shown on the site. Next: review them, then run: npm run catalog:build && npm test"
        : "\nDry run only: nothing was written. Add --write to create the draft product files."
    );
  } catch (error) {
    console.error(`Import stopped: ${error.message}`);
    process.exit(1);
  }
};

if (require.main === module) {
  main();
}

module.exports = { assertDetailedListings, downloadImages, fetchAllListings, normalizeSiteUrl, parseArgs, runImport, summarize };
