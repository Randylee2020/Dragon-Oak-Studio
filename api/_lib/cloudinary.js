const crypto = require("crypto");

const getCloudinaryConfig = () => {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    return { ok: false };
  }

  return { ok: true, cloudName, apiKey, apiSecret };
};

const signUploadParams = (params, apiSecret) => {
  const paramsToSign = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  return crypto.createHash("sha1").update(`${paramsToSign}${apiSecret}`).digest("hex");
};

// Generic signed-upload builder for direct-to-Cloudinary uploads, independent of
// api/reference-upload.js (which carries its own 5MB business rule for the public
// project-inquiry form and is intentionally left untouched by this helper).
const createSignedUpload = ({ fileName, resourceType, folder }) => {
  const config = getCloudinaryConfig();

  if (!config.ok) {
    return { ok: false, error: "Cloudinary is not configured." };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const randomId = crypto.randomBytes(12).toString("hex");
  const extension = String(fileName || "").trim().split(".").pop();
  const publicId =
    resourceType === "raw" && extension ? `${timestamp}-${randomId}.${extension.toLowerCase()}` : `${timestamp}-${randomId}`;

  const uploadParams = {
    folder,
    public_id: publicId,
    timestamp: String(timestamp),
  };
  const signature = signUploadParams(uploadParams, config.apiSecret);

  return {
    ok: true,
    cloudName: config.cloudName,
    apiKey: config.apiKey,
    folder,
    publicId,
    timestamp: uploadParams.timestamp,
    resourceType: resourceType || "raw",
    signature,
  };
};

module.exports = { createSignedUpload, signUploadParams, getCloudinaryConfig };
