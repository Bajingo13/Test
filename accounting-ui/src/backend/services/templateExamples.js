// Example rows for the Chart of Accounts and General Libraries import
// templates - ONE definition used by the template generators and the imports.
//
// Templates no longer put the example on the import sheet (the only sheet the
// importer reads): it sits on a separate "Example" sheet, so the import sheet
// is empty and ready for real data.
//
// Backward compatibility: templates downloaded before this change carried the
// example as row 2 of the import sheet. An uploaded row that matches that
// example on EVERY identifying field below (case-insensitive, trimmed) is
// skipped with an explanation instead of becoming a real account / party. A
// genuine record that merely shares the example's code is unaffected (any
// difference in title, class, description, validations / type, name,
// address makes it a normal row).

const COA_EXAMPLE = {
  code: "1010",
  date: "2026-01-01",
  title: "Cash on Hand",
  accountClass: "ASSET",
  description: "Petty cash fund",
  validations: "BANK / CASH",
  groups: "",
  owningBranch: "",
};
const COA_EXAMPLE_FIELDS = ["code", "title", "accountClass", "description", "validations"];

const GENLIB_EXAMPLE = {
  code: "CUST-001",
  type: "CUSTOMER",
  name: "Sample Customer Inc.",
  status: "ACTIVE",
  startDate: "2026-01-01",
  address1: "123 Sample St.",
  category: "REGULAR",
  isProspective: "NO",
  isClient: "YES",
  owningBranch: "",
};
const GENLIB_EXAMPLE_FIELDS = ["code", "type", "name", "address1"];

const EXAMPLE_ROW_REASON =
  "This is the example row from the template, so it was not imported. Delete it from the file (or change it if you really need this record).";

const norm = (v) => String(v ?? "").trim().replace(/\s+/g, " ").toLowerCase();

// get(field) -> the uploaded cell for that field.
function isExampleRow(get, example, fields) {
  return fields.every((f) => norm(get(f)) === norm(example[f]));
}

module.exports = {
  COA_EXAMPLE,
  COA_EXAMPLE_FIELDS,
  GENLIB_EXAMPLE,
  GENLIB_EXAMPLE_FIELDS,
  EXAMPLE_ROW_REASON,
  isExampleRow,
};
