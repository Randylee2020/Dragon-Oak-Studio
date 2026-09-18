const {
  fetchEtsyJson,
  getPgClient,
  getRequiredConfig,
  getStoredToken,
} = require("./_lib/etsy-oauth");

const DEFAULT_RECEIPT_ID = "4155757603";
const DEFAULT_TRANSACTION_ID = "5192982656";
const MIN_ETSY_TIMESTAMP = 946684800;
const LEDGER_HALF_WINDOW_SECONDS = 15 * 24 * 60 * 60;

const json = (response, statusCode, payload) => {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
};

const getQueryValue = (value) => (Array.isArray(value) ? value[0] : value);

const cleanId = (value, fallback) => {
  const id = String(getQueryValue(value) || fallback).trim();
  return /^\d+$/.test(id) ? id : null;
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

const getMoneyCurrency = (money) => money && money.currency_code ? money.currency_code : null;

const getMoneyDivisor = (money) =>
  money && Number.isFinite(Number(money.divisor)) ? Number(money.divisor) : null;

const getMinorDisplay = (amount, divisor, currency) => {
  if (amount === null || amount === undefined || !divisor || !currency) {
    return null;
  }

  const numericAmount = Number(amount);

  if (!Number.isFinite(numericAmount)) {
    return null;
  }

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(numericAmount / divisor);
  } catch {
    return `${(numericAmount / divisor).toFixed(2)} ${currency}`;
  }
};

const normalizeMinorAmount = (amount, currency, divisor) => {
  if (amount === null || amount === undefined) {
    return null;
  }

  return {
    amount,
    divisor,
    currency,
    display: getMinorDisplay(amount, divisor, currency),
  };
};

const getArray = (value) => (Array.isArray(value) ? value : []);

const uniqueValues = (values) =>
  [...new Set(values.filter((value) => value !== null && value !== undefined))];

const getTimestamp = (record, keys) => {
  for (const key of keys) {
    const value = Number(record && record[key]);

    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }

  return null;
};

const safeFetchEtsyJson = async (path, accessToken, notes, label) => {
  try {
    return await fetchEtsyJson(path, accessToken);
  } catch (error) {
    error.step = label;

    if (error.status === 404) {
      notes.push(`${label} was not found or is not available from Etsy for this shop.`);
      return null;
    }

    throw error;
  }
};

const getPaymentCurrency = (payment) =>
  getMoneyCurrency(payment && payment.amount_gross) ||
  getMoneyCurrency(payment && payment.amount_net) ||
  getMoneyCurrency(payment && payment.posted_net) ||
  (payment && (payment.shop_currency || payment.currency || payment.buyer_currency)) ||
  null;

const getPaymentDivisor = (payment) =>
  getMoneyDivisor(payment && payment.amount_gross) ||
  getMoneyDivisor(payment && payment.amount_net) ||
  getMoneyDivisor(payment && payment.posted_net) ||
  null;

const normalizeFee = (type, money, description) => {
  const amount = normalizeMoney(money);

  if (!amount) {
    return null;
  }

  return {
    type,
    amount,
    currency: amount.currency,
    description,
  };
};

const getFees = (payment) =>
  [
    normalizeFee("amount_fees", payment && payment.amount_fees, "Original Etsy payment fees, when available."),
    normalizeFee("posted_fees", payment && payment.posted_fees, "Fees posted to the ledger after shipment, when available."),
    normalizeFee("adjusted_fees", payment && payment.adjusted_fees, "Fees after Etsy payment adjustments, when available."),
  ].filter(Boolean);

const normalizeAdjustmentItem = (item, currency, divisor) => ({
  paymentAdjustmentItemId: item.payment_adjustment_item_id,
  adjustmentType: item.adjustment_type,
  transactionId: item.transaction_id,
  amount: normalizeMinorAmount(item.amount, currency, divisor),
  shopAmount: normalizeMinorAmount(item.shop_amount, currency, divisor),
  createdTimestamp: item.created_timestamp || null,
  updatedTimestamp: item.updated_timestamp || null,
});

