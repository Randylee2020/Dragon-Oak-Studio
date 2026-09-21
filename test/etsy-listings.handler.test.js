const test = require("node:test");
const { testAuthHeaders } = require("./_bridge-auth-test-helper");
const assert = require("node:assert/strict");

const LIB_PATH = require.resolve("../api/_lib/etsy-oauth");
const HANDLER_PATH = require.resolve("../api/etsy-listings");

const ETSY_LISTING = {
  listing_id: 111,
  title: "Etsy Title",
  state: "active",
  quantity: 3,
  price: { amount: 499, divisor: 100, currency_code: "USD" },
  url: "https://www.etsy.com/listing/111/etsy-title",
  created_timestamp: 1788000000,
  updated_timestamp: 1788000100,
  description: "Long description",
  tags: ["a", "b"],
  skus: ["DO-0001"],
  listing_type: "download",
  taxonomy_id: 68887,
  images: [{ listing_image_id: 9, url_fullxfull: "https://i.etsystatic.com/9/full.jpg", url_570xN: "https://i.etsystatic.com/9/570.jpg", alt_text: "Alt", rank: 1 }],
};

const BASIC_KEYS = ["createdTimestamp", "listingId", "price", "quantity", "state", "title", "updatedTimestamp", "url"];

const setup = (overrides = {}) => {
  const calls = { etsy: [], pg: 0 };
  const stub = {
    getRequiredConfig: () => ({ ok: true, apiKey: "k", sharedSecret: "s", databaseUrl: "postgres://x" }),
    getPgClient: async () => {
      calls.pg += 1;
      return { end: async () => {} };
    },
    getStoredToken: async () => ({ accessToken: "token-123", shopId: 64473522 }),
    fetchEtsyApi: async (...args) => {
      calls.etsy.push(args);
      return { ok: true, status: 200, json: async () => ({ count: 1, results: [ETSY_LISTING] }) };
    },
    ...overrides,
  };

  require.cache[LIB_PATH] = { id: LIB_PATH, filename: LIB_PATH, loaded: true, exports: stub };
  delete require.cache[HANDLER_PATH];

  return { handler: require(HANDLER_PATH), calls };
};

const restore = () => {
  delete require.cache[LIB_PATH];
  delete require.cache[HANDLER_PATH];
};

const fakeResponse = () => ({
  statusCode: null,
  headers: {},
  body: null,
  setHeader(name, value) {
    this.headers[name] = value;
  },
  end(payload) {
    this.body = payload ? JSON.parse(payload) : null;
  },
});

const get = async (handler, request = {}) => {
  const res = fakeResponse();
  await handler({ method: "GET", headers: testAuthHeaders(), ...request }, res);
  return res;
};

test("default request is unchanged: same Etsy call, same response shape, basic fields only", async (t) => {
  const { handler, calls } = setup();
  t.after(restore);

  const res = await get(handler, { query: {} });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.etsy, [["/shops/64473522/listings?state=active&limit=100&offset=0", "token-123"]]);
  assert.deepEqual(Object.keys(res.body).sort(), ["connected", "count", "listings", "ok", "shopId"]);
  assert.deepEqual(Object.keys(res.body.listings[0]).sort(), BASIC_KEYS);
  assert.equal(res.body.listings[0].listingId, 111);
  assert.equal(res.body.listings[0].price.display, "$4.99");
});

test("default request also works with no query object at all (as older callers send it)", async (t) => {
  const { handler, calls } = setup();
  t.after(restore);

  const res = await get(handler);

  assert.equal(res.statusCode, 200);
  assert.equal(calls.etsy[0][0], "/shops/64473522/listings?state=active&limit=100&offset=0");
});

test("detail=full adds SKU, tags, description, type and images and requests Images from Etsy (read only)", async (t) => {
  const { handler, calls } = setup();
  t.after(restore);

  const res = await get(handler, { query: { detail: "full" } });

  assert.equal(res.statusCode, 200);
  assert.equal(calls.etsy[0][0], "/shops/64473522/listings?state=active&limit=100&offset=0&includes=Images");
  assert.equal(calls.etsy[0].length, 2, "no fetch options: a plain GET");

  const [listing] = res.body.listings;
  assert.deepEqual(listing.skus, ["DO-0001"]);
  assert.deepEqual(listing.tags, ["a", "b"]);
  assert.equal(listing.description, "Long description");
  assert.equal(listing.listingType, "download");
  assert.equal(listing.taxonomyId, 68887);
  assert.deepEqual(listing.images, [{ imageId: 9, url: "https://i.etsystatic.com/9/full.jpg", altText: "Alt", rank: 1 }]);
  assert.equal(listing.title, "Etsy Title");
  assert.equal(res.body.detail, "full");
  assert.equal(res.body.state, "active");
});

test("state, limit and offset are passed through when valid (query string via request.url too)", async (t) => {
  const { handler, calls } = setup();
  t.after(restore);

  await get(handler, { query: { state: "draft", limit: "50", offset: "100" } });
  await get(handler, { url: "/api/etsy-listings?state=inactive&limit=10&offset=20" });

  assert.equal(calls.etsy[0][0], "/shops/64473522/listings?state=draft&limit=50&offset=100");
  assert.equal(calls.etsy[1][0], "/shops/64473522/listings?state=inactive&limit=10&offset=20");
});

test("invalid options are rejected with 400 before the database or Etsy is touched", async (t) => {
  const { handler, calls } = setup();
  t.after(restore);

  const bad = [
    { state: "everything" },
    { state: "active; DROP TABLE" },
    { detail: "all" },
    { limit: "0" },
    { limit: "101" },
    { limit: "abc" },
    { limit: "-5" },
    { offset: "-1" },
    { offset: "1e3" },
    { offset: "10001" },
  ];

  for (const query of bad) {
    const res = await get(handler, { query });
    assert.equal(res.statusCode, 400, JSON.stringify(query));
    assert.equal(res.body.ok, false);
  }

  assert.equal(calls.pg, 0);
  assert.equal(calls.etsy.length, 0);
});

test("only GET is allowed, and authentication is still required", async (t) => {
  const { handler, calls } = setup();
  t.after(restore);

  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const res = await get(handler, { method, query: { detail: "full" } });
    assert.equal(res.statusCode, 405, method);
  }

  const unauthenticated = fakeResponse();
  await handler({ method: "GET", headers: {}, query: { detail: "full" } }, unauthenticated);

  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(calls.etsy.length, 0);
  assert.equal(calls.pg, 0);
});

test("when Etsy is not connected the response is unchanged", async (t) => {
  const { handler } = setup({ getStoredToken: async () => null });
  t.after(restore);

  const res = await get(handler, { query: { detail: "full" } });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, connected: false, listings: [] });
});

test("an Etsy failure still returns the generic 502 without leaking details", async (t) => {
  const { handler } = setup({ fetchEtsyApi: async () => ({ ok: false, status: 500, json: async () => ({ error: "secret detail" }) }) });
  t.after(restore);

  const res = await get(handler, { query: { detail: "full" } });

  assert.equal(res.statusCode, 502);
  assert.ok(!JSON.stringify(res.body).includes("secret detail"));
});
