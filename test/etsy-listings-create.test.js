const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validateListingInput,
  buildEtsyPayload,
  normalizeDraftListing,
} = require("../api/etsy-listings-create");

const VALID_DIGITAL_INPUT = {
  title: "Test Digital Print",
  description: "A test description.",
  price: 4.99,
  quantity: 1,
  who_made: "i_did",
  when_made: "made_to_order",
  taxonomy_id: 68887,
  type: "download",
};

test("validateListingInput accepts a complete digital listing", () => {
  assert.deepEqual(validateListingInput(VALID_DIGITAL_INPUT), []);
});

test("validateListingInput reports every missing required field", () => {
  const errors = validateListingInput({});
  for (const field of ["title", "description", "price", "quantity", "who_made", "when_made", "taxonomy_id"]) {
    assert.ok(
      errors.some((error) => error.includes(field)),
      `expected a missing-field error for ${field}`
    );
  }
});

test("validateListingInput rejects a non-object body", () => {
  assert.deepEqual(validateListingInput(null), ["Request body must be a JSON object."]);
  assert.deepEqual(validateListingInput([1, 2, 3]), ["Request body must be a JSON object."]);
});

test("validateListingInput rejects non-positive price and quantity", () => {
  const errors = validateListingInput({ ...VALID_DIGITAL_INPUT, price: 0, quantity: -1 });
  assert.ok(errors.includes("price must be a positive number."));
  assert.ok(errors.includes("quantity must be a positive number."));
});

test("validateListingInput rejects an invalid who_made value", () => {
  const errors = validateListingInput({ ...VALID_DIGITAL_INPUT, who_made: "a_wizard" });
  assert.ok(errors.some((error) => error.startsWith("who_made must be one of")));
});

test("validateListingInput rejects an invalid type value", () => {
  const errors = validateListingInput({ ...VALID_DIGITAL_INPUT, type: "vaporware" });
  assert.ok(errors.some((error) => error.startsWith("type must be one of")));
});

test("validateListingInput requires shipping_profile_id only for physical listings", () => {
  const digitalErrors = validateListingInput({ ...VALID_DIGITAL_INPUT, type: "download" });
  assert.ok(!digitalErrors.some((error) => error.includes("shipping_profile_id")));

  const physicalErrors = validateListingInput({ ...VALID_DIGITAL_INPUT, type: "physical" });
  assert.ok(physicalErrors.some((error) => error.includes("shipping_profile_id")));

  const physicalWithShipping = validateListingInput({
    ...VALID_DIGITAL_INPUT,
    type: "physical",
    shipping_profile_id: 6722757781,
  });
  assert.ok(!physicalWithShipping.some((error) => error.includes("shipping_profile_id")));
});

test("buildEtsyPayload coerces numeric fields and drops unset optional fields", () => {
  const payload = buildEtsyPayload(VALID_DIGITAL_INPUT);
  assert.equal(payload.quantity, 1);
  assert.equal(payload.price, 4.99);
  assert.equal(payload.taxonomy_id, 68887);
  assert.equal(payload.type, "download");
  assert.equal("shipping_profile_id" in payload, false);
  assert.equal("tags" in payload, false);
});

test("buildEtsyPayload passes through provided optional fields untouched", () => {
  const payload = buildEtsyPayload({
    ...VALID_DIGITAL_INPUT,
    tags: ["dragon", "print"],
    materials: ["digital file"],
    is_supply: false,
  });
  assert.deepEqual(payload.tags, ["dragon", "print"]);
  assert.deepEqual(payload.materials, ["digital file"]);
  assert.equal(payload.is_supply, false);
});

test("normalizeDraftListing maps Etsy's snake_case listing fields", () => {
  const normalized = normalizeDraftListing({
    listing_id: 12345,
    state: "draft",
    title: "Test Digital Print",
    type: "download",
    quantity: 1,
    price: { amount: 499, divisor: 100, currency_code: "USD" },
    url: "https://www.etsy.com/listing/12345",
    created_timestamp: 1737072000,
  });

  assert.equal(normalized.listingId, 12345);
  assert.equal(normalized.state, "draft");
  assert.equal(normalized.url, "https://www.etsy.com/listing/12345");
  assert.equal(normalized.createdTimestamp, 1737072000);
});

test("normalizeDraftListing defaults url to null when Etsy omits it", () => {
  const normalized = normalizeDraftListing({ listing_id: 1, state: "draft", title: "x", quantity: 1, price: 1 });
  assert.equal(normalized.url, null);
  assert.equal(normalized.createdTimestamp, null);
});
