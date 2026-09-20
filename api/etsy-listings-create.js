const {
  fetchEtsyJson,
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

const REQUIRED_FIELDS = ["title", "description", "price", "quantity", "who_made", "when_made", "taxonomy_id"];
const WHO_MADE_VALUES = new Set(["i_did", "someone_else", "collective"]);
const LISTING_TYPE_VALUES = new Set(["physical", "download", "both"]);
const PASSTHROUGH_FIELDS = [
  "type",
  "shipping_profile_id",
  "return_policy_id",
  "materials",
  "shop_section_id",
  "processing_min",
  "processing_max",
  "tags",
  "styles",
  "is_supply",
  "is_customizable",
  "should_auto_renew",
  "is_taxable",
];

const isBlank = (value) => value === undefined || value === null || value === "";

const validateListingInput = (input) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return ["Request body must be a JSON object."];
  }

  const errors = [];

  for (const field of REQUIRED_FIELDS) {
    if (isBlank(input[field])) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  if (!isBlank(input.quantity)) {
    const quantity = Number(input.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      errors.push("quantity must be a positive number.");
    }
  }

  if (!isBlank(input.price)) {
    const price = Number(input.price);
    if (!Number.isFinite(price) || price <= 0) {
      errors.push("price must be a positive number.");
    }
  }

  if (!isBlank(input.taxonomy_id) && !Number.isFinite(Number(input.taxonomy_id))) {
    errors.push("taxonomy_id must be numeric.");
  }

  if (!isBlank(input.who_made) && !WHO_MADE_VALUES.has(input.who_made)) {
    errors.push(`who_made must be one of: ${[...WHO_MADE_VALUES].join(", ")}`);
  }

  if (!isBlank(input.type) && !LISTING_TYPE_VALUES.has(input.type)) {
    errors.push(`type must be one of: ${[...LISTING_TYPE_VALUES].join(", ")}`);
  }

  if (input.type === "physical" && isBlank(input.shipping_profile_id)) {
    errors.push("shipping_profile_id is required when type is physical.");
  }

  return errors;
};

const buildEtsyPayload = (input) => {
  const payload = {
    quantity: Number(input.quantity),
    title: String(input.title),
    description: String(input.description),
    price: Number(input.price),
    who_made: input.who_made,
    when_made: input.when_made,
    taxonomy_id: Number(input.taxonomy_id),
  };

  for (const field of PASSTHROUGH_FIELDS) {
    if (input[field] !== undefined) {
      payload[field] = input[field];
    }
  }

  return payload;
};

const normalizeDraftListing = (listing) => ({
  listingId: listing.listing_id,
  state: listing.state,
  title: listing.title,
  type: listing.type,
  quantity: listing.quantity,
  price: listing.price,
  url: listing.url || null,
  createdTimestamp: listing.created_timestamp || listing.creation_timestamp || null,
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

module.exports = async function etsyListingsCreateHandler(request, response) {
  if (!requireBridgeAuth(request, response)) {
    return;
  }

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

  const validationErrors = validateListingInput(input);

  if (validationErrors.length) {
    return json(response, 400, {
      ok: false,
      message: "Invalid draft listing input.",
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
        message: "Etsy is not connected. Complete OAuth before creating listings.",
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

    const payload = buildEtsyPayload(input);
    const listing = await fetchEtsyJson(`/shops/${token.shopId}/listings`, token.accessToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    return json(response, 201, {
      ok: true,
      connected: true,
      shopId: token.shopId,
      listing: normalizeDraftListing(listing),
    });
  } catch (error) {
    console.error("Etsy draft listing creation failed:", error.message);

    if (error.status) {
      return json(response, error.status === 404 ? 404 : 502, {
        ok: false,
        connected: true,
        message: "Etsy rejected the draft listing request.",
        etsy: error.etsy || null,
        status: error.status,
      });
    }

    return json(response, 500, {
      ok: false,
      message: "Unable to create Etsy draft listing.",
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

module.exports.validateListingInput = validateListingInput;
module.exports.buildEtsyPayload = buildEtsyPayload;
module.exports.normalizeDraftListing = normalizeDraftListing;
