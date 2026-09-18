const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validateFileInput,
  decodeFileBuffer,
  fetchRemoteFileBuffer,
  resolveFileBuffer,
  buildUploadForm,
  normalizeListingFile,
  getExtension,
  parseHttpsUrl,
} = require("../api/etsy-listing-file-upload");

const TEST_ZIP_CONTENT_BASE64 = Buffer.from("PK\x03\x04 fake but non-empty test zip bytes").toString("base64");
const TEST_PNG_CONTENT_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const VALID_ZIP_INPUT = {
  listingId: 4577566790,
  fileBase64: TEST_ZIP_CONTENT_BASE64,
  fileName: "dragon-oak-test-download.zip",
};

const VALID_PNG_INPUT = {
  listingId: 4577566790,
  fileBase64: TEST_PNG_CONTENT_BASE64,
  fileName: "dragon-oak-test-print.png",
};

test("getExtension lowercases and reads the last dotted segment", () => {
  assert.equal(getExtension("Archive.ZIP"), "zip");
  assert.equal(getExtension("print.PNG"), "png");
  assert.equal(getExtension("no-extension"), "no-extension");
  assert.equal(getExtension(""), "");
});

test("validateFileInput accepts a valid zip payload", () => {
  assert.deepEqual(validateFileInput(VALID_ZIP_INPUT), []);
});

test("validateFileInput accepts a valid png payload", () => {
  assert.deepEqual(validateFileInput(VALID_PNG_INPUT), []);
});

test("validateFileInput rejects a non-object body", () => {
  assert.deepEqual(validateFileInput(null), ["Request body must be a JSON object."]);
  assert.deepEqual(validateFileInput([1]), ["Request body must be a JSON object."]);
});

test("validateFileInput requires listingId, a file source, and fileName", () => {
  const errors = validateFileInput({});
  assert.ok(errors.includes("Missing required field: listingId"));
  assert.ok(errors.includes("Provide either fileBase64 or fileUrl."));
  assert.ok(errors.some((error) => error.startsWith("Missing required field: fileName")));
});

test("validateFileInput accepts a fileUrl on the allowed Cloudinary host", () => {
  const errors = validateFileInput({
    listingId: 4577566790,
    fileUrl: "https://res.cloudinary.com/dragon-oak/raw/upload/v1/dragon-oak/set01.zip",
    fileName: "dragon-oak-test-download.zip",
  });
  assert.deepEqual(errors, []);
});

test("validateFileInput rejects providing both fileBase64 and fileUrl", () => {
  const errors = validateFileInput({
    ...VALID_ZIP_INPUT,
    fileUrl: "https://res.cloudinary.com/dragon-oak/raw/upload/v1/dragon-oak/set01.zip",
  });
  assert.ok(errors.includes("Provide only one of fileBase64 or fileUrl, not both."));
});

test("validateFileInput rejects a non-https fileUrl", () => {
  const errors = validateFileInput({
    listingId: 4577566790,
    fileUrl: "http://res.cloudinary.com/dragon-oak/raw/upload/v1/dragon-oak/set01.zip",
    fileName: "dragon-oak-test-download.zip",
  });
  assert.ok(errors.includes("fileUrl must be a valid https URL."));
});

test("validateFileInput rejects a fileUrl on a disallowed host", () => {
  const errors = validateFileInput({
    listingId: 4577566790,
    fileUrl: "https://evil.example.com/set01.zip",
    fileName: "dragon-oak-test-download.zip",
  });
  assert.ok(errors.some((error) => error.startsWith("fileUrl host must be one of")));
});

test("validateFileInput rejects a non-positive listingId", () => {
  const errors = validateFileInput({ ...VALID_ZIP_INPUT, listingId: -5 });
  assert.ok(errors.includes("listingId must be a positive number."));
});

test("validateFileInput rejects an unsupported file extension", () => {
  const errors = validateFileInput({ ...VALID_ZIP_INPUT, fileName: "malware.exe" });
  assert.ok(errors.some((error) => error.startsWith("fileName must end in one of")));
});

test("validateFileInput rejects a non-positive rank", () => {
  const errors = validateFileInput({ ...VALID_ZIP_INPUT, rank: 0 });
  assert.ok(errors.includes("rank must be a positive number."));
});

test("decodeFileBuffer decodes a plain base64 zip and infers application/zip", () => {
  const result = decodeFileBuffer(VALID_ZIP_INPUT);
  assert.equal(result.error, undefined);
  assert.ok(Buffer.isBuffer(result.buffer));
  assert.equal(result.mimeType, "application/zip");
});

test("decodeFileBuffer infers image/png for a .png fileName", () => {
  const result = decodeFileBuffer(VALID_PNG_INPUT);
  assert.equal(result.error, undefined);
  assert.equal(result.mimeType, "image/png");
});

test("decodeFileBuffer honors an explicit mimeType override", () => {
  const result = decodeFileBuffer({ ...VALID_ZIP_INPUT, mimeType: "application/x-zip-compressed" });
  assert.equal(result.mimeType, "application/x-zip-compressed");
});

test("decodeFileBuffer strips a data: URL prefix", () => {
  const result = decodeFileBuffer({
    ...VALID_ZIP_INPUT,
    fileBase64: `data:application/zip;base64,${TEST_ZIP_CONTENT_BASE64}`,
  });
  assert.equal(result.error, undefined);
  assert.ok(result.buffer.length > 0);
});

test("decodeFileBuffer rejects an empty decoded payload", () => {
  const result = decodeFileBuffer({ ...VALID_ZIP_INPUT, fileBase64: " " });
  assert.equal(result.error, "fileBase64 decoded to an empty file.");
});

