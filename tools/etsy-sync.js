#!/usr/bin/env node
// ADRIAN one-command Etsy catalog sync -- DRY RUN ONLY (read-only, writes nothing).
//
//   npm run etsy:sync -- --dry-run
//   node tools/etsy-sync.js --dry-run
//
// What it does, in order:
//   1. Finds the bridge secret in ADRIAN's own private setup (tools/bridge-secret.js). Nobody copies or pastes it.
//   2. Asks the existing protected bridge for the full Etsy listing catalog with GET requests only
//      (GET /api/etsy-listings?detail=full for every listing state). Nothing is ever sent to Etsy except reads.
//   3. Runs the EXISTING importer and mapper (tools/import-etsy.js -> api/_lib/etsy-import.js) with writing switched off.
//   4. Prints, for every listing: ID, SKU, title, Etsy state, suggested Dragon Oak collection, digital/physical, and any
//      missing/duplicate SKU or classification problem. Add --json for the same report as JSON, for ADRIAN to read.
//
// This command cannot write files and cannot change Etsy: it has no write option (--write, --download-images and anything
// like --publish are refused), and the tests fail if any file is written or any request other than GET is made.
// To create draft catalog files from Etsy listings later, use the separate, existing importer: tools/import-etsy.js.
const os = require("os");
const path = require("path");
const { loadCatalog } = require("../api/_lib/catalog");
const { SKU_PATTERN, classifyListing, toProductType } = require("../api/_lib/etsy-import");
const { assertSiteMaySeeSecret, parseTrustedHost, redact, resolveBridgeSecret } = require("./bridge-secret");
const { runImport } = require("./import-etsy");

const DEFAULT_SITE = "https://dragonoakstudio.com";
const ALL_STATES = ["active", "inactive", "draft", "sold_out", "expired"];
const TYPE_LABELS = { digital_download: "digital", physical_product: "physical", unknown: "unknown" };
const FLAG_FOR = {
  "missing-sku": "NO-SKU",
  "invalid-sku": "BAD-SKU",
  "duplicate-sku": "DUP-SKU",
  "collection-none": "CHECK-COLL",
  "collection-ambiguous": "CHECK-COLL",
  "type-unknown": "CHECK-TYPE",
  "catalog-conflict": "CONFLICT",
};

const USAGE = "Usage: npm run etsy:sync -- --dry-run [--json] [--site https://dragonoakstudio.com] [--trust-host <host>] [--states active,draft] [--file saved.json]";

