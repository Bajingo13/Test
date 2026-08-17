const pool = require("../db");
const { HttpError } = require("../lib/httpError");
const UserAccessService = require("./userAccessService");

// MySQL DATETIME columns reject ISO 8601 strings with "T"/"Z" (what
// Date.prototype.toISOString() and every provider result in this system
// produce) - accepts only "YYYY-MM-DD HH:MM:SS". Converts at this single
// point of insertion rather than requiring every caller to know MySQL's
// wire format.
function toMysqlDatetime(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

const RATE_MODES = ["BASE", "MANUAL", "FIXED", "AUTOMATIC", "DAILY", "TRANSACTION_SPECIFIC"];
const SETTABLE_RATE_MODES = ["MANUAL", "FIXED"]; // Phase 1 only - AUTOMATIC/DAILY are catalog-only, no live fetch.
const SYMBOL_POSITIONS = ["BEFORE", "AFTER"];
const ISO_CODE_RE = /^[A-Z]{3}$/;

// ---- Company scoping -------------------------------------------------
// SUPER_ADMIN bypasses entirely (full access to all companies, per the
// existing companyScope.js/permissionService.js convention). Everyone
// else may only act on a company from their own user_companies rows.
async function resolveCompanyIdForRead(user, requestedCompanyId) {
  if (user.roleCode === "SUPER_ADMIN") {
    if (requestedCompanyId) return Number(requestedCompanyId);
    return null; // null = no filter, list across all companies
  }

  const accessible = await UserAccessService.getAccessibleCompanyIds(user.id);
  if (requestedCompanyId) {
    if (!accessible.includes(Number(requestedCompanyId))) {
      throw new HttpError(403, "You do not have access to this company");
    }
    return Number(requestedCompanyId);
  }
  return accessible; // array = filter to these companies
}

async function resolveCompanyIdForWrite(user, requestedCompanyId) {
  if (requestedCompanyId) {
    if (user.roleCode !== "SUPER_ADMIN") {
      const hasAccess = await UserAccessService.userHasCompanyAccess(user.id, requestedCompanyId);
      if (!hasAccess) throw new HttpError(403, "You do not have access to this company");
    }
    return Number(requestedCompanyId);
  }

  if (user.roleCode === "SUPER_ADMIN") {
    const [rows] = await pool.execute("SELECT id FROM companies ORDER BY id LIMIT 1");
    if (!rows.length) throw new HttpError(400, "No company exists yet - create a company first.");
    return rows[0].id;
  }

  const accessible = await UserAccessService.getAccessibleCompanyIds(user.id);
  if (accessible.length === 0) throw new HttpError(403, "You are not assigned to any company.");
  if (accessible.length > 1) throw new HttpError(400, "companyId is required - you have access to multiple companies.");
  return accessible[0];
}

async function assertCompanyAccess(user, companyId) {
  if (user.roleCode === "SUPER_ADMIN") return;
  const hasAccess = await UserAccessService.userHasCompanyAccess(user.id, companyId);
  if (!hasAccess) throw new HttpError(403, "You do not have access to this company");
}

// ---- Validation --------------------------------------------------------
function validateCurrencyPayload(data, { partial = false } = {}) {
  const errors = [];

  if (!partial || data.currencyCode !== undefined) {
    const code = String(data.currencyCode || "").toUpperCase().trim();
    if (!ISO_CODE_RE.test(code)) errors.push("Currency Code must be exactly 3 uppercase letters (ISO 4217), e.g. PHP, USD, JPY.");
  }
  if (!partial || data.currencyName !== undefined) {
    if (!String(data.currencyName || "").trim()) errors.push("Currency Name is required.");
  }
  if (!partial || data.currencySymbol !== undefined) {
    if (!String(data.currencySymbol || "").trim()) errors.push("Currency Symbol is required.");
  }
  if (data.isoNumericCode !== undefined && data.isoNumericCode !== null && data.isoNumericCode !== "") {
    if (!/^\d{3}$/.test(String(data.isoNumericCode))) errors.push("ISO Numeric Code must be exactly 3 digits, e.g. 608 for PHP.");
  }
  if (!partial || data.decimalPlaces !== undefined) {
    const dp = Number(data.decimalPlaces);
    if (!Number.isInteger(dp) || dp < 0 || dp > 4) errors.push("Decimal Places must be a whole number between 0 and 4.");
  }
  if (!partial || data.symbolPosition !== undefined) {
    if (!SYMBOL_POSITIONS.includes(data.symbolPosition)) errors.push("Symbol Position must be BEFORE or AFTER.");
  }
  if (data.decimalSeparator !== undefined) {
    if (!String(data.decimalSeparator || "").length) errors.push("Decimal Separator is required.");
  }
  if (data.thousandSeparator !== undefined) {
    if (data.thousandSeparator === null) errors.push("Thousands Separator is required (use an empty string for none).");
  }
  if (!partial || data.defaultRateMode !== undefined) {
    if (!RATE_MODES.includes(data.defaultRateMode)) errors.push(`Default Rate Mode must be one of: ${RATE_MODES.join(", ")}.`);
  }

  if (errors.length) throw new HttpError(400, errors.join(" "));
}

function validateRateValue(rate) {
  const n = Number(rate);
  if (rate === "" || rate === null || rate === undefined || Number.isNaN(n)) {
    throw new HttpError(400, "Exchange rate must be a valid number.");
  }
  if (!Number.isFinite(n)) throw new HttpError(400, "Exchange rate must be a finite number.");
  if (n <= 0) throw new HttpError(400, "Exchange rate must be greater than zero.");
  return n;
}

// ---- Reads ---------------------------------------------------------
async function listCurrencies(user, { companyId } = {}) {
  const scope = await resolveCompanyIdForRead(user, companyId);

  let where = "";
  const params = [];
  if (Array.isArray(scope)) {
    if (scope.length === 0) return [];
    where = `WHERE company_id IN (${scope.map(() => "?").join(",")})`;
    params.push(...scope);
  } else if (scope !== null) {
    where = "WHERE company_id = ?";
    params.push(scope);
  }

  const [rows] = await pool.execute(
    `SELECT id, company_id AS companyId, currency_code AS currencyCode, currency_name AS currencyName,
            currency_symbol AS currencySymbol, iso_numeric_code AS isoNumericCode,
            symbol_position AS symbolPosition, space_after_symbol AS spaceAfterSymbol,
            decimal_places AS decimalPlaces, decimal_separator AS decimalSeparator,
            thousand_separator AS thousandSeparator, default_rate_mode AS defaultRateMode,
            is_base_currency AS isBaseCurrency, is_active AS isActive, current_rate AS currentRate,
            notes, created_at AS createdAt, updated_at AS updatedAt
     FROM currencies ${where}
     ORDER BY is_base_currency DESC, currency_code ASC`,
    params
  );
  return rows.map(mapCurrencyRow);
}

function mapCurrencyRow(row) {
  return {
    ...row,
    spaceAfterSymbol: !!row.spaceAfterSymbol,
    isBaseCurrency: !!row.isBaseCurrency,
    isActive: !!row.isActive,
    currentRate: row.currentRate === null ? null : Number(row.currentRate),
  };
}

async function getCurrencyById(user, id) {
  const [rows] = await pool.execute(
    `SELECT id, company_id AS companyId, currency_code AS currencyCode, currency_name AS currencyName,
            currency_symbol AS currencySymbol, iso_numeric_code AS isoNumericCode,
            symbol_position AS symbolPosition, space_after_symbol AS spaceAfterSymbol,
            decimal_places AS decimalPlaces, decimal_separator AS decimalSeparator,
            thousand_separator AS thousandSeparator, default_rate_mode AS defaultRateMode,
            is_base_currency AS isBaseCurrency, is_active AS isActive, current_rate AS currentRate,
            notes, created_at AS createdAt, updated_at AS updatedAt
     FROM currencies WHERE id = ?`,
    [id]
  );
  if (!rows.length) throw new HttpError(404, "Currency not found");
  await assertCompanyAccess(user, rows[0].companyId);
  return mapCurrencyRow(rows[0]);
}

// ---- Writes ---------------------------------------------------------
async function createCurrency(user, data) {
  validateCurrencyPayload(data);
  const companyId = await resolveCompanyIdForWrite(user, data.companyId);
  const code = String(data.currencyCode).toUpperCase().trim();
  const isBase = !!data.isBaseCurrency;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    if (isBase) {
      const [existingBase] = await conn.execute(
        "SELECT id FROM currencies WHERE company_id = ? AND is_base_currency = 1 LIMIT 1",
        [companyId]
      );
      if (existingBase.length) {
        throw new HttpError(400, "This company already has a base currency. Use Set as Base Currency to change it.");
      }
      if (!data.isActive && data.isActive !== undefined) {
        throw new HttpError(400, "The base currency must be active.");
      }
    }

    const [result] = await conn.execute(
      `INSERT INTO currencies (
        company_id, currency_code, currency_name, currency_symbol, iso_numeric_code,
        symbol_position, space_after_symbol, decimal_places, decimal_separator, thousand_separator,
        default_rate_mode, is_base_currency, is_active, current_rate, notes, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        companyId,
        code,
        data.currencyName.trim(),
        data.currencySymbol.trim(),
        data.isoNumericCode || null,
        data.symbolPosition || "BEFORE",
        data.spaceAfterSymbol ? 1 : 0,
        data.decimalPlaces,
        data.decimalSeparator ?? ".",
        data.thousandSeparator ?? ",",
        isBase ? "BASE" : data.defaultRateMode || "MANUAL",
        isBase ? 1 : 0,
        data.isActive === undefined ? 1 : data.isActive ? 1 : 0,
        isBase ? 1 : null,
        data.notes || null,
        user.id,
        user.id,
      ]
    );

    await conn.commit();
    return getCurrencyById(user, result.insertId);
  } catch (err) {
    await conn.rollback();
    if (err.code === "ER_DUP_ENTRY" && String(err.sqlMessage).includes("uniq_currency_per_company")) {
      throw new HttpError(400, `Currency code ${code} already exists for this company.`);
    }
    if (err.code === "ER_DUP_ENTRY" && String(err.sqlMessage).includes("uniq_base_currency_per_company")) {
      throw new HttpError(400, "This company already has a base currency.");
    }
    throw err;
  } finally {
    conn.release();
  }
}

async function updateCurrency(user, id, data) {
  validateCurrencyPayload(data, { partial: true });
  const existing = await getCurrencyById(user, id);

  if (existing.isBaseCurrency && data.isActive === false) {
    throw new HttpError(400, "Cannot deactivate the company's base currency.");
  }

  const merged = {
    currencyCode: data.currencyCode !== undefined ? String(data.currencyCode).toUpperCase().trim() : existing.currencyCode,
    currencyName: data.currencyName !== undefined ? data.currencyName.trim() : existing.currencyName,
    currencySymbol: data.currencySymbol !== undefined ? data.currencySymbol.trim() : existing.currencySymbol,
    isoNumericCode: data.isoNumericCode !== undefined ? data.isoNumericCode || null : existing.isoNumericCode,
    symbolPosition: data.symbolPosition !== undefined ? data.symbolPosition : existing.symbolPosition,
    spaceAfterSymbol: data.spaceAfterSymbol !== undefined ? !!data.spaceAfterSymbol : existing.spaceAfterSymbol,
    decimalPlaces: data.decimalPlaces !== undefined ? Number(data.decimalPlaces) : existing.decimalPlaces,
    decimalSeparator: data.decimalSeparator !== undefined ? data.decimalSeparator : existing.decimalSeparator,
    thousandSeparator: data.thousandSeparator !== undefined ? data.thousandSeparator : existing.thousandSeparator,
    // Base currency's rate mode is always BASE, never editable via this path.
    defaultRateMode: existing.isBaseCurrency ? "BASE" : data.defaultRateMode !== undefined ? data.defaultRateMode : existing.defaultRateMode,
    isActive: data.isActive !== undefined ? !!data.isActive : existing.isActive,
    notes: data.notes !== undefined ? data.notes || null : existing.notes,
  };

  try {
    await pool.execute(
      `UPDATE currencies SET
        currency_code = ?, currency_name = ?, currency_symbol = ?, iso_numeric_code = ?,
        symbol_position = ?, space_after_symbol = ?, decimal_places = ?, decimal_separator = ?,
        thousand_separator = ?, default_rate_mode = ?, is_active = ?, notes = ?, updated_by = ?
      WHERE id = ?`,
      [
        merged.currencyCode,
        merged.currencyName,
        merged.currencySymbol,
        merged.isoNumericCode,
        merged.symbolPosition,
        merged.spaceAfterSymbol ? 1 : 0,
        merged.decimalPlaces,
        merged.decimalSeparator,
        merged.thousandSeparator,
        merged.defaultRateMode,
        merged.isActive ? 1 : 0,
        merged.notes,
        user.id,
        id,
      ]
    );
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY" && String(err.sqlMessage).includes("uniq_currency_per_company")) {
      throw new HttpError(400, `Currency code ${merged.currencyCode} already exists for this company.`);
    }
    throw err;
  }

  return getCurrencyById(user, id);
}

async function setStatus(user, id, isActive) {
  const existing = await getCurrencyById(user, id);
  if (existing.isBaseCurrency && !isActive) {
    throw new HttpError(400, "Cannot deactivate the company's base currency.");
  }
  await pool.execute("UPDATE currencies SET is_active = ?, updated_by = ? WHERE id = ?", [isActive ? 1 : 0, user.id, id]);
  return getCurrencyById(user, id);
}

// A company is considered to already have "live" data once any of its
// core transaction modules has at least one row. None of these tables
// carry a company_id column yet (see Phase 1 report), so this is a
// system-wide check rather than a true per-company one - the conservative
// reading of "if transactions already exist, block the change" given
// today's single-company reality, not a loophole to relax later without
// re-checking once real per-company scoping lands on transactions.
async function hasExistingTransactions() {
  const tables = ["invoice_headers", "apv_headers", "or_headers", "cv_headers", "jv_headers", "purchase_order_headers"];
  for (const table of tables) {
    const [rows] = await pool.execute(`SELECT 1 FROM ${table} LIMIT 1`);
    if (rows.length) return true;
  }
  return false;
}

async function setBaseCurrency(user, id) {
  const target = await getCurrencyById(user, id);
  if (!target.isActive) throw new HttpError(400, "Cannot set an inactive currency as the base currency. Activate it first.");

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [currentBaseRows] = await conn.execute(
      "SELECT id, currency_code AS currencyCode FROM currencies WHERE company_id = ? AND is_base_currency = 1 FOR UPDATE",
      [target.companyId]
    );
    const currentBase = currentBaseRows[0];

    if (currentBase && currentBase.id === target.id) {
      await conn.commit();
      return target; // already the base currency, no-op
    }

    if (currentBase) {
      const alreadyHasTransactions = await hasExistingTransactions();
      if (alreadyHasTransactions) {
        throw new HttpError(
          409,
          `Cannot change base currency from ${currentBase.currencyCode} to ${target.currencyCode}: posted transactions already exist. ` +
          "Changing the base currency of a company with existing transactions requires a controlled migration process, not a direct switch."
        );
      }
      await conn.execute(
        "UPDATE currencies SET is_base_currency = 0, default_rate_mode = 'MANUAL', current_rate = NULL, updated_by = ? WHERE id = ?",
        [user.id, currentBase.id]
      );
    }

    await conn.execute(
      "UPDATE currencies SET is_base_currency = 1, default_rate_mode = 'BASE', current_rate = 1.0000000000, updated_by = ? WHERE id = ?",
      [user.id, target.id]
    );

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  return getCurrencyById(user, id);
}

// ---- Rates -----------------------------------------------------------
// Phase 2 additions (provider/rateBasis/providerRateDescription/
// ingestionMethod/status/publicationTimestamp/retrievalTimestamp/
// sourceReference/derivationMethod) are all OPTIONAL and default to
// exactly what Phase 1 already stored when omitted - every existing
// Phase 1 call site (and the 21 Phase 1 tests) keeps working unchanged.
// This is also the function "Manual Official Rate Entry" (Phase 2 section
// 24) calls: provider="BAP"/"BSP" with ingestionMethod="MANUAL_ENTRY"
// records that the SOURCE was BAP/BSP but the ENTRY METHOD was manual -
// never indistinguishable from an automated retrieval.
const PROVIDERS = ["BAP", "BSP", "EXTERNAL", "MANUAL", "FIXED", "DERIVED"];
const INGESTION_METHODS = ["API", "FILE_IMPORT", "MANUAL_ENTRY", "DERIVED"];
const RATE_STATUSES = ["INDICATIVE", "PROVISIONAL", "FINAL", "APPROVED", "STALE", "FAILED", "MANUAL", "FIXED"];

async function recordRate(user, id, {
  rateMode,
  rate,
  effectiveDate,
  reason,
  provider,
  rateBasis,
  providerRateDescription,
  ingestionMethod,
  status,
  publicationTimestamp,
  retrievalTimestamp,
  sourceReference,
  derivationMethod,
} = {}) {
  if (!SETTABLE_RATE_MODES.includes(rateMode)) {
    throw new HttpError(400, `rateMode must be one of: ${SETTABLE_RATE_MODES.join(", ")}.`);
  }
  const numericRate = validateRateValue(rate);
  if (!effectiveDate) throw new HttpError(400, "Effective date is required.");

  const resolvedProvider = provider || rateMode; // Phase 1 default: provider mirrors rateMode (MANUAL/FIXED)
  if (!PROVIDERS.includes(resolvedProvider)) {
    throw new HttpError(400, `provider must be one of: ${PROVIDERS.join(", ")}.`);
  }
  const resolvedIngestion = ingestionMethod || "MANUAL_ENTRY";
  if (!INGESTION_METHODS.includes(resolvedIngestion)) {
    throw new HttpError(400, `ingestionMethod must be one of: ${INGESTION_METHODS.join(", ")}.`);
  }
  const resolvedStatus = status || rateMode; // Phase 1 default: status mirrors rateMode (MANUAL/FIXED)
  if (!RATE_STATUSES.includes(resolvedStatus)) {
    throw new HttpError(400, `status must be one of: ${RATE_STATUSES.join(", ")}.`);
  }

  const target = await getCurrencyById(user, id);
  if (target.isBaseCurrency) {
    throw new HttpError(400, "The base currency's rate is always 1 and cannot be changed.");
  }

  const conn = await pool.getConnection();
  let insertedRateId;
  try {
    await conn.beginTransaction();

    const [baseRows] = await conn.execute(
      "SELECT id FROM currencies WHERE company_id = ? AND is_base_currency = 1 LIMIT 1",
      [target.companyId]
    );
    if (!baseRows.length) {
      throw new HttpError(400, "This company has no base currency configured yet. Set a base currency before recording rates.");
    }
    const baseCurrencyId = baseRows[0].id;

    const [currentRow] = await conn.execute("SELECT current_rate AS currentRate FROM currencies WHERE id = ? FOR UPDATE", [id]);
    const oldRate = currentRow[0]?.currentRate != null ? Number(currentRow[0].currentRate) : null;

    const [insertResult] = await conn.execute(
      `INSERT INTO currency_rates (
        company_id, currency_id, base_currency_id, rate_mode, old_rate, new_rate, effective_date, reason, created_by,
        provider, rate_basis, provider_rate_description, ingestion_method, status,
        publication_timestamp, retrieval_timestamp, source_reference, derivation_method
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        target.companyId, id, baseCurrencyId, rateMode, oldRate, numericRate, effectiveDate, reason || null, user.id,
        resolvedProvider, rateBasis || null, providerRateDescription || null, resolvedIngestion, resolvedStatus,
        toMysqlDatetime(publicationTimestamp), toMysqlDatetime(retrievalTimestamp), sourceReference || null, derivationMethod || null,
      ]
    );
    insertedRateId = insertResult.insertId;

    await conn.execute(
      "UPDATE currencies SET current_rate = ?, default_rate_mode = ?, updated_by = ? WHERE id = ?",
      [numericRate, rateMode, user.id, id]
    );

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  // Same return shape Phase 1 always returned (the updated currency
  // object) - rateId is an additive extra field so callers that need to
  // attach derivation-component rows (the import workflow) can, without
  // changing what every existing caller/test already expects back.
  const updated = await getCurrencyById(user, id);
  return { ...updated, rateId: insertedRateId };
}

async function getRateHistory(user, id) {
  await getCurrencyById(user, id); // company-access check + 404

  const [rows] = await pool.execute(
    `SELECT cr.id, cr.currency_id AS currencyId, cr.base_currency_id AS baseCurrencyId,
            bc.currency_code AS baseCurrencyCode,
            cr.rate_mode AS rateMode, cr.old_rate AS oldRate, cr.new_rate AS newRate,
            cr.effective_date AS effectiveDate, cr.reason, cr.created_by AS createdBy,
            u.username AS createdByUsername, cr.created_at AS createdAt,
            cr.provider, cr.rate_basis AS rateBasis, cr.provider_rate_description AS providerRateDescription,
            cr.ingestion_method AS ingestionMethod, cr.status,
            cr.publication_timestamp AS publicationTimestamp, cr.retrieval_timestamp AS retrievalTimestamp,
            cr.source_reference AS sourceReference, cr.derivation_method AS derivationMethod
     FROM currency_rates cr
     LEFT JOIN currencies bc ON bc.id = cr.base_currency_id
     LEFT JOIN users u ON u.id = cr.created_by
     WHERE cr.currency_id = ?
     ORDER BY cr.created_at DESC`,
    [id]
  );
  return rows.map((r) => ({
    ...r,
    oldRate: r.oldRate === null ? null : Number(r.oldRate),
    newRate: Number(r.newRate),
  }));
}

module.exports = {
  RATE_MODES,
  SETTABLE_RATE_MODES,
  listCurrencies,
  getCurrencyById,
  createCurrency,
  updateCurrency,
  setStatus,
  setBaseCurrency,
  recordRate,
  getRateHistory,
  hasExistingTransactions,
  resolveCompanyIdForRead,
  resolveCompanyIdForWrite,
  assertCompanyAccess,
};
