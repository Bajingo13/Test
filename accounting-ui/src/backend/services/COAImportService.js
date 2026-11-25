const path = require("path");
const pool = require("../db");
const {
  extractRowsFromXlsx,
  parseCsvRows,
  parseStatementDate,
} = require("./StatementImportService");
const { OWNING_BRANCH_ALIASES, buildOwningBranchResolver } = require("./importBranchResolver");
const { assertCoaCodeAllowed } = require("./coaLookupService");
const { COA_EXAMPLE, COA_EXAMPLE_FIELDS, EXAMPLE_ROW_REASON, isExampleRow } = require("./templateExamples");

// Phase B code rules (coaLookupService.assertCoaCodeAllowed), applied to the
// whole file before anything is written. `taken` = existing accounts plus the
// rows of this file already accepted ({ branchId, accountClass, inFile }).
// Returns the refusal reason, or null when the row may be created. The
// de8b06a reason texts are kept for the shared (legacy) cases.
function coaCodeRefusal(code, branchId, accountClass, taken) {
  if (branchId === null) {
    if (taken.some((t) => t.branchId === null)) {
      return taken.some((t) => t.branchId === null && t.inFile)
        ? `Code "${code}" is a duplicate of another row in this file`
        : `Code "${code}" already exists`;
    }
    if (taken.length) return `Code "${code}" is already used by a branch account; a shared account cannot reuse it`;
    return null;
  }
  if (taken.some((t) => t.branchId === null)) return `Code "${code}" is a shared account; a branch account cannot reuse it`;
  const same = taken.filter((t) => t.branchId === branchId);
  if (same.length) {
    return same.some((t) => t.inFile)
      ? `Code "${code}" is a duplicate of another row in this file`
      : `Code "${code}" already exists in this branch`;
  }
  if (taken.some((t) => String(t.accountClass).toUpperCase() !== accountClass)) {
    return `Code "${code}" is used by another branch with a different account class; branches sharing a code must use the same class`;
  }
  return null; // the same code in another branch, same class - allowed (Phase B)
}

const CLASS_OPTIONS = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"];

