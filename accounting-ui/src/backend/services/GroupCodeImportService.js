const path = require("path");
const ExcelJS = require("exceljs");
const { parse: parseCsv } = require("csv-parse/sync");
const pool = require("../db");
const { buildMultiSheetXlsxTemplate } = require("./TemplateExportService");
const ReportSectionService = require("./reportSectionService");
const { validateGroupCodeClassification } = require("./groupCodeClassification");

// Group Codes bulk import (Generate Template + Import). Architecture mirrors
// COAImportService (parse + validate is read-only; a separate insert step
// writes every ready row in ONE transaction), with Group Code's own rules:
//
// - INSERT-ONLY. An existing group code (compared case-insensitively, like
//   account_group_codes.group_code's utf8mb4_0900_ai_ci UNIQUE key) is
//   skipped and reported - never updated. This service never issues an
//   UPDATE and never touches coa_groups.
// - Partial import: invalid rows are skipped with a row-numbered reason;
//   valid rows still import. An unexpected DB error during the insert
//   rolls back the whole batch.
// - account_group_codes has no company_id: group codes are a global,
//   shared catalog, so an import affects every company.
// - No group code FORMAT rule exists anywhere in the application, so none
//   is introduced here - only required / length / uniqueness.

const CLASS_OPTIONS = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"];
const STATUS_OPTIONS = ["ACTIVE", "INACTIVE"];

// Schema limits: account_group_codes.group_code VARCHAR(50),
// .group_description VARCHAR(255).
const CODE_MAX_LENGTH = 50;
const DESCRIPTION_MAX_LENGTH = 255;

const FIELD_ALIASES = {
  groupCode: ["group code", "groupcode", "code"],
  groupDescription: ["group description", "groupdescription", "description", "desc"],
  accountClass: ["account class", "accountclass", "class"],
  reportSection: ["report section", "reportsection", "section"],
  displayOrder: ["display order", "displayorder", "order"],
  status: ["status"],
};
const REQUIRED_FIELDS = [
  ["groupCode", "Group Code"],
  ["groupDescription", "Group Description"],
  ["accountClass", "Account Class"],
];