const normalizeAdjustment = (adjustment, currency, divisor) => ({
  paymentAdjustmentId: adjustment.payment_adjustment_id,
  paymentId: adjustment.payment_id,
  status: adjustment.status,
  isSuccess: adjustment.is_success,
  reasonCode: adjustment.reason_code,
  totalAdjustmentAmount: normalizeMinorAmount(adjustment.total_adjustment_amount, currency, divisor),
  shopTotalAdjustmentAmount: normalizeMinorAmount(adjustment.shop_total_adjustment_amount, currency, divisor),
  buyerTotalAdjustmentAmount: normalizeMinorAmount(adjustment.buyer_total_adjustment_amount, currency, divisor),
  totalFeeAdjustmentAmount: normalizeMinorAmount(adjustment.total_fee_adjustment_amount, currency, divisor),
  createdTimestamp: adjustment.created_timestamp || adjustment.create_timestamp || null,
  updatedTimestamp: adjustment.updated_timestamp || adjustment.update_timestamp || null,
  items: getArray(adjustment.payment_adjustment_items).map((item) =>
    normalizeAdjustmentItem(item, currency, divisor)
  ),
});

const normalizeRefund = (refund) => ({
  amount: normalizeMoney(refund.amount),
  status: refund.status,
  reason: refund.reason,
  createdTimestamp: refund.created_timestamp || null,
});

const normalizeLedgerAmount = (entry) => ({
  amount: entry.amount,
  divisor: null,
  currency: entry.currency || null,
  display: null,
});

const normalizeLedgerEntry = (entry) => ({
  entryId: entry.entry_id,
  ledgerId: entry.ledger_id,
  ledgerType: entry.ledger_type,
  referenceType: entry.reference_type,
  referenceId: entry.reference_id,
  description: entry.description,
  amount: normalizeLedgerAmount(entry),
  createdTimestamp: entry.created_timestamp || entry.create_date || null,
});

const entryMatchesTrace = (entry, traceIds) => {
  const referenceId = String(entry.reference_id || "");

  if (traceIds.has(referenceId)) {
    return true;
  }

  return getArray(entry.payment_adjustments).some((adjustment) => {
    if (traceIds.has(String(adjustment.payment_id || ""))) {
      return true;
    }

    return getArray(adjustment.payment_adjustment_items).some((item) =>
      traceIds.has(String(item.transaction_id || "")) ||
      traceIds.has(String(item.bill_payment_id || ""))
    );
  });
};

const getDepositCandidates = (entries) =>
  entries.filter((entry) => {
    const text = `${entry.ledgerType || ""} ${entry.referenceType || ""} ${entry.description || ""}`.toLowerCase();
    return text.includes("deposit") || text.includes("payout") || text.includes("disbursement");
  });

const getLedgerWindows = (records) => {
  const timestamps = records
    .flatMap((record) => [
      getTimestamp(record, ["created_timestamp", "create_timestamp", "create_date"]),
      getTimestamp(record, ["updated_timestamp", "update_timestamp"]),
      getTimestamp(record, ["shipped_timestamp", "paid_timestamp"]),
    ])
    .filter(Boolean);

  if (!timestamps.length) {
    return [];
  }

  const tomorrow = Math.floor(Date.now() / 1000) + 24 * 60 * 60;

  return uniqueValues(timestamps).map((timestamp) => ({
    minCreated: Math.max(MIN_ETSY_TIMESTAMP, timestamp - LEDGER_HALF_WINDOW_SECONDS),
    maxCreated: Math.min(timestamp + LEDGER_HALF_WINDOW_SECONDS, tomorrow),
  }));
};

