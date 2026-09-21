const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { listFilesUnder } = require("../tools/build-storefront");

const ROOT = path.join(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

// The exact set of Vercel functions at the time the storefront was added. On the Hobby plan each file directly inside
// api/ is one serverless function and only 12 are allowed per deployment, so this list must not grow.
const EXISTING_FUNCTIONS = [
  "contact.js",
  "etsy-callback.js",
  "etsy-connect.js",
  "etsy-finances.js",
  "etsy-listing-activate.js",
  "etsy-listing-file-upload.js",
  "etsy-listing-image-upload.js",
  "etsy-listings-create.js",
  "etsy-listings.js",
  "etsy-orders.js",
  "etsy-status.js",
  "reference-upload.js",
];

test("no new Vercel serverless functions were added (Hobby plan limit is 12)", () => {
  const entries = fs.readdirSync(path.join(ROOT, "api"), { withFileTypes: true });
  const functions = entries.filter((entry) => entry.isFile() && /\.(js|mjs|cjs|ts)$/.test(entry.name)).map((entry) => entry.name).sort();

  assert.deepEqual(functions, EXISTING_FUNCTIONS);
  assert.ok(functions.length <= 12);
});

test("api/ contains no scripts outside the 12 functions and the underscore-prefixed _lib folder", () => {
  const scripts = listFilesUnder(ROOT, "api").filter((file) => /\.(js|mjs|cjs|ts)$/.test(file));
  const unexpected = scripts.filter((file) => !EXISTING_FUNCTIONS.includes(path.basename(file)) || file.split("/").length > 2).filter((file) => !file.startsWith("api/_lib/"));

  assert.deepEqual(unexpected, []);
});

test("shared catalog code lives in api/_lib (not a function) and every existing _lib file is still present", () => {
  ["bridge-auth.js", "cloudinary.js", "etsy-oauth.js", "catalog.js", "etsy-import.js"].forEach((name) => {
    assert.ok(fs.existsSync(path.join(ROOT, "api", "_lib", name)), name);
  });
});

test("no secret or credential names appear in any file the browser can receive", () => {
  const browserFiles = [
    "index.html",
    "sitemap.xml",
    "robots.txt",
    "catalog/collections.json",
    "catalog/README.md",
    "catalog/schema/product.schema.json",
    ...listFilesUnder(ROOT, "js"),
    ...listFilesUnder(ROOT, "css"),
    ...listFilesUnder(ROOT, "shop"),
    ...listFilesUnder(ROOT, "product"),
    ...listFilesUnder(ROOT, "catalog/public"),
  ];
  const forbidden = [
    "ADRIAN_BRIDGE_SECRET",
    "ETSY_API_KEY",
    "ETSY_SHARED_SECRET",
    "DATABASE_URL",
    "CLOUDINARY_API_SECRET",
    "RESEND_API_KEY",
    "x-api-key",
    "Bearer ",
    "etsy_oauth_tokens",
    "access_token",
    "refresh_token",
  ];

  assert.ok(browserFiles.length > 12);

  browserFiles.forEach((file) => {
    const content = read(file);

    forbidden.forEach((needle) => {
      // catalog/README.md documents the variable NAME for the person running the import; it must never hold a value.
      if (file === "catalog/README.md" && needle === "ADRIAN_BRIDGE_SECRET") {
        return;
      }

      assert.ok(!content.includes(needle), `${file} must not contain ${needle}`);
    });
  });
});

test("the storefront's browser script makes no network requests", () => {
  const source = read("js/shop.js");

  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|localStorage|sessionStorage|document\.cookie/.test(source));
});

test("every Etsy bridge endpoint still requires the bridge secret (ADRIAN_BRIDGE_SECRET protection preserved)", () => {
  [
    "etsy-connect",
    "etsy-finances",
    "etsy-listing-activate",
    "etsy-listing-file-upload",
    "etsy-listing-image-upload",
    "etsy-listings-create",
    "etsy-listings",
    "etsy-orders",
    "etsy-status",
  ].forEach((name) => {
    const source = read(`api/${name}.js`);

    assert.ok(source.includes('require("./_lib/bridge-auth")'), `${name} imports bridge auth`);
    assert.ok(/requireBridgeAuth\(request, response\)/.test(source), `${name} calls requireBridgeAuth`);
  });
});

test("existing Etsy OAuth/token handling and PostgreSQL integration are still wired in", () => {
  const oauth = read("api/_lib/etsy-oauth.js");

  ["getStoredToken", "refreshStoredToken", "upsertToken", "createPkcePair", "exchangeAuthorizationCode", "getPgClient"].forEach((name) => {
    assert.ok(oauth.includes(name), name);
  });

  assert.ok(oauth.includes("process.env.DATABASE_URL") && oauth.includes('require("pg")'));
  assert.ok(read("api/etsy-callback.js").includes("etsy_oauth_requests"));
});

test("vercel.json keeps the file-upload function's longer time limit", () => {
  assert.deepEqual(JSON.parse(read("vercel.json")), { functions: { "api/etsy-listing-file-upload.js": { maxDuration: 60 } } });
});

test("home page keeps the cinematic intro, Forged Steel & Ice identity, contact form and SEO metadata", () => {
  const html = read("index.html");

  ["introOverlay", "introVideo", "introBurnVideo", "introBurnCanvas", "introStart", "introSkip"].forEach((id) => {
    assert.ok(html.includes(`id="${id}"`), id);
  });

  assert.ok(html.includes('data-src="assets/dragon-oak-intro.mp4"') && html.includes('data-src="assets/dragon-oak-parchment-burn.mp4"'));
  assert.ok(html.includes("Forged Steel & Ice") && html.includes("Crafted by Fire. Designed to Last."));

  // Contact form and reference uploads.
  ['id="contactForm"', 'action="/api/contact"', 'id="contactReferenceImages"', 'name="website"', 'id="contactStartedAt"', 'id="contactSubmit"'].forEach((needle) => {
    assert.ok(html.includes(needle), needle);
  });

  // SEO / social metadata.
  [
    "<title>Dragon Oak Studio | Crafted by Fire. Designed to Last.</title>",
    '<link rel="canonical" href="https://dragonoakstudio.com/" />',
    '<meta property="og:title" content="Dragon Oak Studio" />',
    '<meta property="og:image" content="https://dragonoakstudio.com/assets/dragon-oak-social-share.jpg" />',
    '<meta name="twitter:card" content="summary_large_image" />',
  ].forEach((needle) => assert.ok(html.includes(needle), needle));

  // The existing showcase sections are still there.
  ["id=\"products\"", "id=\"services\"", "id=\"custom\"", "id=\"about\"", "id=\"contact\"", "Featured Products"].forEach((needle) => {
    assert.ok(html.includes(needle), needle);
  });

  // The home page links to the shop and to the generated collections block.
  assert.ok(html.includes('href="/shop/"') && html.includes('id="collections"'));
});

test("main.js (intro + contact form logic) is unchanged in the parts that matter", () => {
  const script = read("js/main.js");

  ["dragonOakIntroViewed", "startBurnThroughReveal", "uploadReferenceFile", '"/api/reference-upload"', "submission_failed"].forEach((needle) => {
    assert.ok(script.includes(needle), needle);
  });
});
