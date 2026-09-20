const {
  createAuthorizationUrl,
  createPkcePair,
  createState,
  getPgClient,
  getRequiredConfig,
} = require("./_lib/etsy-oauth");
const { requireBridgeAuth } = require("./_lib/bridge-auth");

const json = (response, statusCode, payload) => {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
};

module.exports = async function etsyConnectHandler(request, response) {
  if (!requireBridgeAuth(request, response)) {
    return;
  }

  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
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

  const state = createState();
  const { verifier, challenge } = createPkcePair();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  let client;

  try {
    client = await getPgClient();

    await client.query(
      `
        INSERT INTO etsy_oauth_requests (
          state,
          code_verifier,
          expires_at
        )
        VALUES ($1, $2, $3)
      `,
      [state, verifier, expiresAt]
    );

    response.statusCode = 302;
    response.setHeader("Location", createAuthorizationUrl(state, challenge));
    response.end();
  } catch (error) {
    console.error("Etsy OAuth start failed:", error.message);

    return json(response, 500, {
      ok: false,
      message: "Unable to start Etsy connection.",
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
