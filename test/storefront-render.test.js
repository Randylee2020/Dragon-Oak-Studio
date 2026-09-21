const test = require("node:test");
const assert = require("node:assert/strict");
const { REQUIRED_COLLECTION_SLUGS, buildPublicCatalog } = require("../api/_lib/catalog");
const {
  HOME_MARKERS,
  escapeHtml,
  renderCollectionPage,
  renderHomeCollectionsSection,
  renderProductPage,
  renderShopIndex,
  renderSitemap,
  replaceHomeSection,
  safeJsonLd,
} = require("../tools/storefront-render");

const collections = REQUIRED_COLLECTION_SLUGS.map((slug, index) => ({
  slug,
  name: { halloween: "Halloween", christmas: "Christmas", "cute-bookmarks": "Cute Bookmarks", "wine-hill-country": "Wine & Hill Country", "other-seasonal": "Other Seasonal" }[slug],
  tagline: `Tagline for ${slug}.`,
  description: `Description for ${slug}.`,
  order: index + 1,
}));

const product = (overrides = {}) => ({
  schemaVersion: 1,
  id: "prod-test-0001",
  sku: "TEST-0001",
  title: "Test Product",
  slug: "test-product",
  description: "A test description.",
  collection: "halloween",
  subcollection: null,
  productType: "physical_product",
  tags: ["one"],
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

const catalogFor = (products) => buildPublicCatalog({ collections, products });
const collectionOf = (catalog, slug) => catalog.collections.find((entry) => entry.slug === slug);

test("escapeHtml neutralises markup and quotes", () => {
  assert.equal(escapeHtml(`<script>"x" & 'y'</script>`), "&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;");
  assert.equal(escapeHtml(null), "");
});

test("safeJsonLd cannot close the script element or break out", () => {
  const output = safeJsonLd({ name: "</script><script>alert(1)</script>", other: "a&b  " });

  assert.ok(!output.includes("</script>"));
  assert.ok(!output.includes("<"));
  assert.ok(!output.includes(" ") && !output.includes(" "));
  assert.deepEqual(JSON.parse(output), { name: "</script><script>alert(1)</script>", other: "a&b  " });
});

test("hostile product text is escaped on every page type", () => {
  const evil = `<img src=x onerror=alert(1)>"'&`;
  const hostile = product({
    title: `Bad ${evil}`,
    description: `Desc ${evil}\n\nSecond ${evil}`,
    tags: [`t<b>`],
    subcollection: "sub-one",
    images: [{ path: "assets/test/1.webp", alt: `Alt ${evil}` }],
  });
  const other = product({ id: "prod-test-0002", sku: "TEST-0002", slug: "other", subcollection: "sub-two", productType: "digital_download" });
  const catalog = catalogFor([hostile, other]);
  const pages = [
    renderShopIndex(catalog),
    renderCollectionPage(collectionOf(catalog, "halloween"), catalog),
    renderProductPage(catalog.products.find((entry) => entry.sku === "TEST-0001"), collectionOf(catalog, "halloween"), catalog),
    renderHomeCollectionsSection(catalog),
  ];

  pages.forEach((html) => {
    assert.ok(!html.includes("<img src=x"), "raw injected tag must not appear");
    assert.ok(!html.includes("<b>"), "tag text must be escaped");

    // Structural check: scan every real tag (quote-aware) and make sure no user text became an attribute or element.
    const tagPattern = /<([a-z][a-z0-9]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/gi;
    const attributePattern = /\s+([^\s"'>/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?/g;
    let tagCount = 0;
    let tag;

    while ((tag = tagPattern.exec(html)) !== null) {
      tagCount += 1;
      assert.notEqual(tag[1].toLowerCase(), "b");

      let attribute;

      while ((attribute = attributePattern.exec(tag[2])) !== null) {
        assert.ok(!/^on/i.test(attribute[1]), `event-handler attribute injected: ${attribute[1]}`);
      }
    }

    assert.ok(tagCount > 10, "the scanner must actually be reading real tags");
  });
});

test("product page: physical product without Etsy offers an inquiry, not a buy button", () => {
  const catalog = catalogFor([product()]);
  const html = renderProductPage(catalog.products[0], collectionOf(catalog, "halloween"), catalog);

  assert.match(html, /Ask About This Piece/);
  assert.match(html, /href="\/#contact"/);
  assert.ok(!html.includes("Buy on Etsy"));
  assert.match(html, /Physical Product/);
  assert.match(html, /\$12\.50/);
  assert.ok(!html.includes('"offers"'), "no offer without an active Etsy listing");
});

test("product page: active Etsy listing gets a safe Buy on Etsy link and an Offer in JSON-LD", () => {
  const catalog = catalogFor([
    product({ productType: "digital_download", etsy: { listingId: 9, url: "https://www.etsy.com/listing/9/x", state: "active", syncedAt: "2026-09-01T00:00:00Z" } }),
  ]);
  const html = renderProductPage(catalog.products[0], collectionOf(catalog, "halloween"), catalog);

  assert.match(html, /<a class="btn btn-primary" href="https:\/\/www\.etsy\.com\/listing\/9\/x" target="_blank" rel="noopener noreferrer">Buy on Etsy<\/a>/);
  assert.match(html, /Digital Download/);
  assert.match(html, /"availability":"https:\/\/schema\.org\/InStock"/);
  assert.match(html, /"price":"12\.50"/);
});

test("product page: inactive, sold-out or draft Etsy listings never show Buy on Etsy", () => {
  ["draft", "inactive", "sold_out", "expired", "removed"].forEach((state) => {
    const catalog = catalogFor([product({ etsy: { listingId: 9, url: "https://www.etsy.com/listing/9/x", state, syncedAt: null } })]);
    const html = renderProductPage(catalog.products[0], collectionOf(catalog, "halloween"), catalog);

    assert.ok(!html.includes("Buy on Etsy"), state);
    assert.ok(!html.includes("etsy.com"), `${state}: Etsy address must not be published`);
  });
});

test("product page has canonical, Open Graph, Twitter and Product JSON-LD metadata", () => {
  const catalog = catalogFor([product()]);
  const html = renderProductPage(catalog.products[0], collectionOf(catalog, "halloween"), catalog);

  assert.match(html, /<link rel="canonical" href="https:\/\/dragonoakstudio\.com\/product\/test-product\/" \/>/);
  assert.match(html, /<meta property="og:image" content="https:\/\/dragonoakstudio\.com\/assets\/test\/1\.webp" \/>/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image" \/>/);
  assert.match(html, /<title>Test Product \| Dragon Oak Studio<\/title>/);
  assert.match(html, /"@type":"Product"/);
  assert.match(html, /"@type":"BreadcrumbList"/);
  assert.match(html, /"sku":"TEST-0001"/);
});

test("trusted Etsy CDN product images render as absolute image URLs", () => {
  const url = "https://i.etsystatic.com/64473522/r/il/c34365/8549844100/il_fullxfull.8549844100_pf78.jpg";
  const catalog = catalogFor([product({ images: [{ path: url, alt: "Etsy product image" }] })]);
  const productHtml = renderProductPage(catalog.products[0], collectionOf(catalog, "halloween"), catalog);
  const collectionHtml = renderCollectionPage(collectionOf(catalog, "halloween"), catalog);

  assert.match(productHtml, new RegExp(`<img src="${url}`));
  assert.match(productHtml, new RegExp(`<meta property="og:image" content="${url}`));
  assert.match(productHtml, new RegExp(`"image":\\["${url}`));
  assert.match(collectionHtml, new RegExp(`<img src="${url}`));
  assert.ok(!productHtml.includes("https://dragonoakstudio.com/https://i.etsystatic.com"));
});

test("every page shares the site header, footer, styles and scripts, and keeps the site's identity", () => {
  const catalog = catalogFor([product()]);
  const html = renderShopIndex(catalog);

  assert.match(html, /<link rel="stylesheet" href="\/css\/styles\.css" \/>/);
  assert.match(html, /<link rel="stylesheet" href="\/css\/storefront\.css" \/>/);
  assert.match(html, /<script src="\/js\/main\.js\?v=phase-ii-intro" defer><\/script>/);
  assert.match(html, /id="menuToggle"/);
  assert.match(html, /id="navMenu"/);
  assert.match(html, /Crafted by Fire\. Designed to Last\./);
  assert.ok(!html.includes("introOverlay"), "the cinematic intro belongs to the home page only");
});

test("shop index links all five collections", () => {
  const html = renderShopIndex(catalogFor([]));

  ["halloween", "christmas", "cute-bookmarks", "wine-hill-country", "other-seasonal"].forEach((slug) => {
    assert.ok(html.includes(`href="/shop/${slug}/"`), slug);
  });

  assert.match(html, /Wine &amp; Hill Country/);
});

test("empty collection shows a friendly state, is noindex, and stays navigable", () => {
  const catalog = catalogFor([]);
  const html = renderCollectionPage(collectionOf(catalog, "cute-bookmarks"), catalog);

  assert.match(html, /New pieces are on the way/);
  assert.match(html, /<meta name="robots" content="noindex, follow" \/>/);
  assert.match(html, /href="\/shop\/halloween\/"/, "other collections remain reachable");
  assert.ok(!html.includes("data-filter-bar"));
});

test("populated collection is indexable and shows type filters only when both types exist", () => {
  const digital = product({ id: "prod-test-0002", sku: "TEST-0002", slug: "digi", productType: "digital_download", subcollection: "ornaments" });
  const physical = product({ subcollection: "coasters" });
  const both = catalogFor([physical, digital]);
  const bothHtml = renderCollectionPage(collectionOf(both, "halloween"), both);

  assert.ok(!bothHtml.includes('name="robots"'));
  assert.match(bothHtml, /data-filter="type" data-value="digital_download"/);
  assert.match(bothHtml, /data-filter="type" data-value="physical_product"/);
  assert.match(bothHtml, /data-filter="sub" data-value="ornaments"/);
  assert.match(bothHtml, /data-product-type="digital_download"/);

  const single = catalogFor([physical]);
  const singleHtml = renderCollectionPage(collectionOf(single, "halloween"), single);
  assert.ok(!singleHtml.includes("data-filter-bar"), "no pointless filters for one product");
});

test("halloween, christmas and cute bookmarks are independent collection pages with only their own products", () => {
  const catalog = catalogFor([
    product(),
    product({ id: "prod-xmas-0001", sku: "XMAS-0001", slug: "xmas-one", title: "Xmas One", collection: "christmas" }),
    product({ id: "prod-bkmk-0001", sku: "BKMK-0001", slug: "bookmark-one", title: "Bookmark One", collection: "cute-bookmarks" }),
  ]);
  const page = (slug) => renderCollectionPage(collectionOf(catalog, slug), catalog);

  assert.ok(page("halloween").includes("Test Product") && !page("halloween").includes("Xmas One") && !page("halloween").includes("Bookmark One"));
  assert.ok(page("christmas").includes("Xmas One") && !page("christmas").includes("Bookmark One"));
  assert.ok(page("cute-bookmarks").includes("Bookmark One") && !page("cute-bookmarks").includes("Xmas One"));
});

test("home section is wrapped in markers and replaceHomeSection swaps only that region", () => {
  const catalog = catalogFor([product({ featured: true })]);
  const section = renderHomeCollectionsSection(catalog);

  assert.ok(section.startsWith("<!-- storefront:collections:start"));
  assert.ok(section.endsWith(HOME_MARKERS.end));
  assert.match(section, /Featured Pieces/);
  assert.match(section, /href="\/shop\/"/);

  const before = `<main>KEEP-A\n${HOME_MARKERS.start}\nOLD\n${HOME_MARKERS.end}\nKEEP-B</main>`;
  const after = replaceHomeSection(before, section);

  assert.ok(after.startsWith("<main>KEEP-A\n") && after.endsWith("\nKEEP-B</main>"));
  assert.ok(!after.includes("OLD"));
  assert.equal(replaceHomeSection(after, section), after, "idempotent");
  assert.throws(() => replaceHomeSection("<main></main>", section), /markers/);
});

test("home section omits the featured strip when nothing is featured", () => {
  const section = renderHomeCollectionsSection(catalogFor([product()]));
  assert.ok(!section.includes("Featured Pieces"));
});

test("sitemap lists home, shop, non-empty collections and products only", () => {
  const catalog = catalogFor([product(), product({ id: "prod-draft-0001", sku: "DRAFT-0001", slug: "draft-one", siteState: "draft" })]);
  const xml = renderSitemap(catalog);

  assert.match(xml, /<loc>https:\/\/dragonoakstudio\.com\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/dragonoakstudio\.com\/shop\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/dragonoakstudio\.com\/shop\/halloween\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/dragonoakstudio\.com\/product\/test-product\/<\/loc>\s*<lastmod>2026-09-02<\/lastmod>/);
  assert.ok(!xml.includes("/shop/christmas/"), "empty collections are not in the sitemap");
  assert.ok(!xml.includes("draft-one"), "drafts are never in the sitemap");
});

test("rendering is deterministic (same input, same bytes)", () => {
  const catalog = catalogFor([product({ featured: true })]);

  assert.equal(renderShopIndex(catalog), renderShopIndex(catalog));
  assert.equal(renderSitemap(catalog), renderSitemap(catalog));
});