const getFinancialTrace = async (shopId, accessToken, receiptId, transactionId) => {
  const notes = [
    "Etsy Seller App APIs expose receipt, payment, and payment account ledger records for shops authorized with transactions_r.",
    "Etsy payment records expose gross, fee, net, posted, and adjusted amounts when the payment exists.",
    "Etsy payment account ledger entries expose ledger amounts, descriptions, reference IDs, and adjustments; they do not expose bank account destination details.",
    "Etsy rejects payment account ledger entry requests with a min_created/max_created window greater than 31 days, so this endpoint queries narrower timestamp windows.",
  ];

  const receipt = await safeFetchEtsyJson(
    `/shops/${shopId}/receipts/${receiptId}?legacy=true`,
    accessToken,
    notes,
    "Receipt"
  );

  if (!receipt) {
    const error = new Error("Receipt is not available from Etsy.");
    error.status = 404;
    throw error;
  }

  const transactionsData = await safeFetchEtsyJson(
    `/shops/${shopId}/receipts/${receiptId}/transactions?legacy=true`,
    accessToken,
    notes,
    "Receipt transactions"
  );
  const receiptTransactions = getArray(transactionsData && transactionsData.results);
  const embeddedTransactions = getArray(receipt.transactions);
  const transactions = receiptTransactions.length ? receiptTransactions : embeddedTransactions;
  const matchingTransactions = transactions.filter(
    (transaction) => String(transaction.transaction_id || "") === transactionId
  );

  if (!matchingTransactions.length) {
    notes.push("The requested transaction ID was not present in the receipt transaction data Etsy returned.");
  }

  const paymentsData = await safeFetchEtsyJson(
    `/shops/${shopId}/receipts/${receiptId}/payments`,
    accessToken,
    notes,
    "Receipt payment"
  );
  const payments = getArray(paymentsData && paymentsData.results)
    .filter((payment) => String(payment.receipt_id || "") === receiptId);
  const payment = payments[0] || null;

  if (!payment) {
    notes.push("No payment record was returned for this receipt. Etsy notes payment records may not exist until a purchase ships.");
  }

  const ledgerRecords = [receipt, payment, ...transactions].filter(Boolean);
  const ledgerWindows = getLedgerWindows(ledgerRecords);
  let ledgerEntries = [];
  let linkedPayments = [];

  if (ledgerWindows.length) {
    const ledgerResults = [];

    for (const ledgerWindow of ledgerWindows) {
      const params = new URLSearchParams({
        min_created: String(ledgerWindow.minCreated),
        max_created: String(ledgerWindow.maxCreated),
        limit: "100",
        offset: "0",
      });
      const ledgerData = await safeFetchEtsyJson(
        `/shops/${shopId}/payment-account/ledger-entries?${params.toString()}`,
        accessToken,
        notes,
        "Payment account ledger entries"
      );

      ledgerResults.push(...getArray(ledgerData && ledgerData.results));
    }

    const traceIds = new Set([
      receiptId,
      transactionId,
      ...payments.map((record) => String(record.payment_id || "")).filter(Boolean),
    ]);
    ledgerEntries = uniqueValues(ledgerResults.map((entry) => entry.entry_id))
      .map((entryId) => ledgerResults.find((entry) => entry.entry_id === entryId))
      .filter((entry) => entryMatchesTrace(entry, traceIds))
      .map(normalizeLedgerEntry);

    if (!ledgerEntries.length) {
      notes.push("No ledger entries in the queried timestamp window directly matched the receipt, transaction, or payment IDs Etsy returned.");
    }

    const ledgerEntryIds = ledgerEntries.map((entry) => entry.entryId).filter(Boolean);

    if (ledgerEntryIds.length) {
      const ledgerPaymentParams = new URLSearchParams({
        ledger_entry_ids: ledgerEntryIds.join(","),
      });
      const ledgerPaymentsData = await safeFetchEtsyJson(
        `/shops/${shopId}/payment-account/ledger-entries/payments?${ledgerPaymentParams.toString()}`,
        accessToken,
        notes,
        "Ledger entry payment links"
      );
      linkedPayments = getArray(ledgerPaymentsData && ledgerPaymentsData.results)
        .filter((record) => String(record.receipt_id || "") === receiptId)
        .map((record) => ({
          paymentId: record.payment_id,
          receiptId: record.receipt_id,
          status: record.status,
          grossSale: normalizeMoney(record.amount_gross),
          fees: normalizeMoney(record.amount_fees),
          netAmount: normalizeMoney(record.amount_net),
          postedNet: normalizeMoney(record.posted_net),
          adjustedNet: normalizeMoney(record.adjusted_net),
        }));
    }
  } else {
    notes.push("Ledger entries were not queried because Etsy did not return usable receipt, transaction, or payment timestamps.");
  }

  const depositCandidates = getDepositCandidates(ledgerEntries);
  const paymentCurrency = getPaymentCurrency(payment);
  const paymentDivisor = getPaymentDivisor(payment);

  if (!paymentDivisor) {
    notes.push("Some adjustment and ledger amount fields are not Etsy Money objects, so divisor/display values are only included where Etsy exposes enough currency metadata.");
  }

  if (!depositCandidates.length) {
    notes.push("No directly correlated Etsy ledger entry exposed a deposit, payout, or disbursement record for this trace.");
  }

  return {
    grossSale: normalizeMoney(payment && payment.amount_gross) || normalizeMoney(receipt.grandtotal),
    fees: getFees(payment),
    adjustments: getArray(payment && payment.payment_adjustments).map((adjustment) =>
      normalizeAdjustment(adjustment, paymentCurrency, paymentDivisor)
    ),
    credits: getArray(receipt.refunds).map(normalizeRefund),
    netAmount:
      normalizeMoney(payment && payment.adjusted_net) ||
      normalizeMoney(payment && payment.posted_net) ||
      normalizeMoney(payment && payment.amount_net),
    paymentStatus: payment ? payment.status : null,
    payout: {
      available: Boolean(depositCandidates.length),
      note: "Bank destination and bank account details are not exposed by Etsy Open API v3 Seller App endpoints.",
      ledgerEntries,
      linkedPayments,
    },
    depositDate: depositCandidates[0] ? depositCandidates[0].createdTimestamp : null,
    depositStatus: depositCandidates[0] ? depositCandidates[0].description || depositCandidates[0].ledgerType : null,
    availabilityNotes: notes,
  };
};

