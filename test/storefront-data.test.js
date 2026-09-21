const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadCatalog, validateProduct } = require("../api/_lib/catalog");
const { buildOutputs, checkOutputs, listFilesUnder } = require("../tools/build-storefront");

const ROOT = path.join(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

test("the real catalog loads with no errors", () => {
  const loaded = loadCatalog(ROOT);

  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.collections.length >= 5, true);
  assert.deepEqual(
    ["halloween", "christmas", "cute-bookmarks", "wine-hill-country", "other-seasonal"].filter((slug) => !loaded.collections.some((collection) => collection.slug === slug)),
    []
  );
});

test("the committed generated storefront is exactly what the catalog produces (run npm run catalog:build if this fails)", () => {
  const result = buildOutputs(ROOT);

  assert.equal(result.ok, true, result.errors.join("; "));
  assert.deepEqual(checkOutputs(ROOT, result.files), []);
});

test("every published product's images exist on disk", () => {
  const { products } = loadCatalog(ROOT);

  products
    .filter((product) => product.siteState === "published")
    .forEach((product) => {
      assert.ok(product.images.length > 0, `${product.sku} has an image`);
      product.images.forEach((image) => assert.ok(fs.existsSync(path.join(ROOT, image.path)), `${product.sku}: ${image.path}`));
    });
});

test("the example products stay valid against the current schema and are not built into the site", () => {
  const directory = path.join(ROOT, "catalog", "examples");
  const files = fs.readdirSync(directory).filter((name) => name.endsWith(".json"));
  const examples = files.map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")));

  assert.ok(files.length >= 3);

  examples.forEach((example) => {
    assert.deepEqual(validateProduct(example, { fileExists: () => true }).errors, [], example.sku);
    assert.ok(example.sku.startsWith("EXAMPLE-"));
  });

  // Together the examples show both product types and the required collections they demonstrate.
  assert.deepEqual(Array.from(new Set(examples.map((example) => example.productType))).sort(), ["digital_download", "physical_product"]);

  const site = JSON.parse(read("catalog/public/catalog.json"));
  assert.ok(!site.products.some((product) => product.sku.startsWith("EXAMPLE-")));
});

test("nothing private from the canonical files appears in any generated or public file", () => {
  const { products } = loadCatalog(ROOT);
  const publicFiles = [
    "index.html",
    "sitemap.xml",
    "catalog/collections.json",
    ...listFilesUnder(ROOT, "shop"),
    ...listFilesUnder(ROOT, "product"),
    ...listFilesUnder(ROOT, "catalog/public"),
  ];
  const secrets = [];

  products.forEach((product) => {
    (product.digitalFiles || []).forEach((file) => secrets.push(file.ref));
    if (product.notes) secrets.push(product.notes);
    if (product.provenance) secrets.push(product.provenance);
  });

  assert.ok(publicFiles.length > 8);

  publicFiles.forEach((file) => {
    const content = read(file);

    secrets.forEach((secret) => assert.ok(!content.includes(secret), `${file} must not contain a private value`));
    ["adrian:", "digitalFiles", "provenance"].forEach((needle) => assert.ok(!content.includes(needle), `${file} must not contain "${needle}"`));
  });
});

test("private build inputs are excluded from the deployed site", () => {
  const ignore = read(".vercelignore")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  ["/tools", "/catalog/products", "/catalog/examples", "/catalog/import"].forEach((entry) => assert.ok(ignore.includes(entry), entry));

  // Everything the public site needs must NOT be ignored.
  ["/shop", "/product", "/catalog/public", "/css", "/js", "/assets", "/api", "/index.html"].forEach((entry) => assert.ok(!ignore.includes(entry), entry));
});

test("package.json keeps the pg dependency and adds only test and catalog scripts (no build step for Vercel)", () => {
  const manifest = JSON.parse(read("package.json"));

  assert.ok(manifest.dependencies.pg);
  assert.deepEqual(Object.keys(manifest.dependencies), ["pg"], "no new runtime dependencies");
  assert.ok(!("build" in manifest.scripts) && !("vercel-build" in manifest.scripts), "adding a build script would change how Vercel deploys");
  assert.equal(manifest.scripts.test, "node --test test/*.test.js");
});
