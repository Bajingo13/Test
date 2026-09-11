// Account Group Code report classification (Reports Classification
// Foundation). This is metadata about how a group code rolls up on the
// Balance Sheet / Income Statement - it does NOT touch accounting
// recognition, posting, or any ledger data.
//
// account_group_codes now carries:
//   report_section VARCHAR(32) NULL  - one of the codes below, or NULL
//                                      (= unclassified, allowed)
//   display_order  INT NULL          - report ordering; NULL falls back to
//                                      section, then group_code, then
//                                      account_code
//
// The Condensed / Detailed BS & IS output itself is NOT built here - this
// batch only lays the classification + validation + readiness groundwork.

// Machine-safe section codes, grouped by statement, with the friendly
// label the File Setup UI should display.
const REPORT_SECTIONS = [
  // Balance Sheet
  { code: "CURRENT_ASSET", label: "Current Assets", statement: "BALANCE_SHEET", accountClass: "ASSET" },
  { code: "NON_CURRENT_ASSET", label: "Non-Current Assets", statement: "BALANCE_SHEET", accountClass: "ASSET" },
  { code: "CURRENT_LIABILITY", label: "Current Liabilities", statement: "BALANCE_SHEET", accountClass: "LIABILITY" },
  { code: "NON_CURRENT_LIABILITY", label: "Non-Current Liabilities", statement: "BALANCE_SHEET", accountClass: "LIABILITY" },
  { code: "EQUITY", label: "Equity", statement: "BALANCE_SHEET", accountClass: "EQUITY" },
  // Income Statement
  { code: "REVENUE", label: "Revenue", statement: "INCOME_STATEMENT", accountClass: "INCOME" },
  { code: "OTHER_INCOME", label: "Other Income", statement: "INCOME_STATEMENT", accountClass: "INCOME" },
  { code: "DIRECT_COST", label: "Direct Costs", statement: "INCOME_STATEMENT", accountClass: "EXPENSE" },
  { code: "OPERATING_EXPENSE", label: "Operating Expenses", statement: "INCOME_STATEMENT", accountClass: "EXPENSE" },
  { code: "OTHER_EXPENSE", label: "Other Expenses", statement: "INCOME_STATEMENT", accountClass: "EXPENSE" },
  { code: "TAX_EXPENSE", label: "Tax Expense", statement: "INCOME_STATEMENT", accountClass: "EXPENSE" },
];

const SECTION_CODES = REPORT_SECTIONS.map((s) => s.code);

const SECTION_LABELS = REPORT_SECTIONS.reduce((acc, s) => {
  acc[s.code] = s.label;
  return acc;
}, {});

// The §6 validation matrix: which report_section values are allowed for a
// given chart_of_accounts / account_group_codes account_class. NULL
// (unclassified) is always allowed and is handled by the validators, not
// this table.
const ALLOWED_SECTIONS_BY_CLASS = {
  ASSET: ["CURRENT_ASSET", "NON_CURRENT_ASSET"],
  LIABILITY: ["CURRENT_LIABILITY", "NON_CURRENT_LIABILITY"],
  EQUITY: ["EQUITY"],
  INCOME: ["REVENUE", "OTHER_INCOME"],
  EXPENSE: ["DIRECT_COST", "OPERATING_EXPENSE", "OTHER_EXPENSE", "TAX_EXPENSE"],
};

function normalizeSection(value) {
  if (value === null || value === undefined || value === "") return null;
  return String(value).trim().toUpperCase();
}

// Sections offered for an account class - what the File Setup dropdown
// should show (friendly label + machine code), filtered by the currently
// selected Account Class. An unknown class returns [].
function allowedSectionsForClass(accountClass) {
  const codes = ALLOWED_SECTIONS_BY_CLASS[String(accountClass || "").trim().toUpperCase()] || [];
  return codes.map((code) => ({ code, label: SECTION_LABELS[code] }));
}

