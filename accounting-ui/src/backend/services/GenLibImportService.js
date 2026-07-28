const path = require("path");
const pool = require("../db");
const {
  extractRowsFromXlsx,
  parseCsvRows,
  parseStatementDate,
} = require("./StatementImportService");

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
async function parseAndValidateRows(buffer, filename) {
  const { headers, dataRows } = await extractRows(buffer, filename);

  if (headers.length === 0) {
    return { headers: [], ready: [], skipped: [], warnings: [] };
  }

  const mapping = resolveGenLibColumnMapping(headers);

  if (mapping.code === undefined || mapping.name === undefined) {
    return { headers, mapping, ready: [], skipped: [], warnings: [], missingRequiredColumns: true };
  }

  const [existingRows] = await pool.execute("SELECT code FROM general_libraries");
  const existingCodes = new Set(existingRows.map((r) => String(r.code).trim()));

  const ready = [];
  const skipped = [];
  const warnings = [];
  const seenInFile = new Set();

  dataRows.forEach((rowValues, idx) => {
    const rowNum = idx + 2;
    const get = (field) => (mapping[field] !== undefined ? rowValues[mapping[field]] : undefined);

    const code = get("code") != null ? String(get("code")).trim() : "";
    const name = get("name") != null ? String(get("name")).trim() : "";

    if (!code || !name) {
      skipped.push({ row: rowNum, reason: "Missing required code or name" });
      return;
    }

    if (existingCodes.has(code) || seenInFile.has(code)) {
      skipped.push({ row: rowNum, reason: `Code "${code}" already exists` });
      return;
    }

    const rawType = get("type") != null ? String(get("type")).trim().toUpperCase() : "";
    const type = PARTY_TYPES.find((t) => t === rawType);
    if (!type) {
      skipped.push({ row: rowNum, reason: `Type must be one of: ${PARTY_TYPES.join(", ")}` });
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
      code,
      type,
      name,
      status,
      startDate: parseStatementDate(get("startDate")),
      category,
      isProspective: parseBoolean(get("isProspective")),
      isClient: parseBoolean(get("isClient")),
    };

    for (const field of TEXT_FIELDS) {
      record[field] = get(field) != null ? String(get(field)).trim() : "";
    }

    seenInFile.add(code);
    ready.push(record);
  });

  return { headers, mapping, ready, skipped, warnings };
}

async function insertGenLibRows(rows) {
  let imported = 0;

  for (const item of rows) {
    await pool.execute(
      `INSERT INTO general_libraries (
        code, party_type, name, status, start_date,
        address1, address2, address3, attention, position,
        telephone, fax, mobile, tin, email,
        atc_code, ewt_code, category, branch_code, rdo_code,
        notes, is_prospective, is_client
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
      ]
    );
    imported++;
  }

  return imported;
}

module.exports = {
  PARTY_TYPES,
  STATUS_OPTIONS,
  CATEGORY_OPTIONS,
  parseAndValidateRows,
  insertGenLibRows,
};
