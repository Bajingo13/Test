const crypto = require("crypto");
const path = require("path");
const ExcelJS = require("exceljs");
const { parse: parseCsv } = require("csv-parse/sync");
const { HttpError } = require("../lib/httpError");
const { resolveBankDateFormat, parseBankStatementDate } = require("./StatementImportService");
const { normalizeIdentifier } = require("./ConfidenceScoringService");

// Bank statement import foundation (R8.2): the ONE deterministic pipeline
// that turns an uploaded CSV / XLSX statement into normalized statement
// rows. Preview and import both run it; the matching engine and the AI
// assistant only ever see its output, never the raw file.
//
//   read file -> detect / map columns -> normalize each row -> validate
//   (blocking errors vs warnings) -> fingerprint
//
// Money is handled as integer centavos parsed from the cell's text - never
// through floating-point arithmetic. Identifiers (check / reference / bank
// reference) keep their exact text; a normalized form for matching is the
// matching engine's own normalizeIdentifier().

const PARSER_VERSION = 2;
const SUPPORTED_EXTENSIONS = [".csv", ".xlsx"];
const MAX_DESCRIPTION = 500; // bank_recon_statement_lines.description
const MAX_IDENTIFIER = 100; // reference_no / check_no
const MAX_INTEGER_DIGITS = 13; // DECIMAL(15,2)
const EXCEL_SAFE_DIGITS = 15; // Excel keeps 15 significant digits

// Canonical statement fields. `group: "amount"` - one of Debit / Credit /
// Amount is required. Old explicit-mapping keys (date, runningBalance)
// are accepted as aliases of txnDate / balance.
const CANONICAL_FIELDS = [
  { key: "txnDate", label: "Transaction Date", required: true,
    aliases: ["date", "transaction date", "txn date", "trans date", "posting date", "post date", "tran date"] },
  { key: "valueDate", label: "Value Date", required: false, aliases: ["value date", "val date", "effective date"] },
  { key: "description", label: "Description", required: false,
    aliases: ["description", "particulars", "details", "narrative", "transaction description", "remarks", "memo"] },
  { key: "referenceNo", label: "Reference Number", required: false,
    aliases: ["reference", "reference no", "reference no.", "reference number", "ref no", "ref no.", "ref#", "ref #", "transaction ref", "ref"] },
  { key: "checkNo", label: "Check Number", required: false,
    aliases: ["check no", "check no.", "cheque no", "cheque no.", "check number", "cheque number", "chk no", "chk no.", "check #", "check"] },
  { key: "debit", label: "Debit (money out)", required: false, group: "amount",
    aliases: ["debit", "debits", "withdrawal", "withdrawals", "dr", "money out", "debit amount", "out"] },
  { key: "credit", label: "Credit (money in)", required: false, group: "amount",
    aliases: ["credit", "credits", "deposit", "deposits", "cr", "money in", "credit amount", "in"] },
  { key: "amount", label: "Amount (negative or DR = money out)", required: false, group: "amount",
    aliases: ["amount", "transaction amount", "value", "net amount"] },
  { key: "balance", label: "Balance", required: false,
    aliases: ["balance", "running balance", "closing balance", "ending balance", "available balance"] },
  { key: "bankReference", label: "Bank Reference", required: false,
    aliases: ["bank reference", "bank ref", "bank ref no", "transaction id", "trace no", "trace number", "journal no", "sequence no"] },
];
const LEGACY_KEYS = { date: "txnDate", runningBalance: "balance" };
const IDENTIFIER_FIELDS = ["checkNo", "referenceNo", "bankReference"];

// ---- reading the file ----

function fileError(message, code, extra) {
  const err = new HttpError(400, message, code);
  if (extra) err.extra = extra;
  return err;
}

