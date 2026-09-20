const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const LIB_PATH = require.resolve("../api/_lib/etsy-oauth");
const CLOUDINARY_LIB_PATH = require.resolve("../api/_lib/cloudinary");
const HANDLER_PATH = require.resolve("../api/etsy-listing-file-upload");

const UPLOAD_ID = "test_upload_id_0123456789";

// Minimal in-memory stand-in for the etsy_upload_chunks table.
const makeFakeClient = () => {
  const rows = new Map();
  return {
    rows,
    end: async () => {},
    query: async (sql, params = []) => {
      if (/CREATE TABLE/.test(sql)) return { rows: [] };
      if (/DELETE FROM etsy_upload_chunks WHERE created_at/.test(sql)) return { rows: [] };
      if (/SELECT count/.test(sql)) return { rows: [{ n: rows.size }] };
      if (/INSERT INTO etsy_upload_chunks/.test(sql)) {
        rows.set(`${params[0]}:${params[1]}`, { upload_id: params[0], idx: params[1], data: params[2] });
        return { rows: [] };
      }
      if (/SELECT idx, data/.test(sql)) {
        return {
          rows: [...rows.values()].filter((r) => r.upload_id === params[0]).sort((a, b) => a.idx - b.idx),
        };
      }
      if (/DELETE FROM etsy_upload_chunks WHERE upload_id/.test(sql)) {
        for (const key of [...rows.keys()]) if (key.startsWith(`${params[0]}:`)) rows.delete(key);
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
};

const loadHandler = (client, etsyCalls) => {
  const stub = {
    getRequiredConfig: () => ({ ok: true }),
    getPgClient: async () => client,
    getStoredToken: async () => ({ accessToken: "token-123", shopId: 64473522 }),
    fetchEtsyJson: async (path, token, options) => {
      etsyCalls.push({ path, token, options });
      return { listing_file_id: 1, listing_id: 4578818589, rank: 1, filename: "x.zip", filesize: "19 MB" };
    },
  };
  require.cache[LIB_PATH] = { id: LIB_PATH, filename: LIB_PATH, loaded: true, exports: stub };
  require.cache[CLOUDINARY_LIB_PATH] = { id: CLOUDINARY_LIB_PATH, filename: CLOUDINARY_LIB_PATH, loaded: true, exports: {} };
  delete require.cache[HANDLER_PATH];
  return require(HANDLER_PATH);
};

const restore = () => {
  delete require.cache[LIB_PATH];
  delete require.cache[CLOUDINARY_LIB_PATH];
  delete require.cache[HANDLER_PATH];
};

const call = async (handler, body) => {
  const res = { statusCode: null, headers: {}, body: null, setHeader(k, v) { this.headers[k] = v; }, end(payload) { this.body = JSON.parse(payload); } };
  await handler({ method: "POST", body }, res);
  return res;
};

const fileBytes = crypto.randomBytes(3 * 1024 * 1024 + 12345); // spans 2 chunks
const chunks = [fileBytes.subarray(0, 3 * 1024 * 1024), fileBytes.subarray(3 * 1024 * 1024)];
const md5 = crypto.createHash("md5").update(fileBytes).digest("hex");
const finalize = (extra = {}) => ({
  action: "chunk-finalize", uploadId: UPLOAD_ID, totalChunks: 2, listingId: 4578818589,
  fileName: "Part_1_of_5.zip", rank: 1, md5, sizeBytes: fileBytes.length, ...extra,
});
const put = (index, buf, extra = {}) => ({
  action: "chunk-put", uploadId: UPLOAD_ID, index, totalChunks: 2, chunkBase64: buf.toString("base64"), ...extra,
});

test("chunk-put then chunk-finalize assembles the exact bytes and posts one file to Etsy", async () => {
  const client = makeFakeClient();
  const etsyCalls = [];
  const handler = loadHandler(client, etsyCalls);
  try {
    assert.equal((await call(handler, put(0, chunks[0]))).statusCode, 200);
    assert.equal((await call(handler, put(1, chunks[1]))).statusCode, 200);
    const res = await call(handler, finalize());
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.md5, md5);
    assert.equal(etsyCalls.length, 1);
    assert.equal(etsyCalls[0].path, "/shops/64473522/listings/4578818589/files");
    const sent = Buffer.from(await etsyCalls[0].options.body.get("file").arrayBuffer());
    assert.equal(crypto.createHash("md5").update(sent).digest("hex"), md5);
    assert.equal(client.rows.size, 0, "chunks are deleted after a successful upload");
  } finally {
    restore();
  }
});

test("chunk-finalize refuses when a chunk is missing", async () => {
  const client = makeFakeClient();
  const etsyCalls = [];
  const handler = loadHandler(client, etsyCalls);
  try {
    await call(handler, put(0, chunks[0]));
    const res = await call(handler, finalize());
    assert.equal(res.statusCode, 409);
    assert.equal(etsyCalls.length, 0);
  } finally {
    restore();
  }
});

test("chunk-finalize refuses on md5 or size mismatch and never calls Etsy", async () => {
  const client = makeFakeClient();
  const etsyCalls = [];
  const handler = loadHandler(client, etsyCalls);
  try {
    await call(handler, put(0, chunks[0]));
    await call(handler, put(1, chunks[1]));
    assert.equal((await call(handler, finalize({ md5: "0".repeat(32) }))).statusCode, 409);
    assert.equal((await call(handler, finalize({ sizeBytes: fileBytes.length + 1 }))).statusCode, 409);
    assert.equal(etsyCalls.length, 0);
  } finally {
    restore();
  }
});

test("chunk-put validates uploadId, index, and chunk size", async () => {
  const client = makeFakeClient();
  const handler = loadHandler(client, []);
  try {
    assert.equal((await call(handler, put(0, chunks[0], { uploadId: "short" }))).statusCode, 400);
    assert.equal((await call(handler, put(2, chunks[0]))).statusCode, 400);
    assert.equal((await call(handler, put(0, Buffer.alloc(3 * 1024 * 1024 + 1)))).statusCode, 400);
  } finally {
    restore();
  }
});

test("chunk-finalize rejects files above Etsy's 20MB limit and non-png/zip names", async () => {
  const client = makeFakeClient();
  const handler = loadHandler(client, []);
  try {
    assert.equal((await call(handler, finalize({ fileName: "x.exe" }))).statusCode, 400);
    const big = Buffer.alloc(3 * 1024 * 1024, 1);
    for (let i = 0; i < 8; i += 1) await call(handler, put(i, big, { totalChunks: 8 }));
    const total = 8 * big.length; // 24MiB
    const bigMd5 = crypto.createHash("md5").update(Buffer.concat(Array(8).fill(big))).digest("hex");
    const res = await call(handler, finalize({ totalChunks: 8, sizeBytes: total, md5: bigMd5 }));
    assert.equal(res.statusCode, 400);
  } finally {
    restore();
  }
});
