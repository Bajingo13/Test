// voucherToolbarRules.mjs is real ESM (required for Vite dev-server
// compatibility - see its header comment); this suite is otherwise a
// normal CommonJS Jest test, so it's loaded via a dynamic import() in
// beforeAll rather than a top-level require().
let getVoucherToolbarVisibility, isEditableStatus;

beforeAll(async () => {
  const mod = await import("../voucherToolbarRules.mjs");
  getVoucherToolbarVisibility = mod.getVoucherToolbarVisibility;
  isEditableStatus = mod.isEditableStatus;
});

// Phase 7B spec section 30's toolbar matrix, run as a pure-function unit
// suite (no React/jsdom harness exists in this repo - see
// voucherToolbarRules.js's header comment for why the gating logic was
// extracted specifically to make this possible). Every case here mirrors
// a real backend authority (Phase 7A.1's Posted-immutability guard, the
// permission catalog's EDIT/DELETE/PRINT actions) - this suite tests that
// the frontend reflects those correctly, never that it enforces them
// (usePermissions.js's own comment: the backend is the real boundary).
//
// Module fixtures are inlined here (mirroring the real, ESM-only
// transactionModuleConfig.js by value) rather than required from it, so
// this test doesn't force that file into CommonJS too - only the pure
// logic under test needed the CJS/ESM-interop treatment.
const INV = { moduleKey: "TRANSACTIONS.INVOICE", delete: true, statusModel: "DRAFT_POSTED" };
const OR = { moduleKey: "TRANSACTIONS.OR", delete: false, statusModel: "DRAFT_POSTED" };
const CV = { moduleKey: "TRANSACTIONS.CV", delete: false, statusModel: "DRAFT_POSTED" };
// Phase 7K: APV/CV carry cancelVoid; CV still has delete: false (no physical delete route).
const APV_CV = { moduleKey: "TRANSACTIONS.APV", delete: true, statusModel: "DRAFT_POSTED", cancelVoid: true };
const CV_CANCELVOID = { moduleKey: "TRANSACTIONS.CV", delete: false, statusModel: "DRAFT_POSTED", cancelVoid: true };
const JV = { moduleKey: "TRANSACTIONS.JV", delete: true, statusModel: "DRAFT_POSTED" };
const PO = { moduleKey: "TRANSACTIONS.PURCHASE_ORDER", delete: true, statusModel: "OPEN_CLOSED" };
const PCV = { moduleKey: "TRANSACTIONS.PETTY_CASH", delete: true, statusModel: "DRAFT_POSTED" };
const DM = { moduleKey: "TRANSACTIONS.DEBIT_CREDIT_MEMO", delete: true, statusModel: "DRAFT_POSTED" };
const CM = { moduleKey: "TRANSACTIONS.DEBIT_CREDIT_MEMO", delete: true, statusModel: "DRAFT_POSTED" };

const allowAll = () => true;
const denyAll = () => false;