function assertSupportedFile(originalName, buffer) {
  const ext = path.extname(originalName || "").toLowerCase();
  if (ext === ".xls") {
    throw fileError("Legacy Excel 97-2003 (.xls) statements are not supported yet. Save the statement as .xlsx or .csv.", "UNSUPPORTED_STATEMENT_FILE");
  }
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw fileError("Only .csv and .xlsx bank statements are supported.", "UNSUPPORTED_STATEMENT_FILE");
  }
  if (!buffer || buffer.length === 0) throw fileError("The file is empty.", "STATEMENT_FILE_EMPTY");
  return ext;
}

const blankCell = (c) => !c || c.kind === "blank" || (c.kind !== "date" && String(c.text ?? "").trim() === "");

// A cell is { value, text, kind }: value for dates / Excel serials, text
// for everything shown to a person - exactly as written in a CSV, or the
// workbook's own value for XLSX (a zero-padded number format such as
// "000000" is applied here, since exceljs does not).
function xlsxCell(cell) {
  let v = cell.value;
  if (v && typeof v === "object" && !(v instanceof Date)) {
    if ("result" in v) v = v.result;
    else if ("richText" in v) v = v.richText.map((t) => t.text).join("");
    else if ("text" in v) v = v.text;
    else if ("error" in v) return { value: null, text: String(v.error), kind: "error" };
  }
  if (v === null || v === undefined) return { value: null, text: "", kind: "blank" };
  if (v instanceof Date) return { value: v, text: "", kind: "date" };
  if (typeof v === "number") {
    let text = Number.isInteger(v) ? v.toFixed(0) : String(v);
    if (Number.isInteger(v) && /^0+$/.test(String(cell.numFmt || ""))) text = text.padStart(cell.numFmt.length, "0");
    return { value: v, text, kind: "number" };
  }
  if (typeof v === "boolean") return { value: v, text: String(v), kind: "text" };
  return { value: String(v), text: String(v), kind: "text" };
}

async function readRows(buffer, ext) {
  if (ext === ".csv") {
    let records;
    try {
      records = parseCsv(buffer, { columns: false, skip_empty_lines: false, trim: true, relax_column_count: true, bom: true, info: true });
    } catch {
      throw fileError("The file could not be read as a CSV file.", "STATEMENT_FILE_UNREADABLE");
    }
    return records.map(({ record, info }) => ({
      sourceRow: info.lines,
      cells: record.map((t) => ({ value: t, text: t, kind: t === "" ? "blank" : "text" })),
    }));
  }
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw fileError("The file could not be read as an .xlsx workbook.", "STATEMENT_FILE_UNREADABLE");
  }
  const sheet = workbook.worksheets[0];
  if (!sheet || sheet.actualRowCount === 0) throw fileError("The workbook has no data.", "STATEMENT_WORKBOOK_EMPTY");
  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells = [];
    for (let i = 1; i <= row.cellCount; i++) cells.push(xlsxCell(row.getCell(i)));
    rows.push({ sourceRow: row.number, cells });
  });
  return rows;
}

// ---- column mapping ----

const normHeader = (h) => String(h || "").trim().toLowerCase().replace(/\s+/g, " ");

