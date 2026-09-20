// Test-only credentials. This is NOT the production secret (that exists only in the Vercel environment variable).
const TEST_SECRET = "unit-test-only-bridge-secret-0123456789abcdef-not-a-real-secret";

process.env.ADRIAN_BRIDGE_SECRET = TEST_SECRET;

const testAuthHeaders = () => ({ authorization: `Bearer ${TEST_SECRET}` });

module.exports = { TEST_SECRET, testAuthHeaders };
