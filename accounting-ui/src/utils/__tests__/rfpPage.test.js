// RFP page (R4): pure helpers in utils/rfpPage.mjs, plus source checks on
// the page / form / detail / dialog files and the navigation wiring.
const fs = require("fs");
const path = require("path");

let r;
let tb;
beforeAll(async () => {
  r = await import("../rfpPage.mjs");
  tb = await import("../trialBalanceCompany.mjs");
});

const SRC = path.join(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), "utf8");
const PAGE_FILES = ["RFP.jsx", "RfpForm.jsx", "RfpDetail.jsx", "RfpActionDialog.jsx"].map((f) => ["pages", "TRANSACTIONS", f]);

const validForm = (over = {}) => ({
  ...r.emptyForm(),
  rfpDate: "2026-10-01",
  requestedPaymentDate: "2026-10-15",
  supplierId: "7",
  currencyId: "3",
  purpose: "  Office rent  ",
  lines: [{ ...r.emptyLine(), description: "Rent", grossAmount: "1000.5" }, { ...r.emptyLine(), description: "Dues", grossAmount: "0.25", vatTreatment: "EXEMPT", accountId: "12" }],
  ...over,
});

describe("company context (shared with Trial Balance)", () => {
  const companies = [{ id: 4, name: "B" }, { id: 2, name: "A" }];
  test("single-company user: preselected and locked", () => {
    expect(tb.pickInitialCompany({ companies: [{ id: 9 }], isSuperAdmin: false })).toBe("9");
    expect(tb.isCompanyLocked({ companies: [{ id: 9 }], isSuperAdmin: false })).toBe(true);
  });
  test("multi-company user and Super Admin: nothing preselected (never the first/lowest)", () => {
    expect(tb.pickInitialCompany({ companies, isSuperAdmin: false })).toBe("");
    expect(tb.pickInitialCompany({ companies, isSuperAdmin: true })).toBe("");
    expect(tb.pickInitialCompany({ companies: [{ id: 9 }], isSuperAdmin: true })).toBe("");
  });
  test("no company -> no list / lookups request", () => {
    expect(r.listQuery({ companyId: "" })).toBeNull();
    expect(r.lookupsQuery("")).toBeNull();
    expect(r.listQuery({ companyId: "x" })).toBeNull();
    expect(r.listQuery({ companyId: "4", status: "DRAFT" })).toBe("companyId=4&status=DRAFT");
    expect(r.lookupsQuery(" 4 ")).toBe("companyId=4");
  });
  test("stale-response guard: a company switch invalidates older tickets", () => {
    const g = tb.createRequestGuard();
    const a = g.next();
    g.invalidate();
    const b = g.next();
    expect(g.isCurrent(a)).toBe(false);
    expect(g.isCurrent(b)).toBe(true);
  });
  test("a detail or list row is shown only under its own company", () => {
    expect(r.belongsToCompany({ companyId: 4 }, "4")).toBe(true);
    expect(r.belongsToCompany({ companyId: 2 }, "4")).toBe(false);
    expect(r.belongsToCompany(null, "4")).toBe(false);
  });
});

describe("money", () => {
  test.each([["0", 0n], ["12", 1200n], ["12.5", 1250n], ["12.05", 1205n], [" 7.10 ", 710n], [3, 300n]])("%p -> %p cents", (v, c) => {
    expect(r.parseAmountToCents(v)).toBe(c);
  });
  test.each(["", "-1", "1.234", "1e3", "Infinity", "NaN", "1,000", "abc", "12345678901234", null, undefined, {}])("%p is invalid", (v) => {
    expect(r.parseAmountToCents(v)).toBeNull();
  });
  test("total in whole cents (no float drift) and formatted with separators", () => {
    const t = r.sumLines([{ grossAmount: "0.1" }, { grossAmount: "0.2" }, { grossAmount: "1234567.89" }, { grossAmount: "x" }]);
    expect(t.amount).toBe("1234568.19");
    expect(t.invalid).toBe(1);
    expect(r.formatAmount("1234568.19")).toBe("1,234,568.19");
    expect(r.formatAmount("5")).toBe("5.00");
    expect(r.formatAmount(null)).toBe("");
  });
});

