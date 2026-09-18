const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validateImageInput,
  decodeImageBuffer,
  inferExtension,
  buildUploadForm,
  normalizeListingImage,
} = require("../api/etsy-listing-image-upload");

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const VALID_INPUT = {
  listingId: 4577566790,
  imageBase64: ONE_PIXEL_PNG_BASE64,
  mimeType: "image/png",
  fileName: "preview.png",
};

test("validateImageInput accepts a minimal valid payload", () => {
  assert.deepEqual(validateImageInput(VALID_INPUT), []);
});

test("validateImageInput rejects a non-object body", () => {
  assert.deepEqual(validateImageInput(null), ["Request body must be a JSON object."]);
  assert.deepEqual(validateImageInput([1, 2]), ["Request body must be a JSON object."]);
});

test("validateImageInput requires listingId and imageBase64", () => {
  const errors = validateImageInput({});
  assert.ok(errors.includes("Missing required field: listingId"));
  assert.ok(errors.includes("Missing required field: imageBase64"));
});

test("validateImageInput rejects a non-positive listingId", () => {
  const errors = validateImageInput({ ...VALID_INPUT, listingId: 0 });
  assert.ok(errors.includes("listingId must be a positive number."));
});

test("validateImageInput rejects a non-positive rank", () => {
  const errors = validateImageInput({ ...VALID_INPUT, rank: -1 });
  assert.ok(errors.includes("rank must be a positive number."));
});

test("validateImageInput rejects non-boolean overwrite/isWatermarked", () => {
  const errors = validateImageInput({ ...VALID_INPUT, overwrite: "yes", isWatermarked: 1 });
  assert.ok(errors.includes("overwrite must be a boolean."));
  assert.ok(errors.includes("isWatermarked must be a boolean."));
});

test("validateImageInput rejects altText over 250 characters", () => {
  const errors = validateImageInput({ ...VALID_INPUT, altText: "x".repeat(251) });
  assert.ok(errors.includes("altText must be 250 characters or fewer."));
});

test("decodeImageBuffer decodes a plain base64 string", () => {
  const result = decodeImageBuffer(VALID_INPUT);
  assert.equal(result.error, undefined);
  assert.ok(Buffer.isBuffer(result.buffer));
  assert.ok(result.buffer.length > 0);
  assert.equal(result.mimeType, "image/png");
});

test("decodeImageBuffer strips a data: URL prefix and infers mimeType from it", () => {
  const result = decodeImageBuffer({
    imageBase64: `data:image/jpeg;base64,${ONE_PIXEL_PNG_BASE64}`,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.mimeType, "image/jpeg");
  assert.ok(result.buffer.length > 0);
});

test("decodeImageBuffer rejects an unsupported mimeType", () => {
  const result = decodeImageBuffer({ ...VALID_INPUT, mimeType: "image/webp" });
  assert.ok(result.error.startsWith("mimeType must be one of"));
});

test("decodeImageBuffer rejects an empty decoded payload", () => {
  const result = decodeImageBuffer({ imageBase64: "" });
  assert.equal(result.error, "imageBase64 decoded to an empty file.");
});

test("decodeImageBuffer rejects a payload over the size limit", () => {
  const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 1).toString("base64");
  const result = decodeImageBuffer({ imageBase64: oversized, mimeType: "image/png" });
  assert.ok(result.error.includes("exceeds"));
});

test("inferExtension prefers the mimeType mapping over the filename", () => {
  assert.equal(inferExtension("image/png", "photo.JPG"), "png");
  assert.equal(inferExtension("image/jpeg", undefined), "jpg");
});

test("inferExtension falls back to the filename extension, then jpg", () => {
  assert.equal(inferExtension(undefined, "art.gif"), "gif");
  assert.equal(inferExtension(undefined, undefined), "jpg");
});

test("buildUploadForm attaches the image blob and optional fields", async () => {
  const decoded = decodeImageBuffer(VALID_INPUT);
  const form = buildUploadForm(decoded.buffer, decoded.mimeType, {
    ...VALID_INPUT,
    rank: 2,
    overwrite: true,
    isWatermarked: false,
    altText: "Dragon Oak preview mockup",
  });

  const image = form.get("image");
  assert.ok(image instanceof Blob);
  assert.equal(image.type, "image/png");
  assert.equal(image.name, "preview.png");
  const roundTripped = Buffer.from(await image.arrayBuffer());
  assert.ok(roundTripped.equals(decoded.buffer));

  assert.equal(form.get("rank"), "2");
  assert.equal(form.get("overwrite"), "true");
  assert.equal(form.get("is_watermarked"), "false");
  assert.equal(form.get("alt_text"), "Dragon Oak preview mockup");
});

test("buildUploadForm omits optional fields that were not provided", () => {
  const decoded = decodeImageBuffer(VALID_INPUT);
  const form = buildUploadForm(decoded.buffer, decoded.mimeType, VALID_INPUT);

  assert.equal(form.get("rank"), null);
  assert.equal(form.get("overwrite"), null);
  assert.equal(form.get("is_watermarked"), null);
  assert.equal(form.get("alt_text"), null);
});

test("buildUploadForm derives a filename from the mimeType when none is given", () => {
  const decoded = decodeImageBuffer(VALID_INPUT);
  const form = buildUploadForm(decoded.buffer, decoded.mimeType, { ...VALID_INPUT, fileName: undefined });
  const image = form.get("image");
  assert.equal(image.name, "upload.png");
});

test("normalizeListingImage maps Etsy's snake_case fields", () => {
  const normalized = normalizeListingImage({
    listing_image_id: 555,
    listing_id: 4577566790,
    rank: 1,
    url_fullxfull: "https://example.test/full.jpg",
    url_570xN: "https://example.test/570.jpg",
    url_170x135: "https://example.test/170.jpg",
    url_75x75: "https://example.test/75.jpg",
    full_width: 2000,
    full_height: 2000,
    alt_text: "Preview",
    created_timestamp: 1737072000,
  });

  assert.equal(normalized.listingImageId, 555);
  assert.equal(normalized.listingId, 4577566790);
  assert.equal(normalized.urlFullxfull, "https://example.test/full.jpg");
  assert.equal(normalized.createdTimestamp, 1737072000);
});

test("normalizeListingImage defaults missing url/alt fields to null", () => {
  const normalized = normalizeListingImage({ listing_image_id: 1, listing_id: 2, rank: 1 });
  assert.equal(normalized.urlFullxfull, null);
  assert.equal(normalized.altText, null);
  assert.equal(normalized.createdTimestamp, null);
});
