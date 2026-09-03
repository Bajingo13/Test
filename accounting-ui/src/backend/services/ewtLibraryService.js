const pool = require("../db");

// Batch 8: EWT Library traceability. The library's `atc_code` is a plain
// string reference on every transaction/history table (no FK anywhere -
// confirmed against the DDL), so a physical DELETE silently strips the
// only record of a BIR rate/description that historical vouchers and the
// EWT modal still depend on. The library already has a `status` column
// (ACTIVE / INACTIVE) - deactivation is the safe, reversible replacement.

// Every table that stores an ATC code as history/config. Checked before a
// hard delete is ever allowed (it never is via the normal route now, but
// this backs the 409 EWT_CODE_IN_USE guard for any direct/legacy caller).
const EWT_REFERENCE_TABLES = [
  { table: "apv_headers", col: "atc_code" },
  { table: "cv_headers", col: "atc_code" },
  { table: "or_headers", col: "atc_code" },
  { table: "invoice_headers", col: "atc_code" },
  { table: "transaction_tax_entries", col: "atc_code" },
  { table: "general_libraries", col: "atc_code" },
];

// Returns { referenced: boolean, byTable: { <table>: count } } for the
// given atc_code. Case-insensitive comparison (the column collation is
// utf8mb4_0900_ai_ci, so a plain "=" already folds case).
async function getAtcReferences(atcCode, db = pool) {
  const byTable = {};
  let total = 0;
  for (const { table, col } of EWT_REFERENCE_TABLES) {
    // table/col are from the fixed whitelist above - never request input.
    const [[row]] = await db.query(
      `SELECT COUNT(*) AS n FROM \`${table}\` WHERE \`${col}\` = ?`,
      [atcCode]
    );
    const n = Number(row.n) || 0;
    if (n > 0) byTable[table] = n;
    total += n;
  }
  return { referenced: total > 0, total, byTable };
}

module.exports = { EWT_REFERENCE_TABLES, getAtcReferences };
