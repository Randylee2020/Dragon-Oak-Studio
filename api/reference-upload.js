const crypto = require("crypto");

const allowedTypes = new Map([
  ["image/jpeg", { extensions: new Set(["jpg", "jpeg"]), resourceType: "image" }],
  ["image/png", { extensions: new Set(["png"]), resourceType: "image" }],
  ["image/webp", { extensions: new Set(["webp"]), resourceType: "image" }],
  ["application/pdf", { extensions: new Set(["pdf"]), resourceType: "raw" }],
  ["image/svg+xml", { extensions: new Set(["svg"]), resourceType: "raw" }],
]);

const maxFileSize = 5 * 1024 * 1024;

const json = (response, statusCode, payload) => {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
};

const clean = (value) => String(value || "").trim();

const parseBody = async (request) => {
  if (request.body && typeof request.body === "object") {
    return request.body;
  }

  if (typeof request.body === "string") {
    return JSON.parse(request.body || "{}");
  }

  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
};

const getExtension = (fileName) => {
  const extension = clean(fileName).split(".").pop();
  return extension ? extension.toLowerCase() : "";
};

const isAllowedFile = ({ fileName, fileSize, mimeType }) => {
  const size = Number(fileSize);
  const type = clean(mimeType).toLowerCase();
  const extension = getExtension(fileName);
  const allowedType = allowedTypes.get(type);

  return (
    Number.isFinite(size) &&
    size > 0 &&
    size <= maxFileSize &&
    Boolean(allowedType) &&
    allowedType.extensions.has(extension)
  );
};

const getResourceType = (mimeType) => allowedTypes.get(clean(mimeType).toLowerCase())?.resourceType || "raw";

module.exports = async function referenceUploadHandler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return json(response, 405, { ok: false, message: "Method not allowed." });
  }

  let payload;

  try {
    payload = await parseBody(request);
  } catch {
    return json(response, 400, { ok: false, message: "Invalid request." });
  }

  if (!isAllowedFile(payload)) {
    return json(response, 400, { ok: false, message: "Unsupported reference file." });
  }

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const folder = process.env.CLOUDINARY_UPLOAD_FOLDER || "dragon-oak/reference-files";

  if (!cloudName || !apiKey || !apiSecret) {
    return json(response, 500, { ok: false, message: "Reference image upload is unavailable." });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const extension = getExtension(payload.fileName);
  const resourceType = getResourceType(payload.mimeType);
  const randomId = crypto.randomBytes(12).toString("hex");
  const publicId = `${timestamp}-${randomId}.${extension}`;
  const paramsToSign = `folder=${folder}&public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
  const signature = crypto.createHash("sha1").update(paramsToSign).digest("hex");

  return json(response, 200, {
    ok: true,
    cloudName,
    apiKey,
    folder,
    publicId,
    resourceType,
    timestamp,
    signature,
  });
};
