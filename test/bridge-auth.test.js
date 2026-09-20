const test = require("node:test");
const assert = require("node:assert/strict");
const { TEST_SECRET } = require("./_bridge-auth-test-helper");

const LIB_PATH = require.resolve("../api/_lib/etsy-oauth");
const CLOUDINARY_LIB_PATH = require.resolve("../api/_lib/cloudinary");

// Every endpoint that can read, create, modify, upload to, or publish Etsy data (or start the Etsy OAuth flow).
const PROTECTED = [
  "etsy-connect",
  "etsy-finances",
  "etsy-listing-activate",
  "etsy-listing-file-upload",
  "etsy-listing-image-upload",
  "etsy-listings-create",
  "etsy-listings",
  "etsy-orders",
  "etsy-status",
];

const spyCalls = [];

const loadHandler = (name) => {
  // Any touch of Etsy/DB/Cloudinary after auth would be recorded; "not configured" makes handlers stop right after auth.
  const spy = (fn) => (...args) => {
    spyCalls.push(fn);
    return { ok: false };
  };
  const libStub = new Proxy(
    { getRequiredConfig: () => ({ ok: false }) },
    { get: (target, prop) => (prop in target ? target[prop] : spy(String(prop))) }
  );
  require.cache[LIB_PATH] = { id: LIB_PATH, filename: LIB_PATH, loaded: true, exports: libStub };
  require.cache[CLOUDINARY_LIB_PATH] = { id: CLOUDINARY_LIB_PATH, filename: CLOUDINARY_LIB_PATH, loaded: true, exports: {} };
  const path = require.resolve(`../api/${name}`);
  delete require.cache[path];
  return require(path);
};

const call = async (handler, { method = "POST", headers = {}, query = {}, body = {} } = {}) => {
  const res = {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    end(payload) { this.body = payload ? JSON.parse(payload) : null; },
  };
  await handler({ method, headers, query, body }, res);
  return res;
};

for (const name of PROTECTED) {
  test(`${name}: no Authorization header -> 401`, async () => {
    const handler = loadHandler(name);
    for (const method of ["GET", "POST"]) {
      const res = await call(handler, { method });
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.ok, false);
      assert.match(res.headers["WWW-Authenticate"], /Bearer/);
    }
    assert.equal(spyCalls.length, 0, "no Etsy/DB access before authentication");
  });

  test(`${name}: wrong secret -> 403, malformed/other scheme -> 401`, async () => {
    const handler = loadHandler(name);
    assert.equal((await call(handler, { headers: { authorization: "Bearer not-the-secret" } })).statusCode, 403);
    assert.equal((await call(handler, { headers: { authorization: `Bearer ${TEST_SECRET}x` } })).statusCode, 403);
    assert.equal((await call(handler, { headers: { authorization: `Basic ${TEST_SECRET}` } })).statusCode, 401);
    assert.equal((await call(handler, { headers: { authorization: TEST_SECRET } })).statusCode, 401);
    // A secret in the query string or body must never authenticate.
    assert.equal((await call(handler, { query: { secret: TEST_SECRET, token: TEST_SECRET }, body: { secret: TEST_SECRET } })).statusCode, 401);
    assert.equal(spyCalls.length, 0);
  });

  test(`${name}: correct secret passes authentication`, async () => {
    const handler = loadHandler(name);
    const res = await call(handler, { headers: { authorization: `Bearer ${TEST_SECRET}` } });
    assert.notEqual(res.statusCode, 401);
    assert.notEqual(res.statusCode, 403);
    assert.notEqual(res.statusCode, 503);
  });
}

test("server without ADRIAN_BRIDGE_SECRET (or a weak one) fails closed with 503, even for a matching header", async () => {
  const handler = loadHandler("etsy-listing-activate");
  const original = process.env.ADRIAN_BRIDGE_SECRET;
  try {
    delete process.env.ADRIAN_BRIDGE_SECRET;
    assert.equal((await call(handler, { headers: { authorization: `Bearer ${TEST_SECRET}` } })).statusCode, 503);
    process.env.ADRIAN_BRIDGE_SECRET = "short";
    assert.equal((await call(handler, { headers: { authorization: "Bearer short" } })).statusCode, 503);
  } finally {
    process.env.ADRIAN_BRIDGE_SECRET = original;
  }
});

test("public OAuth callback and website endpoints are not wrapped by bridge auth", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  for (const name of ["etsy-callback", "contact", "reference-upload"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", "api", `${name}.js`), "utf8");
    assert.ok(!source.includes("requireBridgeAuth"), `${name} must stay public`);
  }
});

test("the secret is not present in any source file under api/ or test-only helper differs from production naming", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const apiDir = path.join(__dirname, "..", "api");
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) files.push(full);
    }
  };
  walk(apiDir);
  for (const file of files) {
    assert.ok(!fs.readFileSync(file, "utf8").includes(TEST_SECRET), `${file} must not embed a secret`);
  }
});
