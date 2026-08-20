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

const json = (response, statusCode, payload) => {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
};

const clean = (value) => String(value || "").trim();

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const isTooLong = (payload) =>
  Object.entries(limits).some(([field, maxLength]) => clean(payload[field]).length > maxLength);

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

  if (!resendApiKey || !toEmail || !fromEmail) {
    return json(response, 500, { ok: false, message: "Unable to send message right now." });
  }

  const subject = `New Dragon Oak Project Inquiry — ${projectType}`;
  const timestamp = submittedAt.toISOString();
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
