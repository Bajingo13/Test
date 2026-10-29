const multer = require("multer");
const path = require("path");
const ExcelJS = require("exceljs");
const { parse: parseCsv } = require("csv-parse/sync");
const { HttpError } = require("../lib/httpError");

// Bank statement uploads: kept in memory (never written to disk) and capped
// at 10MB; only CSV/XLS/XLSX are accepted for the bank reconciliation import.
const bankStatementUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if ([".csv", ".xls", ".xlsx"].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only .csv, .xls, or .xlsx files are supported"));
    }
  },
});

// ---- Statement import (Phase 4) ----

function handleUpload(uploadMiddleware) {
  return (req, res, next) => {
    uploadMiddleware(req, res, (err) => {
      if (err) {
        return res.status(400).json({ message: err.message || "File upload failed" });
      }
      next();
    });
  };
}

const BANK_STMT_FIELD_ALIASES = {
  date: ["date", "transaction date", "txn date", "posting date", "value date", "trans date"],
  description: ["description", "particulars", "details", "narrative", "transaction description", "remarks"],
  referenceNo: ["reference", "reference no", "reference no.", "ref no", "ref no.", "ref#", "ref #", "transaction ref"],
  checkNo: ["check no", "check no.", "cheque no", "cheque no.", "check number", "chk no", "check #"],
  debit: ["debit", "withdrawal", "withdrawals", "dr", "money out", "debit amount", "out"],
  credit: ["credit", "deposit", "deposits", "cr", "money in", "credit amount", "in"],
  amount: ["amount", "transaction amount", "value"],
  runningBalance: ["balance", "running balance", "closing balance", "ending balance"],
};