function resolveMapping(headers, explicit) {
  const normalized = headers.map(normHeader);
  const mapping = {};
  const notes = [];
  const wanted = {};
  if (explicit && typeof explicit === "object") {
    for (const [k, header] of Object.entries(explicit)) {
      const key = LEGACY_KEYS[k] || k;
      if (header && CANONICAL_FIELDS.some((f) => f.key === key)) wanted[key] = String(header);
    }
  }
  for (const field of CANONICAL_FIELDS) {
    if (wanted[field.key]) {
      const idx = headers.findIndex((h) => String(h) === wanted[field.key]);
      if (idx === -1) {
        throw fileError(`The mapped column "${wanted[field.key]}" for ${field.label} is not in the file.`, "STATEMENT_MAPPING_INVALID");
      }
      mapping[field.key] = idx;
      continue;
    }
    const idx = normalized.findIndex((h, i) => field.aliases.includes(h) && !Object.values(mapping).includes(i));
    if (idx !== -1) mapping[field.key] = idx;
  }
  // A statement with only a Value Date column: read it as the transaction
  // date, and say so.
  if (mapping.txnDate === undefined && mapping.valueDate !== undefined) {
    mapping.txnDate = mapping.valueDate;
    delete mapping.valueDate;
    notes.push("No transaction date column was found - the Value Date column is used as the transaction date.");
  }
  if (mapping.amount !== undefined && (mapping.debit !== undefined || mapping.credit !== undefined)) {
    notes.push("Both Debit/Credit and Amount columns were found - Debit/Credit are used and Amount is ignored.");
    delete mapping.amount;
  }
  const missing = [];
  if (mapping.txnDate === undefined) missing.push("Transaction Date");
  if (mapping.debit === undefined && mapping.credit === undefined && mapping.amount === undefined) {
    missing.push("Debit / Credit or Amount");
  }
  return { mapping, missing, notes };
}

// ---- money (integer centavos, no floating point) ----

// Returns { blank } | { invalid, reason } | { cents, negative, marker }.
function parseMoney(cell) {
  if (blankCell(cell)) return { blank: true };
  let s = String(cell.text).trim();
  if (cell.kind === "number" && /e/i.test(s)) return { invalid: true, reason: "is not a plain number" };
  let negative = false;
  let marker = null;
  const mk = s.match(/^(.*?)\s*(CR|DR)\.?$/i);
  if (mk) {
    marker = mk[2].toUpperCase();
    s = mk[1].trim();
  }
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/^(PHP|Php|php|₱|\$)\s*/, "").replace(/\s*(PHP|Php|php)$/, "");
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1).trim();
  } else if (s.endsWith("-")) {
    negative = !negative;
    s = s.slice(0, -1).trim();
  }
  s = s.replace(/^(PHP|₱|\$)\s*/i, "");
  if (!/^(\d{1,3}(,\d{3})+|\d+)?(\.\d{1,2})?$/.test(s) || s === "" || s === ".") {
    return { invalid: true, reason: /\.\d{3,}$/.test(s) ? "has more than two decimal places" : "is not a valid amount" };
  }
  const [intPart = "", frac = ""] = s.replace(/,/g, "").split(".");
  const digits = intPart.replace(/^0+(?=\d)/, "");
  if (digits.length > MAX_INTEGER_DIGITS) return { invalid: true, reason: "is too large" };
  const cents = Number(digits || "0") * 100 + Number(frac.padEnd(2, "0"));
  return { cents, negative, marker };
}

function centsToString(cents) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

// ---- identifiers ----

// Exact text for display / storage, normalizeIdentifier() for matching.
// A number cell with more than 15 significant digits has already been
// rounded by Excel - refused rather than stored wrong.
function parseIdentifier(cell, label) {
  if (blankCell(cell)) return { original: "", normalized: "" };
  const original = String(cell.text).trim();
  if (cell.kind === "number") {
    const digits = original.replace(/^-/, "").replace(".", "").replace(/^0+/, "");
    if (!Number.isSafeInteger(cell.value) || digits.length > EXCEL_SAFE_DIGITS || /e/i.test(original)) {
      return { error: `${label} was stored by Excel as a number with more than ${EXCEL_SAFE_DIGITS} digits, so Excel has already changed it. Format that column as Text in the workbook and export again.` };
    }
  }
  if (original.length > MAX_IDENTIFIER) return { error: `${label} is longer than ${MAX_IDENTIFIER} characters.` };
  return { original, normalized: normalizeIdentifier(original), numeric: cell.kind === "number" };
}

// ---- fingerprints (version 2) ----

