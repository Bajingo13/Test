const pool = require("../db");

// Phase 7L: the set of Chart-of-Accounts ids that are validation-tagged
// INPUT VAT / OUTPUT VAT (coa_validations.validation_name). Used so every
// backend EWT-base / foreign-tax calculation identifies the VAT line by
// VALIDATED ACCOUNT IDENTITY, never by matching the account title text - a
// control account titled "Taxes Recoverable" but tagged INPUT VAT must
// behave exactly like one titled "Input VAT" (Phase 7L Part D section 15).
//
// COA is global in this schema (GET /api/coa applies no company_id
// filter), so this needs no company scope. Accepts an optional open
// connection so it can run inside an in-flight transaction.
async function loadVatControlAccountIds(conn) {
  const db = conn || pool;
  const [rows] = await db.execute(
    "SELECT coa_id AS id FROM coa_validations WHERE validation_name IN ('INPUT VAT', 'OUTPUT VAT')"
  );
  return new Set(rows.map((r) => String(r.id)));
}

module.exports = { loadVatControlAccountIds };
