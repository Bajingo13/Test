const path = require("path");
const pool = require("../db");
const { HttpError } = require("../lib/httpError");
const { extractRowsFromXlsx, parseCsvRows } = require("./StatementImportService");
const CurrencyService = require("./currencyService");

// Official BAP/BSP rate import (Phase 2 section 23) - since neither
// provider has a verified, permitted automated feed (see the Phase 2 BAP/
// BSP access report), this is the actual "official rate" ingestion path:
// a human downloads the official file from bap.org.ph/bsp.gov.ph
// themselves (ordinary individual access, not bulk automated scraping)
// and uploads it here. Never auto-saves - upload -> parse -> validate ->
// preview -> confirm -> save -> audit, per spec.

const EXPECTED_COLUMNS = {
  currencyPair: ["currency pair", "pair", "currency", "currency code"],
  rate: ["rate", "exchange rate", "value"],
  rateType: ["rate type", "rate basis", "basis"],
  effectiveDate: ["effective date", "date", "as of date"],
  source: ["source", "provider"],
  reference: ["reference", "source reference", "publication reference"],
};

const VALID_PROVIDERS = ["BAP", "BSP"];
const RATE_BASIS_BY_LABEL = {
  "am weighted average": "AM_WEIGHTED_AVERAGE",
  "pm weighted average": "PM_WEIGHTED_AVERAGE",
  "daily weighted average": "DAILY_WEIGHTED_AVERAGE",
  "fx settlement rate": "FX_SETTLEMENT_RATE",
  "daily reference rate": "DAILY_REFERENCE_RATE",
  "php cross rate": "PHP_CROSS_RATE",
  "monthly average": "MONTHLY_AVERAGE",
  "annual average": "ANNUAL_AVERAGE",
};

