const crypto = require("crypto");

// Shared-secret authentication for every ADRIAN Etsy bridge endpoint that can read, create, modify, upload to, or
// publish Etsy data. The secret lives ONLY in the Vercel environment variable ADRIAN_BRIDGE_SECRET (never in source, Git,
// URLs, or logs) and is sent by the client as:  Authorization: Bearer <secret>
//
//   - not configured on the server  -> 503 (fail closed; nothing is served)
//   - missing / malformed header    -> 401 + WWW-Authenticate: Bearer
//   - wrong secret                  -> 403
//
// Comparison is constant-time (SHA-256 digests + timingSafeEqual), so length/prefix are not leaked.
const SECRET_ENV_NAME = "ADRIAN_BRIDGE_SECRET";
const MIN_SECRET_LENGTH = 32;
const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest();

const deny = (response, statusCode, message) => {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  if (statusCode === 401) {
    response.setHeader("WWW-Authenticate", 'Bearer realm="adrian-etsy-bridge"');
  }
  response.end(JSON.stringify({ ok: false, message }));
  return false;
};

// Returns true when the request is authenticated; otherwise writes the rejection response and returns false.
// Usage at the top of a handler:  if (!requireBridgeAuth(request, response)) return;
const requireBridgeAuth = (request, response) => {
  const expected = process.env[SECRET_ENV_NAME];

  if (!expected || expected.length < MIN_SECRET_LENGTH) {
    console.error("Bridge authentication secret is not configured.");
    return deny(response, 503, "Bridge authentication is not configured.");
  }

  const header = request && request.headers ? request.headers.authorization : undefined;
  const match = typeof header === "string" ? BEARER_PATTERN.exec(header.trim()) : null;

  if (!match) {
    return deny(response, 401, "Authentication required.");
  }

  if (!crypto.timingSafeEqual(sha256(match[1]), sha256(expected))) {
    return deny(response, 403, "Invalid credentials.");
  }

  return true;
};

module.exports = { requireBridgeAuth, SECRET_ENV_NAME };
