const {
  fetchEtsyJson,
  getPgClient,
  getRequiredConfig,
  getStoredToken,
} = require("./_lib/etsy-oauth");

const json = (response, statusCode, payload) => {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
};

const isBlank = (value) => value === undefined || value === null || value === "";

const validateActivateInput = (input) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return ["Request body must be a JSON object."];
  }

  const errors = [];

  if (isBlank(input.listingId)) {
    errors.push("Missing required field: listingId");
  } else if (!Number.isFinite(Number(input.listingId)) || Number(input.listingId) <= 0) {
    errors.push("listingId must be a positive number.");
  }

  return errors;
};

const normalizeActivationResult = (listing) => ({
  listingId: listing.listing_id,
  state: listing.state,
  title: listing.title || null,
  url: listing.url || null,
});

const getRequestBody = (request) => {
  if (request.body === undefined || request.body === null) {
    return {};
  }
  if (typeof request.body === "string") {
    try {
      return JSON.parse(request.body || "{}");
    } catch {
      return null;
    }
  }
  return request.body;
};

// Etsy's read-single-listing endpoint is shop-agnostic (no shop_id in the path); only
// the update/activate PATCH below is scoped under /shops/{shop_id}/listings/{listing_id}.
const getListing = (listingId, accessToken) => fetchEtsyJson(`/listings/${listingId}`, accessToken);

const activateListing = (shopId, listingId, accessToken) =>
  fetchEtsyJson(`/shops/${shopId}/listings/${listingId}`, accessToken, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: "active" }),
  });

module.exports = async function etsyListingActivateHandler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
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

  const input = getRequestBody(request);

  if (input === null) {
    return json(response, 400, {
      ok: false,
      message: "Request body must be valid JSON.",
    });
  }

  const validationErrors = validateActivateInput(input);

  if (validationErrors.length) {
    return json(response, 400, {
      ok: false,
      message: "Invalid activation input.",
      errors: validationErrors,
    });
  }

  let client;

  try {
    client = await getPgClient();

    const token = await getStoredToken(client);

    if (!token) {
      return json(response, 409, {
        ok: false,
        connected: false,
        message: "Etsy is not connected. Complete OAuth before activating listings.",
      });
    }

    if (!token.shopId) {
      return json(response, 409, {
        ok: false,
        connected: true,
        shopId: null,
        message: "Etsy is connected, but no shop is associated with the stored token.",
      });
    }

    const listingId = Number(input.listingId);

    let currentListing;

    try {
      currentListing = await getListing(listingId, token.accessToken);
    } catch (error) {
      if (error.status === 404) {
        return json(response, 404, {
          ok: false,
          connected: true,
          shopId: token.shopId,
          listingId,
          message: "Listing was not found in this shop.",
        });
      }
      throw error;
    }

    // getListing is shop-agnostic, so confirm the listing actually belongs to the
    // connected shop before treating it as a valid activation target.
    if (Number(currentListing.shop_id) !== Number(token.shopId)) {
      return json(response, 404, {
        ok: false,
        connected: true,
        shopId: token.shopId,
        listingId,
        message: "Listing was not found in this shop.",
      });
    }

    if (currentListing.state !== "draft") {
      return json(response, 409, {
        ok: false,
        connected: true,
        shopId: token.shopId,
        listingId,
        currentState: currentListing.state,
        message: `Listing is not in draft state (current state: ${currentListing.state}). Refusing to activate.`,
      });
    }

    const activated = await activateListing(token.shopId, listingId, token.accessToken);

    return json(response, 200, {
      ok: true,
      connected: true,
      shopId: token.shopId,
      listing: normalizeActivationResult(activated),
    });
  } catch (error) {
    console.error("Etsy listing activation failed:", error.message);

    if (error.status) {
      return json(response, error.status === 404 ? 404 : 502, {
        ok: false,
        connected: true,
        message: "Etsy rejected the listing activation request.",
        etsy: error.etsy || null,
        status: error.status,
      });
    }

    return json(response, 500, {
      ok: false,
      message: "Unable to activate the Etsy listing.",
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

module.exports.validateActivateInput = validateActivateInput;
module.exports.normalizeActivationResult = normalizeActivationResult;
