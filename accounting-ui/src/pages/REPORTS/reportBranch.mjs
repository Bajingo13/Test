// Multi-Branch Phase C-2A - the report Branch selector's pure logic.
//
// The list comes from GET /api/branch-scope/branches (the server's own answer
// of which branches this user may see, and whether they may consolidate); the
// server re-checks every report request, so nothing here is a permission.
//   ADMIN (canConsolidate) with several branches: All Branches + each branch,
//     All Branches first and selected by default.
//   anyone else: only their own branches, the first selected by default (a
//     single-branch user therefore just sees their branch).
//   no branches (a company without branches): no selector, no parameter.
export const ALL_BRANCHES = "ALL";

export function branchOptions({ branches = [], canConsolidate = false } = {}) {
  const own = (Array.isArray(branches) ? branches : []).map((b) => ({
    value: String(b.id),
    label: `${b.name || b.code || `Branch ${b.id}`}${String(b.status || "").toUpperCase() === "INACTIVE" ? " (inactive)" : ""}`,
  }));
  if (canConsolidate && own.length > 1) return [{ value: ALL_BRANCHES, label: "All Branches" }, ...own];
  return own;
}

export function defaultBranch(options = []) {
  return options.length ? options[0].value : "";
}

export function branchLabel(options = [], value = "") {
  return options.find((o) => o.value === String(value))?.label || "";
}

// The applied period snapshot plus the selected branch: `params.branch` is what
// the report request sends; `branchLabel` is what the report shows / prints.
export function withBranch(snapshot, value, label) {
  if (!snapshot || !value) return snapshot;
  return { ...snapshot, branch: value, branchLabel: label, params: { ...snapshot.params, branch: value } };
}
