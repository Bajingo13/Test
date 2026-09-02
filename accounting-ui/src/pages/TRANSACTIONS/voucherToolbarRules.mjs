// Phase 7B: pure, framework-free toolbar-gating logic, extracted out of
// TransactionFormLayout.jsx specifically so it's unit-testable without a
// React/jsdom test harness (none exists in this repo yet - see
// __tests__/voucherToolbarRules.test.js, section 30 of the Phase 7B spec:
// "Add data-driven frontend/unit/component tests where practical"). The
// frontend's job is only to REFLECT the backend's actual authority, never
// to be the real security boundary - see hooks/usePermissions.js - so
// every rule here mirrors a real backend check from Phase 7A.1/the
// permission catalog, not a new invented restriction.
//
// .mjs (not .js): Vite's dev server does NOT apply Rollup's CJS/ESM
// interop to local project files the way its production `build` does - a
// CommonJS `module.exports` version of this file built cleanly but broke
// `npm run dev` with "does not provide an export named..." (caught via
// Playwright before this shipped). The unambiguous .mjs extension lets
// this one file be real ESM for Vite/the browser AND be loaded via a
// dynamic import() from the still-CommonJS Jest backend suite (see
// __tests__/voucherToolbarRules.test.js) without adding a babel/ESM
// toolchain just for one test file.

// PO's Open/Closed/Draft lifecycle has no backend status restriction on
// Edit/Delete at all (Phase 7A.1 finding) - every other module follows the
// ordinary Draft/Posted rule the Phase 7A.1 immutability guard enforces.
export function isEditableStatus(statusModel, status) {
  if (statusModel === "OPEN_CLOSED") return true;
  return String(status || "Draft").toUpperCase() === "DRAFT";
}

// can(moduleKey, action) is hooks/usePermissions.js's lookup - passed in
// rather than imported so this stays a pure function of its inputs.
export function getVoucherToolbarVisibility({ moduleConfig, status, can }) {
  const moduleKey = moduleConfig?.moduleKey ?? null;
  const editable = isEditableStatus(moduleConfig?.statusModel, status);
  const statusUp = String(status || "Draft").toUpperCase();
  const isDraft = statusUp === "DRAFT";
  const isPosted = statusUp === "POSTED";

  const canEdit = !!moduleKey && can(moduleKey, "EDIT");
  const canDelete = !!moduleKey && can(moduleKey, "DELETE");
  const canVoid = !!moduleKey && can(moduleKey, "VOID");
  const canPrint = !!moduleKey && can(moduleKey, "PRINT");

  return {
    showEdit: editable && canEdit,
    // OR/CV have no DELETE route at all (moduleConfig.delete === false) -
    // never offered regardless of status/permission. Phase 7K: a module
    // with cancelVoid (APV) hides the physical Delete from the normal
    // toolbar entirely - Cancel is the safe Draft replacement (the backend
    // DELETE route is retained only for legacy/direct callers). Delete
    // stays for INV/JV/PCV/DM/CM which have no Cancel action.
    showDelete: !!moduleConfig?.delete && !moduleConfig?.cancelVoid && editable && canDelete,
    // Phase 7K: APV/CV (moduleConfig.cancelVoid) get explicit Cancel on a
    // Draft (authorized by the module's DELETE permission) and Void on a
    // Posted document (new VOID permission).
    showCancel: !!moduleConfig?.cancelVoid && isDraft && canDelete,
    showVoid: !!moduleConfig?.cancelVoid && isPosted && canVoid,
    showPrint: canPrint,
  };
}