describe("form validation and payload", () => {
  test("the RFP date is never defaulted", () => {
    expect(r.emptyForm().rfpDate).toBe("");
    expect(r.validateForm(r.emptyForm()).errors.rfpDate).toMatch(/required/);
  });
  test("required fields", () => {
    const { valid, errors } = r.validateForm(r.emptyForm());
    expect(valid).toBe(false);
    expect(Object.keys(errors)).toEqual(expect.arrayContaining(["rfpDate", "requestedPaymentDate", "supplierId", "currencyId", "purpose"]));
    expect(errors.lines[0]).toEqual(expect.objectContaining({ description: expect.any(String), grossAmount: expect.any(String) }));
  });
  test("calendar-exact dates", () => {
    expect(r.validateForm(validForm({ rfpDate: "2026-02-30" })).errors.rfpDate).toBe("Enter a valid date.");
    expect(r.isValidDate("2028-02-29")).toBe(true);
  });
  test("line rules: amount format, VAT list, at least one, at most 500, length limits", () => {
    expect(r.validateForm(validForm({ lines: [{ ...r.emptyLine(), description: "x", grossAmount: "-1" }] })).errors.lines[0].grossAmount).toBeDefined();
    expect(r.validateForm(validForm({ lines: [{ ...r.emptyLine(), description: "x", grossAmount: "1", vatTreatment: "ZERO" }] })).errors.lines[0].vatTreatment).toBeDefined();
    expect(r.validateForm(validForm({ lines: [] })).errors.linesGeneral).toMatch(/at least one/);
    const many = Array.from({ length: 501 }, () => ({ ...r.emptyLine(), description: "x", grossAmount: "1" }));
    expect(r.validateForm(validForm({ lines: many })).errors.linesGeneral).toMatch(/500/);
    expect(r.validateForm(validForm({ supportingReference: "x".repeat(101) })).errors.supportingReference).toBeDefined();
    expect(r.validateForm(validForm()).valid).toBe(true);
  });
  test("create payload: only R2 fields, server total sent, company included", () => {
    const p = r.buildPayload(validForm(), { companyId: "4", isCreate: true });
    expect(p).toEqual({
      companyId: 4,
      branchId: null,
      rfpDate: "2026-10-01",
      supplierId: 7,
      purpose: "Office rent",
      requestedPaymentDate: "2026-10-15",
      currencyId: 3,
      remarks: null,
      supportingReference: null,
      lines: [
        { description: "Rent", grossAmount: "1000.50", accountId: null, vatTreatment: null, reference: null },
        { description: "Dues", grossAmount: "0.25", accountId: 12, vatTreatment: "EXEMPT", reference: null },
      ],
      totalAmount: "1000.75",
    });
    for (const k of ["status", "requesterUserId", "rfpNo", "supplierName", "supplierTin", "submittedBy", "decidedBy", "convertedApvId"]) {
      expect(p).not.toHaveProperty(k);
    }
  });
  test("edit payload never carries a company", () => {
    expect(r.buildPayload(validForm({ branchId: "5" }), { companyId: "4", isCreate: false })).not.toHaveProperty("companyId");
    expect(r.buildPayload(validForm({ branchId: "5" }), { companyId: "4", isCreate: false }).branchId).toBe(5);
  });
  test("formFromRfp round-trips a stored draft", () => {
    const f = r.formFromRfp({ rfpDate: "2026-01-02", requestedPaymentDate: "2026-01-09", supplierId: 7, currencyId: 3, branchId: null, purpose: "P", remarks: null, supportingReference: "S", lines: [{ description: "L", grossAmount: "5.00", accountId: null, vatTreatment: "STANDARD", reference: null }] });
    expect(f).toMatchObject({ branchId: "", supplierId: "7", currencyId: "3", supportingReference: "S", remarks: "" });
    expect(f.lines[0]).toMatchObject({ description: "L", grossAmount: "5.00", accountId: "", vatTreatment: "STANDARD" });
  });
});

