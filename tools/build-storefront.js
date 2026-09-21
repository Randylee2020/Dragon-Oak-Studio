#!/usr/bin/env node
// Builds the static storefront from the ADRIAN catalog. No dependencies, no network, no database, no Etsy.
//
//   npm run catalog:build            validate the catalog, then (re)write every generated file
//   npm run catalog:check            validate and confirm the committed generated files are up to date (used by tests/CI)
//
// Reads:   catalog/collections.json, catalog/products/<SKU>.json, the image files each product points at, index.html
// Writes:  catalog/public/catalog.json, shop/**, product/**, sitemap.xml, and the marked "Shop by Collection" region of
//          index.html. shop/ and product/ are fully generated directories; nothing else in the repo is touched.
const fs = require("fs");
const path = require("path");
const { buildPublicCatalog, loadCatalog } = require("../api/_lib/catalog");
const {
  renderCollectionPage,
  renderHomeCollectionsSection,
  renderProductPage,
  renderShopIndex,
  renderSitemap,
  replaceHomeSection,
} = require("./storefront-render");

const GENERATED_DIRS = ["shop", "product", "catalog/public"];

const buildOutputs = (root) => {
  const loaded = loadCatalog(root);

  if (loaded.errors.length) {
    return { ok: false, errors: loaded.errors, warnings: loaded.warnings, files: new Map() };
  }

  const catalog = buildPublicCatalog(loaded);
  const collectionsBySlug = new Map(catalog.collections.map((collection) => [collection.slug, collection]));
  const files = new Map();

  files.set("catalog/public/catalog.json", `${JSON.stringify(catalog, null, 2)}\n`);
  files.set("shop/index.html", renderShopIndex(catalog));

  catalog.collections.forEach((collection) => {
    files.set(`shop/${collection.slug}/index.html`, renderCollectionPage(collection, catalog));
  });

  catalog.products.forEach((product) => {
    files.set(`product/${product.slug}/index.html`, renderProductPage(product, collectionsBySlug.get(product.collection), catalog));
  });

  files.set("sitemap.xml", renderSitemap(catalog));

  const homePath = path.join(root, "index.html");
  const home = fs.readFileSync(homePath, "utf8");

  try {
    files.set("index.html", replaceHomeSection(home, renderHomeCollectionsSection(catalog)));
  } catch (error) {
    return { ok: false, errors: [error.message], warnings: loaded.warnings, files: new Map() };
  }

  return { ok: true, errors: [], warnings: loaded.warnings, files, catalog };
};

const listFilesUnder = (root, relativeDir) => {
  const start = path.join(root, relativeDir);
  const found = [];

  const walk = (directory) => {
    if (!fs.existsSync(directory)) {
      return;
    }

    fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
      const fullPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        found.push(path.relative(root, fullPath).split(path.sep).join("/"));
      }
    });
  };

  walk(start);
  return found;
};

// Compares generated output with what is on disk. Returns a list of problems (empty means up to date).
const checkOutputs = (root, files) => {
  const problems = [];

  files.forEach((content, relativePath) => {
    const fullPath = path.join(root, relativePath);

    if (!fs.existsSync(fullPath)) {
      problems.push(`missing: ${relativePath}`);
    } else if (fs.readFileSync(fullPath, "utf8") !== content) {
      problems.push(`out of date: ${relativePath}`);
    }
  });

  GENERATED_DIRS.forEach((directory) => {
    listFilesUnder(root, directory).forEach((relativePath) => {
      if (!files.has(relativePath)) {
        problems.push(`stale generated file (no longer in the catalog): ${relativePath}`);
      }
    });
  });

  return problems;
};

const writeOutputs = (root, files) => {
  GENERATED_DIRS.forEach((directory) => {
    fs.rmSync(path.join(root, directory), { recursive: true, force: true });
  });

  files.forEach((content, relativePath) => {
    const fullPath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  });
};

const main = () => {
  const args = process.argv.slice(2);
  const rootArgIndex = args.indexOf("--root");
  const root = path.resolve(rootArgIndex >= 0 ? args[rootArgIndex + 1] : path.join(__dirname, ".."));
  const checkOnly = args.includes("--check");
  const result = buildOutputs(root);

  result.warnings.forEach((warning) => console.warn(`warning: ${warning}`));

  if (!result.ok) {
    console.error("Catalog is not valid. Nothing was written.");
    result.errors.forEach((error) => console.error(`  error: ${error}`));
    process.exit(1);
  }

  if (checkOnly) {
    const problems = checkOutputs(root, result.files);

    if (problems.length) {
      console.error("Generated storefront files are not up to date. Run: npm run catalog:build");
      problems.forEach((problem) => console.error(`  ${problem}`));
      process.exit(1);
    }

    console.log(`Catalog OK and generated files are up to date (${result.catalog.products.length} published products).`);
    return;
  }

  writeOutputs(root, result.files);
  console.log(
    `Built storefront: ${result.catalog.products.length} published products, ${result.catalog.collections.length} collections, ${result.files.size} files written.`
  );
};

if (require.main === module) {
  main();
}

module.exports = { GENERATED_DIRS, buildOutputs, checkOutputs, listFilesUnder, writeOutputs };
