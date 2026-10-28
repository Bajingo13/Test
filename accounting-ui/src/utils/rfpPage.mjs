// Request for Payment (RFP) page helpers - pure functions (no React, no
// fetch), unit-tested in utils/__tests__/rfpPage.test.js. The server is the
// security and validation boundary for every RFP request; these helpers
// only mirror its rules so the form can explain problems before saving and
// so the page never offers an action the server is certain to refuse.
// Company selection reuses utils/trialBalanceCompany.mjs (pickInitialCompany
// / isCompanyLocked / createRequestGuard).

export const RFP_MODULE = "TRANSACTIONS.RFP";

export const RFP_STATUSES = ["DRAFT", "SUBMITTED", "APPROVED", "RETURNED", "REJECTED", "CANCELLED", "CONVERTED"];

export const STATUS_META = {
  DRAFT: { label: "Draft", tone: "neutral" },
  SUBMITTED: { label: "Submitted", tone: "info" },
  APPROVED: { label: "Approved", tone: "success" },
  RETURNED: { label: "Returned", tone: "warning" },
  REJECTED: { label: "Rejected", tone: "danger" },
  CANCELLED: { label: "Cancelled", tone: "muted" },
  CONVERTED: { label: "Converted", tone: "accent" },
};

export const VAT_TREATMENTS = [
  { value: "STANDARD", label: "Standard" },
  { value: "ZERO_RATED", label: "Zero-rated" },
  { value: "EXEMPT", label: "Exempt" },
];

// Column limits enforced by the server (rfpService.validatePayload).
export const LIMITS = {
  purpose: 5000,
  remarks: 5000,
  supportingReference: 100,
  lineDescription: 255,
  lineReference: 100,
  note: 500,
  lines: 500,
};

// Statuses whose current record IS a decision. After a resubmission the
// stored decision fields still describe the previous (historical) decision,
// so they are shown only while the decision is the current state.
export const DECISION_STATUSES = ["APPROVED", "RETURNED", "REJECTED"];

export function showDecision(rfp) {
  return Boolean(rfp?.decidedAt) && DECISION_STATUSES.includes(rfp.status);
}

// A SUBMIT out of RETURNED is a resubmission.
export function historyActionLabel(entry) {
  if (entry?.action === "SUBMIT" && entry.previousStatus === "RETURNED") return "Resubmitted";
  return ACTION_LABELS[entry?.action] || entry?.action || "";
}

export const ACTION_LABELS = {
  SUBMIT: "Submitted",
  APPROVE: "Approved",
  RETURN: "Returned",
  REJECT: "Rejected",
  CANCEL: "Cancelled",
};

// --- money (whole cents, never floating point) -----------------------------

const AMOUNT_PATTERN = /^(\d+)(?:\.(\d{1,2}))?$/;

// "1,234.5" style input is not accepted - the server takes plain digits.
export function parseAmountToCents(value) {
  const s = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  const m = s.match(AMOUNT_PATTERN);
  if (!m || m[1].replace(/^0+(?=\d)/, "").length > 13) return null;
  return BigInt(m[1]) * 100n + BigInt((m[2] || "").padEnd(2, "0"));
}

