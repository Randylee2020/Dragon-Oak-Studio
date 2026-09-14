const {
  fetchEtsyApi,
  getPgClient,
  getRequiredConfig,
  getStoredToken,
} = require("./lib/etsy-oauth");

const json = (response, statusCode, payload) => {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
};

const getMoneyDisplay = (price) => {
  if (!price || price.amount === undefined || price.divisor === undefined || !price.currency_code) {
    return null;
  }

  const amount = Number(price.amount);
  const divisor = Number(price.divisor);

  if (!Number.isFinite(amount) || !Number.isFinite(divisor) || divisor <= 0) {
    return null;
  }

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: price.currency_code,
    }).format(amount / divisor);
  } catch {
    return `${(amount / divisor).toFixed(2)} ${price.currency_code}`;
  }
};

const normalizePrice = (price) => {
  if (!price) {
    return null;
  }

  return {
    amount: price.amount,
    divisor: price.divisor,
    currency: price.currency_code,
    display: getMoneyDisplay(price),
  };
};

const normalizeListing = (listing) => ({
  listingId: listing.listing_id,
  title: listing.title,
  state: listing.state,
  quantity: listing.quantity,
  price: normalizePrice(listing.price),
  url: listing.url,
  createdTimestamp: listing.created_timestamp || listing.creation_timestamp || null,
  updatedTimestamp: listing.updated_timestamp || listing.last_modified_timestamp || null,
});

const getActiveListings = async (shopId, accessToken) => {
  const params = new URLSearchParams({
    state: "active",
    limit: "100",
    offset: "0",
  });
  const response = await fetchEtsyApi(`/shops/${shopId}/listings?${params.toString()}`, accessToken);

  if (!response.ok) {
    const error = new Error("Etsy listings request failed.");
    error.status = response.status;
    throw error;
  }

  try {
    return await response.json();
  } catch {
    const error = new Error("Etsy returned an invalid listings response.");
    error.status = 502;
    throw error;
  }
};

module.exports = async function etsyListingsHandler(request, response) {
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
        listings: [],
      });
    }

    if (!token.shopId) {
      return json(response, 409, {
        ok: false,
        connected: false,
        shopId: null,
        count: 0,
        listings: [],
        message: "Etsy is connected, but no shop is associated with the stored token.",
      });
    }

    const listingsData = await getActiveListings(token.shopId, token.accessToken);
    const listings = Array.isArray(listingsData.results)
      ? listingsData.results.map(normalizeListing)
      : [];

    return json(response, 200, {
      ok: true,
      connected: true,
      shopId: token.shopId,
      count: Number.isFinite(Number(listingsData.count)) ? Number(listingsData.count) : listings.length,
      listings,
    });
  } catch (error) {
    console.error("Etsy listings request failed:", error.message);

    if (error.status) {
      return json(response, 502, {
        ok: false,
        connected: true,
        message: "Unable to fetch Etsy listings right now.",
      });
    }

    return json(response, 500, {
      ok: false,
      message: "Unable to load Etsy listings.",
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