module.exports = async function etsyFinancesHandler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return json(response, 405, {
      ok: false,
      message: "Method not allowed.",
    });
  }

  const receiptId = cleanId(request.query && request.query.receiptId, DEFAULT_RECEIPT_ID);
  const transactionId = cleanId(request.query && request.query.transactionId, DEFAULT_TRANSACTION_ID);

  if (!receiptId || !transactionId) {
    return json(response, 400, {
      ok: false,
      message: "receiptId and transactionId must be numeric Etsy IDs.",
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
  let shopId = null;

  try {
    client = await getPgClient();

    const token = await getStoredToken(client);

    if (!token) {
      return json(response, 200, {
        ok: true,
        connected: false,
        shopId: null,
        receiptId,
        transactionId,
        grossSale: null,
        fees: [],
        adjustments: [],
        credits: [],
        netAmount: null,
        paymentStatus: null,
        payout: null,
        depositDate: null,
        depositStatus: null,
        availabilityNotes: ["No Etsy OAuth connection is stored."],
      });
    }

    if (!token.shopId) {
      return json(response, 409, {
        ok: false,
        connected: false,
        shopId: null,
        receiptId,
        transactionId,
        grossSale: null,
        fees: [],
        adjustments: [],
        credits: [],
        netAmount: null,
        paymentStatus: null,
        payout: null,
        depositDate: null,
        depositStatus: null,
        availabilityNotes: ["Etsy is connected, but no shop is associated with the stored token."],
      });
    }

    shopId = token.shopId;
    const trace = await getFinancialTrace(shopId, token.accessToken, receiptId, transactionId);

    return json(response, 200, {
      ok: true,
      connected: true,
      shopId,
      receiptId,
      transactionId,
      ...trace,
    });
  } catch (error) {
    console.error("Etsy finance trace failed:", error.message);

    const etsyDiagnostic = error.status
      ? {
          step: error.step || "Etsy API request",
          status: error.status,
          category: error.etsy && error.etsy.category ? error.etsy.category : "etsy_request_error",
          message: error.etsy && error.etsy.message ? error.etsy.message : "Etsy API request failed.",
        }
      : null;

    if (error.status === 404) {
      return json(response, 404, {
        ok: false,
        connected: true,
        shopId,
        receiptId,
        transactionId,
        message: "The requested Etsy receipt or financial record was not found.",
        etsy: etsyDiagnostic,
      });
    }

    if (error.status) {
      return json(response, 502, {
        ok: false,
        connected: true,
        shopId,
        receiptId,
        transactionId,
        message: "Unable to fetch Etsy finance data right now.",
        etsy: etsyDiagnostic,
      });
    }

    return json(response, 500, {
      ok: false,
      message: "Unable to load Etsy finance data.",
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
