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

async function buildTemplate(module, format) {
  if (module === "gl") return buildGLTemplate(format);
  throw Object.assign(new Error(`Template for module "${module}" is not available yet`), { statusCode: 400 });
}

module.exports = { buildTemplate };