// Schema limits (chart_of_accounts.code VARCHAR(50), .title VARCHAR(255)) -
// validated here, before any insert is attempted, rather than relying on
// MySQL's own truncation/rejection behavior at write time.
const CODE_MAX_LENGTH = 50;
const TITLE_MAX_LENGTH = 255;

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
  owningBranch: OWNING_BRANCH_ALIASES,
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
//
// Post-File-Setup: an optional "Owning Branch" column assigns branch-only
// accounts (importBranchResolver). Without the column every row is a shared
// account exactly as before. `user` is required only when the column is
// present (authority over the branch is re-checked on confirm as well).
async function parseAndValidateRows(buffer, filename, { user = null } = {}) {
  const { headers, dataRows } = await extractRows(buffer, filename);

  if (headers.length === 0) {
    return { headers: [], ready: [], skipped: [], warnings: [] };
  }

  const mapping = resolveCOAColumnMapping(headers);

  if (mapping.code === undefined || mapping.title === undefined) {
    return { headers, mapping, ready: [], skipped: [], warnings: [], missingRequiredColumns: true };
  }

  // chart_of_accounts.code uses a case-insensitive collation
  // (utf8mb4_0900_ai_ci) at the DB level - "CASH" and "cash" are the SAME
  // row as far as MySQL's own UNIQUE constraint is concerned. Comparing
  // here with a case-sensitive JS Set would let a case-variant slip past
  // validation and fail at INSERT instead, which is exactly the mid-batch
  // failure this checkpoint fixes. Comparison is normalized to uppercase;
  // the ORIGINAL casing the user typed is still what gets stored - this
  // never rewrites a code, only how two codes are compared for sameness.
  const [existingRows] = await pool.execute("SELECT code, branch_id, account_class FROM chart_of_accounts");
  const takenByCode = new Map(); // upper-cased code -> [{ branchId, accountClass, inFile }]
  for (const r of existingRows) {
    const k = String(r.code).trim().toUpperCase();
    if (!takenByCode.has(k)) takenByCode.set(k, []);
    takenByCode.get(k).push({ branchId: r.branch_id === null ? null : Number(r.branch_id), accountClass: r.account_class, inFile: false });
  }
  const hasOwnerColumn = mapping.owningBranch !== undefined;
  const owner = hasOwnerColumn
    ? await buildOwningBranchResolver(user, { companyId: null })
    : { resolve: () => ({ ok: true, branchId: null, label: "Shared" }) };

  const [groupRows] = await pool.execute(
    "SELECT group_code, group_description FROM account_group_codes"
  );
  const groupsByCode = new Map(groupRows.map((g) => [String(g.group_code).trim(), g.group_description]));

  const ready = [];
  const skipped = [];
  const warnings = [];

  dataRows.forEach((rowValues, idx) => {
    const rowNum = idx + 2; // +1 for header row, +1 for 1-indexing
    const get = (field) => (mapping[field] !== undefined ? rowValues[mapping[field]] : undefined);

    const code = get("code") != null ? String(get("code")).trim() : "";
    const title = get("title") != null ? String(get("title")).trim() : "";

    if (!code || !title) {
      skipped.push({ row: rowNum, reason: "Missing required code or title" });
      return;
    }

    // The example row of an older template (see templateExamples.js).
    if (isExampleRow(get, COA_EXAMPLE, COA_EXAMPLE_FIELDS)) {
      skipped.push({ row: rowNum, reason: EXAMPLE_ROW_REASON });
      return;
    }

    if (code.length > CODE_MAX_LENGTH) {
      skipped.push({ row: rowNum, reason: `Code exceeds the maximum length of ${CODE_MAX_LENGTH} characters` });
      return;
    }
    if (title.length > TITLE_MAX_LENGTH) {
      skipped.push({ row: rowNum, reason: `Title exceeds the maximum length of ${TITLE_MAX_LENGTH} characters` });
      return;
    }

    const codeUpper = code.toUpperCase();
    const taken = takenByCode.get(codeUpper) || [];
    const ownerResult = owner.resolve(get("owningBranch"));
    const branchId = ownerResult.ok ? ownerResult.branchId : null;

    // Shared rows keep the de8b06a order (code checks before class).
    if (ownerResult.ok && branchId === null) {
      const refusal = coaCodeRefusal(code, null, null, taken);
      if (refusal) { skipped.push({ row: rowNum, reason: refusal }); return; }
    }

    let accountClass = get("accountClass") != null ? String(get("accountClass")).trim().toUpperCase() : "";
    if (!CLASS_OPTIONS.includes(accountClass)) {
      skipped.push({
        row: rowNum,
        reason: `Account Class must be one of: ${CLASS_OPTIONS.join(", ")}`,
      });
      return;
    }

    if (!ownerResult.ok) { skipped.push({ row: rowNum, reason: ownerResult.reason }); return; }
    if (branchId !== null) {
      const refusal = coaCodeRefusal(code, branchId, accountClass, taken);
      if (refusal) { skipped.push({ row: rowNum, reason: refusal }); return; }
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

    if (!takenByCode.has(codeUpper)) takenByCode.set(codeUpper, []);
    takenByCode.get(codeUpper).push({ branchId, accountClass, inFile: true });
    ready.push({ rowNum, code, date, title, accountClass, description, validations, groups, branchId, owningBranchLabel: ownerResult.label });
  });

  return { headers, mapping, ready, skipped, warnings, hasOwnerColumn };
}

// Checkpoint (COA import reliability audit): ALL rows in one request now
// share a SINGLE transaction. Previously each row committed independently,
// so a failure on (say) row 347 of a 500-row batch left rows 1-346
// permanently in the database with rows 348-500 never attempted - an
// unknown, silently-partial COA. Now: any unexpected DB error during
// insertion rolls back the ENTIRE batch, leaving zero newly-imported rows
// from this request. Rows already excluded by parseAndValidateRows (missing
// fields, duplicates, bad class, overlong values) are still just skipped,
// same as before - this only changes what happens to the rows that WERE
// classified as valid.
async function insertCOARows(rows, syncBankCodeForAccount) {
  if (rows.length === 0) return 0;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    for (const row of rows) {
      const branchId = row.branchId ?? null;
      // Phase B rules again inside the transaction (locking read): a code
      // another user created after validation rolls the whole batch back.
      await assertCoaCodeAllowed(conn, { code: row.code, branchId, accountClass: row.accountClass });
      const [result] = await conn.execute(
        `INSERT INTO chart_of_accounts (code, account_date, title, account_class, description, branch_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [row.code, row.date, row.title, row.accountClass, row.description, branchId]
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
    }

    await conn.commit();
    return rows.length;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  CLASS_OPTIONS,
  VALIDATION_OPTIONS,
  parseAndValidateRows,
  insertCOARows,
};
