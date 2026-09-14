const crypto = require("crypto");

const REDIRECT_URI = "https://dragonoakstudio.com/api/etsy-callback";
const TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";

const json = (response, statusCode, payload) => {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
};

const html = (response, statusCode, content) => {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(content);
};

const timingSafeEqual = (a, b) => {
  const aBuffer = Buffer.from(String(a || ""));
  const bBuffer = Buffer.from(String(b || ""));

  if (aBuffer.length !== bBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(aBuffer, bBuffer);
};

const getPgClient = async () => {
  const { Client } = require("pg");

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  return client;
};

module.exports = async function etsyCallbackHandler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return json(response, 405, {
      ok: false,
      message: "Method not allowed.",
    });
  }

  const {
    code,
    state,
    error,
    error_description: errorDescription,
  } = request.query || {};

  if (error) {
    return html(
      response,
      400,
      `<h1>Etsy authorization failed</h1>
       <p>${String(errorDescription || error)}</p>`
    );
  }

  if (!code || !state) {
    return html(
      response,
      400,
      "<h1>Etsy authorization failed</h1><p>Missing authorization response.</p>"
    );
  }

  if (
    !process.env.ETSY_API_KEY ||
    !process.env.DATABASE_URL
  ) {
    return html(
      response,
      500,
      "<h1>Dragon Oak configuration error</h1><p>Required server configuration is missing.</p>"
    );
  }

  let client;

  try {
    client = await getPgClient();

    const pendingResult = await client.query(
      `
        DELETE FROM etsy_oauth_requests
        WHERE state = $1
          AND expires_at > NOW()
        RETURNING code_verifier
      `,
      [state]
    );

    if (pendingResult.rowCount !== 1) {
      return html(
        response,
        400,
        "<h1>Etsy authorization expired</h1><p>Please start the Etsy connection again.</p>"
      );
    }

    const codeVerifier = pendingResult.rows[0].code_verifier;

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: process.env.ETSY_API_KEY,
      redirect_uri: REDIRECT_URI,
      code: String(code),
      code_verifier: codeVerifier,
    });

    const tokenResponse = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: tokenBody.toString(),
    });

    if (!tokenResponse.ok) {
      const failureText = await tokenResponse.text();
      console.error("Etsy token exchange failed:", tokenResponse.status, failureText);

      return html(
        response,
        502,
        "<h1>Etsy connection failed</h1><p>Dragon Oak could not complete the Etsy token exchange.</p>"
      );
    }

    const tokenData = await tokenResponse.json();

    if (
      !tokenData.access_token ||
      !tokenData.refresh_token ||
      !tokenData.expires_in
    ) {
      console.error("Unexpected Etsy token response.");
      return html(
        response,
        502,
        "<h1>Etsy connection failed</h1><p>Etsy returned an unexpected authorization response.</p>"
      );
    }

    const userId = String(tokenData.access_token).split(".")[0];

    const expiresAt = new Date(
      Date.now() + Number(tokenData.expires_in) * 1000
    );

    await client.query(
      `
        INSERT INTO etsy_oauth_tokens (
          id,
          shop_id,
          access_token,
          refresh_token,
          expires_at,
          scope,
          created_at,
          updated_at
        )
        VALUES (1, NULL, $1, $2, $3, $4, NOW(), NOW())
        ON CONFLICT (id)
        DO UPDATE SET
          access_token = EXCLUDED.access_token,
          refresh_token = EXCLUDED.refresh_token,
          expires_at = EXCLUDED.expires_at,
          scope = EXCLUDED.scope,
          updated_at = NOW()
      `,
      [
        tokenData.access_token,
        tokenData.refresh_token,
        expiresAt,
        tokenData.scope || null,
      ]
    );

    return html(
      response,
      200,
      `<!doctype html>
       <html>
       <head>
         <meta charset="utf-8">
         <title>Dragon Oak Studio — Etsy Connected</title>
       </head>
       <body style="font-family:Arial,sans-serif;background:#101418;color:#fff;padding:48px;">
         <h1>🐉 Etsy connected.</h1>
         <p>Dragon Oak Studio has successfully authorized Etsy.</p>
         <p>User ${userId} is connected.</p>
         <p>You can close this window.</p>
       </body>
       </html>`
    );
  } catch (error) {
    console.error("Etsy OAuth callback error:", error);

    return html(
      response,
      500,
      "<h1>Dragon Oak connection error</h1><p>The Etsy authorization could not be completed.</p>"
    );
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
