const test = require("node:test");
const { testAuthHeaders } = require("./_bridge-auth-test-helper");
const assert = require("node:assert/strict");

const LIB_PATH = require.resolve("../api/_lib/etsy-oauth");
const HANDLER_PATH = require.resolve("../api/etsy-listing-image-upload");

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const VALID_INPUT = {
  listingId: 4577566790,
  imageBase64: ONE_PIXEL_PNG_BASE64,
  mimeType: "image/png",
  fileName: "preview.png",
  rank: 1,
  altText: "Dragon Oak preview mockup",
};

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

const fakeRequest = ({ method = "POST", body = VALID_INPUT } = {}) => ({ method, body, headers: testAuthHeaders() });

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
  await handler(fakeRequest({ body: { listingId: 4577566790 } }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
  assert.ok(res.body.errors.includes("Missing required field: imageBase64"));
});

test("handler returns 400 when the image cannot be decoded", async (t) => {
  const handler = stubLib();
  t.after(restoreLib);

  const res = fakeResponse();
  await handler(fakeRequest({ body: { ...VALID_INPUT, imageBase64: " " } }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, "imageBase64 decoded to an empty file.");
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

test("handler uploads a multipart form to the correct Etsy path and returns a normalized 201", async (t) => {
  let capturedPath;
  let capturedAccessToken;
  let capturedOptions;

  const handler = stubLib({
    fetchEtsyJson: async (path, accessToken, options) => {
      capturedPath = path;
      capturedAccessToken = accessToken;
      capturedOptions = options;
      return {
        listing_image_id: 111222333,
        listing_id: 4577566790,
        rank: 1,
        url_fullxfull: "https://example.test/full.jpg",
        alt_text: "Dragon Oak preview mockup",
        created_timestamp: 1789700000,
      };
    },
  });
  t.after(restoreLib);

  const res = fakeResponse();
  await handler(fakeRequest(), res);

  assert.equal(capturedPath, "/shops/64473522/listings/4577566790/images");
  assert.equal(capturedAccessToken, "token-123");
  assert.equal(capturedOptions.method, "POST");
  assert.ok(capturedOptions.body instanceof FormData);
  assert.equal(capturedOptions.headers, undefined);

  const uploadedImage = capturedOptions.body.get("image");
  assert.ok(uploadedImage instanceof Blob);
  assert.equal(uploadedImage.name, "preview.png");
  assert.equal(capturedOptions.body.get("alt_text"), "Dragon Oak preview mockup");

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.shopId, 64473522);
  assert.equal(res.body.listingId, 4577566790);
  assert.equal(res.body.image.listingImageId, 111222333);
  assert.equal(res.body.image.urlFullxfull, "https://example.test/full.jpg");
});

test("handler surfaces Etsy rejection errors as 502 with diagnostic detail", async (t) => {
  const handler = stubLib({
    fetchEtsyJson: async () => {
      const error = new Error("Etsy API request failed.");
      error.status = 400;
      error.etsy = { category: "invalid_request", message: "rank is invalid" };
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

test("handler surfaces a 404 when Etsy cannot find the listing", async (t) => {
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
});