export function centsToAmount(cents) {
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

// Display only: "1250.5" / "1250.50" -> "1,250.50". Non-numeric -> "".
export function formatAmount(value) {
  const cents = parseAmountToCents(value === null || value === undefined ? "" : String(value));
  if (cents === null) return "";
  const [whole, frac] = centsToAmount(cents).split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
}

// Live total of the editor lines; invalid amounts are skipped and reported.
export function sumLines(lines = []) {
  let cents = 0n;
  let invalid = 0;
  for (const line of lines) {
    const c = parseAmountToCents(line?.grossAmount ?? "");
    if (c === null) invalid += 1;
    else cents += c;
  }
  return { cents, amount: centsToAmount(cents), invalid };
}

// --- dates -----------------------------------------------------------------

export function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// --- form ------------------------------------------------------------------

let lineSeq = 0;
export function emptyLine() {
  lineSeq += 1;
  return { key: `l${lineSeq}`, description: "", accountId: "", grossAmount: "", vatTreatment: "", reference: "" };
}

// The RFP date is deliberately blank: it is never defaulted to today.
export function emptyForm() {
  return {
    branchId: "",
    rfpDate: "",
    supplierId: "",
    purpose: "",
    requestedPaymentDate: "",
    currencyId: "",
    remarks: "",
    supportingReference: "",
    lines: [emptyLine()],
  };
}

const str = (v) => (v === null || v === undefined ? "" : String(v));

export function formFromRfp(rfp) {
  return {
    branchId: str(rfp.branchId),
    rfpDate: str(rfp.rfpDate),
    supplierId: str(rfp.supplierId),
    purpose: str(rfp.purpose),
    requestedPaymentDate: str(rfp.requestedPaymentDate),
    currencyId: str(rfp.currencyId),
    remarks: str(rfp.remarks),
    supportingReference: str(rfp.supportingReference),
    lines: (rfp.lines || []).map((l) => ({
      ...emptyLine(),
      description: str(l.description),
      accountId: str(l.accountId),
      grossAmount: str(l.grossAmount),
      vatTreatment: str(l.vatTreatment),
      reference: str(l.reference),
    })),
  };
}

// Mirrors the server's create/edit validation. Returns { valid, errors }
// where errors.lines[i] holds that line's field messages.
export function validateForm(form) {
  const errors = { lines: [] };
  if (!str(form.rfpDate).trim()) errors.rfpDate = "RFP date is required.";
  else if (!isValidDate(form.rfpDate)) errors.rfpDate = "Enter a valid date.";
  if (!str(form.requestedPaymentDate).trim()) errors.requestedPaymentDate = "Requested payment date is required.";
  else if (!isValidDate(form.requestedPaymentDate)) errors.requestedPaymentDate = "Enter a valid date.";
  if (!str(form.supplierId)) errors.supplierId = "Select a supplier.";
  if (!str(form.currencyId)) errors.currencyId = "Select a currency.";
  const purpose = str(form.purpose).trim();
  if (!purpose) errors.purpose = "Purpose is required.";
  else if (purpose.length > LIMITS.purpose) errors.purpose = `At most ${LIMITS.purpose} characters.`;
  if (str(form.remarks).trim().length > LIMITS.remarks) errors.remarks = `At most ${LIMITS.remarks} characters.`;
  if (str(form.supportingReference).trim().length > LIMITS.supportingReference) {
    errors.supportingReference = `At most ${LIMITS.supportingReference} characters.`;
  }

  const lines = Array.isArray(form.lines) ? form.lines : [];
  if (lines.length === 0) errors.linesGeneral = "Add at least one line.";
  else if (lines.length > LIMITS.lines) errors.linesGeneral = `An RFP can have at most ${LIMITS.lines} lines.`;
  lines.forEach((line, i) => {
    const e = {};
    const description = str(line.description).trim();
    if (!description) e.description = "Description is required.";
    else if (description.length > LIMITS.lineDescription) e.description = `At most ${LIMITS.lineDescription} characters.`;
    if (!str(line.grossAmount).trim()) e.grossAmount = "Amount is required.";
    else if (parseAmountToCents(line.grossAmount) === null) e.grossAmount = "Enter a non-negative amount with at most 2 decimals.";
    if (line.vatTreatment && !VAT_TREATMENTS.some((v) => v.value === line.vatTreatment)) e.vatTreatment = "Choose a VAT treatment.";
    if (str(line.reference).trim().length > LIMITS.lineReference) e.reference = `At most ${LIMITS.lineReference} characters.`;
    errors.lines[i] = e;
  });

  const lineErrors = errors.lines.some((e) => Object.keys(e).length > 0);
  const fieldErrors = Object.keys(errors).some((k) => k !== "lines");
  return { valid: !lineErrors && !fieldErrors, errors };
}

const optional = (v) => (str(v).trim() ? str(v).trim() : null);
const optionalNumber = (v) => (str(v).trim() ? Number(v) : null);

// Exactly the fields the R2 API accepts. companyId only on create - an
// RFP's company is fixed and never sent on edit. Requester, status, number,
// supplier snapshots, workflow and conversion fields are never sent.
export function buildPayload(form, { companyId, isCreate }) {
  const lines = form.lines.map((l) => ({
    description: str(l.description).trim(),
    grossAmount: centsToAmount(parseAmountToCents(l.grossAmount) ?? 0n),
    accountId: optionalNumber(l.accountId),
    vatTreatment: optional(l.vatTreatment),
    reference: optional(l.reference),
  }));
  const payload = {
    ...(isCreate ? { companyId: Number(companyId) } : {}),
    branchId: optionalNumber(form.branchId),
    rfpDate: form.rfpDate,
    supplierId: Number(form.supplierId),
    purpose: str(form.purpose).trim(),
    requestedPaymentDate: form.requestedPaymentDate,
    currencyId: Number(form.currencyId),
    remarks: optional(form.remarks),
    supportingReference: optional(form.supportingReference),
    lines,
    totalAmount: sumLines(lines).amount,
  };
  return payload;
}

// --- list ------------------------------------------------------------------

function validCompanyId(companyId) {
  return /^\d+$/.test(str(companyId).trim()) && Number(companyId) > 0;
}

// GET /api/rfp query; null = don't request (no company selected).
export function listQuery({ companyId, status }) {
  if (!validCompanyId(companyId)) return null;
  const params = new URLSearchParams({ companyId: str(companyId).trim() });
  if (status) params.set("status", status);
  return params.toString();
}

export function lookupsQuery(companyId) {
  return validCompanyId(companyId) ? new URLSearchParams({ companyId: str(companyId).trim() }).toString() : null;
}

// Search / date range narrow the company-scoped list the server returned
// (the list API filters by company and status only). They never widen it.
export function refineList(rows = [], { search = "", from = "", to = "" } = {}) {
  const q = search.trim().toLowerCase();
  return rows.filter((r) => {
    if (from && (!r.rfpDate || r.rfpDate < from)) return false;
    if (to && (!r.rfpDate || r.rfpDate > to)) return false;
    if (!q) return true;
    return [r.rfpNo, r.supplierName, r.purpose, r.requesterUsername, r.branchName]
      .some((v) => str(v).toLowerCase().includes(q));
  });
}

export function hasActiveFilters({ status = "", search = "", from = "", to = "" } = {}) {
  return Boolean(status || search.trim() || from || to);
}

// --- actions ---------------------------------------------------------------

// What the page may offer for this RFP and user. Mirrors R2/R3/R4.1: DRAFT
// and RETURNED are editable, only DRAFT is deletable; SUBMIT (DRAFT),
// RESUBMIT (RETURNED) and CANCEL are requester-side (SUBMIT permission); APPROVE/RETURN/REJECT need APPROVE and are never offered to
// the RFP's requester or submitter - Super Admin included. The server
// re-checks everything.
export function availableActions({ rfp, can, userId }) {
  const none = { edit: false, remove: false, submit: false, resubmit: false, cancel: false, approve: false, return: false, reject: false, selfDecisionBlocked: false };
  if (!rfp) return none;
  const status = rfp.status;
  const self = userId != null && (rfp.requesterUserId === userId || rfp.submittedBy === userId);
  const mayDecide = can("APPROVE") && status === "SUBMITTED";
  return {
    edit: (status === "DRAFT" || status === "RETURNED") && can("EDIT"),
    remove: status === "DRAFT" && can("DELETE"),
    submit: status === "DRAFT" && can("SUBMIT"),
    resubmit: status === "RETURNED" && can("SUBMIT"),
    cancel: (status === "DRAFT" || status === "SUBMITTED") && can("SUBMIT"),
    approve: mayDecide && !self,
    return: mayDecide && !self,
    reject: mayDecide && !self,
    selfDecisionBlocked: mayDecide && self,
  };
}

export const WORKFLOW_DIALOGS = {
  submit: {
    action: "SUBMIT",
    title: "Submit Request for Payment",
    message: "This Request for Payment will move from DRAFT to SUBMITTED for approval. It can no longer be edited after submission.",
    note: "optional",
    confirm: "Submit",
    tone: "primary",
  },
  // Same SUBMIT endpoint; the server reads the RETURNED status itself.
  resubmit: {
    action: "SUBMIT",
    route: "submit",
    title: "Resubmit Request for Payment",
    message: "This Request for Payment will move from RETURNED back to SUBMITTED for approval. Save the corrections the approver asked for before resubmitting.",
    note: "optional",
    confirm: "Resubmit",
    tone: "primary",
  },
  approve: {
    action: "APPROVE",
    title: "Approve Request for Payment",
    message: "This Request for Payment will move to APPROVED. Approval does not create an AP voucher or a payment.",
    note: "optional",
    confirm: "Approve",
    tone: "primary",
  },
  return: {
    action: "RETURN",
    title: "Return Request for Payment",
    message: "This Request for Payment will move to RETURNED. Explain what the requester needs to address.",
    note: "required",
    confirm: "Return",
    tone: "warning",
  },
  reject: {
    action: "REJECT",
    title: "Reject Request for Payment",
    message: "This Request for Payment will move to REJECTED. This cannot be undone.",
    note: "required",
    confirm: "Reject",
    tone: "danger",
  },
  cancel: {
    action: "CANCEL",
    title: "Cancel Request for Payment",
    message: "Canceling this RFP will permanently move it to CANCELLED.",
    note: "optional",
    confirm: "Cancel RFP",
    tone: "danger",
  },
};

// Note for a workflow dialog: trimmed, null when blank. `ok` is false when a
// required note is blank or any note is over the limit.
export function normalizeNote(value, mode) {
  const note = str(value).trim();
  if (note.length > LIMITS.note) return { ok: false, note: null };
  if (mode === "required" && !note) return { ok: false, note: null };
  return { ok: true, note: note || null };
}

// --- errors ----------------------------------------------------------------

// Shapes of internal errors (SQL text, MySQL codes, stack frames) - never
// the plain words "select"/"update", which real user messages contain.
const LEAKY_SQL = /\bSELECT\b[\s\S]*\bFROM\b|\bINSERT INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE FROM\b|\bER_[A-Z_]+\b/; // SQL is upper-case
const LEAKY_OTHER = /\bsqlState\b|\berrno\b|\bsql\b|\n\s*at\s+\S+/i;
const LEAKY = { test: (s) => LEAKY_SQL.test(s) || LEAKY_OTHER.test(s) };

// A user-safe message for a failed RFP request. Server messages for
// 400/403/404/409 are already user-facing and are kept; 401 and 5xx get a
// fixed message; anything that looks like an internal error is replaced.
export function errorMessage(status, body, fallback = "Something went wrong. Please try again.") {
  if (status === 0) return "Unable to reach the server. Check your connection and try again.";
  if (status === 401) return "Your session has expired. Please sign in again.";
  const server = body && typeof body.message === "string" ? body.message.trim() : "";
  const safe = server && server.length <= 300 && !LEAKY.test(server) ? server : "";
  if (status === 403) return safe || "You do not have permission to perform this action.";
  if (status === 404) return safe || "Request for Payment not found.";
  if (status === 400 || status === 409) return safe || fallback;
  return fallback;
}

// A detail response is shown only under the company it belongs to.
export function belongsToCompany(rfp, companyId) {
  return Boolean(rfp) && str(rfp.companyId) === str(companyId);
}
