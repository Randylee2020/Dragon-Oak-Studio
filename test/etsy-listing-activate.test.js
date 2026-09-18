const test = require("node:test");
const assert = require("node:assert/strict");

const { validateActivateInput, normalizeActivationResult } = require("../api/etsy-listing-activate");

test("validateActivateInput accepts a positive listingId", () => {
  assert.deepEqual(validateActivateInput({ listingId: 4577566790 }), []);
});

test("validateActivateInput rejects a non-object body", () => {
  assert.deepEqual(validateActivateInput(null), ["Request body must be a JSON object."]);
  assert.deepEqual(validateActivateInput([1]), ["Request body must be a JSON object."]);
});

test("validateActivateInput requires listingId", () => {
  assert.deepEqual(validateActivateInput({}), ["Missing required field: listingId"]);
});

test("validateActivateInput rejects a non-positive listingId", () => {
  assert.deepEqual(validateActivateInput({ listingId: 0 }), ["listingId must be a positive number."]);
  assert.deepEqual(validateActivateInput({ listingId: -3 }), ["listingId must be a positive number."]);
});

test("validateActivateInput rejects a non-numeric listingId", () => {
  assert.deepEqual(validateActivateInput({ listingId: "abc" }), ["listingId must be a positive number."]);
});

test("normalizeActivationResult maps Etsy's snake_case listing fields", () => {
  const normalized = normalizeActivationResult({
    listing_id: 4577566790,
    state: "active",
    title: "Halloween Ceramic Coaster",
    url: "https://www.etsy.com/listing/4577566790/halloween-ceramic-coaster",
  });

  assert.equal(normalized.listingId, 4577566790);
  assert.equal(normalized.state, "active");
  assert.equal(normalized.title, "Halloween Ceramic Coaster");
  assert.equal(normalized.url, "https://www.etsy.com/listing/4577566790/halloween-ceramic-coaster");
});

test("normalizeActivationResult defaults missing title/url to null", () => {
  const normalized = normalizeActivationResult({ listing_id: 1, state: "active" });
  assert.equal(normalized.title, null);
  assert.equal(normalized.url, null);
});
