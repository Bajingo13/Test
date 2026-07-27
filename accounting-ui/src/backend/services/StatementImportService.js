const multer = require("multer");
const path = require("path");
const ExcelJS = require("exceljs");
const { parse: parseCsv } = require("csv-parse/sync");

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

function buildStatementLine(rowValues, mapping) {
  const get = (field) =>
    mapping[field] !== undefined ? rowValues[mapping[field]] : undefined;

  const txnDate = parseStatementDate(get("date"));
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
};