// Row fingerprint - the same definition the R8.2 migration backfills in SQL
// (r82_bank_statement_import_migration.sql), so stored and freshly parsed
// rows compare byte for byte:
//   sha256( "v2" US txnDate US direction US amount-in-centavos US
//           checkNo US referenceNo US description "#" n )
// US = U+001F. Values exactly as they are stored (description already cut
// to 500 characters; identifiers as written). n is the n-th occurrence of
// that exact tuple in the same statement file / import batch: two genuinely
// identical bank lines (two P600 cash deposits the same day) stay two
// transactions, and re-importing the statement reproduces the same
// fingerprints. Company and bank account are not hashed - the database's
// UNIQUE(company_id, bank_account_id, row_fingerprint) scopes them.
const FINGERPRINT_VERSION = 2;
const US = "\u001f";

function canonicalTuple(row) {
  return [
    `v${FINGERPRINT_VERSION}`,
    row.txnDate,
    row.direction,
    String(row.amountCents),
    row.checkNo || "",
    row.referenceNo || "",
    row.description || "",
  ].join(US);
}

function fingerprintRows(rows) {
  const seen = new Map();
  for (const row of rows) {
    const tuple = canonicalTuple(row);
    const n = (seen.get(tuple) || 0) + 1;
    seen.set(tuple, n);
    row.occurrence = n;
    row.fingerprint = crypto.createHash("sha256").update(`${tuple}#${n}`, "utf8").digest("hex");
  }
  return rows;
}

// Fingerprints already stored for this company + bank account (any session).
async function existingFingerprints(conn, ctx) {
  const [rows] = await conn.query(
    `SELECT row_fingerprint AS fp, session_id AS sessionId, batch_id AS batchId
     FROM bank_recon_statement_lines
     WHERE company_id = ? AND bank_account_id = ? AND row_fingerprint IS NOT NULL`,
    [ctx.companyId, ctx.bankAccountId]
  );
  return new Map(rows.map((r) => [r.fp, { sessionId: r.sessionId, batchId: r.batchId }]));
}

// ---- the pipeline ----

/**
 * Parses and validates a statement. Writes nothing.
 * ctx: { companyId, bankAccountId, periodStart, periodEnd }
 * options: { columnMapping (object), dateFormat }
 */