describe("list refinement", () => {
  const rows = [
    { rfpNo: "RFP26-00001", rfpDate: "2026-01-10", supplierName: "Acme", purpose: "Rent", requesterUsername: "ana" },
    { rfpNo: "RFP26-00002", rfpDate: "2026-03-05", supplierName: "Globex", purpose: "Supplies", requesterUsername: "ben" },
  ];
  test("search and date range only narrow the server list", () => {
    expect(r.refineList(rows, { search: "glob" }).map((x) => x.rfpNo)).toEqual(["RFP26-00002"]);
    expect(r.refineList(rows, { search: "00001" })).toHaveLength(1);
    expect(r.refineList(rows, { from: "2026-02-01" }).map((x) => x.rfpNo)).toEqual(["RFP26-00002"]);
    expect(r.refineList(rows, { to: "2026-02-01" }).map((x) => x.rfpNo)).toEqual(["RFP26-00001"]);
    expect(r.refineList(rows, {})).toHaveLength(2);
  });
  test("active-filter detection drives the 'Try adjusting your filters.' hint", () => {
    expect(r.hasActiveFilters({})).toBe(false);
    expect(r.hasActiveFilters({ status: "DRAFT" })).toBe(true);
    expect(r.hasActiveFilters({ search: "  " })).toBe(false);
  });
  test("every status has a distinct label and tone; no invented statuses", () => {
    expect(r.RFP_STATUSES).toEqual(["DRAFT", "SUBMITTED", "APPROVED", "RETURNED", "REJECTED", "CANCELLED", "CONVERTED"]);
    const tones = r.RFP_STATUSES.map((s) => r.STATUS_META[s].tone);
    expect(new Set(tones).size).toBe(tones.length);
  });
});

describe("actions", () => {
  const all = () => true;
  const only = (...a) => (x) => a.includes(x);
  const rfp = (status, over = {}) => ({ status, requesterUserId: 10, submittedBy: status === "DRAFT" ? null : 10, ...over });

  test("DRAFT: edit / delete / submit / cancel by permission", () => {
    expect(r.availableActions({ rfp: rfp("DRAFT"), can: all, userId: 10 })).toMatchObject({ edit: true, remove: true, submit: true, cancel: true, approve: false });
    expect(r.availableActions({ rfp: rfp("DRAFT"), can: only("VIEW", "EDIT"), userId: 10 })).toMatchObject({ edit: true, remove: false, submit: false, cancel: false });
  });
  test("SUBMITTED: decisions need APPROVE and are hidden from the requester/submitter (Super Admin included)", () => {
    expect(r.availableActions({ rfp: rfp("SUBMITTED"), can: all, userId: 99 })).toMatchObject({ approve: true, return: true, reject: true, cancel: true, edit: false, selfDecisionBlocked: false });
    expect(r.availableActions({ rfp: rfp("SUBMITTED"), can: all, userId: 10 })).toMatchObject({ approve: false, return: false, reject: false, selfDecisionBlocked: true });
    expect(r.availableActions({ rfp: rfp("SUBMITTED", { requesterUserId: 5, submittedBy: 77 }), can: all, userId: 77 }).approve).toBe(false);
    expect(r.availableActions({ rfp: rfp("SUBMITTED"), can: only("VIEW", "SUBMIT"), userId: 99 })).toMatchObject({ approve: false, cancel: true, selfDecisionBlocked: false });
  });
  test.each(["APPROVED", "REJECTED", "CANCELLED", "CONVERTED"])("%s offers no action at all (no convert, no resubmit)", (status) => {
    const a = r.availableActions({ rfp: rfp(status), can: all, userId: 99 });
    expect(Object.values(a).some(Boolean)).toBe(false);
  });
  test("workflow dialogs: required reasons for return/reject, cancel wording, no convert", () => {
    expect(r.WORKFLOW_DIALOGS.return.note).toBe("required");
    expect(r.WORKFLOW_DIALOGS.reject.note).toBe("required");
    expect(r.WORKFLOW_DIALOGS.cancel.message).toBe("Canceling this RFP will permanently move it to CANCELLED.");
    expect(Object.keys(r.WORKFLOW_DIALOGS).sort()).toEqual(["approve", "cancel", "reject", "resubmit", "return", "submit"]);
  });
  test("notes are trimmed, blank required notes block, 500 max", () => {
    expect(r.normalizeNote("  x  ", "required")).toEqual({ ok: true, note: "x" });
    expect(r.normalizeNote("   ", "required").ok).toBe(false);
    expect(r.normalizeNote("", "optional")).toEqual({ ok: true, note: null });
    expect(r.normalizeNote("x".repeat(501), "optional").ok).toBe(false);
  });
});