const parseSyncArgs = (argv) => {
  const options = { dryRun: false, json: false, site: DEFAULT_SITE, states: ALL_STATES.slice(), file: null, root: null, trustHosts: [] };
  const valueOf = (index, flag) => {
    const value = argv[index];

    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} needs a value. ${USAGE}`);
    }

    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--site") {
      options.site = valueOf((index += 1), arg);
    } else if (arg === "--states") {
      options.states = valueOf((index += 1), arg).split(",").map((state) => state.trim()).filter(Boolean);
    } else if (arg === "--file") {
      options.file = valueOf((index += 1), arg);
    } else if (arg === "--root") {
      options.root = valueOf((index += 1), arg);
    } else if (arg === "--trust-host") {
      options.trustHosts.push(parseTrustedHost(valueOf((index += 1), arg)));
    } else if (arg === "--secret" || arg.startsWith("--secret=")) {
      throw new Error("The secret can never be given on the command line. ADRIAN supplies it through its private setup (see tools/bridge-secret.js).");
    } else if (arg === "--write" || arg === "--download-images" || arg === "--publish" || arg === "--activate") {
      throw new Error(`${arg} is not available here. This command is read-only and never writes files or changes Etsy.`);
    } else {
      throw new Error(`Unknown option: ${arg}. ${USAGE}`);
    }
  }

  if (!options.dryRun) {
    throw new Error(`Add --dry-run. This version of etsy sync only reports; it never writes files or changes Etsy. ${USAGE}`);
  }

  if (!options.states.length || options.states.some((state) => !ALL_STATES.includes(state))) {
    throw new Error(`--states must be a comma list of: ${ALL_STATES.join(", ")}`);
  }

  return options;
};

const isValidListing = (listing) => listing && Number.isInteger(listing.listingId) && listing.listingId > 0 && typeof listing.state === "string";

// Pure: turns the raw listings plus the importer's own report into one row per listing and a flat list of problems.
const buildSyncReport = ({ listings, report, collectionNames = {} }) => {
  const nameOf = (slug) => collectionNames[slug] || slug;
  const outcomes = new Map();
  const setOutcome = (listingId, outcome) => {
    if (!outcomes.has(listingId)) {
      outcomes.set(listingId, outcome);
    }
  };

  report.creates.forEach((entry) => setOutcome(entry.listingId, { kind: "new-draft", sku: entry.sku, message: `Would create draft product ${entry.sku}` }));
  report.updates.forEach((entry) => setOutcome(entry.listingId, { kind: "update", sku: entry.sku, message: `Matches catalog product ${entry.sku} (by ${entry.matchedBy}); its Etsy link would be updated` }));
  report.unchanged.forEach((entry) => setOutcome(entry.listingId, { kind: "unchanged", sku: entry.sku, message: `Matches catalog product ${entry.sku}; already up to date` }));
  report.conflicts.forEach((entry) => setOutcome(entry.listingId, { kind: "conflict", sku: null, message: entry.reason }));

  const seen = new Set();
  const rows = [];

  (Array.isArray(listings) ? listings : []).forEach((listing) => {
    if (!isValidListing(listing) || seen.has(listing.listingId)) {
      return;
    }

    seen.add(listing.listingId);

    const etsySkus = (Array.isArray(listing.skus) ? listing.skus : []).map((sku) => String(sku).trim()).filter(Boolean);
    const classification = classifyListing(listing);
    const type = toProductType(listing);

    rows.push({
      listingId: listing.listingId,
      title: String(listing.title || "").trim(),
      state: listing.state,
      etsySkus,
      sku: etsySkus[0] || null,
      collection: classification.collection,
      collectionName: nameOf(classification.collection),
      classification: { confidence: classification.confidence, matches: classification.matches },
      productType: type.known ? type.productType : "unknown",
      listingType: listing.listingType || null,
      outcome: outcomes.get(listing.listingId) || null,
      problems: [],
    });
  });

  // Which listings share a SKU (compared ignoring capital letters, because Etsy does not enforce one style).
  const owners = new Map();

  rows.forEach((row) => {
    new Set(row.etsySkus.map((sku) => sku.toUpperCase())).forEach((key) => {
      if (!owners.has(key)) {
        owners.set(key, []);
      }

      owners.get(key).push(row.listingId);
    });
  });

  rows.forEach((row) => {
    const add = (code, message) => row.problems.push({ code, message });

    if (row.etsySkus.length === 0) {
      const temporary = row.outcome && row.outcome.kind === "new-draft" && String(row.outcome.sku).startsWith("ETSY-") ? ` The importer would give it the temporary SKU ${row.outcome.sku}.` : "";
      add("missing-sku", `No SKU on this Etsy listing.${temporary}`);
    }

    row.etsySkus
      .filter((sku) => !SKU_PATTERN.test(sku))
      .forEach((sku) => add("invalid-sku", `SKU "${sku}" is not a valid ADRIAN SKU (capital letters, numbers and dashes, 3 to 40 characters).`));

    Array.from(new Set(row.etsySkus.map((sku) => sku.toUpperCase()))).forEach((key) => {
      const others = (owners.get(key) || []).filter((id) => id !== row.listingId);

      if (others.length) {
        add("duplicate-sku", `SKU ${key} is also on Etsy listing ${others.join(", ")}.`);
      }
    });

    if (row.classification.confidence === "none") {
      add("collection-none", `No collection keyword matched the title or tags. "${row.collectionName}" is only a default.`);
    } else if (row.classification.confidence === "ambiguous") {
      add("collection-ambiguous", `Matches ${row.classification.matches.map(nameOf).join(" and ")}. Suggested ${row.collectionName} (first in priority order); a person should decide.`);
    }

    if (row.productType === "unknown") {
      add("type-unknown", `Etsy listing type is ${row.listingType ? `"${row.listingType}"` : "not provided"}, so digital versus physical cannot be told.`);
    }

    if (row.outcome && row.outcome.kind === "conflict") {
      add("catalog-conflict", row.outcome.message);
    }
  });

  const problems = [];

  rows.forEach((row) => row.problems.forEach((problem) => problems.push({ listingId: row.listingId, title: row.title, ...problem })));
  report.skipped.forEach((entry) => problems.push({ listingId: entry.listingId === undefined ? null : entry.listingId, title: "", code: "skipped", message: `Skipped: ${entry.reason}.` }));

  const tally = (key) => rows.reduce((counts, row) => ({ ...counts, [row[key]]: (counts[row[key]] || 0) + 1 }), {});
  const codes = (code) => new Set(problems.filter((problem) => problem.code === code).map((problem) => problem.listingId)).size;

  return {
    rows,
    problems,
    collectionNames,
    totals: {
      listings: rows.length,
      byState: tally("state"),
      byCollection: tally("collection"),
      byType: tally("productType"),
      missingSku: codes("missing-sku"),
      invalidSku: codes("invalid-sku"),
      duplicateSku: codes("duplicate-sku"),
      needsCollectionReview: codes("collection-none") + codes("collection-ambiguous"),
      needsTypeReview: codes("type-unknown"),
      conflicts: codes("catalog-conflict"),
      skipped: report.skipped.length,
    },
  };
};

// Text meant for a person. Control characters (for example terminal escape codes in a title) are replaced with spaces.
const printable = (value) => String(value === null || value === undefined ? "" : value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
const fit = (value, width) => {
  const text = printable(value);

  return (text.length > width ? `${text.slice(0, width - 3)}...` : text).padEnd(width);
};
const countsText = (counts) => Object.entries(counts).map(([name, count]) => `${name} ${count}`).join(", ") || "none";

const formatSyncReport = ({ analysis, meta }) => {
  const { rows, problems, totals } = analysis;
  const lines = [
    "ADRIAN Etsy catalog sync - DRY RUN (read-only)",
    `Source      : ${meta.source}`,
    `Credential  : ${meta.credential}`,
    `Checked     : ${meta.generatedAt}`,
    "",
    `Total Etsy listings found: ${totals.listings}   (${countsText(totals.byState)})`,
    "",
  ];

  if (rows.length) {
    const idWidth = Math.max(2, ...rows.map((row) => String(row.listingId).length));

    lines.push(`${fit("ID", idWidth)}  ${fit("STATE", 9)}  ${fit("SKU", 18)}  ${fit("COLLECTION", 19)}  ${fit("TYPE", 8)}  ${fit("FLAGS", 30)}  TITLE`);

    rows.forEach((row) => {
      const flags = Array.from(new Set(row.problems.map((problem) => FLAG_FOR[problem.code]))).join(" ") || "-";
      const sku = row.sku ? `${row.sku}${row.etsySkus.length > 1 ? ` +${row.etsySkus.length - 1}` : ""}` : "(none)";

      lines.push(`${fit(row.listingId, idWidth)}  ${fit(row.state, 9)}  ${fit(sku, 18)}  ${fit(row.collectionName, 19)}  ${fit(TYPE_LABELS[row.productType], 8)}  ${fit(flags, 30)}  ${printable(row.title)}`);
    });

    lines.push("");
  }

  const section = (heading, codes) => {
    const items = problems.filter((problem) => codes.includes(problem.code));

    lines.push(`${heading}: ${items.length ? items.length : "none"}`);
    items.forEach((problem) => lines.push(`  - ${problem.listingId === null ? "(no listing ID)" : problem.listingId}${problem.title ? ` "${printable(problem.title)}"` : ""}: ${printable(problem.message)}`));
    lines.push("");
  };

  section("Cannot be confidently classified (collection or digital/physical)", ["collection-none", "collection-ambiguous", "type-unknown"]);
  section("SKU problems (missing, badly formatted or duplicated)", ["missing-sku", "invalid-sku", "duplicate-sku"]);
  section("Conflicts with the existing catalog, and skipped listings", ["catalog-conflict", "skipped"]);

  const named = (counts, names) => countsText(Object.fromEntries(Object.entries(counts).map(([key, count]) => [names[key] || key, count])));

  lines.push(`Collections suggested : ${named(totals.byCollection, analysis.collectionNames)}`);
  lines.push(`Digital / physical    : ${named(totals.byType, TYPE_LABELS)}`);
  lines.push("");
  lines.push("What the existing importer would do (nothing was written):");
  lines.push(...meta.importerSummary.split("\n").map((line) => `  ${line}`));
  lines.push("");
  lines.push("Dry run only: no file was written and no Etsy listing was changed. Only read (GET) requests were made.");

  return lines.join("\n");
};

// deps are injectable so tests never touch the network, the real home folder or the clock.
const runSync = async (options, { fetchImpl = fetch, env = process.env, now = new Date(), homedir = os.homedir() } = {}) => {
  let secret = null;

  try {
    let credential = "not needed (reading a saved file)";

    if (!options.file) {
      assertSiteMaySeeSecret(options.site, options.trustHosts);

      const resolved = resolveBridgeSecret({ env, homedir });

      secret = resolved.secret;
      credential = `${resolved.source} (the value is never shown)`;
    }

    // Writing is forced OFF here. Nothing the caller passes can turn it on.
    const result = await runImport(
      { site: options.site, states: options.states, file: options.file, root: options.root, trustHosts: options.trustHosts, write: false, downloadImages: false },
      { fetchImpl, env, now, secret: secret === null ? undefined : secret, homedir }
    );
    const root = path.resolve(options.root || path.join(__dirname, ".."));
    const collectionNames = Object.fromEntries(loadCatalog(root).collections.map((collection) => [collection.slug, collection.name]));
    const analysis = buildSyncReport({ listings: result.listings, report: result.report, collectionNames });
    const meta = {
      source: options.file ? `saved file ${path.basename(options.file)}` : `${options.site.replace(/\/+$/, "")} (Etsy states: ${options.states.join(", ")})`,
      credential,
      generatedAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
      importerSummary: result.summary,
    };
    const json = {
      dryRun: true,
      wroteFiles: false,
      source: meta.source,
      credential: meta.credential,
      generatedAt: meta.generatedAt,
      totals: analysis.totals,
      listings: analysis.rows.map(({ outcome, ...row }) => ({ ...row, catalogAction: outcome })),
      problems: analysis.problems,
      importer: {
        newDrafts: result.report.creates.length,
        catalogUpdates: result.report.updates.length,
        unchanged: result.report.unchanged.length,
        conflicts: result.report.conflicts.length,
        skipped: result.report.skipped.length,
        inCatalogNotSeenOnEtsy: result.report.notSeen.length,
      },
    };

    return { analysis, json: redact(JSON.stringify(json, null, 2), secret), text: redact(formatSyncReport({ analysis, meta }), secret), wrote: false };
  } catch (error) {
    throw new Error(redact(error.message, secret));
  }
};

const main = async (argv = process.argv.slice(2)) => {
  try {
    const options = parseSyncArgs(argv);
    const result = await runSync(options);

    console.log(options.json ? result.json : result.text);
  } catch (error) {
    console.error(`Sync stopped: ${error.message}`);
    process.exitCode = 1;
  }
};

if (require.main === module) {
  main();
}

module.exports = { ALL_STATES, DEFAULT_SITE, buildSyncReport, formatSyncReport, main, parseSyncArgs, runSync };
