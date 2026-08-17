const pool = require("../db");
const { HttpError } = require("../lib/httpError");
const Resolver = require("./exchangeRateResolverService");
const { sumVatLines } = require("./ewtCalculationService");

// Wires Invoice/APV (Checkpoint 3A) to the existing Phase 1/2 currency
// infrastructure. Does NOT duplicate provider-resolution logic - every
// rate comes from exchangeRateResolverService.resolveRate(). Does NOT
// introduce a second VAT/EWT formula - lines stay in the transaction
// currency exactly as ewtCalculationService/currencyService already
// expect, and this file only adds a currency-conversion step AFTER that
// existing tax engine has already produced its result.

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function toMysqlDatetime(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

// Converts every line's foreign debit/credit into base-currency debit/
// credit at the given rate, then corrects for rounding drift so the base
// totals balance EXACTLY (section 14) - per-line rate x amount rounding
// can drift the base sums apart by a centavo even when the foreign lines
// balance exactly, so any drift is absorbed into the last non-zero line
// on each side rather than left as silent GL noise.
function computeBaseLines({ lines, exchangeRate }) {
  const rate = Number(exchangeRate);

  const converted = lines.map((line) => ({
    ...line,
    foreignDebit: roundMoney(line.debit || 0),
    foreignCredit: roundMoney(line.credit || 0),
    baseDebit: roundMoney((Number(line.debit) || 0) * rate),
    baseCredit: roundMoney((Number(line.credit) || 0) * rate),
  }));

  const foreignTotalDebit = roundMoney(converted.reduce((s, l) => s + l.foreignDebit, 0));
  const foreignTotalCredit = roundMoney(converted.reduce((s, l) => s + l.foreignCredit, 0));
  // Both sides target the SAME rounded total (foreign is already balanced
  // by the time this runs - see caller's pre-check), so debit and credit
  // land on an identical base total by construction, guaranteeing balance.
  const target = roundMoney(foreignTotalDebit * rate);

  function correctSide(field, currentSum) {
    const drift = roundMoney(target - currentSum);
    if (drift === 0) return currentSum;
    for (let i = converted.length - 1; i >= 0; i--) {
      if (converted[i][field] > 0) {
        converted[i][field] = roundMoney(converted[i][field] + drift);
        return roundMoney(currentSum + drift);
      }
    }
    return currentSum;
  }

  let baseTotalDebit = roundMoney(converted.reduce((s, l) => s + l.baseDebit, 0));
  let baseTotalCredit = roundMoney(converted.reduce((s, l) => s + l.baseCredit, 0));
  baseTotalDebit = correctSide("baseDebit", baseTotalDebit);
  baseTotalCredit = correctSide("baseCredit", baseTotalCredit);

  return { lines: converted, foreignTotalDebit, foreignTotalCredit, baseTotalDebit, baseTotalCredit };
}

// Derives foreign subtotal/tax/EWT/total from the already-built lines,
// reusing the EXACT same VAT-line detection ewtCalculationService uses
// (sumVatLines) rather than a second formula. taxWithheldAmount is
// whatever the existing EWT flow already computed in the transaction
// currency - untouched by this file.
function computeForeignTaxTotals({ lines, grossAmount, vatKeyword, taxWithheldAmount }) {
  const foreignTax = roundMoney(sumVatLines(lines, vatKeyword));
  const foreignTotal = roundMoney(grossAmount);
  const foreignSubtotal = roundMoney(foreignTotal - foreignTax);
  const foreignEwt = roundMoney(Number(taxWithheldAmount) || 0);
  return { foreignSubtotal, foreignTax, foreignEwt, foreignTotal };
}

async function getSnapshot(transactionType, transactionId) {
  const [rows] = await pool.execute(
    `SELECT id, company_id AS companyId, transaction_type AS transactionType, transaction_id AS transactionId,
            currency_id AS currencyId, currency_code AS currencyCode, base_currency_id AS baseCurrencyId,
            base_currency_code AS baseCurrencyCode, exchange_rate AS exchangeRate, rate_date AS rateDate,
            rate_source AS rateSource, rate_basis AS rateBasis, rate_status AS rateStatus,
            rate_retrieved_at AS rateRetrievedAt, rate_ingestion_method AS rateIngestionMethod,
            rate_locked AS rateLocked, system_rate AS systemRate, override_rate AS overrideRate,
            override_reason AS overrideReason, override_by AS overrideBy, override_at AS overrideAt,
            foreign_subtotal AS foreignSubtotal, foreign_tax AS foreignTax, foreign_ewt AS foreignEwt,
            foreign_total AS foreignTotal, base_subtotal AS baseSubtotal, base_tax AS baseTax,
            base_ewt AS baseEwt, base_total AS baseTotal, created_at AS createdAt, updated_at AS updatedAt
     FROM transaction_currency_snapshots WHERE transaction_type = ? AND transaction_id = ?`,
    [transactionType, transactionId]
  );
  if (!rows.length) return null;
  const row = rows[0];
  return {
    ...row,
    rateLocked: !!row.rateLocked,
    exchangeRate: Number(row.exchangeRate),
    systemRate: row.systemRate == null ? null : Number(row.systemRate),
    overrideRate: row.overrideRate == null ? null : Number(row.overrideRate),
  };
}

// The main entry point Invoice/APV route handlers call. `currencyPayload`
// is null/undefined for a base-currency transaction (backward compatible
// default). Returns everything the caller needs to persist: resolved
// currency/rate info, converted lines, and foreign/base totals. Never
// trusts a frontend-submitted rate at face value - see the branches below.
async function resolveTransactionCurrency({
  user,
  companyId,
  transactionType,
  transactionId, // null for a brand-new transaction
  currencyPayload,
  lines,
  grossAmount,
  vatKeyword,
  taxWithheldAmount,
  isPosting,
}) {
  const baseCurrency = await Resolver.getBaseCurrencyForCompany(companyId);
  const existingSnapshot = transactionId ? await getSnapshot(transactionType, transactionId) : null;

  if (existingSnapshot?.rateLocked) {
    // Posted transactions are immutable on the currency side (section 10).
    const requestedCurrencyId = currencyPayload?.currencyId ?? baseCurrency.id;
    const requestedRate = currencyPayload?.exchangeRate;
    const currencyChanged = Number(requestedCurrencyId) !== existingSnapshot.currencyId;
    const rateChanged = requestedRate != null && Math.abs(Number(requestedRate) - existingSnapshot.exchangeRate) > 0.000001;
    if (currencyChanged || rateChanged) {
      throw new HttpError(409, "Posted transactions use their original exchange rate and cannot be changed.");
    }
    return finalizeWithRate({ currencyId: existingSnapshot.currencyId, currencyCode: existingSnapshot.currencyCode, baseCurrency, rateInfo: existingSnapshot, lines, grossAmount, vatKeyword, taxWithheldAmount, wasLocked: true });
  }

  // No currency selected (or explicitly the base currency) -> plain base-currency transaction.
  const requestedCurrencyId = currencyPayload?.currencyId ? Number(currencyPayload.currencyId) : baseCurrency.id;

  if (requestedCurrencyId === baseCurrency.id) {
    const rateInfo = {
      // rate_date is NOT NULL on transaction_currency_snapshots - a base-
      // currency transaction has no meaningful "rate date" (rate is always
      // 1), but the column still needs a valid value. Falls back to today,
      // same as the foreign-currency branch below.
      currencyCode: baseCurrency.currencyCode, exchangeRate: 1,
      rateDate: currencyPayload?.rateDate || new Date().toISOString().split("T")[0], rateSource: "BASE",
      rateBasis: null, rateStatus: "FINAL", rateRetrievedAt: null, rateIngestionMethod: null,
      systemRate: null, overrideRate: null, overrideReason: null,
    };
    return finalizeWithRate({ currencyId: baseCurrency.id, currencyCode: baseCurrency.currencyCode, baseCurrency, rateInfo, lines, grossAmount, vatKeyword, taxWithheldAmount, wasLocked: false });
  }

  // Foreign currency.
  const [currencyRows] = await pool.execute(
    "SELECT id, currency_code AS currencyCode, is_active AS isActive, company_id AS companyId FROM currencies WHERE id = ?",
    [requestedCurrencyId]
  );
  if (!currencyRows.length || currencyRows[0].companyId !== Number(companyId)) {
    throw new HttpError(400, "Selected currency does not belong to this company.");
  }
  if (!currencyRows[0].isActive) {
    throw new HttpError(400, "Selected currency is not active.");
  }
  const currency = currencyRows[0];
  const transactionDate = currencyPayload?.rateDate || new Date().toISOString().split("T")[0];

  let rateInfo;

  if (currencyPayload?.isOverride) {
    const PermissionService = require("./permissionService");
    const allowed = user.roleCode === "SUPER_ADMIN" || (await PermissionService.can(user.id, "FILESETUP.CURRENCY_SETUP", "OVERRIDE_RATE"));
    if (!allowed) throw new HttpError(403, "You do not have permission to override the exchange rate.");
    if (!currencyPayload.overrideReason || !String(currencyPayload.overrideReason).trim()) {
      throw new HttpError(400, "A reason is required to override the exchange rate.");
    }
    const overrideRate = Number(currencyPayload.exchangeRate);
    if (!Number.isFinite(overrideRate) || overrideRate <= 0) {
      throw new HttpError(400, "Override exchange rate must be greater than zero.");
    }
    const systemResolved = await Resolver.resolveRate({ companyId, foreignCurrencyId: currency.id, transactionDate });
    rateInfo = {
      currencyCode: currency.currencyCode, exchangeRate: overrideRate, rateDate: transactionDate,
      rateSource: systemResolved.provider || "MANUAL", rateBasis: systemResolved.rateBasis, rateStatus: "APPROVED",
      rateRetrievedAt: new Date().toISOString(), rateIngestionMethod: "MANUAL_ENTRY",
      systemRate: systemResolved.rate, overrideRate, overrideReason: currencyPayload.overrideReason,
      overrideBy: user.id, overrideAt: new Date().toISOString(),
    };
  } else if (currencyPayload?.isRefresh || !existingSnapshot) {
    // Explicit refresh, OR the very first save of a new transaction -
    // both independently re-resolve rather than trusting whatever the
    // frontend suggested (section 38/39 - backend is authoritative).
    const resolved = await Resolver.resolveRate({ companyId, foreignCurrencyId: currency.id, transactionDate });
    if (resolved.rate == null) {
      throw new HttpError(422, resolved.errorMessage || `No approved exchange rate is available for ${currency.currencyCode}/${baseCurrency.currencyCode} on ${transactionDate}.`);
    }
    rateInfo = {
      currencyCode: currency.currencyCode, exchangeRate: resolved.rate, rateDate: resolved.effectiveDate,
      rateSource: resolved.provider, rateBasis: resolved.rateBasis, rateStatus: resolved.status,
      rateRetrievedAt: resolved.retrievalTimestamp, rateIngestionMethod: resolved.derivationMethod ? "DERIVED" : "API",
      systemRate: resolved.rate, overrideRate: null, overrideReason: null,
    };
  } else {
    // Existing unlocked draft, no explicit refresh/override requested:
    // keep the STORED rate exactly as-is (section 8 - "do not silently
    // change the rate every time the draft is opened"). The frontend's
    // submitted rate is ignored in favor of what's already on file.
    rateInfo = {
      currencyCode: existingSnapshot.currencyCode, exchangeRate: existingSnapshot.exchangeRate, rateDate: existingSnapshot.rateDate,
      rateSource: existingSnapshot.rateSource, rateBasis: existingSnapshot.rateBasis, rateStatus: existingSnapshot.rateStatus,
      rateRetrievedAt: existingSnapshot.rateRetrievedAt, rateIngestionMethod: existingSnapshot.rateIngestionMethod,
      systemRate: existingSnapshot.systemRate, overrideRate: existingSnapshot.overrideRate, overrideReason: existingSnapshot.overrideReason,
    };
  }

  if (isPosting) {
    // Section 9: posting policy enforcement.
    const policy = await Resolver.getCompanyPolicy(companyId);
    if (policy.postingRateType === "FINAL" && rateInfo.rateStatus && ["INDICATIVE", "PROVISIONAL"].includes(rateInfo.rateStatus)) {
      throw new HttpError(422, "Cannot post this transaction because the current exchange rate is provisional. Refresh or select an approved final rate.");
    }
  }

  return finalizeWithRate({ currencyId: currency.id, currencyCode: currency.currencyCode, baseCurrency, rateInfo, lines, grossAmount, vatKeyword, taxWithheldAmount, wasLocked: false });
}

function finalizeWithRate({ currencyId, currencyCode, baseCurrency, rateInfo, lines, grossAmount, vatKeyword, taxWithheldAmount, wasLocked }) {
  const { lines: convertedLines, foreignTotalDebit, foreignTotalCredit, baseTotalDebit, baseTotalCredit } = computeBaseLines({ lines, exchangeRate: rateInfo.exchangeRate });

  if (Math.abs(foreignTotalDebit - foreignTotalCredit) > 0.01) {
    throw new HttpError(400, "Transaction lines are not balanced in the transaction currency.");
  }

  const foreignTotals = computeForeignTaxTotals({ lines, grossAmount, vatKeyword, taxWithheldAmount });
  const baseTotals = {
    baseSubtotal: roundMoney(foreignTotals.foreignSubtotal * rateInfo.exchangeRate),
    baseTax: roundMoney(foreignTotals.foreignTax * rateInfo.exchangeRate),
    baseEwt: roundMoney(foreignTotals.foreignEwt * rateInfo.exchangeRate),
    baseTotal: baseTotalDebit, // authoritative - matches the actually-balanced GL lines, not a second independent conversion
  };

  return {
    currencyId, currencyCode, baseCurrencyId: baseCurrency.id, baseCurrencyCode: baseCurrency.currencyCode,
    rateInfo, lines: convertedLines, foreignTotalDebit, foreignTotalCredit, baseTotalDebit, baseTotalCredit,
    foreignTotals, baseTotals, wasLocked,
  };
}

async function saveSnapshot(conn, { companyId, transactionType, transactionId, currencyId, currencyCode, baseCurrencyId, baseCurrencyCode, rateInfo, foreignTotals, baseTotals, userId, lockNow }) {
  await conn.execute(
    `INSERT INTO transaction_currency_snapshots (
      company_id, transaction_type, transaction_id, currency_id, currency_code, base_currency_id, base_currency_code,
      exchange_rate, rate_date, rate_source, rate_basis, rate_status, rate_retrieved_at, rate_ingestion_method,
      rate_locked, system_rate, override_rate, override_reason, override_by, override_at,
      foreign_subtotal, foreign_tax, foreign_ewt, foreign_total, base_subtotal, base_tax, base_ewt, base_total, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      currency_id = VALUES(currency_id), currency_code = VALUES(currency_code),
      base_currency_id = VALUES(base_currency_id), base_currency_code = VALUES(base_currency_code),
      exchange_rate = VALUES(exchange_rate), rate_date = VALUES(rate_date), rate_source = VALUES(rate_source),
      rate_basis = VALUES(rate_basis), rate_status = VALUES(rate_status), rate_retrieved_at = VALUES(rate_retrieved_at),
      rate_ingestion_method = VALUES(rate_ingestion_method),
      rate_locked = IF(rate_locked = 1, 1, VALUES(rate_locked)),
      system_rate = VALUES(system_rate), override_rate = VALUES(override_rate), override_reason = VALUES(override_reason),
      override_by = VALUES(override_by), override_at = VALUES(override_at),
      foreign_subtotal = VALUES(foreign_subtotal), foreign_tax = VALUES(foreign_tax), foreign_ewt = VALUES(foreign_ewt),
      foreign_total = VALUES(foreign_total), base_subtotal = VALUES(base_subtotal), base_tax = VALUES(base_tax),
      base_ewt = VALUES(base_ewt), base_total = VALUES(base_total)`,
    [
      companyId, transactionType, transactionId, currencyId, currencyCode, baseCurrencyId, baseCurrencyCode,
      rateInfo.exchangeRate, rateInfo.rateDate, rateInfo.rateSource, rateInfo.rateBasis || null, rateInfo.rateStatus || null,
      toMysqlDatetime(rateInfo.rateRetrievedAt), rateInfo.rateIngestionMethod || null,
      lockNow ? 1 : 0, rateInfo.systemRate, rateInfo.overrideRate, rateInfo.overrideReason || null,
      rateInfo.overrideBy || null, toMysqlDatetime(rateInfo.overrideAt),
      foreignTotals.foreignSubtotal, foreignTotals.foreignTax, foreignTotals.foreignEwt, foreignTotals.foreignTotal,
      baseTotals.baseSubtotal, baseTotals.baseTax, baseTotals.baseEwt, baseTotals.baseTotal, userId,
    ]
  );
}

async function lockSnapshot(conn, transactionType, transactionId) {
  await conn.execute(
    "UPDATE transaction_currency_snapshots SET rate_locked = 1 WHERE transaction_type = ? AND transaction_id = ?",
    [transactionType, transactionId]
  );
}

// ---- Checkpoint 3B: payment applications (OR->Invoice, CV->APV) --------
// Reused by both OR and CV route handlers - one code path, not a second
// copy of the conversion/validation logic per module.

// Pure function: validates a single payment-application line and computes
// its currency/rate/FX metadata. Never touches the DB - the caller
// supplies the source document's currency/rate (from its OWN, already-
// locked snapshot) and the payment document's currency/rate (from the
// OR/CV's own snapshot) separately, because they are two independent
// historical facts (section 2) that must never be conflated.
//
// perspective: "RECEIVABLE" (Invoice/OR - a stronger foreign currency at
// payment time than at invoice time means MORE base currency received
// than recorded, i.e. a GAIN) or "PAYABLE" (APV/CV - the inverse: paying
// MORE base currency than the liability was carried at is a LOSS).
function buildApplication({
  sourceCurrencyCode,
  sourceExchangeRate,
  paymentCurrencyCode,
  paymentExchangeRate,
  foreignAmountApplied,
  perspective,
  isPosting,
}) {
  if (sourceCurrencyCode !== paymentCurrencyCode) {
    throw new HttpError(
      400,
      "This payment currency differs from the source document currency. Cross-currency settlement is not enabled."
    );
  }

  const srcRate = Number(sourceExchangeRate) || 1;
  const payRate = Number(paymentExchangeRate) || 1;
  const foreignAmount = roundMoney(foreignAmountApplied);
  const sourceBaseAmount = roundMoney(foreignAmount * srcRate);
  const paymentBaseAmount = roundMoney(foreignAmount * payRate);
  const fxDifference = roundMoney(paymentBaseAmount - sourceBaseAmount);
  const rateMismatch = Math.abs(srcRate - payRate) > 0.000001;

  let fxDirection = "NONE";
  if (fxDifference !== 0) {
    fxDirection =
      perspective === "PAYABLE"
        ? fxDifference > 0 ? "REALIZED_LOSS" : "REALIZED_GAIN"
        : fxDifference > 0 ? "REALIZED_GAIN" : "REALIZED_LOSS";
  }

  // Checkpoint 3FX: a different rate no longer blocks posting outright -
  // the caller (paymentApplicationService.js) is responsible for adding a
  // realized FX gain/loss journal line for `fxDifference` and rejecting
  // the post if the relevant FX account isn't configured
  // (fxAccountService.requireFxAccount). isPosting/rateMismatch are still
  // returned so callers that care can act on them; this function itself
  // no longer throws for a mismatch alone (section 11 of the 3FX spec:
  // "Remove the current different-rate-settlement-blocked behavior only
  // after correct FX lines are generated" - the FX-line generation lives
  // one layer up, this function only supplies the numbers).

  return {
    sourceCurrencyCode,
    paymentCurrencyCode,
    sourceExchangeRate: srcRate,
    paymentExchangeRate: payRate,
    foreignAmountApplied: foreignAmount,
    sourceBaseAmount,
    paymentBaseAmount,
    fxDifference,
    fxDirection,
    rateMismatch,
    isPosting,
    // What gets recorded as `transaction_applications.amount` (base
    // currency) and summed by updateInvoicePaymentStatus/
    // updateApvPaymentStatus into the source document's own paid_amount.
    // Must be sourceBaseAmount (valued at the SOURCE's own historical
    // rate), not paymentBaseAmount - the source header's total_debit/
    // total_credit are themselves valued at that same historical rate, so
    // paid_amount and balance_amount must stay on that one consistent
    // basis or the base-currency balance would silently mix two different
    // valuations. Identical to paymentBaseAmount whenever rates match, so
    // this changes nothing for same-rate settlements.
    baseAmount: sourceBaseAmount,
  };
}

// DB-backed: derives a source document's (Invoice/APV) foreign payment
// state purely from already-committed facts - its own locked currency
// snapshot (foreign_total, never recomputed) and the live SUM of
// `foreign_amount_applied` across its transaction_applications rows. Mirrors
// server.js's updateInvoicePaymentStatus/updateApvPaymentStatus "recompute
// from source of truth" pattern instead of trusting an incrementally
// maintained running total, so it can never drift out of sync with the
// applications actually on file (including after an edit-time reversal).
async function getForeignPaymentState(conn, { transactionType, transactionId }) {
  const snapshot = await getSnapshot(transactionType, transactionId);
  if (!snapshot || snapshot.currencyId === snapshot.baseCurrencyId) {
    return { hasForeignCurrency: false };
  }

  const [sumRows] = await conn.execute(
    `SELECT COALESCE(SUM(foreign_amount_applied), 0) AS foreignPaid
     FROM transaction_applications
     WHERE source_type = ? AND source_id = ?`,
    [transactionType, transactionId]
  );

  const foreignOriginalAmount = roundMoney(snapshot.foreignTotal);
  const foreignPaidAmount = roundMoney(Number(sumRows[0].foreignPaid) || 0);
  const foreignBalanceAmount = roundMoney(Math.max(foreignOriginalAmount - foreignPaidAmount, 0));

  return {
    hasForeignCurrency: true,
    currencyCode: snapshot.currencyCode,
    exchangeRate: snapshot.exchangeRate,
    foreignOriginalAmount,
    foreignPaidAmount,
    foreignBalanceAmount,
  };
}

module.exports = {
  roundMoney,
  computeBaseLines,
  computeForeignTaxTotals,
  getSnapshot,
  resolveTransactionCurrency,
  saveSnapshot,
  lockSnapshot,
  buildApplication,
  getForeignPaymentState,
};
