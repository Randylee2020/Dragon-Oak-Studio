const {
  getPgClient,
  getRequiredConfig,
  getShopForUser,
  getStoredToken,
  normalizeScope,
  updateStoredShop,
} = require("./_lib/etsy-oauth");
const { requireBridgeAuth } = require("./_lib/bridge-auth");

const json = (response, statusCode, payload) => {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
};

const publicTokenStatus = (token, shop) => ({
  connected: true,
  userId: token.userId,
  shopId: shop && shop.shop_id ? shop.shop_id : token.shopId,
  shopName: shop && shop.shop_name ? shop.shop_name : undefined,
  scopes: normalizeScope(token.scope),
  expiresAt: token.expiresAt.toISOString(),
});

module.exports = async function etsyStatusHandler(request, response) {
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

  let client;

  try {
    client = await getPgClient();

    const token = await getStoredToken(client);

    if (!token) {
      return json(response, 200, {
        ok: true,
        connected: false,
      });
    }

    const shop = await getShopForUser(token.accessToken);
    await updateStoredShop(client, shop);

    return json(response, 200, {
      ok: true,
      ...publicTokenStatus(token, shop),
    });
  } catch (error) {
    console.error("Etsy status check failed:", error.message);

    if (!error.status) {
      return json(response, 500, {
        ok: false,
        message: "Unable to check Etsy connection.",
      });
    }

    return json(response, 200, {
      ok: true,
      connected: false,
      needsReconnect: true,
      message: "Etsy needs to be reconnected.",
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
