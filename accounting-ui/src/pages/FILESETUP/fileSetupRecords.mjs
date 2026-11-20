// Pure helpers for the Chart of Accounts and General Libraries screens - no
// React, no requests. Unit-tested in backend/__tests__/fileSetupCoaGenLibUi.test.js.
// They only order / filter / describe the records the page already loaded.

// ---------------------------------------------------------------------------
// Chart of Accounts: the View dialog lists accounts in account-code order.
// Natural order, so "1010" < "1010-01" < "1020" and "2" < "10". Ties (codes
// equal apart from letter case) keep a stable order by id. Returns a new
// array; the loaded list (which Previous / Next walk) is never reordered.

export function compareAccountCodes(a, b) {
  const byCode = String(a?.code ?? "").localeCompare(String(b?.code ?? ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
  if (byCode !== 0) return byCode;
  return Number(a?.id ?? 0) - Number(b?.id ?? 0);
}

export function sortAccountsByCode(accounts) {
  return [...(Array.isArray(accounts) ? accounts : [])].sort(compareAccountCodes);
}

// ---------------------------------------------------------------------------
// General Libraries: View dialog search + Party Type / Status filters.

export const GENLIB_SEARCH_FIELDS = ["code", "name", "type", "email", "mobile", "telephone", "tin", "category", "status"];

// search: case-insensitive substring over GENLIB_SEARCH_FIELDS.
// type / status: "" means all; otherwise an exact (case-insensitive) match, so
// the ACTIVE filter never picks up INACTIVE records.
export function filterGenLibRecords(records, { search = "", type = "", status = "" } = {}) {
  const list = Array.isArray(records) ? records : [];
  const q = String(search ?? "").trim().toLowerCase();
  const wantType = String(type ?? "").trim().toUpperCase();
  const wantStatus = String(status ?? "").trim().toUpperCase();
  return list.filter((item) => {
    if (wantType && String(item?.type ?? "").toUpperCase() !== wantType) return false;
    if (wantStatus && String(item?.status ?? "").toUpperCase() !== wantStatus) return false;
    if (!q) return true;
    return GENLIB_SEARCH_FIELDS.some((f) => item?.[f] !== null && item?.[f] !== undefined && String(item[f]).toLowerCase().includes(q));
  });
}

// Status badge: anything other than INACTIVE is shown as ACTIVE (the record
// default) - display only.
export function statusBadge(status) {
  return String(status ?? "").toUpperCase() === "INACTIVE"
    ? { label: "INACTIVE", tone: "inactive" }
    : { label: "ACTIVE", tone: "active" };
}

// ---------------------------------------------------------------------------
// Toolbar states shared by both pages. Each button is disabled exactly when
// its existing handler would do nothing (or, for Import, while a record is
// being edited) - the handlers themselves are unchanged.
//   index: position of the selected record in the loaded list (-1 = none)

export function toolbarState({ index = -1, total = 0, hasRecord = false, isEditing = false, busy = false } = {}) {
  return {
    canEdit: hasRecord && !isEditing,
    canDelete: hasRecord,
    canPrevious: index > 0,
    canNext: index < total - 1,
    canImport: !isEditing && !busy,
  };
}
