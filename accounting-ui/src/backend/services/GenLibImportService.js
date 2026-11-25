const path = require("path");
const pool = require("../db");
const {
  extractRowsFromXlsx,
  parseCsvRows,
  parseStatementDate,
} = require("./StatementImportService");
const { OWNING_BRANCH_ALIASES, buildOwningBranchResolver } = require("./importBranchResolver");

const PARTY_TYPES = ["CUSTOMER", "SUPPLIER", "EMPLOYEE", "AFFILIATE", "BRANCH", "OTHER"];
const STATUS_OPTIONS = ["ACTIVE", "INACTIVE"];
const CATEGORY_OPTIONS = ["REGULAR", "VIP", "AFFILIATES", "WALK-IN", "OTHERS"];

const GENLIB_FIELD_ALIASES = {
  code: ["code"],
  type: ["type", "party type"],
  name: ["name"],
  status: ["status"],
  startDate: ["start date", "startdate", "date"],
  address1: ["address1", "address 1"],
  address2: ["address2", "address 2"],
  address3: ["address3", "address 3"],
  attention: ["attention", "attn"],
  position: ["position"],
  telephone: ["telephone", "tel", "phone"],
  fax: ["fax"],
  mobile: ["mobile", "cell"],
  tin: ["tin"],
  email: ["email", "e-mail"],
  atcCode: ["atc code", "atccode"],
  ewtCode: ["ewt code", "ewtcode"],
  category: ["category"],
  branchCode: ["branch code", "branchcode"],
  rdoCode: ["rdo code", "rdocode"],
  notes: ["notes", "remarks"],
  isProspective: ["is prospective", "prospective"],
  isClient: ["is client", "client"],
  // Organizational owner (shared or one branch of the company). NOT the
  // party's BIR "Branch Code" above, which stays a plain text field.
  owningBranch: OWNING_BRANCH_ALIASES,
};

