const {
  fetchEtsyJson,
  getPgClient,
  getRequiredConfig,
  getStoredToken,
} = require("./_lib/etsy-oauth");
const { createSignedUpload } = require("./_lib/cloudinary");

const json = (response, statusCode, payload) => {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
};

// Etsy's documented digital-download limit: 20MB per file, up to 5 files per listing.
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ALLOWED_EXTENSION_MIME_TYPES = new Map([
  ["zip", "application/zip"],
  ["png", "image/png"],
]);
const DATA_URL_PATTERN = /^data:([^;]+);base64,(.*)$/s;

// Files delivered by fileUrl are fetched server-side, so the host is restricted to the
// existing Cloudinary account this project already uploads reference files to (see
// api/reference-upload.js) rather than allowing arbitrary caller-supplied URLs.
const ALLOWED_URL_HOSTS = new Set(["res.cloudinary.com"]);

// A separate Cloudinary folder/signing path from api/reference-upload.js (which is
// intentionally left untouched, including its 5MB cap for the public project-inquiry
// form). This one is sized for full-resolution production digital-download files.
const ETSY_DIGITAL_FILES_FOLDER = "dragon-oak/etsy-digital-files";
const CLOUDINARY_RESOURCE_TYPES_BY_EXTENSION = new Map([
  ["png", "image"],
  ["zip", "raw"],
]);

const isBlank = (value) => value === undefined || value === null || value === "";

const getExtension = (fileName) => {
  const extension = String(fileName || "").trim().split(".").pop();
  return extension ? extension.toLowerCase() : "";
};

const parseHttpsUrl = (value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
};

const validateFileInput = (input) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return ["Request body must be a JSON object."];
  }

  const errors = [];

  if (isBlank(input.listingId)) {
    errors.push("Missing required field: listingId");
  } else if (!Number.isFinite(Number(input.listingId)) || Number(input.listingId) <= 0) {
    errors.push("listingId must be a positive number.");
  }

  const hasBase64 = !isBlank(input.fileBase64) && typeof input.fileBase64 === "string";
  const hasUrl = !isBlank(input.fileUrl) && typeof input.fileUrl === "string";

  if (!hasBase64 && !hasUrl) {
    errors.push("Provide either fileBase64 or fileUrl.");
  } else if (hasBase64 && hasUrl) {
    errors.push("Provide only one of fileBase64 or fileUrl, not both.");
  } else if (hasUrl) {
    const parsed = parseHttpsUrl(input.fileUrl);
    if (!parsed) {
      errors.push("fileUrl must be a valid https URL.");
    } else if (!ALLOWED_URL_HOSTS.has(parsed.hostname)) {
      errors.push(`fileUrl host must be one of: ${[...ALLOWED_URL_HOSTS].join(", ")}`);
    }
  }

  if (isBlank(input.fileName) || typeof input.fileName !== "string") {
    errors.push("Missing required field: fileName (the customer-facing download filename)");
  } else if (!ALLOWED_EXTENSION_MIME_TYPES.has(getExtension(input.fileName))) {
    errors.push(`fileName must end in one of: ${[...ALLOWED_EXTENSION_MIME_TYPES.keys()].map((ext) => `.${ext}`).join(", ")}`);
  }

  if (!isBlank(input.rank) && (!Number.isFinite(Number(input.rank)) || Number(input.rank) <= 0)) {
    errors.push("rank must be a positive number.");
  }

  return errors;
};

const decodeFileBuffer = (input) => {
  const raw = String(input.fileBase64 || "");
  const match = raw.match(DATA_URL_PATTERN);
  const base64 = match ? match[2] : raw;
  const extension = getExtension(input.fileName);
  const mimeType = String(input.mimeType || ALLOWED_EXTENSION_MIME_TYPES.get(extension) || "").toLowerCase();

  let buffer;
  try {
    buffer = Buffer.from(base64, "base64");
  } catch {
    return { error: "fileBase64 is not valid base64 data." };
  }

  if (!buffer.length) {
    return { error: "fileBase64 decoded to an empty file." };
  }

  if (buffer.length > MAX_FILE_BYTES) {
    return { error: `File exceeds Etsy's ${MAX_FILE_BYTES / (1024 * 1024)}MB digital file limit.` };
  }

  return { buffer, mimeType };
};

