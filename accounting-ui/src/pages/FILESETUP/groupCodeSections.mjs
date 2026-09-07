// Reports Classification Foundation - the report-section options the File
// Setup > Group Codes screen offers, keyed by the group's Account Class.
// Machine-safe codes are stored; the label is what the user sees.
//
// This MUST stay in lock-step with the backend authority
// src/backend/services/groupCodeClassification.js (ALLOWED_SECTIONS_BY_CLASS
// + SECTION_LABELS) - a test asserts the two match.

export const SECTION_LABELS = {
  CURRENT_ASSET: "Current Assets",
  NON_CURRENT_ASSET: "Non-Current Assets",
  CURRENT_LIABILITY: "Current Liabilities",
  NON_CURRENT_LIABILITY: "Non-Current Liabilities",
  EQUITY: "Equity",
  REVENUE: "Revenue",
  OTHER_INCOME: "Other Income",
  DIRECT_COST: "Direct Costs",
  OPERATING_EXPENSE: "Operating Expenses",
  OTHER_EXPENSE: "Other Expenses",
  TAX_EXPENSE: "Tax Expense",
};

export const ALLOWED_SECTIONS_BY_CLASS = {
  ASSET: ["CURRENT_ASSET", "NON_CURRENT_ASSET"],
  LIABILITY: ["CURRENT_LIABILITY", "NON_CURRENT_LIABILITY"],
  EQUITY: ["EQUITY"],
  INCOME: ["REVENUE", "OTHER_INCOME"],
  EXPENSE: ["DIRECT_COST", "OPERATING_EXPENSE", "OTHER_EXPENSE", "TAX_EXPENSE"],
};

// [{ code, label }] for the given Account Class, for a <select>.
export function sectionsForClass(accountClass) {
  const codes = ALLOWED_SECTIONS_BY_CLASS[String(accountClass || "").trim().toUpperCase()] || [];
  return codes.map((code) => ({ code, label: SECTION_LABELS[code] }));
}

export function sectionLabel(code) {
  return SECTION_LABELS[code] || code || "";
}

// true if `section` (may be "" / null = Unclassified) is a legal choice
// for `accountClass`.
export function isSectionValidForClass(accountClass, section) {
  if (!section) return true;
  const codes = ALLOWED_SECTIONS_BY_CLASS[String(accountClass || "").trim().toUpperCase()] || [];
  return codes.includes(String(section).trim().toUpperCase());
}