function normalizeHeaderKey(header) {
  return String(header || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function resolveColumnMapping(headers, explicitMapping) {
  const normalizedHeaders = headers.map((h) => normalizeHeaderKey(h));
  const mapping = {};

  for (const field of Object.keys(BANK_STMT_FIELD_ALIASES)) {
    if (explicitMapping && explicitMapping[field]) {
      const idx = headers.findIndex((h) => String(h) === String(explicitMapping[field]));
      if (idx !== -1) {
        mapping[field] = idx;
        continue;
      }
    }

    const aliasIdx = normalizedHeaders.findIndex((h) =>
      BANK_STMT_FIELD_ALIASES[field].includes(h)
    );
    if (aliasIdx !== -1) {
      mapping[field] = aliasIdx;
    }
  }

  return mapping;
}

// Deliberately avoids `date.toISOString()` for anything derived from a
// local/ambiguous string - `new Date(nonIsoString)` parses in the server's
// local timezone, so converting the result back via UTC getters silently
// shifts the calendar day whenever local time is ahead of UTC (e.g. UTC+8).
// Each branch below reads the calendar date back out the same way it went
// in (UTC in, UTC out; local in, local out) so the day never drifts.
function parseStatementDate(value) {
  if (value === undefined || value === null || value === "") return null;

  if (value instanceof Date && !isNaN(value)) {
    // exceljs date cells are UTC-midnight-anchored (Excel dates carry no
    // timezone of their own), so read them back out via UTC getters.
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, "0");
    const d = String(value.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  const str = String(value).trim();
  if (!str) return null;

  const isoMatch = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  const slashMatch = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (slashMatch) {
    const [, a, b, yearRaw] = slashMatch;
    const year = yearRaw.length === 2 ? `20${yearRaw}` : yearRaw;
    const month = String(a).padStart(2, "0");
    const day = String(b).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  if (/\d{4}/.test(str)) {
    const native = new Date(str);
    if (!isNaN(native)) {
      const y = native.getFullYear();
      const m = String(native.getMonth() + 1).padStart(2, "0");
      const d = String(native.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
  }

  return null;
}

function parseStatementAmount(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return value;

  let str = String(value).trim();
  if (!str) return null;

  const isNegativeParens = /^\(.*\)$/.test(str);
  str = str.replace(/[₱PHPphp,\s()]/g, "");

  if (str === "" || str === "-") return null;

  let num = Number(str);
  if (isNaN(num)) return null;

  if (isNegativeParens) num = -Math.abs(num);

  return num;
}

// ---- Bank statement dates (R7-5) ----
// parseStatementDate above is lenient and shared with the beginning-balance
// and Chart of Accounts importers (unchanged for them). A bank statement
// needs stricter rules: 05/08/2026 is 5 August in a DD/MM statement and
// 8 May in an MM/DD one, so a slash date is only read with a known order -
// chosen by the user, or proven by the file itself (some day above 12) -
// and every date must exist on the calendar before it reaches MySQL.
//
// Always unambiguous, whatever the format: YYYY-MM-DD (optionally with a
// time), an Excel date cell, an Excel date serial number, and a written
// month ("5 Aug 2026", "05-Aug-26", "Aug 5, 2026").
const BANK_DATE_FORMATS = ["AUTO", "DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"];

const TIME_SUFFIX = String.raw`(?:[ T]+\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:[AaPp][Mm])?(?:Z|[+-]\d{2}:?\d{2})?)?`;
const ISO_DATE_RE = new RegExp(String.raw`^(\d{4})-(\d{1,2})-(\d{1,2})${TIME_SUFFIX}$`);
const SLASH_DATE_RE = new RegExp(String.raw`^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})${TIME_SUFFIX}$`);
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_MONTH_YEAR_RE = new RegExp(String.raw`^(\d{1,2})[ \-/]([A-Za-z]{3,9})\.?[ \-/,]+(\d{2}|\d{4})${TIME_SUFFIX}$`);
const MONTH_DAY_YEAR_RE = new RegExp(String.raw`^([A-Za-z]{3,9})\.?[ \-]+(\d{1,2}),?[ \-]+(\d{2}|\d{4})${TIME_SUFFIX}$`);
// Excel serials from 1954 to 2118 - a plain small number is not a date.
const EXCEL_SERIAL_MIN = 20000;
const EXCEL_SERIAL_MAX = 80000;

function fullYear(y) {
  return y.length === 2 ? 2000 + Number(y) : Number(y);
}

function isoIfValid(y, m, d) {
  if (!Number.isInteger(y) || y < 1900 || y > 2999) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function monthIndex(name) {
  const s = String(name).toLowerCase();
  const i = MONTHS.indexOf(s.slice(0, 3));
  if (i === -1) return null;
  // "Aug" / "August" - not "Augxyz"
  const full = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"][i];
  return s.length === 3 || full === s || (s.length === 4 && s === "sept") ? i + 1 : null;
}

// { kind: "blank" } | { kind: "date", date } | { kind: "slash", first, second, year } | { kind: "invalid" }
function classifyBankDate(value) {
  if (value === undefined || value === null) return { kind: "blank" };
  if (value instanceof Date) {
    if (isNaN(value)) return { kind: "invalid" };
    const date = isoIfValid(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
    return date ? { kind: "date", date } : { kind: "invalid" };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < EXCEL_SERIAL_MIN || value > EXCEL_SERIAL_MAX) return { kind: "invalid" };
    const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000);
    const date = isoIfValid(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    return date ? { kind: "date", date } : { kind: "invalid" };
  }
  const str = String(value).trim();
  if (!str) return { kind: "blank" };

  let m = str.match(ISO_DATE_RE);
  if (m) {
    const date = isoIfValid(Number(m[1]), Number(m[2]), Number(m[3]));
    return date ? { kind: "date", date } : { kind: "invalid" };
  }
  m = str.match(SLASH_DATE_RE);
  if (m) return { kind: "slash", first: Number(m[1]), second: Number(m[2]), year: fullYear(m[3]) };
  m = str.match(DAY_MONTH_YEAR_RE);
  if (m && monthIndex(m[2])) {
    const date = isoIfValid(fullYear(m[3]), monthIndex(m[2]), Number(m[1]));
    return date ? { kind: "date", date } : { kind: "invalid" };
  }
  m = str.match(MONTH_DAY_YEAR_RE);
  if (m && monthIndex(m[1])) {
    const date = isoIfValid(fullYear(m[3]), monthIndex(m[1]), Number(m[2]));
    return date ? { kind: "date", date } : { kind: "invalid" };
  }
  return { kind: "invalid" };
}

// Returns { date } (YYYY-MM-DD), { blank: true }, or { invalid: true }.
function parseBankStatementDate(value, format) {
  const c = classifyBankDate(value);
  if (c.kind === "blank") return { blank: true };
  if (c.kind === "date") return { date: c.date };
  if (c.kind === "slash") {
    let date = null;
    if (format === "DD/MM/YYYY") date = isoIfValid(c.year, c.second, c.first);
    else if (format === "MM/DD/YYYY") date = isoIfValid(c.year, c.first, c.second);
    return date ? { date } : { invalid: true };
  }
  return { invalid: true };
}

function importError(statusCode, message, code) {
  return new HttpError(statusCode, message, code);
}

// The format the whole file is read with. An explicit choice wins. AUTO
// decides only from proof inside the file: a first part above 12 means
// DD/MM, a second part above 12 means MM/DD; both at once is a mixed file;
// slash dates with no such proof cannot be read safely and the user must
// choose. A file with no slash dates needs no choice at all.
function resolveBankDateFormat(dateValues, requested = "AUTO") {
  const format = requested || "AUTO";
  if (!BANK_DATE_FORMATS.includes(format)) {
    throw importError(400, `Unknown date format "${requested}". Use one of: ${BANK_DATE_FORMATS.join(", ")}.`, "INVALID_DATE_FORMAT");
  }
  if (format !== "AUTO") return format;

  let sawSlash = false;
  let dayFirst = false;
  let monthFirst = false;
  for (const v of dateValues) {
    const c = classifyBankDate(v);
    if (c.kind !== "slash") continue;
    sawSlash = true;
    if (c.first > 12 && c.second <= 12) dayFirst = true;
    if (c.second > 12 && c.first <= 12) monthFirst = true;
  }
  if (dayFirst && monthFirst) {
    throw importError(
      400,
      "This statement mixes day-first and month-first dates (e.g. 25/08 and 08/25), so its dates cannot be read safely. Fix the file or choose the date format.",
      "DATE_FORMAT_MIXED"
    );
  }
  if (dayFirst) return "DD/MM/YYYY";
  if (monthFirst) return "MM/DD/YYYY";
  if (sawSlash) {
    throw importError(
      400,
      "Dates like 05/08/2026 could mean 5 August or 8 May. Choose the statement's date format (DD/MM/YYYY or MM/DD/YYYY) and import again.",
      "DATE_FORMAT_REQUIRED"
    );
  }
  return "YYYY-MM-DD";
}

// ---- Duplicate statement import (R7-7) ----
// Uses only what the existing tables already hold: an earlier batch in the
// same session with the same row count whose stored lines, in import order,
// are identical to the lines about to be imported. Catches the same file
// (or an identical re-export) imported twice into one session. Not caught -
// left for the statement-import phase, which needs a stored file hash /
// per-line fingerprint: overlapping statements (same rows, different
// extent) and the same file imported into two different sessions.
function lineFingerprint(l) {
  const money = (v) => (v === null || v === undefined || v === "" ? "" : Number(v).toFixed(2));
  return [
    l.txnDate,
    String(l.description || "").trim(),
    String(l.referenceNo || "").trim(),
    String(l.checkNo || "").trim(),
    money(l.debit),
    money(l.credit),
    money(l.runningBalance),
  ].join("\u0001");
}

async function findDuplicateBatch(conn, sessionId, parsedLines) {
  const [batches] = await conn.execute(
    "SELECT id, file_name AS fileName FROM bank_recon_import_batches WHERE session_id = ? AND row_count = ? ORDER BY id",
    [sessionId, parsedLines.length]
  );
  if (!batches.length) return null;
  const incoming = parsedLines.map(lineFingerprint);
  for (const batch of batches) {
    const [rows] = await conn.execute(
      `SELECT DATE_FORMAT(txn_date, '%Y-%m-%d') AS txnDate, description, reference_no AS referenceNo,
              check_no AS checkNo, debit, credit, running_balance AS runningBalance
       FROM bank_recon_statement_lines WHERE batch_id = ? ORDER BY id`,
      [batch.id]
    );
    if (rows.length === incoming.length && rows.every((r, i) => lineFingerprint(r) === incoming[i])) {
      return batch;
    }
  }
  return null;
}

// options.dateFormat (bank statements) switches the date column to the
// strict parser above; the result then carries dateBlank / dateInvalid.
function buildStatementLine(rowValues, mapping, options = {}) {
  const get = (field) =>
    mapping[field] !== undefined ? rowValues[mapping[field]] : undefined;

  let txnDate;
  let dateBlank = false;
  let dateInvalid = false;
  if (options.dateFormat) {
    const parsed = parseBankStatementDate(get("date"), options.dateFormat);
    txnDate = parsed.date || null;
    dateBlank = Boolean(parsed.blank);
    dateInvalid = Boolean(parsed.invalid);
  } else {
    txnDate = parseStatementDate(get("date"));
  }
  const description = get("description") != null ? String(get("description")).trim() : "";
  const referenceNo = get("referenceNo") != null ? String(get("referenceNo")).trim() : "";
  const checkNo = get("checkNo") != null ? String(get("checkNo")).trim() : "";

  let debit = mapping.debit !== undefined ? parseStatementAmount(get("debit")) : null;
  let credit = mapping.credit !== undefined ? parseStatementAmount(get("credit")) : null;

  if (mapping.debit === undefined && mapping.credit === undefined && mapping.amount !== undefined) {
    const amt = parseStatementAmount(get("amount"));
    if (amt !== null) {
      if (amt < 0) {
        debit = Math.abs(amt);
        credit = 0;
      } else {
        debit = 0;
        credit = amt;
      }
    }
  }

  const runningBalance =
    mapping.runningBalance !== undefined ? parseStatementAmount(get("runningBalance")) : null;

  return {
    txnDate,
    ...(options.dateFormat ? { dateBlank, dateInvalid, rawDate: get("date") } : {}),
    description,
    referenceNo,
    checkNo,
    debit: debit || 0,
    credit: credit || 0,
    runningBalance,
  };
}

function unwrapCellValue(value) {
  if (value && typeof value === "object") {
    if (value instanceof Date) return value;
    if ("result" in value) return value.result;
    if ("richText" in value) return value.richText.map((t) => t.text).join("");
    if ("text" in value) return value.text;
  }
  return value;
}

async function extractRowsFromXlsx(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];

  if (!worksheet) return { headers: [], dataRows: [] };

  const allRows = [];

  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values.slice(1).map(unwrapCellValue);
    allRows.push(values);
  });

  const headers = (allRows[0] || []).map((h) => (h == null ? "" : String(h)));
  const dataRows = allRows.slice(1);

  return { headers, dataRows };
}

function parseCsvRows(buffer) {
  return parseCsv(buffer, {
    columns: false,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });
}

module.exports = {
  bankStatementUpload,
  handleUpload,
  resolveColumnMapping,
  parseStatementDate,
  parseStatementAmount,
  buildStatementLine,
  extractRowsFromXlsx,
  parseCsvRows,
  BANK_DATE_FORMATS,
  parseBankStatementDate,
  resolveBankDateFormat,
  findDuplicateBatch,
};