describe("returned RFP (R4.1)", () => {
  const all = () => true;
  const only = (...a) => (x) => a.includes(x);
  const returned = { status: "RETURNED", requesterUserId: 10, submittedBy: 10, decidedAt: "2026-10-01T00:00:00Z", decisionNote: "Attach invoice" };

  test("RETURNED offers Edit and Resubmit to the requester side - no decisions, no cancel, no delete", () => {
    expect(r.availableActions({ rfp: returned, can: all, userId: 10 })).toEqual({
      edit: true, remove: false, submit: false, resubmit: true, cancel: false, approve: false, return: false, reject: false, selfDecisionBlocked: false,
    });
  });
  test("Edit needs EDIT, Resubmit needs SUBMIT", () => {
    expect(r.availableActions({ rfp: returned, can: only("VIEW", "EDIT"), userId: 99 })).toMatchObject({ edit: true, resubmit: false });
    expect(r.availableActions({ rfp: returned, can: only("VIEW", "SUBMIT"), userId: 99 })).toMatchObject({ edit: false, resubmit: true });
    expect(r.availableActions({ rfp: returned, can: only("VIEW"), userId: 99 })).toMatchObject({ edit: false, resubmit: false });
  });
  test("after resubmission the requester / resubmitter still gets no decisions (Super Admin too)", () => {
    const resubmitted = { ...returned, status: "SUBMITTED", submittedBy: 22 };
    expect(r.availableActions({ rfp: resubmitted, can: all, userId: 10 })).toMatchObject({ approve: false, return: false, reject: false, selfDecisionBlocked: true });
    expect(r.availableActions({ rfp: resubmitted, can: all, userId: 22 })).toMatchObject({ approve: false, selfDecisionBlocked: true });
    expect(r.availableActions({ rfp: resubmitted, can: all, userId: 33 })).toMatchObject({ approve: true, return: true, reject: true });
  });
  test("resubmit dialog goes to the existing submit route and explains RETURNED -> SUBMITTED", () => {
    expect(r.WORKFLOW_DIALOGS.resubmit).toMatchObject({ action: "SUBMIT", route: "submit", note: "optional", confirm: "Resubmit" });
    expect(r.WORKFLOW_DIALOGS.resubmit.message).toMatch(/from RETURNED back to SUBMITTED/);
  });
  test("decision fields are shown only while the decision is current", () => {
    expect(r.showDecision(returned)).toBe(true);
    expect(r.showDecision({ ...returned, status: "SUBMITTED" })).toBe(false);
    expect(r.showDecision({ ...returned, status: "APPROVED" })).toBe(true);
    expect(r.showDecision({ status: "RETURNED", decidedAt: null })).toBe(false);
  });
  test("history labels a SUBMIT out of RETURNED as a resubmission", () => {
    expect(r.historyActionLabel({ action: "SUBMIT", previousStatus: "RETURNED" })).toBe("Resubmitted");
    expect(r.historyActionLabel({ action: "SUBMIT", previousStatus: "DRAFT" })).toBe("Submitted");
    expect(r.historyActionLabel({ action: "RETURN", previousStatus: "SUBMITTED" })).toBe("Returned");
  });
  test("editing a returned RFP sends no company, status or workflow fields", () => {
    const p = r.buildPayload({ ...r.formFromRfp({ ...returned, rfpDate: "2026-01-02", requestedPaymentDate: "2026-01-09", supplierId: 7, currencyId: 3, purpose: "P", lines: [{ description: "L", grossAmount: "5.00" }] }) }, { companyId: "4", isCreate: false });
    for (const k of ["companyId", "status", "submittedBy", "decidedBy", "decidedAt", "decisionNote", "convertedApvId", "requesterUserId"]) expect(p).not.toHaveProperty(k);
  });
  test("page / form / detail wiring", () => {
    const page = read("pages", "TRANSACTIONS", "RFP.jsx");
    const detail = read("pages", "TRANSACTIONS", "RfpDetail.jsx");
    const form = read("pages", "TRANSACTIONS", "RfpForm.jsx");
    expect(page).toContain("WORKFLOW_DIALOGS[key].route || key");
    expect(page).toContain('returnNote={rfp.status === "RETURNED"');
    expect(page).toContain("It is still RETURNED - resubmit it when the corrections are complete.");
    expect(detail).toContain("Returned for correction");
    expect(detail).toContain('onAction("resubmit")');
    expect(detail).toContain("historyActionLabel(h)");
    expect(form).toContain("Saving keeps this request RETURNED.");
  });
});

