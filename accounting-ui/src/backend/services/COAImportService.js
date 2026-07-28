const path = require("path");
const pool = require("../db");
const {
  extractRowsFromXlsx,
  parseCsvRows,
  parseStatementDate,
} = require("./StatementImportService");

const CLASS_OPTIONS = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"];

const VALIDATION_OPTIONS = [
  "BANK / CASH",
  "OTHER ACCOUNTS",
  "PREPAYMENT",
  "ALLOCATION",
  "AR CODE",
  "EXPANDED TAX",
  "FIXED ASSET",
  "BEG. INVENTORY",
  "AP CODE",
  "FINAL TAX",
  "GAIN OR LOSS",
  "END INVENTORY",
  "INCOME",
  "INPUT VAT",
  "RESTATEMENT",
  "EXPENSE",
  "OUTPUT VAT",
];

const COA_FIELD_ALIASES = {
  code: ["code", "account code", "acct code", "account no"],
  date: ["date", "account date", "effective date"],
  title: ["title", "account title", "account name", "name"],
  accountClass: ["account class", "class", "accountclass"],
  description: ["description", "desc", "particulars"],
  validations: ["validations", "validation", "tags"],
  groups: ["group codes", "groups", "group code"],
};

function normalizeHeaderKey(header) {
  return String(header || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function resolveCOAColumnMapping(headers) {
  const normalized = headers.map(normalizeHeaderKey);
  const mapping = {};

  for (const field of Object.keys(COA_FIELD_ALIASES)) {
    const idx = normalized.findIndex((h) => COA_FIELD_ALIASES[field].includes(h));
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

function splitTokens(value) {
  return String(value || "")
    .split(/[;,]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

// Parses+validates every row, resolves group codes against the live
// account_group_codes table, and separates rows into ready-to-insert /
// skipped (hard failure, e.g. missing code, duplicate code, bad class) /
// warnings (soft issue that doesn't block the row, e.g. an unrecognized
// validation token that just gets dropped). Never overwrites an existing
// account code - bulk import only ever adds new accounts.
async function parseAndValidateRows(buffer, filename) {
  const { headers, dataRows } = await extractRows(buffer, filename);

  if (headers.length === 0) {
    return { headers: [], ready: [], skipped: [], warnings: [] };
  }

  const mapping = resolveCOAColumnMapping(headers);

  if (mapping.code === undefined || mapping.title === undefined) {
    return { headers, mapping, ready: [], skipped: [], warnings: [], missingRequiredColumns: true };
  }

  const [existingRows] = await pool.execute("SELECT code FROM chart_of_accounts");
  const existingCodes = new Set(existingRows.map((r) => String(r.code).trim()));

  const [groupRows] = await pool.execute(
    "SELECT group_code, group_description FROM account_group_codes"
  );
  const groupsByCode = new Map(groupRows.map((g) => [String(g.group_code).trim(), g.group_description]));

  const ready = [];
  const skipped = [];
  const warnings = [];
  const seenInFile = new Set();

  dataRows.forEach((rowValues, idx) => {
    const rowNum = idx + 2; // +1 for header row, +1 for 1-indexing
    const get = (field) => (mapping[field] !== undefined ? rowValues[mapping[field]] : undefined);

    const code = get("code") != null ? String(get("code")).trim() : "";
    const title = get("title") != null ? String(get("title")).trim() : "";

    if (!code || !title) {
      skipped.push({ row: rowNum, reason: "Missing required code or title" });
      return;
    }

    if (existingCodes.has(code) || seenInFile.has(code)) {
      skipped.push({ row: rowNum, reason: `Code "${code}" already exists` });
      return;
    }

    let accountClass = get("accountClass") != null ? String(get("accountClass")).trim().toUpperCase() : "";
    if (!CLASS_OPTIONS.includes(accountClass)) {
      skipped.push({
        row: rowNum,
        reason: `Account Class must be one of: ${CLASS_OPTIONS.join(", ")}`,
      });
      return;
    }

    const date = parseStatementDate(get("date")) || new Date().toISOString().slice(0, 10);
    const description = get("description") != null ? String(get("description")).trim() : "";

    const rawValidations = splitTokens(get("validations"));
    const validations = [];
    for (const token of rawValidations) {
      const match = VALIDATION_OPTIONS.find((v) => v.toLowerCase() === token.toLowerCase());
      if (match) {
        validations.push(match);
      } else {
        warnings.push({ row: rowNum, message: `Unrecognized validation "${token}" - skipped` });
      }
    }

    const rawGroups = splitTokens(get("groups"));
    const groups = [];
    for (const groupCode of rawGroups) {
      const description2 = groupsByCode.get(groupCode);
      if (description2 !== undefined) {
        groups.push({ code: groupCode, description: description2 });
      } else {
        warnings.push({ row: rowNum, message: `Unrecognized group code "${groupCode}" - skipped` });
      }
    }

    seenInFile.add(code);
    ready.push({ code, date, title, accountClass, description, validations, groups });
  });

  return { headers, mapping, ready, skipped, warnings };
}

async function insertCOARows(rows, syncBankCodeForAccount) {
  let imported = 0;

  for (const row of rows) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [result] = await conn.execute(
        `INSERT INTO chart_of_accounts (code, account_date, title, account_class, description)
         VALUES (?, ?, ?, ?, ?)`,
        [row.code, row.date, row.title, row.accountClass, row.description]
      );

      const coaId = result.insertId;

      for (const validation of row.validations) {
        await conn.execute(
          "INSERT INTO coa_validations (coa_id, validation_name) VALUES (?, ?)",
          [coaId, validation]
        );
      }

      for (const group of row.groups) {
        await conn.execute(
          "INSERT INTO coa_groups (coa_id, group_code, group_description) VALUES (?, ?, ?)",
          [coaId, group.code, group.description]
        );
      }

      await syncBankCodeForAccount(conn, coaId, row.code, row.title, row.validations);

      await conn.commit();
      imported++;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  return imported;
}

module.exports = {
  CLASS_OPTIONS,
  VALIDATION_OPTIONS,
  parseAndValidateRows,
  insertCOARows,
};