const fetchRemoteFileBuffer = async (input) => {
  let response;
  try {
    response = await fetch(input.fileUrl);
  } catch (error) {
    return { error: `Unable to fetch fileUrl: ${error.message}` };
  }

  if (!response.ok) {
    return { error: `fileUrl request failed with HTTP ${response.status}` };
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (!buffer.length) {
    return { error: "fileUrl resolved to an empty file." };
  }

  if (buffer.length > MAX_FILE_BYTES) {
    return { error: `File exceeds Etsy's ${MAX_FILE_BYTES / (1024 * 1024)}MB digital file limit.` };
  }

  const extension = getExtension(input.fileName);
  const contentType = response.headers.get("content-type");
  const mimeType = String(
    input.mimeType || contentType || ALLOWED_EXTENSION_MIME_TYPES.get(extension) || ""
  ).toLowerCase();

  return { buffer, mimeType };
};

// Resolves the file bytes from whichever source the caller provided. fileUrl is fetched
// server-side (not subject to Vercel's ~4.5MB inbound request body limit, unlike relaying
// the bytes through this function's own JSON request body via fileBase64).
const resolveFileBuffer = (input) =>
  isBlank(input.fileUrl) ? Promise.resolve(decodeFileBuffer(input)) : fetchRemoteFileBuffer(input);

const buildUploadForm = (buffer, mimeType, input) => {
  const form = new FormData();
  const blob = new Blob([buffer], { type: mimeType || "application/octet-stream" });

  form.append("file", blob, input.fileName);
  form.append("name", input.fileName);

  if (!isBlank(input.rank)) {
    form.append("rank", String(Number(input.rank)));
  }

  return form;
};

const normalizeListingFile = (file) => ({
  listingFileId: file.listing_file_id,
  listingId: file.listing_id,
  rank: file.rank,
  filename: file.filename || file.name || null,
  filesize: file.filesize || null,
  filesizeUnit: file.filesize_unit || null,
  fileType: file.file_type || null,
  createdTimestamp: file.create_timestamp || file.created_timestamp || null,
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

// Validates a { action: "sign-upload", fileName, mimeType } request and returns the
// Cloudinary resourceType to sign for, independent of any Etsy connection state.
const validateSignUploadInput = (input) => {
  if (isBlank(input.fileName) || typeof input.fileName !== "string") {
    return { errors: ["Missing required field: fileName"] };
  }

  const extension = getExtension(input.fileName);
  const resourceType = CLOUDINARY_RESOURCE_TYPES_BY_EXTENSION.get(extension);

  if (!resourceType) {
    return {
      errors: [`fileName must end in one of: ${[...ALLOWED_EXTENSION_MIME_TYPES.keys()].map((ext) => `.${ext}`).join(", ")}`],
    };
  }

  return { errors: [], resourceType };
};

module.exports = async function etsyListingFileUploadHandler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return json(response, 405, {
      ok: false,
      message: "Method not allowed.",
    });
  }

  const input = getRequestBody(request);

  if (input === null) {
    return json(response, 400, {
      ok: false,
      message: "Request body must be valid JSON.",
    });
  }

  if (input && input.action === "sign-upload") {
    const { errors, resourceType } = validateSignUploadInput(input);

    if (errors.length) {
      return json(response, 400, { ok: false, message: "Invalid sign-upload input.", errors });
    }

    const signed = createSignedUpload({
      fileName: input.fileName,
      resourceType,
      folder: ETSY_DIGITAL_FILES_FOLDER,
    });

    if (!signed.ok) {
      return json(response, 500, { ok: false, message: signed.error || "Unable to sign Cloudinary upload." });
    }

    return json(response, 200, signed);
  }

  const config = getRequiredConfig();

  if (!config.ok) {
    return json(response, 500, {
      ok: false,
      message: "Etsy connection is not configured.",
    });
  }

  const validationErrors = validateFileInput(input);

  if (validationErrors.length) {
    return json(response, 400, {
      ok: false,
      message: "Invalid digital file input.",
      errors: validationErrors,
    });
  }

  const decoded = await resolveFileBuffer(input);

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
        message: "Etsy is not connected. Complete OAuth before uploading digital files.",
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

    const file = await fetchEtsyJson(`/shops/${token.shopId}/listings/${listingId}/files`, token.accessToken, {
      method: "POST",
      body: form,
    });

    return json(response, 201, {
      ok: true,
      connected: true,
      shopId: token.shopId,
      listingId,
      file: normalizeListingFile(file),
    });
  } catch (error) {
    console.error("Etsy digital file upload failed:", error.message);

    if (error.status) {
      return json(response, error.status === 404 ? 404 : 502, {
        ok: false,
        connected: true,
        message: "Etsy rejected the digital file upload.",
        etsy: error.etsy || null,
        status: error.status,
      });
    }

    return json(response, 500, {
      ok: false,
      message: "Unable to upload the Etsy digital listing file.",
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

module.exports.validateFileInput = validateFileInput;
module.exports.decodeFileBuffer = decodeFileBuffer;
module.exports.fetchRemoteFileBuffer = fetchRemoteFileBuffer;
module.exports.resolveFileBuffer = resolveFileBuffer;
module.exports.buildUploadForm = buildUploadForm;
module.exports.normalizeListingFile = normalizeListingFile;
module.exports.getExtension = getExtension;
module.exports.parseHttpsUrl = parseHttpsUrl;
module.exports.validateSignUploadInput = validateSignUploadInput;
