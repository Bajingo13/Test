// Multi-Branch Phase C-2B - the transaction screens' branch rules (pure).
//
// Branches come from GET /api/branch-scope/branches (the server's list of the
// branches THIS user may use); the server re-validates the branch, every
// account, every party and every payment application on save, so nothing here
// is a permission - it only decides what the form offers and when.
//
//   no branches at all          -> no Branch field (legacy company-level entry)
//   exactly one active branch   -> selected automatically, shown, locked
//   several active branches     -> the user must choose (no silent default)

export const isActiveBranch = (b) => String(b?.status || "ACTIVE").toUpperCase() === "ACTIVE";

export function activeBranches(branches = []) {
  return (Array.isArray(branches) ? branches : []).filter(isActiveBranch);
}

// The branch a NEW transaction starts with ("" = the user must choose).
export function defaultTransactionBranch(branches = []) {
  const active = activeBranches(branches);
  return active.length === 1 ? String(active[0].id) : "";
}

export function branchFieldMode(branches = []) {
  const active = activeBranches(branches);
  if (!active.length) return "none";
  return active.length === 1 ? "auto" : "choose";
}

// Shared records (branchId null) are usable everywhere; a branch-only record
// only in its own branch. With no branch chosen yet only shared ones show.
export function visibleInBranch(record, branchId) {
  const own = record?.branchId;
  if (own === null || own === undefined || own === "") return true;
  return branchId !== "" && branchId !== null && branchId !== undefined && Number(own) === Number(branchId);
}

export function branchName(branchId, branches = []) {
  if (branchId === null || branchId === undefined || branchId === "") return "";
  const b = (branches || []).find((x) => Number(x.id) === Number(branchId));
  return b ? b.name || b.code || `Branch ${branchId}` : `Branch ${branchId}`;
}

// "— Shared" / "— Branch A" suffix for account / party pickers, only where the
// company actually has branches (a branch-less company sees no change).
export function ownershipSuffix(record, branches = []) {
  if (!(branches || []).length) return "";
  const own = record?.branchId;
  return own === null || own === undefined || own === "" ? " — Shared" : ` — ${branchName(own, branches)}`;
}

// The amount field that opens the payment-application selector:
//   CV: an Accounts Payable line's DEBIT   -> unpaid APVs
//   OR: an Accounts Receivable line's CREDIT -> unpaid Invoices
export function applicationTrigger({ code, side, isControlLine }) {
  if (!isControlLine) return null;
  if (code === "CV" && side === "debit") return "APV";
  if (code === "OR" && side === "credit") return "INV";
  return null;
}

// In-modal check before applying: every selected document gets an amount
// above zero and no more than its outstanding balance. Returns a message, or
// "" when valid. (The server re-checks every amount under row locks.)
export function applicationAmountError(applications = [], money = (n) => Number(n).toFixed(2)) {
  for (const app of applications) {
    const amount = Number(app.amount);
    const balance = Number(app.balanceAmount);
    const label = app.voucherNo || `#${app.sourceId}`;
    if (!(amount > 0)) return `Enter an amount to apply for ${label}.`;
    if (Number.isFinite(balance) && amount > balance + 0.005) {
      return `${label}: the amount to apply (${money(amount)}) exceeds its outstanding balance (${money(balance)}).`;
    }
  }
  return "";
}
