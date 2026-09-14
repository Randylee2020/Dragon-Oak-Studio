const {
  exchangeAuthorizationCode,
  getPgClient,
  getRequiredConfig,
  getShopForUser,
  parseTokenUserId,
  updateStoredShop,
  upsertToken,
} = require("./lib/etsy-oauth");

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

const escapeHtml = (value) =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const getQueryValue = (value) => (Array.isArray(value) ? value[0] : value);

module.exports = async function etsyCallbackHandler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return json(response, 405, {
      ok: false,
      message: "Method not allowed.",
    });
  }

  const {
    code: rawCode,
    state: rawState,
    error,
    error_description: errorDescription,
  } = request.query || {};
  const code = getQueryValue(rawCode);
  const state = getQueryValue(rawState);

  if (error) {
    const message = errorDescription || error;

    return html(
      response,
      400,
      `<h1>Etsy authorization failed</h1>
       <p>${escapeHtml(message)}</p>`
    );
  }

  if (!code || !state) {
    return html(
      response,
      400,
      "<h1>Etsy authorization failed</h1><p>Missing authorization response.</p>"
    );
  }

  const config = getRequiredConfig();

  if (!config.ok) {
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

    const tokenData = await exchangeAuthorizationCode(
      code,
      pendingResult.rows[0].code_verifier
    );
    const shop = await getShopForUser(tokenData.access_token);
    const token = await upsertToken(client, tokenData, shop && shop.shop_id);
    await updateStoredShop(client, shop);
    const userId = parseTokenUserId(token.accessToken);
    const connectedDetail = shop && shop.shop_name
      ? `Shop ${escapeHtml(shop.shop_name)} is connected.`
      : "Dragon Oak Studio has successfully authorized Etsy.";

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
         <h1>Etsy connected.</h1>
         <p>${connectedDetail}</p>
         ${userId ? `<p>Etsy user ${escapeHtml(userId)} is connected.</p>` : ""}
         <p>You can close this window.</p>
       </body>
       </html>`
    );
  } catch (error) {
    console.error("Etsy OAuth callback error:", error.message);

    if (error.status) {
      return html(
        response,
        502,
        "<h1>Etsy connection failed</h1><p>Dragon Oak could not complete the Etsy token exchange.</p>"
      );
    }

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
