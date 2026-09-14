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

const getMoneyDisplay = (money) => {
  if (!money || money.amount === undefined || money.divisor === undefined || !money.currency_code) {
    return null;
  }

  const amount = Number(money.amount);
  const divisor = Number(money.divisor);

  if (!Number.isFinite(amount) || !Number.isFinite(divisor) || divisor <= 0) {
    return null;
  }

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: money.currency_code,
    }).format(amount / divisor);
  } catch {
    return `${(amount / divisor).toFixed(2)} ${money.currency_code}`;
  }
};

const normalizeMoney = (money) => {
  if (!money) {
    return null;
  }

  return {
    amount: money.amount,
    divisor: money.divisor,
    currency: money.currency_code,
    display: getMoneyDisplay(money),
  };
};

const getBooleanOrNull = (value) => (typeof value === "boolean" ? value : null);

const getTransactions = (receipt) =>
  Array.isArray(receipt.transactions) ? receipt.transactions : [];

const uniqueValues = (values) => [...new Set(values.filter((value) => value !== null && value !== undefined))];

const getTransactionQuantity = (transaction) => {
  const quantity = Number(transaction.quantity);
  return Number.isFinite(quantity) ? quantity : 0;
};

const normalizeOrder = (receipt) => {
  const transactions = getTransactions(receipt);
  const itemCount = transactions.length
    ? transactions.reduce((total, transaction) => total + getTransactionQuantity(transaction), 0)
    : Number(receipt.item_count || receipt.items_count || 0);

  return {
    receiptId: receipt.receipt_id,
    status: receipt.status,
    paidState: receipt.was_paid === true ? "paid" : receipt.was_paid === false ? "unpaid" : null,
    wasPaid: getBooleanOrNull(receipt.was_paid),
    wasShipped: getBooleanOrNull(receipt.was_shipped),
    wasDelivered: getBooleanOrNull(receipt.was_delivered),
    wasCanceled: getBooleanOrNull(receipt.was_canceled),
    orderTotal: normalizeMoney(receipt.grandtotal || receipt.total_price),
    itemCount,
    listingIds: uniqueValues(transactions.map((transaction) => transaction.listing_id)),
    listingTitles: uniqueValues(transactions.map((transaction) => transaction.title)),
    quantities: transactions.map((transaction) => getTransactionQuantity(transaction)),
    transactionIds: uniqueValues(transactions.map((transaction) => transaction.transaction_id)),
    createdTimestamp: receipt.created_timestamp || receipt.create_timestamp || null,
    updatedTimestamp: receipt.updated_timestamp || receipt.update_timestamp || receipt.last_modified_timestamp || null,
  };
};

const getRecentOrders = async (shopId, accessToken) => {
  const params = new URLSearchParams({
    limit: "50",
    offset: "0",
    sort_on: "created",
    sort_order: "desc",
  });
  const response = await fetchEtsyApi(`/shops/${shopId}/receipts?${params.toString()}`, accessToken);

  if (!response.ok) {
    const error = new Error("Etsy orders request failed.");
    error.status = response.status;
    throw error;
  }

  try {
    return await response.json();
  } catch {
    const error = new Error("Etsy returned an invalid orders response.");
    error.status = 502;
    throw error;
  }
};

module.exports = async function etsyOrdersHandler(request, response) {
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
        orders: [],
      });
    }

    if (!token.shopId) {
      return json(response, 409, {
        ok: false,
        connected: false,
        shopId: null,
        count: 0,
        orders: [],
        message: "Etsy is connected, but no shop is associated with the stored token.",
      });
    }

    const ordersData = await getRecentOrders(token.shopId, token.accessToken);
    const orders = Array.isArray(ordersData.results)
      ? ordersData.results.map(normalizeOrder)
      : [];

    return json(response, 200, {
      ok: true,
      connected: true,
      shopId: token.shopId,
      count: Number.isFinite(Number(ordersData.count)) ? Number(ordersData.count) : orders.length,
      orders,
    });
  } catch (error) {
    console.error("Etsy orders request failed:", error.message);

    if (error.status) {
      return json(response, 502, {
        ok: false,
        connected: true,
        message: "Unable to fetch Etsy orders right now.",
      });
    }

    return json(response, 500, {
      ok: false,
      message: "Unable to load Etsy orders.",
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
