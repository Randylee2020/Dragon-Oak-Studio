const {
  fetchEtsyJson,
  getPgClient,
  getRequiredConfig,
  getStoredToken,
} = require("./lib/etsy-oauth");

const json = (response, statusCode, payload) => {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
};

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_EXTENSIONS = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/gif", "gif"],
]);
const DATA_URL_PATTERN = /^data:([^;]+);base64,(.*)$/s;

const isBlank = (value) => value === undefined || value === null || value === "";

const validateImageInput = (input) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return ["Request body must be a JSON object."];
  }

  const errors = [];

  if (isBlank(input.listingId)) {
    errors.push("Missing required field: listingId");
  } else if (!Number.isFinite(Number(input.listingId)) || Number(input.listingId) <= 0) {
    errors.push("listingId must be a positive number.");
  }

  if (isBlank(input.imageBase64) || typeof input.imageBase64 !== "string") {
    errors.push("Missing required field: imageBase64");
  }

  if (!isBlank(input.rank) && (!Number.isFinite(Number(input.rank)) || Number(input.rank) <= 0)) {
    errors.push("rank must be a positive number.");
  }

  if (!isBlank(input.overwrite) && typeof input.overwrite !== "boolean") {
    errors.push("overwrite must be a boolean.");
  }

  if (!isBlank(input.isWatermarked) && typeof input.isWatermarked !== "boolean") {
    errors.push("isWatermarked must be a boolean.");
  }

  if (!isBlank(input.altText) && String(input.altText).length > 250) {
    errors.push("altText must be 250 characters or fewer.");
  }

  return errors;
};

const decodeImageBuffer = (input) => {
  const raw = String(input.imageBase64 || "");
  const match = raw.match(DATA_URL_PATTERN);
  const base64 = match ? match[2] : raw;
  const mimeType = String(input.mimeType || (match ? match[1] : "") || "").toLowerCase();

  let buffer;
  try {
    buffer = Buffer.from(base64, "base64");
  } catch {
    return { error: "imageBase64 is not valid base64 data." };
  }

  if (!buffer.length) {
    return { error: "imageBase64 decoded to an empty file." };
  }

  if (buffer.length > MAX_IMAGE_BYTES) {
    return { error: `Image exceeds the ${MAX_IMAGE_BYTES / (1024 * 1024)}MB upload limit.` };
  }

  if (mimeType && !ALLOWED_MIME_EXTENSIONS.has(mimeType)) {
    return { error: `mimeType must be one of: ${[...ALLOWED_MIME_EXTENSIONS.keys()].join(", ")}` };
  }

  return { buffer, mimeType };
};

const inferExtension = (mimeType, fileName) => {
  const fromMime = ALLOWED_MIME_EXTENSIONS.get(String(mimeType || "").toLowerCase());
  if (fromMime) {
    return fromMime;
  }
  const extension = String(fileName || "").split(".").pop();
  return extension ? extension.toLowerCase() : "jpg";
};

const buildUploadForm = (buffer, mimeType, input) => {
  const form = new FormData();
  const extension = inferExtension(mimeType, input.fileName);
  const fileName = input.fileName || `upload.${extension}`;
  const blob = new Blob([buffer], { type: mimeType || "application/octet-stream" });

  form.append("image", blob, fileName);

  if (!isBlank(input.rank)) {
    form.append("rank", String(Number(input.rank)));
  }
  if (!isBlank(input.overwrite)) {
    form.append("overwrite", String(Boolean(input.overwrite)));
  }
  if (!isBlank(input.isWatermarked)) {
    form.append("is_watermarked", String(Boolean(input.isWatermarked)));
  }
  if (!isBlank(input.altText)) {
    form.append("alt_text", String(input.altText));
  }

  return form;
};

const normalizeListingImage = (image) => ({
  listingImageId: image.listing_image_id,
  listingId: image.listing_id,
  rank: image.rank,
  urlFullxfull: image.url_fullxfull || null,
  url570xN: image.url_570xN || null,
  url170x135: image.url_170x135 || null,
  url75x75: image.url_75x75 || null,
  fullWidth: image.full_width || null,
  fullHeight: image.full_height || null,
  altText: image.alt_text || null,
  createdTimestamp: image.created_timestamp || image.creation_tsz || null,
});

const getRequestBody = (request) => {
  if (request.body === undefined || request.body === null) {
    return {};
  }
  if (typeof request.body === "string") {
    try {
      return JSON.parse(request.body || "{}");
    } catch {
      return null;
    }
  }
  return request.body;
};

module.exports = async function etsyListingImageUploadHandler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return json(response, 405, {
      ok: false,
      message: "Method not allowed.",
    });
  }

  const config = getRequiredConfig();

  if (!config.ok) {
    return json(response, 500, {
      ok: false,
      message: "Etsy connection is not configured.",
    });
  }

  const input = getRequestBody(request);

  if (input === null) {
    return json(response, 400, {
      ok: false,
      message: "Request body must be valid JSON.",
    });
  }

  const validationErrors = validateImageInput(input);

  if (validationErrors.length) {
    return json(response, 400, {
      ok: false,
      message: "Invalid listing image input.",
      errors: validationErrors,
    });
  }

  const decoded = decodeImageBuffer(input);

  if (decoded.error) {
    return json(response, 400, {
      ok: false,
      message: decoded.error,
    });
  }

  let client;

  try {
    client = await getPgClient();

    const token = await getStoredToken(client);

    if (!token) {
      return json(response, 409, {
        ok: false,
        connected: false,
        message: "Etsy is not connected. Complete OAuth before uploading listing images.",
      });
    }

    if (!token.shopId) {
      return json(response, 409, {
        ok: false,
        connected: true,
        shopId: null,
        message: "Etsy is connected, but no shop is associated with the stored token.",
      });
    }

    const listingId = Number(input.listingId);
    const form = buildUploadForm(decoded.buffer, decoded.mimeType, input);

    const image = await fetchEtsyJson(`/shops/${token.shopId}/listings/${listingId}/images`, token.accessToken, {
      method: "POST",
      body: form,
    });

    return json(response, 201, {
      ok: true,
      connected: true,
      shopId: token.shopId,
      listingId,
      image: normalizeListingImage(image),
    });
  } catch (error) {
    console.error("Etsy listing image upload failed:", error.message);

    if (error.status) {
      return json(response, error.status === 404 ? 404 : 502, {
        ok: false,
        connected: true,
        message: "Etsy rejected the listing image upload.",
        etsy: error.etsy || null,
        status: error.status,
      });
    }

    return json(response, 500, {
      ok: false,
      message: "Unable to upload the Etsy listing image.",
    });
  } finally {
    if (client) {
      try {
        await client.end();
      } catch {
        // Ignore cleanup errors.
      }
    }
  }
};

module.exports.validateImageInput = validateImageInput;
module.exports.decodeImageBuffer = decodeImageBuffer;
module.exports.inferExtension = inferExtension;
module.exports.buildUploadForm = buildUploadForm;
module.exports.normalizeListingImage = normalizeListingImage;