// "Group Code*" (the template's required marker) matches "group code".
function normalizeHeaderKey(header) {
  return String(header ?? "")
    .replace(/\*/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function resolveColumnMapping(headers) {
  const normalized = headers.map(normalizeHeaderKey);
  const mapping = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const idx = normalized.findIndex((h) => aliases.includes(h));
    if (idx !== -1) mapping[field] = idx;
  }
  return mapping;
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

function isBlankRow(values) {
  return !values.some((v) => v !== null && v !== undefined && String(v).trim() !== "");
}

// Returns { headers, dataRows: [{ rowNum, values }] } where rowNum is the
// real spreadsheet/CSV line number, so a blank line left in the middle of
// the file never shifts the row numbers reported back to the user. Fully
// blank rows are ignored. Only the FIRST worksheet is read - the
// template's Report Sections / Instructions sheets come after it.
async function extractRows(buffer, filename) {
  const ext = path.extname(filename || "").toLowerCase();

  if (ext === ".csv") {
    const records = parseCsv(buffer, {
      columns: false,
      skip_empty_lines: false,
      trim: true,
      relax_column_count: true,
      bom: true,
    });
    const headerIdx = records.findIndex((r) => !isBlankRow(r));
    if (headerIdx === -1) return { headers: [], dataRows: [] };
    const dataRows = [];
    for (let i = headerIdx + 1; i < records.length; i++) {
      if (!isBlankRow(records[i])) dataRows.push({ rowNum: i + 1, values: records[i] });
    }
    return { headers: records[headerIdx].map((h) => String(h ?? "")), dataRows };
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return { headers: [], dataRows: [] };

  let headers = null;
  const dataRows = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values.slice(1).map(unwrapCellValue);
    if (isBlankRow(values)) return;
    if (headers === null) {
      headers = values.map((h) => (h == null ? "" : String(h)));
      return;
    }
    dataRows.push({ rowNum: row.number, values });
  });
  return { headers: headers || [], dataRows };
}

function cellText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

// Parses + validates every row against the CURRENT database. Zero writes.
// Returns ready rows (to insert), skipped rows ({ row, groupCode, reason })
// and warnings ({ row, message }).
async function parseAndValidateRows(buffer, filename) {
  const { headers, dataRows } = await extractRows(buffer, filename);

  if (headers.length === 0) {
    return { headers: [], ready: [], skipped: [], warnings: [] };
  }

  const mapping = resolveColumnMapping(headers);
  const missingColumns = REQUIRED_FIELDS.filter(([f]) => mapping[f] === undefined).map(([, label]) => label);
  if (missingColumns.length) {
    return { headers, mapping, ready: [], skipped: [], warnings: [], missingRequiredColumns: missingColumns };
  }

  const [existingRows] = await pool.execute("SELECT group_code FROM account_group_codes");
  const existingUpper = new Set(existingRows.map((r) => String(r.group_code).trim().toUpperCase()));

  const ready = [];
  const skipped = [];
  const warnings = [];
  const seenInFileUpper = new Set();

  for (const { rowNum, values } of dataRows) {
    const get = (field) => (mapping[field] !== undefined ? cellText(values[mapping[field]]) : "");
    const groupCode = get("groupCode");
    const skip = (reason) => skipped.push({ row: rowNum, groupCode, reason });

    const groupDescription = get("groupDescription");
    const accountClass = get("accountClass").toUpperCase();

    if (!groupCode) { skip("Group Code is required."); continue; }
    if (!groupDescription) { skip("Group Description is required."); continue; }
    if (!accountClass) { skip("Account Class is required."); continue; }

    if (groupCode.length > CODE_MAX_LENGTH) {
      skip(`Group Code exceeds the maximum length of ${CODE_MAX_LENGTH} characters.`);
      continue;
    }
    if (groupDescription.length > DESCRIPTION_MAX_LENGTH) {
      skip(`Group Description exceeds the maximum length of ${DESCRIPTION_MAX_LENGTH} characters.`);
      continue;
    }

    const codeUpper = groupCode.toUpperCase();
    if (existingUpper.has(codeUpper)) { skip("Group Code already exists."); continue; }
    if (seenInFileUpper.has(codeUpper)) {
      skip("Group Code is a duplicate of an earlier row in this file.");
      continue;
    }

    if (!CLASS_OPTIONS.includes(accountClass)) {
      skip(`Account Class must be one of: ${CLASS_OPTIONS.join(", ")}.`);
      continue;
    }

    const rawStatus = get("status").toUpperCase();
    const status = rawStatus || "ACTIVE";
    if (!STATUS_OPTIONS.includes(status)) {
      skip(`Status must be ACTIVE or INACTIVE (blank defaults to ACTIVE).`);
      continue;
    }

    // Report Section (exists + ACTIVE + belongs to the class) and Display
    // Order (whole number) use the same validator as POST/PUT
    // /api/group-codes, so import can never accept what the form rejects.
    const check = await validateGroupCodeClassification({
      accountClass,
      reportSection: get("reportSection"),
      displayOrder: get("displayOrder"),
    });
    if (!check.ok) { skip(check.error); continue; }

    seenInFileUpper.add(codeUpper);
    ready.push({
      rowNum,
      groupCode,
      groupDescription,
      accountClass,
      reportSection: check.value.reportSection,
      displayOrder: check.value.displayOrder,
      status,
    });
  }

  return { headers, mapping, ready, skipped, warnings };
}

// All ready rows in ONE transaction. Any DB error rolls back the whole
// batch (zero rows from this request remain) and is re-thrown. INSERT only.
async function insertGroupCodeRows(rows) {
  if (rows.length === 0) return 0;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const row of rows) {
      await conn.execute(
        `INSERT INTO account_group_codes
         (group_code, group_description, account_class, report_section, display_order, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [row.groupCode, row.groupDescription, row.accountClass, row.reportSection, row.displayOrder, row.status]
      );
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

// Template: Group Codes import sheet (first, so the importer reads it),
// a Report Sections reference sheet built from the LIVE report_sections
// table, and an Instructions sheet. No sample data row on the import sheet
// - an un-deleted example would otherwise be imported as a real group code.
async function buildTemplate() {
  const sections = await ReportSectionService.listReportSections();
  const sortedSections = [...sections].sort(
    (a, b) =>
      CLASS_OPTIONS.indexOf(a.accountClass) - CLASS_OPTIONS.indexOf(b.accountClass) ||
      (a.displayOrder ?? Number.MAX_SAFE_INTEGER) - (b.displayOrder ?? Number.MAX_SAFE_INTEGER) ||
      String(a.name).localeCompare(String(b.name))
  );

  return buildMultiSheetXlsxTemplate({
    sheets: [
      {
        type: "import",
        name: "Group Codes",
        columns: [
          { key: "groupCode", header: "Group Code*", width: 18, required: true, note: `Up to ${CODE_MAX_LENGTH} characters. Must not already exist (case-insensitive).` },
          { key: "groupDescription", header: "Group Description*", width: 36, required: true, note: `Up to ${DESCRIPTION_MAX_LENGTH} characters.` },
          { key: "accountClass", header: "Account Class*", width: 16, required: true, note: `One of: ${CLASS_OPTIONS.join(", ")}.` },
          { key: "reportSection", header: "Report Section", width: 24, note: "Optional. A Report Section CODE from the 'Report Sections' sheet that belongs to the same Account Class and is ACTIVE." },
          { key: "displayOrder", header: "Display Order", width: 14, note: "Optional. A whole number." },
          { key: "status", header: "Status", width: 12, note: "Optional. ACTIVE or INACTIVE. Blank = ACTIVE." },
        ],
        dropdowns: {
          accountClass: CLASS_OPTIONS,
          status: STATUS_OPTIONS,
        },
      },
      {
        type: "reference",
        name: "Report Sections",
        columns: [
          { key: "code", header: "Code", width: 26 },
          { key: "name", header: "Name", width: 30 },
          { key: "accountClass", header: "Class", width: 14 },
          { key: "status", header: "Status", width: 12 },
        ],
        rows: sortedSections.map((s) => ({ code: s.code, name: s.name, accountClass: s.accountClass, status: s.status })),
      },
      {
        type: "instructions",
        name: "Instructions",
        title: "Group Codes Import Template",
        meta: [`Generated ${new Date().toISOString().slice(0, 10)}. Report Sections reflect the database at that time.`],
        sections: [
          {
            heading: "Group codes are GLOBAL",
            body: [
              "Group Codes are shared by every company in the system. Importing a Group Code makes it available to ALL companies.",
            ],
          },
          {
            heading: "Columns",
            body: [
              "Required: Group Code, Group Description, Account Class.",
              "Optional: Report Section, Display Order, Status.",
              `Account Class must be one of: ${CLASS_OPTIONS.join(", ")}.`,
              "Status must be ACTIVE or INACTIVE. A blank Status imports as ACTIVE.",
              "Report Section is optional. If supplied it must be a Code from the 'Report Sections' sheet that is ACTIVE and belongs to the same Account Class as the row.",
              "Display Order is optional. If supplied it must be a whole number.",
              "Example row: GC-100 | Cash and Cash Equivalents | ASSET | CURRENT_ASSET | 10 | ACTIVE",
            ],
          },
          {
            heading: "How the import works",
            body: [
              "Only the first sheet ('Group Codes') is read. Fully blank rows are ignored.",
              "The import only ADDS new Group Codes. Existing Group Codes are never updated or overwritten.",
              "A Group Code that already exists (ignoring upper/lower case) is skipped.",
              "If the same Group Code appears more than once in the file, only the first valid occurrence is imported.",
              "Invalid rows are skipped and reported with their row number and the reason. Valid rows are still imported.",
              "You will see a preview first. Nothing is saved until you confirm the import.",
            ],
          },
        ],
      },
    ],
  });
}

module.exports = {
  CLASS_OPTIONS,
  STATUS_OPTIONS,
  CODE_MAX_LENGTH,
  DESCRIPTION_MAX_LENGTH,
  resolveColumnMapping,
  parseAndValidateRows,
  insertGroupCodeRows,
  buildTemplate,
};