describe("getVoucherToolbarVisibility", () => {
  test("Invoice Draft + full permissions: Edit/Delete/Print all visible", () => {
    const result = getVoucherToolbarVisibility({
      moduleConfig: INV,
      status: "Draft",
      can: allowAll,
    });
    expect(result).toEqual({ showEdit: true, showDelete: true, showCancel: false, showVoid: false, showPrint: true });
  });

  test("Invoice Posted: Edit/Delete hidden even with full permissions (Phase 7A.1 guard reflected)", () => {
    const result = getVoucherToolbarVisibility({
      moduleConfig: INV,
      status: "Posted",
      can: allowAll,
    });
    expect(result.showEdit).toBe(false);
    expect(result.showDelete).toBe(false);
    // Print remains available for a Posted document - printing a posted
    // voucher is a normal, expected action.
    expect(result.showPrint).toBe(true);
  });

  test("OR Draft: Delete never offered - no DELETE route exists for OR", () => {
    const result = getVoucherToolbarVisibility({
      moduleConfig: OR,
      status: "Draft",
      can: allowAll,
    });
    expect(result.showDelete).toBe(false);
    expect(result.showEdit).toBe(true);
  });

  test("CV Draft: Delete never offered - no DELETE route exists for CV", () => {
    const result = getVoucherToolbarVisibility({
      moduleConfig: CV,
      status: "Draft",
      can: allowAll,
    });
    expect(result.showDelete).toBe(false);
  });

  test("No PRINT permission: Print hidden regardless of status", () => {
    const canNoPrint = (moduleKey, action) => action !== "PRINT";
    const result = getVoucherToolbarVisibility({
      moduleConfig: INV,
      status: "Draft",
      can: canNoPrint,
    });
    expect(result.showPrint).toBe(false);
    expect(result.showEdit).toBe(true);
  });

  test("No EDIT permission: Edit hidden regardless of status", () => {
    const canNoEdit = (moduleKey, action) => action !== "EDIT";
    const result = getVoucherToolbarVisibility({
      moduleConfig: JV,
      status: "Draft",
      can: canNoEdit,
    });
    expect(result.showEdit).toBe(false);
  });

  test("No DELETE permission: Delete hidden on an otherwise-deletable Draft JV", () => {
    const canNoDelete = (moduleKey, action) => action !== "DELETE";
    const result = getVoucherToolbarVisibility({
      moduleConfig: JV,
      status: "Draft",
      can: canNoDelete,
    });
    expect(result.showDelete).toBe(false);
  });

  test("Full permission denial: nothing offered", () => {
    const result = getVoucherToolbarVisibility({
      moduleConfig: PCV,
      status: "Draft",
      can: denyAll,
    });
    expect(result).toEqual({ showEdit: false, showDelete: false, showCancel: false, showVoid: false, showPrint: false });
  });

  // Phase 7K
  test("APV Draft + full perms: Cancel visible, physical Delete HIDDEN, Void hidden", () => {
    const r = getVoucherToolbarVisibility({ moduleConfig: APV_CV, status: "Draft", can: allowAll });
    expect(r.showCancel).toBe(true);
    expect(r.showVoid).toBe(false);
    // Phase 7K safety correction: the physical Delete action is hidden from
    // the normal APV toolbar once Cancel is available (backend route retained).
    expect(r.showDelete).toBe(false);
  });

  test("APV Draft WITHOUT DELETE permission: Cancel hidden AND Delete hidden", () => {
    const canNoDelete = (mk, a) => a !== "DELETE";
    const r = getVoucherToolbarVisibility({ moduleConfig: APV_CV, status: "Draft", can: canNoDelete });
    expect(r.showCancel).toBe(false);
    expect(r.showDelete).toBe(false);
  });

  test("APV Posted: Void visible (with perm), Delete + Cancel hidden", () => {
    const r = getVoucherToolbarVisibility({ moduleConfig: APV_CV, status: "Posted", can: allowAll });
    expect(r.showVoid).toBe(true);
    expect(r.showDelete).toBe(false);
    expect(r.showCancel).toBe(false);
  });

  test("INV/JV still show physical Delete on a Draft (no cancelVoid -> unchanged)", () => {
    for (const mc of [INV, JV]) {
      const r = getVoucherToolbarVisibility({ moduleConfig: mc, status: "Draft", can: allowAll });
      expect(r.showDelete).toBe(true);
      expect(r.showCancel).toBe(false);
    }
  });

  test("APV Posted + full perms: Void visible, Cancel hidden, Edit/Delete hidden", () => {
    const r = getVoucherToolbarVisibility({ moduleConfig: APV_CV, status: "Posted", can: allowAll });
    expect(r.showVoid).toBe(true);
    expect(r.showCancel).toBe(false);
    expect(r.showEdit).toBe(false);
    expect(r.showDelete).toBe(false);
  });

  test("CV Draft: Cancel visible (via DELETE perm) even though CV has no physical delete route", () => {
    const r = getVoucherToolbarVisibility({ moduleConfig: CV_CANCELVOID, status: "Draft", can: allowAll });
    expect(r.showCancel).toBe(true);
    expect(r.showDelete).toBe(false);
  });

  test("CV Posted: Void visible", () => {
    const r = getVoucherToolbarVisibility({ moduleConfig: CV_CANCELVOID, status: "Posted", can: allowAll });
    expect(r.showVoid).toBe(true);
  });

  test("No VOID permission: Void hidden on a Posted APV", () => {
    const canNoVoid = (mk, a) => a !== "VOID";
    const r = getVoucherToolbarVisibility({ moduleConfig: APV_CV, status: "Posted", can: canNoVoid });
    expect(r.showVoid).toBe(false);
  });

  test("No DELETE permission: Cancel hidden on a Draft APV", () => {
    const canNoDelete = (mk, a) => a !== "DELETE";
    const r = getVoucherToolbarVisibility({ moduleConfig: APV_CV, status: "Draft", can: canNoDelete });
    expect(r.showCancel).toBe(false);
  });

  test("modules without cancelVoid never show Cancel/Void", () => {
    for (const mc of [INV, OR, JV, PCV]) {
      const d = getVoucherToolbarVisibility({ moduleConfig: mc, status: "Draft", can: allowAll });
      const p = getVoucherToolbarVisibility({ moduleConfig: mc, status: "Posted", can: allowAll });
      expect(d.showCancel).toBe(false);
      expect(d.showVoid).toBe(false);
      expect(p.showVoid).toBe(false);
    }
  });

  describe("PO (OPEN_CLOSED statusModel - no Draft/Posted restriction, per Phase 7A.1)", () => {
    test.each(["Open", "Closed", "Draft", "Posted", undefined])(
      "status=%s: Edit/Delete available whenever permission allows (PO has no status guard)",
      (status) => {
        const result = getVoucherToolbarVisibility({
          moduleConfig: PO,
          status,
          can: allowAll,
        });
        expect(result.showEdit).toBe(true);
        expect(result.showDelete).toBe(true);
      }
    );
  });

  test("Debit Memo / Credit Memo Posted: Edit/Delete hidden (Checkpoint 6 modules covered by the same guard)", () => {
    for (const code of ["DM", "CM"]) {
      const result = getVoucherToolbarVisibility({
        moduleConfig: { INV, APV: INV, OR, CV, JV, PO, PCV, DM, CM }[code],
        status: "Posted",
        can: allowAll,
      });
      expect(result.showEdit).toBe(false);
      expect(result.showDelete).toBe(false);
    }
  });
});

describe("isEditableStatus", () => {
  test("DRAFT_POSTED: only Draft is editable (case-insensitive)", () => {
    expect(isEditableStatus("DRAFT_POSTED", "Draft")).toBe(true);
    expect(isEditableStatus("DRAFT_POSTED", "draft")).toBe(true);
    expect(isEditableStatus("DRAFT_POSTED", "Posted")).toBe(false);
    expect(isEditableStatus("DRAFT_POSTED", undefined)).toBe(true); // matches form.status's own "Draft" default
  });

  test("OPEN_CLOSED: always editable regardless of value", () => {
    expect(isEditableStatus("OPEN_CLOSED", "Open")).toBe(true);
    expect(isEditableStatus("OPEN_CLOSED", "Closed")).toBe(true);
    expect(isEditableStatus("OPEN_CLOSED", "Posted")).toBe(true);
  });
});
