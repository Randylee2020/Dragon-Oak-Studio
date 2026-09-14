const crypto = require("crypto");

const REDIRECT_URI = "https://dragonoakstudio.com/api/etsy-callback";
const AUTHORIZATION_URL = "https://www.etsy.com/oauth/connect";
const TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";
const API_BASE_URL = "https://api.etsy.com/v3/application";
const TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;

const SCOPES = [
  "listings_r",
  "listings_w",
  "shops_r",
  "shops_w",
  "transactions_r",
  "transactions_w",
];

const base64Url = (buffer) =>
  buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const createPkcePair = () => {
  const verifier = base64Url(crypto.randomBytes(64));
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());

  return { verifier, challenge };
};

const createState = () => base64Url(crypto.randomBytes(32));

const getRequiredConfig = () => {
  const apiKey = process.env.ETSY_API_KEY;
  const sharedSecret = process.env.ETSY_SHARED_SECRET;
  const databaseUrl = process.env.DATABASE_URL;

  if (!apiKey || !sharedSecret || !databaseUrl) {
    return {
      ok: false,
      message: "Required server configuration is missing.",
    };
  }

  return {
    ok: true,
    apiKey,
    sharedSecret,
    databaseUrl,
  };
};

const getPgClient = async () => {
  const config = getRequiredConfig();

  if (!config.ok) {
    throw new Error("Missing Etsy integration configuration.");
  }

  const { Client } = require("pg");
  const client = new Client({
    connectionString: config.databaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  return client;
};

const getApiKeyHeader = () => {
  const config = getRequiredConfig();

  if (!config.ok) {
    throw new Error("Missing Etsy integration configuration.");
  }

  return `${config.apiKey}:${config.sharedSecret}`;
};

const parseTokenUserId = (accessToken) => {
  const [userId] = String(accessToken || "").split(".");
  return /^\d+$/.test(userId) ? userId : null;
};

const normalizeScope = (scope) =>
  String(scope || "")
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);

const getTokenHeaders = () => ({
  "Content-Type": "application/x-www-form-urlencoded",
  "x-api-key": getApiKeyHeader(),
});

const requestToken = async (body) => {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: getTokenHeaders(),
    body: body.toString(),
  });

  if (!response.ok) {
    const error = new Error("Etsy token request failed.");
    error.status = response.status;
    throw error;
  }

  let tokenData;

  try {
    tokenData = await response.json();
  } catch {
    const error = new Error("Etsy returned an invalid token response.");
    error.status = 502;
    throw error;
  }

  if (!tokenData.access_token || !tokenData.refresh_token || !tokenData.expires_in) {
    const error = new Error("Unexpected Etsy token response.");
    error.status = 502;
    throw error;
  }

  return tokenData;
};

const exchangeAuthorizationCode = (code, codeVerifier) => {
  const config = getRequiredConfig();

  if (!config.ok) {
    throw new Error("Missing Etsy integration configuration.");
  }

  return requestToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.apiKey,
      redirect_uri: REDIRECT_URI,
      code: String(code),
      code_verifier: codeVerifier,
    })
  );
};

const refreshToken = (refreshTokenValue) => {
  const config = getRequiredConfig();

  if (!config.ok) {
    throw new Error("Missing Etsy integration configuration.");
  }

  return requestToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.apiKey,
      refresh_token: refreshTokenValue,
    })
  );
};

const getTokenExpiresAt = (expiresIn) => new Date(Date.now() + Number(expiresIn) * 1000);

const upsertToken = async (client, tokenData, shopId) => {
  const expiresAt = getTokenExpiresAt(tokenData.expires_in);

  await client.query(
    `
      INSERT INTO etsy_oauth_tokens (
        id,
        shop_id,
        access_token,
        refresh_token,
        expires_at,
        scope,
        created_at,
        updated_at
      )
      VALUES (1, $1, $2, $3, $4, $5, NOW(), NOW())
      ON CONFLICT (id)
      DO UPDATE SET
        shop_id = COALESCE(EXCLUDED.shop_id, etsy_oauth_tokens.shop_id),
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        expires_at = EXCLUDED.expires_at,
        scope = EXCLUDED.scope,
        updated_at = NOW()
    `,
    [
      shopId || null,
      tokenData.access_token,
      tokenData.refresh_token,
      expiresAt,
      tokenData.scope || null,
    ]
  );

  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt,
    scope: tokenData.scope || null,
    shopId: shopId || null,
    userId: parseTokenUserId(tokenData.access_token),
  };
};

const refreshStoredToken = async (client, tokenRow) => {
  const tokenData = await refreshToken(tokenRow.refresh_token);
  return upsertToken(client, tokenData, tokenRow.shop_id);
};

const getStoredToken = async (client, options = {}) => {
  const refreshIfNeeded = options.refreshIfNeeded !== false;
  const result = await client.query(
    `
      SELECT id, shop_id, access_token, refresh_token, expires_at, scope
      FROM etsy_oauth_tokens
      WHERE id = 1
      LIMIT 1
    `
  );

  if (result.rowCount !== 1) {
    return null;
  }

  const row = result.rows[0];
  const expiresAt = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
  const expiresAtMs = expiresAt.getTime();
  const shouldRefresh =
    !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now() + TOKEN_REFRESH_WINDOW_MS;

  if (refreshIfNeeded && shouldRefresh) {
    return refreshStoredToken(client, row);
  }

  return {
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt,
    scope: row.scope || null,
    shopId: row.shop_id || null,
    userId: parseTokenUserId(row.access_token),
  };
};

const fetchEtsyApi = async (path, accessToken, options = {}) => {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      "x-api-key": getApiKeyHeader(),
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {}),
    },
  });

  return response;
};

const fetchEtsyJson = async (path, accessToken, options = {}) => {
  const response = await fetchEtsyApi(path, accessToken, options);

  if (!response.ok) {
    const error = new Error("Etsy API request failed.");
    error.status = response.status;
    throw error;
  }

  try {
    return await response.json();
  } catch {
    const error = new Error("Etsy returned an invalid API response.");
    error.status = 502;
    throw error;
  }
};

const getShopForUser = async (accessToken) => {
  const userId = parseTokenUserId(accessToken);

  if (!userId) {
    return null;
  }

  const response = await fetchEtsyApi(`/users/${userId}/shops`, accessToken);

  if (!response.ok) {
    return null;
  }

  return response.json();
};

const updateStoredShop = async (client, shop) => {
  if (!shop || !shop.shop_id) {
    return;
  }

  await client.query(
    `
      UPDATE etsy_oauth_tokens
      SET shop_id = $1,
          updated_at = NOW()
      WHERE id = 1
    `,
    [shop.shop_id]
  );
};

const createAuthorizationUrl = (state, codeChallenge) => {
  const config = getRequiredConfig();

  if (!config.ok) {
    throw new Error("Missing Etsy integration configuration.");
  }

  const params = new URLSearchParams({
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(" "),
    client_id: config.apiKey,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return `${AUTHORIZATION_URL}?${params.toString()}`;
};

module.exports = {
  REDIRECT_URI,
  SCOPES,
  createAuthorizationUrl,
  createPkcePair,
  createState,
  exchangeAuthorizationCode,
  fetchEtsyApi,
  fetchEtsyJson,
  getPgClient,
  getRequiredConfig,
  getShopForUser,
  getStoredToken,
  normalizeScope,
  parseTokenUserId,
  refreshStoredToken,
  updateStoredShop,
  upsertToken,
};