test("decodeFileBuffer rejects a payload over Etsy's 20MB digital file limit", () => {
  const oversized = Buffer.alloc(20 * 1024 * 1024 + 1, 1).toString("base64");
  const result = decodeFileBuffer({ ...VALID_ZIP_INPUT, fileBase64: oversized });
  assert.ok(result.error.includes("20MB"));
});

test("buildUploadForm attaches the file blob under 'file' and the customer-facing name under 'name'", async () => {
  const decoded = decodeFileBuffer(VALID_ZIP_INPUT);
  const form = buildUploadForm(decoded.buffer, decoded.mimeType, { ...VALID_ZIP_INPUT, rank: 1 });

  const uploaded = form.get("file");
  assert.ok(uploaded instanceof Blob);
  assert.equal(uploaded.name, "dragon-oak-test-download.zip");
  assert.equal(uploaded.type, "application/zip");

  const roundTripped = Buffer.from(await uploaded.arrayBuffer());
  assert.ok(roundTripped.equals(decoded.buffer));

  assert.equal(form.get("name"), "dragon-oak-test-download.zip");
  assert.equal(form.get("rank"), "1");
});

test("buildUploadForm omits rank when not provided", () => {
  const decoded = decodeFileBuffer(VALID_ZIP_INPUT);
  const form = buildUploadForm(decoded.buffer, decoded.mimeType, VALID_ZIP_INPUT);
  assert.equal(form.get("rank"), null);
});

test("normalizeListingFile maps Etsy's snake_case fields", () => {
  const normalized = normalizeListingFile({
    listing_file_id: 777,
    listing_id: 4577566790,
    rank: 1,
    filename: "dragon-oak-test-download.zip",
    filesize: "3",
    filesize_unit: "mb",
    file_type: "zip",
    create_timestamp: 1789700000,
  });

  assert.equal(normalized.listingFileId, 777);
  assert.equal(normalized.listingId, 4577566790);
  assert.equal(normalized.filename, "dragon-oak-test-download.zip");
  assert.equal(normalized.filesizeUnit, "mb");
  assert.equal(normalized.createdTimestamp, 1789700000);
});

test("normalizeListingFile falls back to 'name' when 'filename' is absent", () => {
  const normalized = normalizeListingFile({ listing_file_id: 1, listing_id: 2, name: "fallback.png" });
  assert.equal(normalized.filename, "fallback.png");
});

test("normalizeListingFile defaults missing fields to null", () => {
  const normalized = normalizeListingFile({ listing_file_id: 1, listing_id: 2 });
  assert.equal(normalized.filename, null);
  assert.equal(normalized.filesize, null);
  assert.equal(normalized.createdTimestamp, null);
});

test("parseHttpsUrl accepts https URLs and rejects everything else", () => {
  assert.ok(parseHttpsUrl("https://res.cloudinary.com/x.zip"));
  assert.equal(parseHttpsUrl("http://res.cloudinary.com/x.zip"), null);
  assert.equal(parseHttpsUrl("not a url"), null);
  assert.equal(parseHttpsUrl(""), null);
});

const withStubbedFetch = async (stub, run) => {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
};

test("fetchRemoteFileBuffer downloads the bytes and infers mimeType from Content-Type", async () => {
  const bytes = Buffer.from("fake zip bytes for a remote fetch test");
  await withStubbedFetch(
    async (url) => {
      assert.equal(url, "https://res.cloudinary.com/dragon-oak/raw/upload/v1/set01.zip");
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/zip" },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    },
    async () => {
      const result = await fetchRemoteFileBuffer({
        fileUrl: "https://res.cloudinary.com/dragon-oak/raw/upload/v1/set01.zip",
        fileName: "download.zip",
      });
      assert.equal(result.error, undefined);
      assert.ok(result.buffer.equals(bytes));
      assert.equal(result.mimeType, "application/zip");
    }
  );
});

test("fetchRemoteFileBuffer reports a clear error on a failed HTTP response", async () => {
  await withStubbedFetch(
    async () => ({ ok: false, status: 404 }),
    async () => {
      const result = await fetchRemoteFileBuffer({
        fileUrl: "https://res.cloudinary.com/missing.zip",
        fileName: "download.zip",
      });
      assert.equal(result.error, "fileUrl request failed with HTTP 404");
    }
  );
});

test("fetchRemoteFileBuffer rejects a payload over Etsy's 20MB limit", async () => {
  const oversized = Buffer.alloc(20 * 1024 * 1024 + 1, 1);
  await withStubbedFetch(
    async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "image/png" },
      arrayBuffer: async () => oversized.buffer,
    }),
    async () => {
      const result = await fetchRemoteFileBuffer({
        fileUrl: "https://res.cloudinary.com/huge.png",
        fileName: "huge.png",
      });
      assert.ok(result.error.includes("20MB"));
    }
  );
});

test("resolveFileBuffer uses the base64 path when no fileUrl is given", async () => {
  const result = await resolveFileBuffer(VALID_ZIP_INPUT);
  assert.equal(result.error, undefined);
  assert.ok(Buffer.isBuffer(result.buffer));
});

test("resolveFileBuffer uses the remote-fetch path when fileUrl is given", async () => {
  const bytes = Buffer.from("remote bytes");
  await withStubbedFetch(
    async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/zip" },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }),
    async () => {
      const result = await resolveFileBuffer({
        fileUrl: "https://res.cloudinary.com/set01.zip",
        fileName: "set01.zip",
      });
      assert.ok(result.buffer.equals(bytes));
    }
  );
});
