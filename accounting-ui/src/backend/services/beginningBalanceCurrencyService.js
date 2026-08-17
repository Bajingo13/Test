const pool = require("../db");
const { HttpError } = require("../lib/httpError");
const Resolver = require("./exchangeRateResolverService");
const TransactionCurrencyService = require("./transactionCurrencyService");

// Checkpoint 3D Part A: resolves the opening currency/rate for ONE
// beginning-balance line/document (GL, AR, or AP). Deliberately separate
// from transactionCurrencyService.resolveTransactionCurrency: that function
// enforces foreign-debit == foreign-credit on the set of lines it's given,
// which is correct for a single transaction (Invoice/APV/OR/CV/JV/PO) but
// wrong here - a beginning balance line is one leg of a batch that balances
// across the WHOLE header/batch (section 4), not per line. This function
// reuses the same primitives (resolver, permission check, snapshot
// lock/override shape) without that per-call balance assumption.
//
// transactionType is one of 'GL_BEGINNING' | 'AR_BEGINNING' | 'AP_BEGINNING',
// transactionId is the beginning-balance LINE's own id (each line is its
// own "document" for transaction_currency_snapshots purposes - see the
// migration file's design note).

const { roundMoney } = TransactionCurrencyService;

async function resolveLineCurrency({ user, companyId, transactionType, transactionId, currencyPayload, rateDate }) {
  const baseCurrency = await Resolver.getBaseCurrencyForCompany(companyId);
  const existingSnapshot = transactionId
    ? await TransactionCurrencyService.getSnapshot(transactionType, transactionId)
    : null;

  if (existingSnapshot?.rateLocked) {
    const requestedCurrencyId = currencyPayload?.currencyId ?? baseCurrency.id;
    const requestedRate = currencyPayload?.exchangeRate;
    const currencyChanged = Number(requestedCurrencyId) !== existingSnapshot.currencyId;
    const rateChanged = requestedRate != null && Math.abs(Number(requestedRate) - existingSnapshot.exchangeRate) > 0.000001;
    if (currencyChanged || rateChanged) {
      throw new HttpError(409, "This beginning balance is finalized - its opening exchange rate cannot be changed.");
    }
    return { currencyId: existingSnapshot.currencyId, currencyCode: existingSnapshot.currencyCode, baseCurrency, rateInfo: existingSnapshot, wasLocked: true };
  }

  const requestedCurrencyId = currencyPayload?.currencyId ? Number(currencyPayload.currencyId) : baseCurrency.id;

  if (requestedCurrencyId === baseCurrency.id) {
    return {
      currencyId: baseCurrency.id, currencyCode: baseCurrency.currencyCode, baseCurrency,
      rateInfo: {
        currencyCode: baseCurrency.currencyCode, exchangeRate: 1,
        rateDate: rateDate || currencyPayload?.rateDate || new Date().toISOString().split("T")[0],
        rateSource: "BASE", rateBasis: null, rateStatus: "FINAL", rateRetrievedAt: null, rateIngestionMethod: null,
        systemRate: null, overrideRate: null, overrideReason: null,
      },
      wasLocked: false,
    };
  }

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
  const effectiveDate = rateDate || currencyPayload?.rateDate || new Date().toISOString().split("T")[0];

  let rateInfo;
  if (currencyPayload?.isManualRate) {
    // Beginning balances routinely need a historical/migration rate no
    // provider will ever carry (section 5D) - gated behind the same
    // OVERRIDE_RATE permission used for live-transaction overrides
    // (section 44), since it's the same "a human is asserting a rate"
    // trust boundary, just applied to an opening balance.
    const PermissionService = require("./permissionService");
    const allowed = user.roleCode === "SUPER_ADMIN" || (await PermissionService.can(user.id, "FILESETUP.CURRENCY_SETUP", "OVERRIDE_RATE"));
    if (!allowed) throw new HttpError(403, "You do not have permission to manually set an opening exchange rate.");
    const manualRate = Number(currencyPayload.exchangeRate);
    if (!Number.isFinite(manualRate) || manualRate <= 0) {
      throw new HttpError(400, "Opening exchange rate must be greater than zero.");
    }
    rateInfo = {
      currencyCode: currency.currencyCode, exchangeRate: manualRate, rateDate: effectiveDate,
      rateSource: "MANUAL", rateBasis: null, rateStatus: "MANUAL",
      rateRetrievedAt: new Date().toISOString(), rateIngestionMethod: "MANUAL_ENTRY",
      systemRate: null, overrideRate: manualRate, overrideReason: currencyPayload.overrideReason || "Manual opening balance rate",
      overrideBy: user.id, overrideAt: new Date().toISOString(),
    };
  } else {
    // Historical lookup via the existing Phase 2 resolver, using the
    // OPENING/rate date - never today's date (section 2/5C/12).
    const resolved = await Resolver.resolveRate({ companyId, foreignCurrencyId: currency.id, transactionDate: effectiveDate });
    if (resolved.rate == null) {
      throw new HttpError(
        422,
        resolved.errorMessage ||
          `No approved historical exchange rate is available for ${currency.currencyCode}/${baseCurrency.currencyCode} on ${effectiveDate}. Provide a manual opening rate instead.`
      );
    }
    rateInfo = {
      currencyCode: currency.currencyCode, exchangeRate: resolved.rate, rateDate: resolved.effectiveDate,
      rateSource: resolved.provider, rateBasis: resolved.rateBasis, rateStatus: resolved.status,
      rateRetrievedAt: resolved.retrievalTimestamp, rateIngestionMethod: resolved.derivationMethod ? "DERIVED" : "API",
      systemRate: resolved.rate, overrideRate: null, overrideReason: null,
    };
  }

  return { currencyId: currency.id, currencyCode: currency.currencyCode, baseCurrency, rateInfo, wasLocked: false };
}

// Converts one line's foreign debit/credit into base amounts at the
// resolved rate. Deliberately NOT transactionCurrencyService.computeBaseLines
// - that function's drift-correction assumes a balanced set of lines from
// ONE transaction; here every line is independent and only the whole BATCH
// needs to balance (validated separately by the caller).
function convertLineAmount({ debit, credit, exchangeRate }) {
  const rate = Number(exchangeRate) || 1;
  return {
    foreignDebit: roundMoney(debit || 0),
    foreignCredit: roundMoney(credit || 0),
    baseDebit: roundMoney((Number(debit) || 0) * rate),
    baseCredit: roundMoney((Number(credit) || 0) * rate),
  };
}

module.exports = {
  resolveLineCurrency,
  convertLineAmount,
};