describe("error messages", () => {
  test("409 / 400 / 403 keep the server's user-safe message", () => {
    expect(r.errorMessage(409, { message: "Cannot approve a Request for Payment that is APPROVED (allowed from: SUBMITTED)." })).toMatch(/Cannot approve/);
    expect(r.errorMessage(400, { message: "Select a company to continue." })).toBe("Select a company to continue.");
    expect(r.errorMessage(400, { message: "The selected supplier is not active." })).toBe("The selected supplier is not active.");
    expect(r.errorMessage(403, {})).toMatch(/permission/);
    expect(r.errorMessage(404, { message: "Request for Payment not found" })).toBe("Request for Payment not found");
  });
  test("401, 5xx, network and leaky messages never reach the user", () => {
    expect(r.errorMessage(401, { message: "jwt expired" })).toMatch(/session has expired/);
    expect(r.errorMessage(500, { message: "ER_DUP_ENTRY: Duplicate entry" }, "Fallback")).toBe("Fallback");
    expect(r.errorMessage(0, null)).toMatch(/Unable to reach the server/);
    expect(r.errorMessage(409, { message: "ER_LOCK_DEADLOCK: Deadlock found" }, "Fallback")).toBe("Fallback");
    expect(r.errorMessage(400, { message: "SELECT * FROM rfp_headers WHERE id = 1" }, "Fallback")).toBe("Fallback");
    expect(r.errorMessage(400, { message: "Error\n    at Object.<anonymous> (x.js:1:1)" }, "Fallback")).toBe("Fallback");
  });
});

describe("source checks", () => {
  test("no native alert / confirm / prompt and no console logging in the RFP page files", () => {
    for (const f of PAGE_FILES) {
      const src = read(...f);
      expect(src).not.toMatch(/\b(window\.)?(alert|confirm|prompt)\(/);
      expect(src).not.toMatch(/console\./);
    }
  });
  test("navigation: Accounts Payable group holds APV and RFP; RFP gated by TRANSACTIONS.RFP VIEW; route registered", () => {
    const menu = read("components", "sidebar", "transactionsMenuConfig.js");
    expect(menu).toMatch(/label: "Accounts Payable",\s*children: \[\s*\{ id: "accounts-payable-voucher", label: "Accounts Payable Voucher"[^\n]*\n\s*\{ id: "request-for-payment", label: "Request for Payment", icon: HandCoins, path: "\/transactions\/rfp" \}/);
    expect(read("components", "sidebar", "pathPermissionMap.js")).toMatch(/"\/transactions\/rfp": \["TRANSACTIONS\.RFP", "VIEW"\]/);
    expect(read("App.jsx")).toMatch(/<Route path="\/transactions\/rfp" element={<RFP \/>} \/>/);
  });
  test("page: page-level VIEW gate, explicit company selection, no company from the URL, no convert", () => {
    const src = read("pages", "TRANSACTIONS", "RFP.jsx");
    expect(src).toMatch(/You do not have permission to view Requests for Payment\./);
    expect(src).toMatch(/pickInitialCompany\(\{ companies: list, isSuperAdmin, current \}\)/);
    expect(src).toMatch(/Select a company to continue\./);
    expect(src).not.toMatch(/searchParams\.get\("company/);
    expect(src).not.toMatch(/convert/i);
    expect(src).toMatch(/guards\.current\.list\.isCurrent\(ticket\)/);
    expect(src).toMatch(/guards\.current\.detail\.isCurrent\(ticket\)/);
    expect(src).toMatch(/guards\.current\.lookups\.isCurrent\(ticket\)/);
  });
  test("form: requester and company are read-only, no supplier name/TIN inputs, branch never auto-selected", () => {
    const src = read("pages", "TRANSACTIONS", "RfpForm.jsx");
    expect(src).toMatch(/No branches available\./);
    expect(src).toMatch(/<option value="">No branch<\/option>/);
    expect(src).not.toMatch(/onChange=\{set\("(supplierName|supplierTin|requester|status|companyId)"\)\}/);
  });
});
