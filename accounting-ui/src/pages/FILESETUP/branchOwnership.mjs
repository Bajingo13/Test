// Multi-Branch Phase C-2A - Shared vs branch-only setup records (COA, General
// Libraries) as the File Setup pages show and edit them. Phase B rules are
// enforced by the server; this only presents them:
//   branchId null  -> "Shared" (every authorized branch of the company)
//   branchId set   -> that branch only
// The branch list offered is the server's list of branches THIS user may use
// (GET /api/branch-scope/branches), so a foreign branch is never offered - and
// the server still refuses one if it is submitted anyway.
export const SHARED_LABEL = "Shared";

export function ownershipLabel(record, branches = []) {
  const id = record?.branchId;
  if (id === null || id === undefined || id === "") return SHARED_LABEL;
  const b = (branches || []).find((x) => Number(x.id) === Number(id));
  return b ? b.name || b.code || `Branch ${id}` : `Branch ${id}`;
}

export function ownershipOptions(branches = []) {
  return [
    { value: "", label: `${SHARED_LABEL} (all branches)` },
    ...(branches || []).map((b) => ({
      value: String(b.id),
      label: `${b.name || b.code || `Branch ${b.id}`}${String(b.status || "").toUpperCase() === "INACTIVE" ? " (inactive)" : ""}`,
    })),
  ];
}

export function ownershipValue(record) {
  const id = record?.branchId;
  return id === null || id === undefined ? "" : String(id);
}

// What the API receives: null = shared, otherwise the branch id.
export function branchIdPayload(value) {
  return value === "" || value === null || value === undefined ? null : Number(value);
}