async function parseStatement({ buffer, originalName, ctx, columnMapping = null, dateFormat = "AUTO" }) {
  const ext = assertSupportedFile(originalName, buffer);
  const rawRows = (await readRows(buffer, ext)).filter((r) => r.cells.some((c) => !blankCell(c)));
  if (rawRows.length === 0) {
    throw fileError(ext === ".csv" ? "The file is empty." : "The workbook has no data.", ext === ".csv" ? "STATEMENT_FILE_EMPTY" : "STATEMENT_WORKBOOK_EMPTY");
  }
  const [headerRow, ...dataRows] = rawRows;
  const headers = headerRow.cells.map((c) => String(c.text ?? "").trim());
  const file = {
    name: originalName,
    type: ext === ".csv" ? "CSV" : "XLSX",
    size: buffer.length,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
  };
  const { mapping, missing, notes } = resolveMapping(headers, columnMapping);
  const fields = CANONICAL_FIELDS.map((f) => ({
    key: f.key, label: f.label, required: Boolean(f.required), oneOfAmount: f.group === "amount",
    column: mapping[f.key] !== undefined ? headers[mapping[f.key]] : null,
  }));
  const base = { file, headers, fields, mapping, missingRequired: missing, notes };
  if (dataRows.length === 0) {
    throw fileError("The file has a header row but no transaction rows.", "STATEMENT_NO_ROWS");
  }
  if (missing.length) return { ...base, rows: [], blocking: [], warnings: [], dateFormat: null };

  const cellOf = (row, key) => (mapping[key] !== undefined ? row.cells[mapping[key]] : undefined);
  const resolvedDateFormat = resolveBankDateFormat(
    dataRows.map((r) => {
      const c = cellOf(r, "txnDate");
      return c ? (c.kind === "date" || c.kind === "number" ? c.value : c.text) : undefined;
    }),
    dateFormat || "AUTO"
  );
  const dateOf = (c) => parseBankStatementDate(c ? (c.kind === "date" || c.kind === "number" ? c.value : c.text) : undefined, resolvedDateFormat);

  const blocking = [];
  const warnings = notes.map((message) => ({ row: null, message }));
  const rows = [];
  let numericIdentifierCells = 0;

  for (const raw of dataRows) {
    const r = { sourceRow: raw.sourceRow, errors: [], warnings: [] };
    const err = (field, message) => r.errors.push({ row: raw.sourceRow, field, message });
    const warn = (message) => r.warnings.push({ row: raw.sourceRow, message });

    const date = dateOf(cellOf(raw, "txnDate"));
    const money = {};
    for (const k of ["debit", "credit", "amount"]) if (mapping[k] !== undefined) money[k] = parseMoney(cellOf(raw, k));
    const hasMoney = Object.values(money).some((m) => !m.blank);
    const balance = mapping.balance !== undefined ? parseMoney(cellOf(raw, "balance")) : { blank: true };

    // Not a transaction row: no date and no amount (titles, "Total" lines),
    // or a dated balance-only line ("Balance forward").
    if (!hasMoney && (date.blank || date.invalid)) {
      warnings.push({ row: raw.sourceRow, message: "Ignored - not a transaction row (no date and no amount)." });
      continue;
    }
    // An undated "Total" / "Grand Total" footer carries amounts but is not a
    // transaction (any other undated row with money is a blocking error).
    const descText = mapping.description !== undefined ? String(cellOf(raw, "description")?.text ?? "").trim() : "";
    if (hasMoney && date.blank && /^(grand\s+)?(sub\s*)?totals?\b/i.test(descText)) {
      warnings.push({ row: raw.sourceRow, message: `Ignored - "${descText.slice(0, 30)}" summary row.` });
      continue;
    }
    if (!hasMoney && !balance.blank) {
      warnings.push({ row: raw.sourceRow, message: "Ignored - balance-only row (no debit, credit or amount)." });
      continue;
    }

    if (date.blank) err("txnDate", "Missing transaction date.");
    else if (date.invalid) err("txnDate", `"${String(cellOf(raw, "txnDate")?.text ?? "").slice(0, 40)}" is not a valid ${resolvedDateFormat} date.`);
    else r.txnDate = date.date;

    for (const [k, m] of Object.entries(money)) {
      if (m.invalid) err(k, `${CANONICAL_FIELDS.find((f) => f.key === k).label.split(" (")[0]} "${String(cellOf(raw, k)?.text ?? "").slice(0, 30)}" ${m.reason}.`);
    }
    if (!r.errors.some((e) => ["debit", "credit", "amount"].includes(e.field))) {
      if (mapping.amount !== undefined) {
        const m = money.amount;
        if (m.blank || m.cents === 0) err("amount", "Missing or zero amount.");
        else if (m.marker && m.negative) err("amount", "Amount has both a minus sign and a DR/CR marker.");
        else {
          r.direction = m.marker ? (m.marker === "DR" ? "OUT" : "IN") : m.negative ? "OUT" : "IN";
          r.amountCents = m.cents;
        }
      } else {
        const d = money.debit && !money.debit.blank ? money.debit : null;
        const c = money.credit && !money.credit.blank ? money.credit : null;
        const dc = d && d.cents > 0 ? d : null;
        const cc = c && c.cents > 0 ? c : null;
        if ((d && d.negative) || (c && c.negative)) err(d && d.negative ? "debit" : "credit", "Negative value in a Debit / Credit column.");
        else if (dc && cc) err("debit", "Both Debit and Credit have an amount.");
        else if (!dc && !cc) err("debit", "Missing or zero Debit / Credit amount.");
        else {
          r.direction = dc ? "OUT" : "IN";
          r.amountCents = (dc || cc).cents;
        }
      }
    }

    const description = mapping.description !== undefined ? String(cellOf(raw, "description")?.text ?? "").trim() : "";
    if (description.length > MAX_DESCRIPTION) warn(`Description is longer than ${MAX_DESCRIPTION} characters and will be shortened.`);
    r.description = description.slice(0, MAX_DESCRIPTION);

    const ids = {};
    for (const k of IDENTIFIER_FIELDS) {
      if (mapping[k] === undefined) {
        ids[k] = { original: "", normalized: "" };
        continue;
      }
      const label = CANONICAL_FIELDS.find((f) => f.key === k).label;
      const id = parseIdentifier(cellOf(raw, k), label);
      if (id.error) {
        err(k, id.error);
        ids[k] = { original: "", normalized: "" };
      } else {
        ids[k] = id;
        if (id.numeric && k === "checkNo") numericIdentifierCells++;
      }
    }
    r.checkNo = ids.checkNo.original;
    r.checkNoNormalized = ids.checkNo.normalized;
    r.referenceNo = ids.referenceNo.original;
    r.referenceNoNormalized = ids.referenceNo.normalized;
    r.bankReference = ids.bankReference.original;
    if (!r.description && !r.checkNo && !r.referenceNo && !r.bankReference) {
      err("description", "No description, reference, check number or bank reference to identify this transaction.");
    }

    if (mapping.valueDate !== undefined) {
      const vd = dateOf(cellOf(raw, "valueDate"));
      if (vd.invalid) warn("Value date is not a valid date and is ignored.");
      r.valueDate = vd.date || null;
    }
    if (balance.invalid) warn(`Balance ${balance.reason} and is ignored.`);
    r.balanceCents = balance.cents !== undefined ? (balance.negative ? -balance.cents : balance.cents) : null;

    if (r.txnDate && ctx.periodStart && ctx.periodEnd && (r.txnDate < ctx.periodStart || r.txnDate > ctx.periodEnd)) {
      warn(`Dated ${r.txnDate}, outside this reconciliation period (${ctx.periodStart} to ${ctx.periodEnd}).`);
    }

    r.valid = r.errors.length === 0;
    if (r.valid) {
      r.amount = centsToString(r.amountCents);
      r.debit = r.direction === "OUT" ? r.amount : "0.00";
      r.credit = r.direction === "IN" ? r.amount : "0.00";
      r.balance = r.balanceCents === null ? null : `${r.balanceCents < 0 ? "-" : ""}${centsToString(Math.abs(r.balanceCents))}`;
    }
    blocking.push(...r.errors);
    warnings.push(...r.warnings);
    rows.push(r);
  }

  if (numericIdentifierCells > 0) {
    warnings.unshift({
      row: null,
      message: `${numericIdentifierCells} check number(s) are stored as numbers in the workbook. Any leading zeros Excel dropped cannot be recovered - format the column as Text if your check numbers start with 0.`,
    });
  }

  fingerprintRows(rows.filter((r) => r.valid));
  // Identical rows within this file: kept as separate transactions, flagged.
  const firstSeen = new Map();
  for (const r of rows.filter((x) => x.valid)) {
    const key = canonicalTuple(r);
    if (firstSeen.has(key)) {
      warnings.push({ row: r.sourceRow, message: `Identical to row ${firstSeen.get(key)} in this file - kept as a separate transaction.` });
    } else firstSeen.set(key, r.sourceRow);
  }

  return { ...base, dateFormat: resolvedDateFormat, rows, blocking, warnings };
}

module.exports = {
  PARSER_VERSION,
  SUPPORTED_EXTENSIONS,
  CANONICAL_FIELDS,
  parseStatement,
  parseMoney,
  centsToString,
  existingFingerprints,
  fingerprintRows,
  canonicalTuple,
  FINGERPRINT_VERSION,
};
