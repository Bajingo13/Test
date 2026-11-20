// Multi-Branch Foundation - payment application must stay inside one branch.
//
//   CV (Branch A)  -> APV / AP beginning balance (Branch A)      OK
//   OR (Branch A)  -> Invoice / AR beginning balance (Branch A)  OK
//   Branch A -> Branch B                                          400 BRANCH_MISMATCH
//   one side branch-tagged, the other unresolved (NULL)           400 BRANCH_UNRESOLVED
//   both NULL (legacy company-level rows)                         unchanged (allowed)
//
// Inter-branch settlement is NOT supported; it needs its own accounting design.
// Called from PaymentApplicationService.applyApvPayment / applyInvoicePayment
// inside their transaction (`conn`), before any balance is touched, so a
// rejected application writes nothing. Company isolation stays where it is
// (the existing cross-company checks in those functions).
//
// Both reads are LOCKING (FOR UPDATE), never plain SELECTs: in InnoDB the first
// non-locking read of a transaction fixes its snapshot, so a plain read here
// (before the caller's own SELECT ... FOR UPDATE of the source balance) would
// let a concurrent second payment read a stale balance and over-apply. Locking
// reads take no snapshot and lock in the same order the save path already uses
// (payment document, then source document), so serialization is unchanged.
const { HttpError } = require("../lib/httpError");

const PAYMENT_HEADER = { CV: "cv_headers", OR: "or_headers" };

async function branchOfPayment(conn, appliedType, appliedId) {
  const table = PAYMENT_HEADER[String(appliedType || "").toUpperCase()];
  if (!table || !appliedId) return undefined; // not a branch-aware payment document
  const [rows] = await conn.execute(`SELECT branch_id FROM ${table} WHERE id = ? FOR UPDATE`, [appliedId]);
  return rows.length ? rows[0].branch_id : undefined;
}

async function branchOfSource(conn, sourceType, sourceId) {
  let sql;
  if (sourceType === "APV") sql = "SELECT branch_id FROM apv_headers WHERE id = ? FOR UPDATE";
  else if (sourceType === "INV") sql = "SELECT branch_id FROM invoice_headers WHERE id = ? FOR UPDATE";
  else if (sourceType === "AP_BEGINNING" || sourceType === "AR_BEGINNING") {
    sql = "SELECT h.branch_id FROM arap_beginning_balance_lines l JOIN arap_beginning_balance_headers h ON h.id = l.header_id WHERE l.id = ? FOR UPDATE";
  } else return undefined;
  const [rows] = await conn.execute(sql, [sourceId]);
  return rows.length ? rows[0].branch_id : undefined;
}

async function assertSameBranchApplication(conn, { appliedType, appliedId, sourceType, sourceId }) {
  const paymentBranch = await branchOfPayment(conn, appliedType, appliedId);
  const sourceBranch = await branchOfSource(conn, sourceType, sourceId);
  if (paymentBranch === undefined || sourceBranch === undefined) return; // missing rows: existing checks report them
  if (paymentBranch === null && sourceBranch === null) return;
  if (paymentBranch === null || sourceBranch === null) {
    throw new HttpError(400, "This payment and the document it settles do not both have a branch. Resolve the historical branch before applying.", "BRANCH_UNRESOLVED");
  }
  if (Number(paymentBranch) !== Number(sourceBranch)) {
    throw new HttpError(400, "A payment can only be applied to a document of the same branch (inter-branch settlement is not supported).", "BRANCH_MISMATCH");
  }
}

module.exports = { assertSameBranchApplication };
