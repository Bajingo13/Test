const { HttpError } = require("../lib/httpError");

// Phase 7G: voucher/reference numbers are unique PER COMPANY, not globally.
// Different companies may legitimately use the same INV-0001 / CV-0001; the
// same company may not reuse one. The authoritative, concurrency-safe
// protection is the composite UNIQUE index each header table now carries
// (see phase7g_voucher_no_company_scope_migration.sql). This helper is the
// application-level pre-check that turns the common (non-race) case into a
// clean 409 instead of a raw ER_DUP_ENTRY.
//
// Manual numbering is preserved - voucher_no stays user-typed free text.
// This phase only changes SCOPE + duplicate protection, never introduces an
// auto-numbering scheme.

// Whitelisted module -> header table. `extraCol`/`extraVal` scope memo_headers
// (shared by Debit + Credit Memo) so DEBIT-0001 and CREDIT-0001 can coexist
// in one company while two DEBIT-0001 cannot.
const MODULE_TABLE = {
  INV: { table: "invoice_headers", label: "Invoice" },
  APV: { table: "apv_headers", label: "APV" },
  OR: { table: "or_headers", label: "OR" },
  CV: { table: "cv_headers", label: "CV" },
  JV: { table: "jv_headers", label: "JV" },
  PO: { table: "purchase_order_headers", label: "Purchase Order" },
  PCV: { table: "petty_cash_headers", label: "Petty Cash Voucher" },
  DM: { table: "memo_headers", label: "Debit Memo", extraCol: "memo_type", extraVal: "DEBIT" },
  CM: { table: "memo_headers", label: "Credit Memo", extraCol: "memo_type", extraVal: "CREDIT" },
};

// The ONE canonical transform, used by BOTH the duplicate pre-check and the
// header INSERT/UPDATE (see server.js) so the string the DB unique index
// compares is always the same one we checked. SQL NULL is preserved (CV/PO
// permit a null voucher_no); a non-null value is trimmed; "" stays "".
function normalizeVoucherNo(value) {
  if (value == null) return null;
  return String(value).trim();
}

// `conn` is the same transaction connection the insert/update will use.
// `excludeId` = the row being edited (skip self-conflict); null on create.
// A blank voucher number is not checked - it is not a meaningful number and
// this phase does not add a "voucher number required" rule.
async function assertVoucherNoUnique(conn, { module, companyId, voucherNo, excludeId = null }) {
  const cfg = MODULE_TABLE[module];
  if (!cfg) throw new Error(`assertVoucherNoUnique: unknown module "${module}"`);

  const vno = normalizeVoucherNo(voucherNo);
  if (!vno) return; // null or "" - not a meaningful number, nothing to check

  const where = ["company_id = ?", "voucher_no = ?"];
  const params = [companyId, vno];
  if (cfg.extraCol) {
    where.push(`${cfg.extraCol} = ?`);
    params.push(cfg.extraVal);
  }
  if (excludeId != null && !Number.isNaN(Number(excludeId))) {
    where.push("id <> ?");
    params.push(Number(excludeId));
  }

  // cfg.table / cfg.extraCol come from the fixed whitelist above, never from
  // request input.
  const [rows] = await conn.query(
    `SELECT id FROM ${cfg.table} WHERE ${where.join(" AND ")} LIMIT 1`,
    params
  );
  if (rows.length) {
    throw new HttpError(
      409,
      `Voucher number ${vno} already exists for this company.`,
      "DUPLICATE_VOUCHER_NO"
    );
  }
}

// Uniform response for the race-condition backstop: a DB ER_DUP_ENTRY on a
// voucher-number composite index reaching the route's catch block. Returns
// true if it handled the error (a 409 was sent), false otherwise.
function handleVoucherDupError(err, res) {
  if (err && err.code === "ER_DUP_ENTRY") {
    res.status(409).json({
      message: "Voucher number already exists for this company.",
      code: "DUPLICATE_VOUCHER_NO",
    });
    return true;
  }
  return false;
}

module.exports = { assertVoucherNoUnique, handleVoucherDupError, normalizeVoucherNo, MODULE_TABLE };
