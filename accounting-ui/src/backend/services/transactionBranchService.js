// Multi-Branch Foundation, Phase B - backend checks for branch-aware
// transaction entry, ready for the (collaborator-owned) entry screens to call.
// Nothing here is wired into the existing save / post routes yet; it is the
// validated building block those routes and screens will use:
//
//   resolveTransactionBranch      the branch a new transaction may be saved in
//   assertAccountsUsableInBranch  shared accounts, or the branch's own accounts
//   assertPartyUsableInBranch     company party, shared or the branch's own
//   validateApplications          read-only CV->APV / OR->Invoice pre-check
//   checkReversal                 read-only APV / CV reversal pre-check
//
// A branch id from the browser is never trusted on its own: every check goes
// through lib/branchResolution (company access, branch ownership, user scope).
const pool = require("../db");
const { HttpError } = require("../lib/httpError");
const BranchResolution = require("../lib/branchResolution");
const ControlAmountService = require("./controlAmountService");
const { findPostedReversalJv } = require("./reversalService");

async function resolveTransactionBranch(user, companyId, requestedBranchId, db = pool) {
  const branchId = await BranchResolution.resolveBranch(user, companyId, requestedBranchId, { required: true, db });
  const [[b]] = await db.execute("SELECT status FROM branches WHERE id = ?", [branchId]);
  if (String(b.status || "").toUpperCase() !== "ACTIVE") {
    throw new HttpError(409, "This branch is inactive; new transactions cannot be recorded in it.", "BRANCH_INACTIVE");
  }
  return branchId;
}

