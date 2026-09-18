const test = require("node:test");
const assert = require("node:assert/strict");

const LIB_PATH = require.resolve("../api/_lib/etsy-oauth");
const HANDLER_PATH = require.resolve("../api/etsy-listing-file-upload");

const TEST_ZIP_CONTENT_BASE64 = Buffer.from("PK\x03\x04 fake but non-empty test zip bytes").toString("base64");

const VALID_INPUT = {
  listingId: 4577566790,
  fileBase64: TEST_ZIP_CONTENT_BASE64,
  fileName: "dragon-oak-test-download.zip",
  rank: 1,
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
  await handler(fakeRequest({ body: { listingId: 4577566790 } }), res);

  assert.equal(res.statusCode, 400);
  assert.ok(res.body.errors.includes("Provide either fileBase64 or fileUrl."));
});

test("handler returns 400 for an unsupported extension", async (t) => {
  const handler = stubLib();
  t.after(restoreLib);

  const res = fakeResponse();
  await handler(fakeRequest({ body: { ...VALID_INPUT, fileName: "not-allowed.exe" } }), res);

  assert.equal(res.statusCode, 400);
  assert.ok(res.body.errors.some((error) => error.startsWith("fileName must end in one of")));
});

test("handler returns 400 when the file cannot be decoded", async (t) => {
  const handler = stubLib();
  t.after(restoreLib);

  const res = fakeResponse();
  await handler(fakeRequest({ body: { ...VALID_INPUT, fileBase64: " " } }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, "fileBase64 decoded to an empty file.");
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
        listing_file_id: 999111,
        listing_id: 4577566790,
        rank: 1,
        filename: "dragon-oak-test-download.zip",
        filesize: "1",
        filesize_unit: "kb",
        create_timestamp: 1789700000,
      };
    },
  });
  t.after(restoreLib);

  const res = fakeResponse();
  await handler(fakeRequest(), res);

  assert.equal(capturedPath, "/shops/64473522/listings/4577566790/files");
  assert.equal(capturedAccessToken, "token-123");
  assert.equal(capturedOptions.method, "POST");
  assert.ok(capturedOptions.body instanceof FormData);
  assert.equal(capturedOptions.headers, undefined);

  assert.equal(capturedOptions.body.get("name"), "dragon-oak-test-download.zip");
  const uploadedFile = capturedOptions.body.get("file");
  assert.ok(uploadedFile instanceof Blob);
  assert.equal(uploadedFile.name, "dragon-oak-test-download.zip");

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.listingId, 4577566790);
  assert.equal(res.body.file.listingFileId, 999111);
  assert.equal(res.body.file.filename, "dragon-oak-test-download.zip");
});

test("handler surfaces Etsy rejection errors as 502 with diagnostic detail", async (t) => {
  const handler = stubLib({
    fetchEtsyJson: async () => {
      const error = new Error("Etsy API request failed.");
      error.status = 400;
      error.etsy = { category: "invalid_request", message: "file is too large" };
      throw error;
    },
  });
  t.after(restoreLib);

  const res = fakeResponse();
  await handler(fakeRequest(), res);

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.etsy.category, "invalid_request");
});

test("handler fetches a Cloudinary fileUrl server-side and uploads those bytes to Etsy", async (t) => {
  const remoteBytes = Buffer.from("remote fetched zip bytes");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, "https://res.cloudinary.com/dragon-oak/raw/upload/v1/set01.zip");
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/zip" },
      arrayBuffer: async () => remoteBytes.buffer.slice(remoteBytes.byteOffset, remoteBytes.byteOffset + remoteBytes.byteLength),
    };
  };

  let capturedOptions;
  const handler = stubLib({
    fetchEtsyJson: async (path, accessToken, options) => {
      capturedOptions = options;
      return {
        listing_file_id: 555444,
        listing_id: 4577566790,
        rank: 1,
        filename: "dragon-oak-set01.zip",
        create_timestamp: 1789700000,
      };
    },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
    restoreLib();
  });

  const res = fakeResponse();
  await handler(
    fakeRequest({
      body: {
        listingId: 4577566790,
        fileUrl: "https://res.cloudinary.com/dragon-oak/raw/upload/v1/set01.zip",
        fileName: "dragon-oak-set01.zip",
        rank: 1,
      },
    }),
    res
  );

  const uploadedFile = capturedOptions.body.get("file");
  const roundTripped = Buffer.from(await uploadedFile.arrayBuffer());
  assert.ok(roundTripped.equals(remoteBytes));

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.file.listingFileId, 555444);
});

test("handler returns 400 when fileUrl host is not the allowed Cloudinary host", async (t) => {
  const handler = stubLib();
  t.after(restoreLib);

  const res = fakeResponse();
  await handler(
    fakeRequest({
      body: {
        listingId: 4577566790,
        fileUrl: "https://evil.example.com/set01.zip",
        fileName: "dragon-oak-set01.zip",
      },
    }),
    res
  );

  assert.equal(res.statusCode, 400);
  assert.ok(res.body.errors.some((error) => error.startsWith("fileUrl host must be one of")));
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