// true when `reportSection` (may be null) is a valid choice for
// `accountClass`. NULL / "" is always valid (unclassified).
function isValidSectionForClass(accountClass, reportSection) {
  const section = normalizeSection(reportSection);
  if (section === null) return true;
  const cls = String(accountClass || "").trim().toUpperCase();
  return (ALLOWED_SECTIONS_BY_CLASS[cls] || []).includes(section);
}

// Full validation for a create/update payload. Returns { ok: true, value }
// with the normalized section + display order, or { ok: false, error }.
function validateGroupCodeClassification({ accountClass, reportSection, displayOrder } = {}) {
  const section = normalizeSection(reportSection);

  if (section !== null && !SECTION_CODES.includes(section)) {
    return { ok: false, error: `Unknown report section "${reportSection}".` };
  }
  if (section !== null && !isValidSectionForClass(accountClass, section)) {
    return {
      ok: false,
      error:
        `Report section "${SECTION_LABELS[section] || section}" is not valid for account class ` +
        `${String(accountClass || "").toUpperCase()}. Allowed: ` +
        `${allowedSectionsForClass(accountClass).map((s) => s.label).join(", ") || "(none)"}.`,
    };
  }

  let order = null;
  if (displayOrder !== null && displayOrder !== undefined && displayOrder !== "") {
    order = Number(displayOrder);
    if (!Number.isInteger(order)) {
      return { ok: false, error: "Display order must be a whole number or blank." };
    }
  }

  return { ok: true, value: { reportSection: section, displayOrder: order } };
}

// The five canonical account classes report_section validation is keyed on.
const CANONICAL_ACCOUNT_CLASSES = Object.keys(ALLOWED_SECTIONS_BY_CLASS);

// Classification readiness over a list of active group-code rows. Pure -
// the caller supplies the rows (already company/tenant appropriate; group
// codes follow the shared-catalog architecture, so there is no per-company
// scoping to apply here, and no balances are ever read). `ready` is true
// only when every active group is classified AND no active group carries
// an invalid section for its class.
//
// `unrecognizedGroupClass` (added for the Reports canonical statement model)
// is an ADDITIVE diagnostic derived from the same input rows: any active
// group whose account_class is not one of the five canonical classes. It
// does NOT change the `ready` rule - such a group is already caught as
// unclassified (NULL section) or invalid (non-NULL section that can never
// be valid for a non-canonical class), so `ready` was already unreachable
// for it.
function getClassificationReadiness(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const unclassified = [];
  const invalid = [];
  const unrecognizedGroupClass = [];

  for (const row of list) {
    const section = normalizeSection(row.report_section ?? row.reportSection);
    const cls = row.account_class ?? row.accountClass;
    const clsNorm = String(cls ?? "").trim().toUpperCase();
    if (!CANONICAL_ACCOUNT_CLASSES.includes(clsNorm)) {
      unrecognizedGroupClass.push({
        groupCode: row.group_code ?? row.groupCode,
        accountClass: cls ?? null,
      });
    }
    if (section === null) {
      unclassified.push({ groupCode: row.group_code ?? row.groupCode, groupDescription: row.group_description ?? row.groupDescription });
    } else if (!isValidSectionForClass(cls, section)) {
      invalid.push({
        groupCode: row.group_code ?? row.groupCode,
        accountClass: cls,
        reportSection: section,
      });
    }
  }

  const total = list.length;
  const classified = total - unclassified.length;
  return {
    total,
    classified,
    unclassified: unclassified.length,
    unclassifiedGroupCodes: unclassified,
    invalid,
    unrecognizedGroupClass,
    ready: total > 0 && unclassified.length === 0 && invalid.length === 0,
  };
}

module.exports = {
  REPORT_SECTIONS,
  SECTION_CODES,
  SECTION_LABELS,
  ALLOWED_SECTIONS_BY_CLASS,
  normalizeSection,
  allowedSectionsForClass,
  isValidSectionForClass,
  validateGroupCodeClassification,
  getClassificationReadiness,
};