async function assertAccountsUsableInBranch(accountIds, branchId, db = pool) {
  const ids = [...new Set((accountIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return;
  const [rows] = await db.query("SELECT id, code, branch_id FROM chart_of_accounts WHERE id IN (?)", [ids]);
  const found = new Map(rows.map((r) => [Number(r.id), r]));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw new HttpError(400, `Account not found: ${missing.join(", ")}.`, "ACCOUNT_NOT_FOUND");
  const foreign = rows.filter((r) => r.branch_id !== null && Number(r.branch_id) !== Number(branchId));
  if (foreign.length) {
    throw new HttpError(400, `Account ${foreign.map((r) => r.code).join(", ")} belongs to another branch.`, "ACCOUNT_BRANCH_MISMATCH");
  }
}

async function assertPartyUsableInBranch({ companyId, partyId, branchId }, db = pool) {
  if (partyId === undefined || partyId === null || partyId === "") return;
  const [rows] = await db.execute("SELECT company_id, branch_id FROM general_libraries WHERE id = ?", [partyId]);
  if (!rows.length || Number(rows[0].company_id) !== Number(companyId)) {
    throw new HttpError(404, "Party not found.", "PARTY_NOT_FOUND");
  }
  if (rows[0].branch_id !== null && Number(rows[0].branch_id) !== Number(branchId)) {
    throw new HttpError(400, "This party belongs to another branch.", "PARTY_BRANCH_MISMATCH");
  }
}

// ---- Payment application pre-check (read-only) -----------------------------
const SOURCES = {
  CV: { APV: "doc", AP_BEGINNING: "bb" },
  OR: { INV: "doc", AR_BEGINNING: "bb" },
};

async function loadSource(db, sourceType, sourceId) {
  if (sourceType === "APV" || sourceType === "INV") {
    const t = sourceType === "APV" ? "apv_headers" : "invoice_headers";
    const party = sourceType === "APV" ? "supplier_id" : "customer_id";
    const orig = ControlAmountService.baseOriginalExpr(sourceType, t, "ca");
    const [rows] = await db.execute(
      `SELECT ${t}.id, ${t}.voucher_no AS voucherNo, ${t}.company_id AS companyId, ${t}.branch_id AS branchId,
              ${t}.${party} AS partyId, ${t}.status, COALESCE(${t}.payment_status, 'Unpaid') AS paymentStatus,
              ${orig} AS totalAmount, COALESCE(${t}.paid_amount, 0) AS paidAmount,
              GREATEST(${orig} - COALESCE(${t}.paid_amount, 0), 0) AS balanceAmount
         FROM ${t} LEFT JOIN ${ControlAmountService.aggregateSql(sourceType)} ca ON ca.doc_id = ${t}.id
        WHERE ${t}.id = ?`,
      [sourceId]
    );
    return rows[0] || null;
  }
  const side = sourceType === "AP_BEGINNING" ? "credit" : "debit";
  const [rows] = await db.execute(
    `SELECT l.id, l.reference_no AS voucherNo, h.company_id AS companyId, h.branch_id AS branchId,
            l.party_id AS partyId, h.status, COALESCE(l.status, 'Unpaid') AS paymentStatus,
            l.${side} AS totalAmount, COALESCE(l.paid_amount, 0) AS paidAmount,
            COALESCE(l.balance_amount, l.${side}, 0) AS balanceAmount, h.balance_type AS balanceType
       FROM arap_beginning_balance_lines l JOIN arap_beginning_balance_headers h ON h.id = l.header_id
      WHERE l.id = ?`,
    [sourceId]
  );
  const row = rows[0] || null;
  if (row && row.balanceType !== (sourceType === "AP_BEGINNING" ? "AP" : "AR")) return null;
  return row;
}

// applications: [{ sourceType, sourceId, amount }]. Never writes. Returns
// { valid, totalApplied, items: [{ ..., ok, code, message }] }.
async function validateApplications(user, { companyId, branchId, paymentType, partyId, applications }, db = pool) {
  const type = String(paymentType || "").toUpperCase();
  if (!SOURCES[type]) throw new HttpError(400, "paymentType must be CV or OR.", "PAYMENT_TYPE_INVALID");
  const resolvedBranch = await BranchResolution.resolveBranch(user, companyId, branchId, { required: true, db });
  if (!Array.isArray(applications) || !applications.length) throw new HttpError(400, "At least one application is required.", "APPLICATIONS_REQUIRED");

  const requested = new Map();
  const items = [];
  for (const a of applications) {
    const sourceType = String(a?.sourceType || (type === "CV" ? "APV" : "INV")).toUpperCase();
    const sourceId = Number(a?.sourceId);
    const amount = Math.round(Number(a?.amount) * 100) / 100;
    const item = { sourceType, sourceId, amount, ok: false };
    items.push(item);
    const fail = (code, message) => Object.assign(item, { code, message });
    if (!SOURCES[type][sourceType]) { fail("SOURCE_TYPE_INVALID", `${type} cannot settle ${sourceType}.`); continue; }
    if (!Number.isInteger(sourceId) || sourceId <= 0) { fail("SOURCE_NOT_FOUND", "Document not found."); continue; }
    if (!(amount > 0)) { fail("AMOUNT_INVALID", "The applied amount must be greater than zero."); continue; }
    const src = await loadSource(db, sourceType, sourceId);
    if (!src || Number(src.companyId) !== Number(companyId)) { fail("SOURCE_NOT_FOUND", "Document not found."); continue; }
    Object.assign(item, { voucherNo: src.voucherNo, balanceAmount: Number(src.balanceAmount), totalAmount: Number(src.totalAmount), paidAmount: Number(src.paidAmount) });
    if (src.branchId === null) { fail("BRANCH_UNRESOLVED", "This document has no branch yet; resolve its historical branch first."); continue; }
    if (Number(src.branchId) !== Number(resolvedBranch)) { fail("BRANCH_MISMATCH", "This document belongs to another branch."); continue; }
    if (partyId && Number(src.partyId) !== Number(partyId)) { fail("PARTY_MISMATCH", "This document belongs to another party."); continue; }
    if (String(src.status || "").toUpperCase() !== "POSTED") { fail("NOT_POSTED", `This document is ${src.status || "not posted"} and cannot be paid.`); continue; }
    if (sourceType === "APV" && (await findPostedReversalJv(db, { companyId, module: "APV", originalId: sourceId }))) {
      fail("REVERSED", "This APV has been reversed and cannot be paid."); continue;
    }
    if (Number(src.balanceAmount) <= 0.005 || String(src.paymentStatus).toUpperCase() === "PAID") { fail("FULLY_PAID", "This document is already fully paid."); continue; }
    const key = `${sourceType}:${sourceId}`;
    const total = Math.round(((requested.get(key) || 0) + amount) * 100) / 100;
    requested.set(key, total);
    if (total > Number(src.balanceAmount) + 0.005) {
      fail("OVER_APPLICATION", `The applied amount exceeds the outstanding balance of ${Number(src.balanceAmount).toFixed(2)}.`); continue;
    }
    item.ok = true;
  }
  const totalApplied = Math.round(items.filter((i) => i.ok).reduce((s, i) => s + i.amount, 0) * 100) / 100;
  return { valid: items.every((i) => i.ok), branchId: resolvedBranch, totalApplied, items };
}

// ---- Reversal pre-check (read-only; the reverse routes enforce the same) ---
const REVERSIBLE = { APV: "apv_headers", CV: "cv_headers" };

async function checkReversal(user, { companyId, module, originalId }, db = pool) {
  const m = String(module || "").toUpperCase();
  const table = REVERSIBLE[m];
  if (!table) throw new HttpError(400, "Only APV and CV can be reversed.", "REVERSAL_MODULE_INVALID");
  const [rows] = await db.execute(`SELECT id, company_id, branch_id, status, voucher_no FROM ${table} WHERE id = ?`, [originalId]);
  if (!rows.length || Number(rows[0].company_id) !== Number(companyId)) throw new HttpError(404, `${m} not found.`, "DOCUMENT_NOT_FOUND");
  const doc = rows[0];
  await BranchResolution.assertRecordBranchAccess(user, companyId, doc.branch_id, db);
  if (String(doc.status || "").toUpperCase() !== "POSTED") {
    return { allowed: false, code: "TRANSACTION_NOT_POSTED", branchId: doc.branch_id };
  }
  const existing = await findPostedReversalJv(db, { companyId, module: m, originalId: Number(originalId) });
  if (existing) return { allowed: false, code: "TRANSACTION_ALREADY_REVERSED", branchId: doc.branch_id, reversalVoucher: existing.voucherNo };
  return { allowed: true, branchId: doc.branch_id, voucherNo: doc.voucher_no };
}

module.exports = {
  resolveTransactionBranch,
  assertAccountsUsableInBranch,
  assertPartyUsableInBranch,
  validateApplications,
  checkReversal,
};
