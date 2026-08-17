// Checkpoint 4I: reusable pre/post-migration verification. Run before
// applying checkpoint4i_company_phase_e_migration.sql (and again after,
// including on Railway before it's trusted) to confirm every company-owned
// table has zero NULL and zero invalid company_id rows. Never assume -
// this is the actual verification, not a stand-in for it.
//
// Usage: node src/backend/scripts/verifyCompanyIsolation.js

const pool = require("../db");

const TABLES = [
  "invoice_headers",
  "apv_headers",
  "or_headers",
  "cv_headers",
  "jv_headers",
  "purchase_order_headers",
  "arap_beginning_balance_headers",
  "gl_beginning_balance_headers",
  "general_libraries",
];

async function main() {
  let anyProblem = false;
  const rows = [];

  for (const table of TABLES) {
    const [[total]] = await pool.query(`SELECT COUNT(*) c FROM ${table}`);
    const [[nulls]] = await pool.query(`SELECT COUNT(*) c FROM ${table} WHERE company_id IS NULL`);
    const [[invalid]] = await pool.query(
      `SELECT COUNT(*) c FROM ${table} t LEFT JOIN companies c2 ON c2.id = t.company_id WHERE t.company_id IS NOT NULL AND c2.id IS NULL`
    );
    const [[distinct]] = await pool.query(`SELECT COUNT(DISTINCT company_id) c FROM ${table}`);

    if (nulls.c > 0 || invalid.c > 0) anyProblem = true;
    rows.push({
      table,
      totalRows: total.c,
      nullCompanyId: nulls.c,
      invalidCompanyId: invalid.c,
      distinctCompanies: distinct.c,
    });
  }

  console.table(rows);

  if (anyProblem) {
    console.error("\nFAIL: at least one table has NULL or invalid company_id rows. Do not apply the NOT NULL/FK migration until this is resolved.");
    process.exitCode = 1;
  } else {
    console.log("\nPASS: every table has zero NULL and zero invalid company_id rows. Safe to apply checkpoint4i_company_phase_e_migration.sql.");
  }

  await pool.end();
}

main().catch((err) => {
  console.error("VERIFICATION SCRIPT ERROR:", err);
  process.exit(1);
});