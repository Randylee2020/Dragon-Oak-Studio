const projectTypes = new Set([
  "Laser Cutting / Engraving",
  "UV Printing",
  "Custom Product",
  "Digital Design File",
  "Business Branding",
  "Bulk / Business Order",
  "Other",
]);

const limits = {
  name: 120,
  email: 180,
  phone: 40,
  company: 140,
  projectType: 60,
  message: 4000,
};

const minimumFillTimeMs = 2500;
const maxReferenceFiles = 3;
const maxReferenceFileSize = 5 * 1024 * 1024;
const allowedReferenceTypes = new Map([
  ["image/jpeg", { extensions: new Set(["jpg", "jpeg"]), resourceType: "image" }],
  ["image/png", { extensions: new Set(["png"]), resourceType: "image" }],
  ["image/webp", { extensions: new Set(["webp"]), resourceType: "image" }],
  ["application/pdf", { extensions: new Set(["pdf"]), resourceType: "raw" }],
  ["image/svg+xml", { extensions: new Set(["svg"]), resourceType: "raw" }],
]);

const json = (response, statusCode, payload) => {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
};

const clean = (value) => String(value || "").trim();

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const isTooLong = (payload) =>
  Object.entries(limits).some(([field, maxLength]) => clean(payload[field]).length > maxLength);

const getExtension = (fileName) => {
  const extension = clean(fileName).split(".").pop();
  return extension ? extension.toLowerCase() : "";
};

const normalizeReferenceImages = (images) => {
  if (!Array.isArray(images)) {
    return [];
  }

  return images.map((image) => ({
    url: clean(image.url),
    originalName: clean(image.originalName).slice(0, 180),
    size: Number(image.size),
    type: clean(image.type).toLowerCase(),
    resourceType: clean(image.resourceType).toLowerCase(),
  }));
};

const isAllowedReferenceFile = (file, cloudName) => {
  const allowedType = allowedReferenceTypes.get(file.type);
  const urlPrefix = `https://res.cloudinary.com/${cloudName}/${file.resourceType}/upload/`;
  const extension = getExtension(file.originalName || file.url);

  try {
    const parsedUrl = new URL(file.url);

    return (
      parsedUrl.protocol === "https:" &&
      file.url.startsWith(urlPrefix) &&
      Number.isFinite(file.size) &&
      file.size > 0 &&
      file.size <= maxReferenceFileSize &&
      Boolean(allowedType) &&
      allowedType.extensions.has(extension) &&
      allowedType.resourceType === file.resourceType
    );
  } catch {
    return false;
  }
};

const getReferenceFileKind = (file) => {
  if (file.type === "image/jpeg") {
    return "JPEG";
  }

  if (file.type === "image/png") {
    return "PNG";
  }

  if (file.type === "image/webp") {
    return "WebP";
  }

  if (file.type === "application/pdf") {
    return "PDF";
  }

  if (file.type === "image/svg+xml") {
    return "SVG";
  }

  return "File";
};

const getSafeDeliveryUrl = (file) => {
  if (file.resourceType !== "raw") {
    return file.url;
  }

  return file.url.replace("/upload/", "/upload/fl_attachment/");
};

const bytesStartWith = (bytes, values) => values.every((value, index) => bytes[index] === value);

const svgHasUnsafeContent = (text) => {
  const normalized = text.toLowerCase();

  return (
    !normalized.includes("<svg") ||
    normalized.includes("<html") ||
    normalized.includes("<script") ||
    normalized.includes("<foreignobject") ||
    normalized.includes("javascript:") ||
    /\son[a-z]+\s*=/.test(normalized) ||
    /<(iframe|object|embed|link|meta)\b/.test(normalized)
  );
};

const verifyReferenceFileContent = async (file) => {
  const response = await fetch(file.url, {
    headers: {
      Range: "bytes=0-65535",
    },
  });

  if (!response.ok) {
    return false;
  }

  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  if (file.type === "image/jpeg") {
    return bytesStartWith(bytes, [0xff, 0xd8, 0xff]);
  }

  if (file.type === "image/png") {
    return bytesStartWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }

  if (file.type === "image/webp") {
    return (
      bytesStartWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    );
  }

  if (file.type === "application/pdf") {
    return bytesStartWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
  }

  if (file.type === "image/svg+xml") {
    const text = Buffer.from(bytes).toString("utf8").replace(/^\uFEFF/, "").trimStart();
    return (text.startsWith("<svg") || text.startsWith("<?xml")) && !svgHasUnsafeContent(text);
  }

  return false;
};

const verifyReferenceFiles = async (files, cloudName) => {
  if (!files.length) {
    return true;
  }

  if (!cloudName || files.length > maxReferenceFiles) {
    return false;
  }

  for (const file of files) {
    if (!isAllowedReferenceFile(file, cloudName) || !(await verifyReferenceFileContent(file))) {
      return false;
    }
  }

  return true;
};

