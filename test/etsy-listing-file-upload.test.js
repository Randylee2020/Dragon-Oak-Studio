const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validateFileInput,
  decodeFileBuffer,
  buildUploadForm,
  normalizeListingFile,
  getExtension,
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

test("validateFileInput requires listingId, fileBase64, and fileName", () => {
  const errors = validateFileInput({});
  assert.ok(errors.includes("Missing required field: listingId"));
  assert.ok(errors.includes("Missing required field: fileBase64"));
  assert.ok(errors.some((error) => error.startsWith("Missing required field: fileName")));
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
