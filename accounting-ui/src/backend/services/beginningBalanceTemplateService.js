const pool = require("../db");
const { buildMultiSheetXlsxTemplate } = require("./TemplateExportService");
const { TEMPLATE_VERSION } = require("./beginningBalanceImportService");

async function getCompanyName() {
  try {
    const [rows] = await pool.execute("SELECT payor_name FROM company_profile LIMIT 1");
    return (rows[0] && rows[0].payor_name && rows[0].payor_name.trim()) || "AstreaBlue Accounting System";
  } catch {
    return "AstreaBlue Accounting System";
  }
}

function generatedMeta(module, companyName) {
  const now = new Date();
  return [
    `Company: ${companyName}`,
    `Module: ${module.toUpperCase()}_BEGINNING_BALANCE`,
    `Template Version: ${TEMPLATE_VERSION}`,
    `Generated: ${now.toISOString().slice(0, 19).replace("T", " ")}`,
  ];
}

const GL_COLUMNS = [
  { key: "accountCode", header: "Account Code" },
  { key: "accountTitle", header: "Account Title" },
  { key: "balanceDate", header: "Beginning Balance Date" },
  { key: "debit", header: "Debit" },
  { key: "credit", header: "Credit" },
  { key: "referenceNo", header: "Reference Number" },
  { key: "description", header: "Description" },
  { key: "department", header: "Department" },
  { key: "project", header: "Project" },
  { key: "remarks", header: "Remarks" },
];

function buildCsvTemplate(columns, sampleRow) {
  const rows = [
    columns.map((c) => c.header),
    columns.map((c) => sampleRow[c.key] ?? ""),
  ];
  return rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
}

async function buildGLTemplate(format) {
  const companyName = await getCompanyName();

  const [accounts] = await pool.execute(
    "SELECT code, title, account_class AS accountClass FROM chart_of_accounts ORDER BY code ASC"
  );

  const sampleRow = {
    accountCode: accounts[0]?.code || "101001",
    accountTitle: accounts[0]?.title || "CASH ON HAND",
    balanceDate: new Date().toISOString().slice(0, 10),
    debit: "10000.00",
    credit: "",
    referenceNo: "GL-BEG-0001",
    description: "Opening balance",
    department: "",
    project: "",
    remarks: "",
  };

  if (format === "csv") {
    return buildCsvTemplate(GL_COLUMNS, sampleRow);
  }

  const buffer = await buildMultiSheetXlsxTemplate({
    sheets: [
      {
        type: "import",
        name: "Import Template",
        columns: [
          { key: "accountCode", header: "Account Code", width: 16, required: true },
          { key: "accountTitle", header: "Account Title", width: 30, note: "Reference only - validated against Account Code, not used to look up the account." },
          { key: "balanceDate", header: "Beginning Balance Date", width: 20, required: true, note: "Format: YYYY-MM-DD" },
          { key: "debit", header: "Debit", width: 16, note: "Leave blank or 0 if this row is a credit. A row cannot have both Debit and Credit." },
          { key: "credit", header: "Credit", width: 16, note: "Leave blank or 0 if this row is a debit." },
          { key: "referenceNo", header: "Reference Number", width: 20 },
          { key: "description", header: "Description", width: 30 },
          { key: "department", header: "Department", width: 16 },
          { key: "project", header: "Project", width: 16 },
          { key: "remarks", header: "Remarks", width: 30 },
        ],
        sampleRow,
      },
      {
        type: "instructions",
        name: "Instructions",
        title: "GL Beginning Balance Import - Instructions",
        meta: generatedMeta("gl", companyName),
        sections: [
          {
            heading: "Required Columns",
            body: [
              "Account Code - must exist in the Chart of Accounts (see the Account Reference sheet).",
              "Beginning Balance Date - format YYYY-MM-DD.",
            ],
          },
          {
            heading: "Debit / Credit Rules",
            body: [
              "Exactly one of Debit or Credit must have an amount greater than zero per row.",
              "A row cannot have both Debit and Credit filled in.",
              "A row cannot have both Debit and Credit blank/zero.",
              "Total Debit must equal Total Credit across the whole file before it can be imported - the preview screen shows the running difference.",
            ],
          },
          {
            heading: "Date and Numeric Format",
            body: [
              "Dates: YYYY-MM-DD (e.g. 2026-01-01). Excel date-formatted cells are also accepted.",
              "Amounts: plain numbers, e.g. 10000.00 or 10000. Currency symbols and thousands separators are stripped automatically.",
            ],
          },
          {
            heading: "How Codes Are Resolved",
            body: [
              "Account Code is matched against the Chart of Accounts and resolved to the account internally - the account's internal ID is never something you need to know or enter.",
              "Account Title is reference only. If it doesn't match what's on file for that Account Code, you'll get a warning (not a blocking error) - the Account Code always wins.",
            ],
          },
          {
            heading: "Duplicate Handling",
            body: [
              "A row is flagged as a duplicate if another row in the same file has the same Account Code + Beginning Balance Date, or if a beginning balance already exists in the system for that Account Code + Date.",
              "By default, duplicates block the import (Reject mode). You can choose \"Skip Existing\" when importing to exclude duplicate rows and import everything else.",
            ],
          },
          {
            heading: "Import Process",
            body: [
              "1. Upload the file - it is parsed and every row validated, but nothing is saved yet.",
              "2. Review the preview: total/valid/invalid/warning rows, and the debit/credit totals.",
              "3. Download the error file if there are invalid rows, fix them, and re-upload if needed.",
              "4. Confirm the import - only then are records actually saved, inside a single transaction (all-or-nothing).",
            ],
          },
          {
            heading: "Common Validation Errors",
            body: [
              "\"Account Code ... does not exist in the Chart of Accounts\" - check spelling/spacing against the Account Reference sheet.",
              "\"Debit and Credit cannot both contain an amount\" - clear one of the two columns.",
              "\"Beginning Balance Date is not a valid date\" - use YYYY-MM-DD.",
              "\"Total Debit and Total Credit are not balanced\" - the whole file's debits and credits must sum to the same amount.",
            ],
          },
          {
            heading: "Limits",
            body: ["Maximum upload size: 10 MB.", "Accepted file types: .xlsx, .csv."],
          },
        ],
      },
      {
        type: "reference",
        name: "Account Reference",
        columns: [
          { key: "code", header: "Account Code", width: 16 },
          { key: "title", header: "Account Title", width: 34 },
          { key: "accountClass", header: "Class", width: 14 },
        ],
        rows: accounts,
      },
    ],
  });

  return buffer;
}