function normalizeHeader(h) {
  return String(h || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function resolveColumnMapping(headers) {
  const normalized = headers.map(normalizeHeader);
  const mapping = {};
  for (const field of Object.keys(EXPECTED_COLUMNS)) {
    const idx = normalized.findIndex((h) => EXPECTED_COLUMNS[field].includes(h));
    if (idx !== -1) mapping[field] = idx;
  }
  return mapping;
}

async function extractRows(buffer, filename) {
  const ext = path.extname(filename || "").toLowerCase();
  if (ext === ".csv") {
    const records = parseCsvRows(buffer);
    return { headers: records[0] || [], dataRows: records.slice(1) };
  }
  return extractRowsFromXlsx(buffer);
}

function parseDateCell(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().split("T")[0];
}

// Parses + validates only - never writes to the database. Returns one row
// per input line, each flagged with a validationStatus so the frontend
// can render the required preview table (Currency Pair / Rate / Rate Type
// / Effective Date / Source / Existing Rate / New Rate / Validation Status).
async function parsePreview({ buffer, filename, companyId }) {
  const { headers, dataRows } = await extractRows(buffer, filename);
  const mapping = resolveColumnMapping(headers);

  const missingRequired = ["currencyPair", "rate", "effectiveDate", "source"].filter((f) => mapping[f] === undefined);
  if (missingRequired.length) {
    throw new HttpError(
      400,
      `Missing required column(s): ${missingRequired.join(", ")}. Expected headers like Currency Pair, Rate, Effective Date, Source.`
    );
  }

  const [currencies] = await pool.execute(
    "SELECT id, currency_code AS currencyCode, is_base_currency AS isBaseCurrency FROM currencies WHERE company_id = ?",
    [companyId]
  );
  const currencyByCode = new Map(currencies.map((c) => [c.currencyCode, c]));

  const seenKeys = new Set();
  const preview = [];

  for (const row of dataRows) {
    if (!row.some((cell) => String(cell || "").trim())) continue; // skip blank lines

    const rawPair = String(row[mapping.currencyPair] || "").trim().toUpperCase();
    const currencyCode = rawPair.includes("/") ? rawPair.split("/")[0].trim() : rawPair;
    const rawRate = row[mapping.rate];
    const rawRateType = mapping.rateType !== undefined ? String(row[mapping.rateType] || "").trim() : "";
    const effectiveDate = parseDateCell(row[mapping.effectiveDate]);
    const source = String(row[mapping.source] || "").trim().toUpperCase();
    const reference = mapping.reference !== undefined ? String(row[mapping.reference] || "").trim() : "";

    const issues = [];
    const currency = currencyByCode.get(currencyCode);
    if (!currency) issues.push(`Unknown currency code "${currencyCode}" for this company.`);
    else if (currency.isBaseCurrency) issues.push(`${currencyCode} is the base currency - its rate is always 1 and cannot be imported.`);

    const numericRate = Number(rawRate);
    if (rawRate === "" || rawRate === undefined || Number.isNaN(numericRate)) issues.push("Rate is not a valid number.");
    else if (!Number.isFinite(numericRate)) issues.push("Rate must be finite.");
    else if (numericRate <= 0) issues.push("Rate must be greater than zero.");

    if (!effectiveDate) issues.push("Effective date is invalid or missing.");

    if (!VALID_PROVIDERS.includes(source)) issues.push(`Source must be one of: ${VALID_PROVIDERS.join(", ")}.`);

    const dedupeKey = `${currencyCode}|${effectiveDate}|${source}`;
    if (seenKeys.has(dedupeKey)) issues.push("Duplicate row for the same currency, date, and source within this file.");
    seenKeys.add(dedupeKey);

    preview.push({
      currencyPair: rawPair,
      currencyCode,
      currencyId: currency ? currency.id : null,
      rate: Number.isFinite(numericRate) ? numericRate : null,
      rateType: rawRateType || null,
      rateBasis: RATE_BASIS_BY_LABEL[normalizeHeader(rawRateType)] || null,
      effectiveDate,
      source: VALID_PROVIDERS.includes(source) ? source : null,
      reference: reference || null,
      existingRate: currency ? currency.currentRate ?? null : null,
      newRate: Number.isFinite(numericRate) ? numericRate : null,
      validationStatus: issues.length ? "INVALID" : "VALID",
      validationMessages: issues,
    });
  }

  return { rows: preview, validCount: preview.filter((r) => r.validationStatus === "VALID").length, totalCount: preview.length };
}

// Re-validates every row server-side (never trusts that what the frontend
// sends back from "preview" is still accurate) before writing anything -
// same defense-in-depth as every other endpoint in this system trusting
// nothing from the client at face value.
async function confirmImport({ user, companyId, rows }) {
  if (!Array.isArray(rows) || !rows.length) throw new HttpError(400, "No rows to import.");

  const results = [];
  for (const row of rows) {
    try {
      if (!row.currencyId) throw new HttpError(400, "Row is missing a resolved currency.");
      if (!VALID_PROVIDERS.includes(row.source)) throw new HttpError(400, "Row source must be BAP or BSP.");
      if (!row.effectiveDate) throw new HttpError(400, "Row is missing an effective date.");

      const currency = await CurrencyService.recordRate(user, row.currencyId, {
        rateMode: "MANUAL",
        rate: row.rate,
        effectiveDate: row.effectiveDate,
        reason: `Imported from official ${row.source} file`,
        provider: row.source,
        rateBasis: row.rateBasis || null,
        providerRateDescription: row.rateType || null,
        ingestionMethod: "FILE_IMPORT",
        status: "FINAL",
        retrievalTimestamp: new Date().toISOString(),
        sourceReference: row.reference || null,
      });

      results.push({ currencyCode: row.currencyCode, status: "IMPORTED", newRate: currency.currentRate });
    } catch (err) {
      results.push({ currencyCode: row.currencyCode, status: "FAILED", errorMessage: err.message });
    }
  }

  return { imported: results.filter((r) => r.status === "IMPORTED").length, failed: results.filter((r) => r.status === "FAILED").length, results };
}

module.exports = { parsePreview, confirmImport, VALID_PROVIDERS };
