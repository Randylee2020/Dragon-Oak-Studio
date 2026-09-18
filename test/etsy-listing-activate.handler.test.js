const test = require("node:test");
const assert = require("node:assert/strict");

const LIB_PATH = require.resolve("../api/lib/etsy-oauth");
const HANDLER_PATH = require.resolve("../api/etsy-listing-activate");

const VALID_INPUT = { listingId: 4577566790 };

const stubLib = (overrides = {}) => {
  const stub = {
    getRequiredConfig: () => ({ ok: true, apiKey: "k", sharedSecret: "s", databaseUrl: "postgres://x" }),
    getPgClient: async () => ({ end: async () => {} }),
    getStoredToken: async () => ({
      accessToken: "token-123",
      shopId: 64473522,
      userId: "965241607",
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
  await handler(fakeRequest({ body: {} }), res);

  assert.equal(res.statusCode, 400);
  assert.ok(res.body.errors.includes("Missing required field: listingId"));
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
  const handler = stubLib({ getStoredToken: async () => ({ accessToken: "t", shopId: null }) });
  t.after(restoreLib);

  const res = fakeResponse();
  await handler(fakeRequest(), res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.shopId, null);
});

test("handler returns 404 when the precondition GET cannot find the listing", async (t) => {
  const handler = stubLib({
    fetchEtsyJson: async () => {
      const error = new Error("Etsy API request failed.");
      error.status = 404;
      throw error;
    },
  });
  t.after(restoreLib);

  const res = fakeResponse();
  await handler(fakeRequest(), res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.listingId, 4577566790);
});

test("handler refuses to activate a listing that is not currently draft", async (t) => {
  let callCount = 0;
  const handler = stubLib({
    fetchEtsyJson: async (path, accessToken, options) => {
      callCount += 1;
      assert.equal(options, undefined, "the precondition check must be a plain GET");
      return { listing_id: 4577566790, state: "active" };
    },
  });
  t.after(restoreLib);

  const res = fakeResponse();
  await handler(fakeRequest(), res);

  assert.equal(callCount, 1, "must not proceed to PATCH once the precondition fails");
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.currentState, "active");
  assert.match(res.body.message, /not in draft state/);
});

test("handler GETs the listing, confirms draft state, then PATCHes it active", async (t) => {
  const calls = [];

  const handler = stubLib({
    fetchEtsyJson: async (path, accessToken, options) => {
      calls.push({ path, accessToken, options });
      if (calls.length === 1) {
        return { listing_id: 4577566790, state: "draft" };
      }
      return {
        listing_id: 4577566790,
        state: "active",
        title: "Halloween Ceramic Coaster",
        url: "https://www.etsy.com/listing/4577566790/halloween-ceramic-coaster",
      };
    },
  });
  t.after(restoreLib);

  const res = fakeResponse();
  await handler(fakeRequest(), res);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, "/shops/64473522/listings/4577566790");
  assert.equal(calls[0].options, undefined);
  assert.equal(calls[1].path, "/shops/64473522/listings/4577566790");
  assert.equal(calls[1].options.method, "PATCH");
  assert.equal(calls[1].options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[1].options.body), { state: "active" });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.listing.listingId, 4577566790);
  assert.equal(res.body.listing.state, "active");
  assert.equal(res.body.listing.url, "https://www.etsy.com/listing/4577566790/halloween-ceramic-coaster");
});

test("handler surfaces Etsy rejection errors from the activation PATCH as 502", async (t) => {
  const handler = stubLib({
    fetchEtsyJson: async (path, accessToken, options) => {
      if (!options) {
        return { listing_id: 4577566790, state: "draft" };
      }
      const error = new Error("Etsy API request failed.");
      error.status = 400;
      error.etsy = { category: "invalid_request", message: "listing is missing a required field" };
      throw error;
    },
  });
  t.after(restoreLib);

  const res = fakeResponse();
  await handler(fakeRequest(), res);

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.etsy.category, "invalid_request");
});