function normalizeHeaderKey(header) {
  return String(header || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function resolveGenLibColumnMapping(headers) {
  const normalized = headers.map(normalizeHeaderKey);
  const mapping = {};

  for (const field of Object.keys(GENLIB_FIELD_ALIASES)) {
    const idx = normalized.findIndex((h) => GENLIB_FIELD_ALIASES[field].includes(h));
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

function parseBoolean(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["yes", "true", "1", "y"].includes(normalized);
}

const TEXT_FIELDS = [
  "address1", "address2", "address3", "attention", "position", "telephone",
  "fax", "mobile", "tin", "email", "atcCode", "ewtCode", "branchCode",
  "rdoCode", "notes",
];

// Same shape as COAImportService.parseAndValidateRows: required fields
// missing or an unrecognized code -> skipped row; enum values are matched
// case-insensitively; a code that already exists in general_libraries is
// never overwritten by import, only reported back as skipped.
//
// Read-only: used by BOTH the preview and the confirm request. Confirm calls
// it again on the resubmitted file, so it always validates against the
// database as it is at write time (a preview result is never trusted).
// Since Multi-Branch Phase B general_libraries.code is UNIQUE per COMPANY
// (uq_genlib_company_code) and the collation is case-insensitive, so existing
// / in-file duplicates are compared case-insensitively within `companyId` -
// exactly what the INSERT would reject. (de8b06a compared against every
// company's codes: a code used only by ANOTHER company was wrongly refused as
// "already exists", which also disclosed that company's code.)
//
// Post-File-Setup: optional "Owning Branch" column - shared (blank / SHARED)
// or one branch of `companyId` (importBranchResolver). Without the column
// every row is shared, exactly as before.
async function parseAndValidateRows(buffer, filename, { companyId = null, user = null } = {}) {
  const { headers, dataRows } = await extractRows(buffer, filename);

  if (headers.length === 0) {
    return { headers: [], ready: [], skipped: [], warnings: [] };
  }

  const mapping = resolveGenLibColumnMapping(headers);

  if (mapping.code === undefined || mapping.name === undefined) {
    return { headers, mapping, ready: [], skipped: [], warnings: [], missingRequiredColumns: true };
  }

  const [existingRows] = companyId
    ? await pool.execute("SELECT code FROM general_libraries WHERE company_id = ?", [companyId])
    : await pool.execute("SELECT code FROM general_libraries");
  const codeKey = (c) => String(c).trim().toLowerCase();
  const existingCodes = new Set(existingRows.map((r) => codeKey(r.code)));
  const hasOwnerColumn = mapping.owningBranch !== undefined;
  const owner = hasOwnerColumn
    ? await buildOwningBranchResolver(user, { companyId })
    : { resolve: () => ({ ok: true, branchId: null, label: "Shared" }) };

  const ready = [];
  const skipped = [];
  const warnings = [];
  const seenInFile = new Map(); // code key -> first row number that used it

  dataRows.forEach((rowValues, idx) => {
    const rowNum = idx + 2;
    const get = (field) => (mapping[field] !== undefined ? rowValues[mapping[field]] : undefined);

    const code = get("code") != null ? String(get("code")).trim() : "";
    const name = get("name") != null ? String(get("name")).trim() : "";

    if (!code || !name) {
      skipped.push({ row: rowNum, code, reason: "Missing required code or name" });
      return;
    }

    if (existingCodes.has(codeKey(code))) {
      skipped.push({ row: rowNum, code, reason: `Code "${code}" already exists` });
      return;
    }

    if (seenInFile.has(codeKey(code))) {
      skipped.push({ row: rowNum, code, reason: `Code "${code}" is repeated in this file (first used on row ${seenInFile.get(codeKey(code))})` });
      return;
    }

    const rawType = get("type") != null ? String(get("type")).trim().toUpperCase() : "";
    const type = PARTY_TYPES.find((t) => t === rawType);
    if (!type) {
      skipped.push({ row: rowNum, code, reason: `Type must be one of: ${PARTY_TYPES.join(", ")}` });
      return;
    }

    const ownerResult = owner.resolve(get("owningBranch"));
    if (!ownerResult.ok) {
      skipped.push({ row: rowNum, code, reason: ownerResult.reason });
      return;
    }

    const rawStatus = get("status") != null ? String(get("status")).trim().toUpperCase() : "ACTIVE";
    const status = STATUS_OPTIONS.includes(rawStatus) ? rawStatus : "ACTIVE";
    if (get("status") && !STATUS_OPTIONS.includes(rawStatus)) {
      warnings.push({ row: rowNum, message: `Unrecognized status "${get("status")}" - defaulted to ACTIVE` });
    }

    const rawCategory = get("category") != null ? String(get("category")).trim().toUpperCase() : "";
    let category = "";
    if (rawCategory) {
      const match = CATEGORY_OPTIONS.find((c) => c === rawCategory);
      if (match) {
        category = match;
      } else {
        warnings.push({ row: rowNum, message: `Unrecognized category "${rawCategory}" - left blank` });
      }
    }

    const record = {
      row: rowNum,
      code,
      type,
      name,
      status,
      startDate: parseStatementDate(get("startDate")),
      category,
      isProspective: parseBoolean(get("isProspective")),
      isClient: parseBoolean(get("isClient")),
      branchId: ownerResult.branchId,
      owningBranchLabel: ownerResult.label,
    };

    for (const field of TEXT_FIELDS) {
      record[field] = get(field) != null ? String(get(field)).trim() : "";
    }

    seenInFile.set(codeKey(code), rowNum);
    ready.push(record);
  });

  return { headers, mapping, ready, skipped, warnings, hasOwnerColumn };
}

// All ready rows in ONE transaction (same pattern as COA / Group Codes
// import). Any DB error - including ER_DUP_ENTRY from a code another user
// created after this request validated the file - rolls back the whole batch
// (zero rows from this request remain) and is re-thrown. INSERT only.
async function insertGenLibRows(rows, companyId) {
  if (rows.length === 0) return 0;

  const conn = await pool.getConnection();
  let imported = 0;
  try {
    await conn.beginTransaction();
    for (const item of rows) {
      await conn.execute(
        `INSERT INTO general_libraries (
          company_id, code, party_type, name, status, start_date,
          address1, address2, address3, attention, position,
          telephone, fax, mobile, tin, email,
          atc_code, ewt_code, category, branch_code, rdo_code,
          notes, is_prospective, is_client, branch_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          companyId,
          item.code,
          item.type,
          item.name,
          item.status,
          item.startDate,
          item.address1,
          item.address2,
          item.address3,
          item.attention,
          item.position,
          item.telephone,
          item.fax,
          item.mobile,
          item.tin,
          item.email,
          item.atcCode,
          item.ewtCode,
          item.category,
          item.branchCode,
          item.rdoCode,
          item.notes,
          item.isProspective ? 1 : 0,
          item.isClient ? 1 : 0,
          item.branchId ?? null,
        ]
      );
      imported++;
    }
    await conn.commit();
    return imported;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  PARTY_TYPES,
  STATUS_OPTIONS,
  CATEGORY_OPTIONS,
  parseAndValidateRows,
  insertGenLibRows,
};
