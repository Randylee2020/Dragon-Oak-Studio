const {
  fetchEtsyApi,
  getPgClient,
  getRequiredConfig,
  getStoredToken,
} = require("./_lib/etsy-oauth");
const { requireBridgeAuth } = require("./_lib/bridge-auth");

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

// ---- Opt-in catalog-import options (READ ONLY) ---------------------------------------------------------------------
// With no query string this endpoint behaves exactly as before (active listings, first 100, basic fields).
// The storefront import tool (tools/import-etsy.js) may add:  ?detail=full  &state=  &limit=  &offset=
// These only change which listings are READ and how many fields come back. Nothing here can write to Etsy.
const ALLOWED_STATES = new Set(["active", "inactive", "draft", "sold_out", "expired"]);
const MAX_LIMIT = 100;
const MAX_OFFSET = 10000;

const firstValue = (value) => (Array.isArray(value) ? value[0] : value);

const readQuery = (request) => {
  if (request.query && typeof request.query === "object") {
    return request.query;
  }

  try {
    return Object.fromEntries(new URL(request.url || "/", "http://localhost").searchParams);
  } catch {
    return {};
  }
};

// Returns { ok: true, options } or { ok: false, message }. Absent parameters keep the original defaults.
const parseListOptions = (request) => {
  const query = readQuery(request);
  const state = firstValue(query.state);
  const detail = firstValue(query.detail);
  const limit = firstValue(query.limit);
  const offset = firstValue(query.offset);
  const options = { state: "active", limit: MAX_LIMIT, offset: 0, full: false, custom: false };

  if (state !== undefined) {
    if (!ALLOWED_STATES.has(state)) {
      return { ok: false, message: "Unsupported listing state." };
    }

    options.state = state;
    options.custom = true;
  }

  if (detail !== undefined) {
    if (detail !== "full") {
      return { ok: false, message: "Unsupported detail level." };
    }

    options.full = true;
    options.custom = true;
  }

  if (limit !== undefined) {
    const parsed = Number(limit);

    if (!/^\d+$/.test(String(limit)) || parsed < 1 || parsed > MAX_LIMIT) {
      return { ok: false, message: `limit must be a whole number from 1 to ${MAX_LIMIT}.` };
    }

    options.limit = parsed;
    options.custom = true;
  }

  if (offset !== undefined) {
    const parsed = Number(offset);

    if (!/^\d+$/.test(String(offset)) || parsed > MAX_OFFSET) {
      return { ok: false, message: `offset must be a whole number from 0 to ${MAX_OFFSET}.` };
    }

    options.offset = parsed;
    options.custom = true;
  }

  return { ok: true, options };
};

const normalizeImage = (image) => ({
  imageId: image.listing_image_id === undefined ? null : image.listing_image_id,
  url: image.url_fullxfull || image.url_570xN || null,
  altText: image.alt_text || null,
  rank: image.rank === undefined ? null : image.rank,
});

// Extra fields for catalog import. skus/tags/description/images are what the ADRIAN catalog needs to map by SKU.
const normalizeListingFull = (listing) => ({
  ...normalizeListing(listing),
  description: typeof listing.description === "string" ? listing.description : null,
  tags: Array.isArray(listing.tags) ? listing.tags : [],
  skus: Array.isArray(listing.skus) ? listing.skus : [],
  listingType:
    listing.listing_type ||
    listing.type ||
    (listing.is_digital === true ? "download" : listing.is_digital === false ? "physical" : null),
  taxonomyId: listing.taxonomy_id === undefined ? null : listing.taxonomy_id,
  images: Array.isArray(listing.images) ? listing.images.map(normalizeImage) : [],
});

const getListings = async (shopId, accessToken, options) => {
  const params = new URLSearchParams({
    state: options.state,
    limit: String(options.limit),
    offset: String(options.offset),
  });

  if (options.full) {
    params.set("includes", "Images");
  }

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

  const parsed = parseListOptions(request);

  if (!parsed.ok) {
    return json(response, 400, {
      ok: false,
      message: parsed.message,
    });
  }

  const listOptions = parsed.options;

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

    const listingsData = await getListings(token.shopId, token.accessToken, listOptions);
    const normalize = listOptions.full ? normalizeListingFull : normalizeListing;
    const listings = Array.isArray(listingsData.results)
      ? listingsData.results.map(normalize)
      : [];
    const payload = {
      ok: true,
      connected: true,
      shopId: token.shopId,
      count: Number.isFinite(Number(listingsData.count)) ? Number(listingsData.count) : listings.length,
      listings,
    };

    // Paging details are only added when the caller asked for them; the default response shape is unchanged.
    if (listOptions.custom) {
      payload.state = listOptions.state;
      payload.limit = listOptions.limit;
      payload.offset = listOptions.offset;
      payload.detail = listOptions.full ? "full" : "basic";
    }

    return json(response, 200, payload);
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