const PARTY_COLUMNS = [
  { key: "partyCode", header: "Code" },
  { key: "partyName", header: "Name" },
  { key: "accountCode", header: "Account Code" },
  { key: "documentNumber", header: "Document Number" },
  { key: "balanceDate", header: "Beginning Balance Date" },
  { key: "documentDate", header: "Document Date" },
  { key: "dueDate", header: "Due Date" },
  { key: "referenceNo", header: "Reference Number" },
  { key: "originalAmount", header: "Original Amount" },
  { key: "paidAmount", header: "Paid Amount" },
  { key: "balanceAmount", header: "Balance Amount" },
];

// AR and AP templates are structurally identical - only the party type
// (Customer/Supplier), the COA validation flag (AR CODE/AP CODE), and
// labels differ, so one function builds both.
async function buildPartyTemplate(module, format) {
  const isAR = module === "ar";
  const partyLabel = isAR ? "Customer" : "Supplier";
  const partyType = isAR ? "CUSTOMER" : "SUPPLIER";
  const coaFlag = isAR ? "AR CODE" : "AP CODE";
  const docPrefix = isAR ? "AR" : "AP";

  const companyName = await getCompanyName();

  const [parties] = await pool.execute(
    "SELECT code, name FROM general_libraries WHERE party_type = ? ORDER BY code ASC",
    [partyType]
  );

  const [accounts] = await pool.execute(
    `SELECT ca.code, ca.title
     FROM chart_of_accounts ca
     JOIN coa_validations cv ON cv.coa_id = ca.id
     WHERE cv.validation_name = ?
     ORDER BY ca.code ASC`,
    [coaFlag]
  );

  const today = new Date().toISOString().slice(0, 10);
  const sampleRow = {
    partyCode: parties[0]?.code || `${docPrefix}0001`,
    partyName: parties[0]?.name || `Sample ${partyLabel}`,
    accountCode: accounts[0]?.code || "",
    documentNumber: `${docPrefix}-BEG-0001`,
    balanceDate: today,
    documentDate: today,
    dueDate: today,
    referenceNo: "",
    originalAmount: "10000.00",
    paidAmount: "0.00",
    balanceAmount: "10000.00",
  };

  const columnHeaderFor = (key) => {
    if (key === "partyCode") return `${partyLabel} Code`;
    if (key === "partyName") return `${partyLabel} Name`;
    return PARTY_COLUMNS.find((c) => c.key === key).header;
  };

  if (format === "csv") {
    const columns = PARTY_COLUMNS.map((c) => ({ key: c.key, header: columnHeaderFor(c.key) }));
    return buildCsvTemplate(columns, sampleRow);
  }

  const buffer = await buildMultiSheetXlsxTemplate({
    sheets: [
      {
        type: "import",
        name: "Import Template",
        columns: [
          { key: "partyCode", header: columnHeaderFor("partyCode"), width: 16, required: true },
          { key: "partyName", header: columnHeaderFor("partyName"), width: 26, note: `Reference only - validated against ${partyLabel} Code, not used to look up the ${partyLabel.toLowerCase()}.` },
          { key: "accountCode", header: "Account Code", width: 16, required: true, note: `Must be flagged as a valid ${docPrefix === "AR" ? "Accounts Receivable" : "Accounts Payable"} account (see the Account Reference sheet).` },
          { key: "documentNumber", header: "Document Number", width: 20, note: "Optional, but must be unique if provided." },
          { key: "balanceDate", header: "Beginning Balance Date", width: 20, required: true, note: "Format: YYYY-MM-DD. Groups rows into the same beginning balance batch/header." },
          { key: "documentDate", header: "Document Date", width: 18, note: "Format: YYYY-MM-DD" },
          { key: "dueDate", header: "Due Date", width: 16, required: true, note: "Format: YYYY-MM-DD. Cannot be earlier than Document Date." },
          { key: "referenceNo", header: "Reference Number", width: 20 },
          { key: "originalAmount", header: "Original Amount", width: 18, required: true },
          { key: "paidAmount", header: "Paid Amount", width: 16, note: "Leave blank or 0 if unpaid. Cannot exceed Original Amount." },
          { key: "balanceAmount", header: "Balance Amount", width: 18, note: "Must equal Original Amount minus Paid Amount. Leave blank to have it calculated automatically." },
        ],
        sampleRow,
      },
      {
        type: "instructions",
        name: "Instructions",
        title: `${docPrefix} Beginning Balance Import - Instructions`,
        meta: generatedMeta(module, companyName),
        sections: [
          {
            heading: "Required Columns",
            body: [
              `${partyLabel} Code - must exist in General Libraries (see the ${partyLabel} Reference sheet). Never auto-created.`,
              `Account Code - must exist and be flagged as a valid ${docPrefix} account (see the Account Reference sheet).`,
              "Beginning Balance Date - format YYYY-MM-DD. All rows sharing the same date are grouped into one beginning balance batch, matching how a manual entry's header date works.",
              "Due Date - format YYYY-MM-DD, cannot be earlier than Document Date.",
              "Original Amount - required, cannot be negative.",
            ],
          },
          {
            heading: "Amounts",
            body: [
              "Paid Amount - optional, defaults to 0. Cannot exceed Original Amount.",
              "Balance Amount - optional; if provided it must equal Original Amount minus Paid Amount. If left blank, it is calculated automatically.",
            ],
          },
          {
            heading: "How Codes Are Resolved",
            body: [
              `${partyLabel} Code is matched against General Libraries and resolved internally - the internal ID is never something you need to know or enter.`,
              `${partyLabel} Name is reference only. If it doesn't match what's on file for that ${partyLabel} Code, you'll get a warning (not a blocking error) - the ${partyLabel} Code always wins.`,
              "Account Code is matched only against accounts flagged for this module in the Chart of Accounts validation settings.",
            ],
          },
          {
            heading: "Duplicate Handling",
            body: [
              "A row is flagged as a duplicate if another row in the same file has the same Document Number, or if that Document Number already exists in the system for this module.",
              "Rows without a Document Number are never flagged as duplicates.",
              "By default, duplicates block the import (Reject mode). You can choose \"Skip Existing\" when importing to exclude duplicate rows and import everything else.",
            ],
          },
          {
            heading: "Import Process",
            body: [
              "1. Upload the file - it is parsed and every row validated, but nothing is saved yet.",
              "2. Review the preview: total/valid/invalid/warning rows.",
              "3. Download the error file if there are invalid rows, fix them, and re-upload if needed.",
              "4. Confirm the import - only then are records actually saved, inside a single transaction (all-or-nothing).",
            ],
          },
          {
            heading: "Limits",
            body: ["Maximum upload size: 10 MB.", "Accepted file types: .xlsx, .csv."],
          },
        ],
      },
      {
        type: "reference",
        name: "Account Reference",
        columns: [
          { key: "code", header: "Account Code", width: 16 },
          { key: "title", header: "Account Title", width: 34 },
        ],
        rows: accounts,
      },
      {
        type: "reference",
        name: `${partyLabel} Reference`,
        columns: [
          { key: "code", header: `${partyLabel} Code`, width: 16 },
          { key: "name", header: `${partyLabel} Name`, width: 34 },
        ],
        rows: parties,
      },
    ],
  });

  return buffer;
}

async function buildTemplate(module, format) {
  if (module === "gl") return buildGLTemplate(format);
  if (module === "ar" || module === "ap") return buildPartyTemplate(module, format);
  throw Object.assign(new Error(`Template for module "${module}" is not available yet`), { statusCode: 400 });
}

module.exports = { buildTemplate };