const escapeHtml = (value) =>
  clean(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

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

module.exports = async function contactHandler(request, response) {
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

  const name = clean(payload.name);
  const email = clean(payload.email).toLowerCase();
  const phone = clean(payload.phone);
  const company = clean(payload.company);
  const projectType = clean(payload.projectType);
  const message = clean(payload.message);
  const website = clean(payload.website);
  const startedAt = Number(payload.startedAt);
  const submittedAt = new Date();
  const referenceFiles = normalizeReferenceImages(payload.referenceImages);

  if (website) {
    return json(response, 400, { ok: false, message: "Unable to send message." });
  }

  if (!Number.isFinite(startedAt) || Date.now() - startedAt < minimumFillTimeMs) {
    return json(response, 429, { ok: false, message: "Please wait a moment and try again." });
  }

  if (!name || !email || !projectType || !message) {
    return json(response, 400, { ok: false, message: "Please complete the required fields." });
  }

  if (!isValidEmail(email) || !projectTypes.has(projectType) || isTooLong(payload)) {
    return json(response, 400, { ok: false, message: "Please check your message and try again." });
  }

  const resendApiKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.CONTACT_TO_EMAIL;
  const fromEmail = process.env.CONTACT_FROM_EMAIL;
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;

  if (!resendApiKey || !toEmail || !fromEmail) {
    return json(response, 500, { ok: false, message: "Unable to send message right now." });
  }

  if (!(await verifyReferenceFiles(referenceFiles, cloudName))) {
    return json(response, 400, { ok: false, message: "Please check your reference files and try again." });
  }

  const subject = `New Dragon Oak Project Inquiry — ${projectType}`;
  const timestamp = submittedAt.toISOString();
  const referenceFileText = referenceFiles.length
    ? referenceFiles
        .map((file, index) => `${index + 1}. ${file.originalName || "Reference file"} (${getReferenceFileKind(file)}, ${Math.round(file.size / 1024)} KB): ${getSafeDeliveryUrl(file)}`)
        .join("\n")
    : "No reference files supplied.";
  const referenceFileHtml = referenceFiles.length
    ? `<ol style="margin: 8px 0 0; padding-left: 22px;">${referenceFiles
        .map(
          (file) =>
            `<li style="margin: 0 0 8px;"><a href="${escapeHtml(getSafeDeliveryUrl(file))}" style="color: #0b6f95;">${escapeHtml(file.originalName || "Reference file")}</a> <span style="color: #667580;">${escapeHtml(getReferenceFileKind(file))}, ${Math.round(file.size / 1024)} KB</span></li>`
        )
        .join("")}</ol>`
    : `<p style="margin: 8px 0 0; color: #667580;">No reference files supplied.</p>`;
  const text = [
    "New Dragon Oak Studio project inquiry",
    "",
    `Customer Name: ${name}`,
    `Customer Email: ${email}`,
    `Phone: ${phone || "Not supplied"}`,
    `Company / Business Name: ${company || "Not supplied"}`,
    `Project Type: ${projectType}`,
    `Submission Timestamp: ${timestamp}`,
    "",
    "Reference Files:",
    referenceFileText,
    "",
    "Message:",
    message,
  ].join("\n");
  const html = `
    <div style="font-family: Arial, sans-serif; color: #17212b; line-height: 1.55;">
      <h2 style="margin: 0 0 16px; color: #0c1822;">New Dragon Oak Studio project inquiry</h2>
      <table cellpadding="0" cellspacing="0" style="border-collapse: collapse; width: 100%; max-width: 720px;">
        <tr><td style="padding: 6px 0; font-weight: 700;">Customer Name</td><td style="padding: 6px 0;">${escapeHtml(name)}</td></tr>
        <tr><td style="padding: 6px 0; font-weight: 700;">Customer Email</td><td style="padding: 6px 0;">${escapeHtml(email)}</td></tr>
        <tr><td style="padding: 6px 0; font-weight: 700;">Phone</td><td style="padding: 6px 0;">${escapeHtml(phone || "Not supplied")}</td></tr>
        <tr><td style="padding: 6px 0; font-weight: 700;">Company / Business Name</td><td style="padding: 6px 0;">${escapeHtml(company || "Not supplied")}</td></tr>
        <tr><td style="padding: 6px 0; font-weight: 700;">Project Type</td><td style="padding: 6px 0;">${escapeHtml(projectType)}</td></tr>
        <tr><td style="padding: 6px 0; font-weight: 700;">Submission Timestamp</td><td style="padding: 6px 0;">${escapeHtml(timestamp)}</td></tr>
      </table>
      <h3 style="margin: 22px 0 8px; color: #0c1822;">Reference Files</h3>
      ${referenceFileHtml}
      <h3 style="margin: 22px 0 8px; color: #0c1822;">Message</h3>
      <div style="white-space: pre-wrap; border-left: 3px solid #34bdf2; padding: 12px 14px; background: #f4f8fb;">${escapeHtml(message)}</div>
    </div>
  `;

  try {
    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        reply_to: email,
        subject,
        text,
        html,
      }),
    });

    if (!resendResponse.ok) {
      return json(response, 502, { ok: false, message: "Unable to send message right now." });
    }

    return json(response, 200, { ok: true, message: "Message sent." });
  } catch {
    return json(response, 502, { ok: false, message: "Unable to send message right now." });
  }
};
