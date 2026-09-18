const test = require("node:test");
const assert = require("node:assert/strict");

const LIB_PATH = require.resolve("../api/lib/etsy-oauth");
const HANDLER_PATH = require.resolve("../api/etsy-listings-create");

const VALID_INPUT = {
  title: "Test Digital Print",
  description: "A test description.",
  price: 4.99,
  quantity: 1,
  who_made: "i_did",
  when_made: "made_to_order",
  taxonomy_id: 68887,
  type: "download",
};

const stubLib = (overrides = {}) => {
  const stub = {
    getRequiredConfig: () => ({ ok: true, apiKey: "k", sharedSecret: "s", databaseUrl: "postgres://x" }),
    getPgClient: async () => ({ end: async () => {} }),
    getStoredToken: async () => ({
      accessToken: "token-123",
      refreshToken: "refresh-123",
      shopId: 64473522,
      userId: "965241607",
      scope: "listings_r listings_w shops_r shops_w transactions_r transactions_w",
      expiresAt: new Date(Date.now() + 3600 * 1000),
    }),
    fetchEtsyJson: async () => {
      throw new Error("fetchEtsyJson stub was not overridden for this test");
    },
    ...overrides,
  };

  require.cache[LIB_PATH] = { id: LIB_PATH, filename: LIB_PATH, loaded: true, exports: stub };
  delete require.cache[HANDLER_PATH];
  return require(HANDLER_PATH);
};

const restoreLib = () => {
  delete require.cache[LIB_PATH];
  delete require.cache[HANDLER_PATH];
};

const fakeRequest = ({ method = "POST", body = VALID_INPUT } = {}) => ({ method, body });

const fakeResponse = () => {
  const res = {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(payload) {
      this.body = payload ? JSON.parse(payload) : null;
    },
  };
  return res;
};

test("handler rejects non-POST methods", async (t) => {
  const handler = stubLib();
  t.after(restoreLib);

  const res = fakeResponse();
  await handler(fakeRequest({ method: "GET" }), res);

  assert.equal(res.statusCode, 405);
  assert.equal(res.body.ok, false);
});

test("handler returns 400 with field errors for invalid input", async (t) => {
  const handler = stubLib();
  t.after(restoreLib);

  const res = fakeResponse();
  await handler(fakeRequest({ body: { title: "only a title" } }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
  assert.ok(Array.isArray(res.body.errors) && res.body.errors.length > 0);
});

test("handler returns 409 when Etsy is not connected", async (t) => {
  const handler = stubLib({ getStoredToken: async () => null });
  t.after(restoreLib);

  const res = fakeResponse();
  await handler(fakeRequest(), res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.connected, false);
});

test("handler returns 409 when the stored token has no shop", async (t) => {
  const handler = stubLib({
    getStoredToken: async () => ({ accessToken: "t", shopId: null }),
  });
  t.after(restoreLib);

  const res = fakeResponse();
  await handler(fakeRequest(), res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.shopId, null);
});

test("handler posts the built payload to Etsy and returns a normalized 201", async (t) => {
  let capturedPath;
  let capturedAccessToken;
  let capturedOptions;

  const handler = stubLib({
    fetchEtsyJson: async (path, accessToken, options) => {
      capturedPath = path;
      capturedAccessToken = accessToken;
      capturedOptions = options;
      return {
        listing_id: 999888777,
        state: "draft",
        title: VALID_INPUT.title,
        type: "download",
        quantity: 1,
        price: { amount: 499, divisor: 100, currency_code: "USD" },
        url: "https://www.etsy.com/listing/999888777",
      };
    },
  });
  t.after(restoreLib);

  const res = fakeResponse();
  await handler(fakeRequest(), res);

  assert.equal(capturedPath, "/shops/64473522/listings");
  assert.equal(capturedAccessToken, "token-123");
  assert.equal(capturedOptions.method, "POST");
  assert.equal(capturedOptions.headers["Content-Type"], "application/json");

  const sentPayload = JSON.parse(capturedOptions.body);
  assert.equal(sentPayload.title, VALID_INPUT.title);
  assert.equal(sentPayload.taxonomy_id, 68887);
  assert.equal(sentPayload.type, "download");

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.shopId, 64473522);
  assert.equal(res.body.listing.listingId, 999888777);
  assert.equal(res.body.listing.state, "draft");
});

test("handler surfaces Etsy rejection errors as 502 with diagnostic detail", async (t) => {
  const handler = stubLib({
    fetchEtsyJson: async () => {
      const error = new Error("Etsy API request failed.");
      error.status = 400;
      error.etsy = { category: "invalid_request", message: "taxonomy_id is invalid" };
      throw error;
    },
  });
  t.after(restoreLib);

  const res = fakeResponse();
  await handler(fakeRequest(), res);

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.etsy.category, "invalid_request");
});
