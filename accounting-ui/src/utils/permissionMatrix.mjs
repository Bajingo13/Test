// Builds the module x action grid for the Roles & Permissions matrix and
// the Permission Template editor straight from the permission catalog the
// backend returns - no hardcoded action list, so every permission (and any
// added later) gets a checkbox.
//
// Input rows: { permission_id, module_key, action, label?, granted? }
// Output:
//   actions - every distinct action, most widely used first (ties A-Z)
//   modules - [{ moduleKey, cells: { [action]: row } }] sorted by key
//   permissionCount - number of distinct permissions placed in the grid
export function buildPermissionMatrix(permissions) {
  const counts = new Map();
  const byModule = new Map();
  let permissionCount = 0;

  for (const p of permissions || []) {
    if (!p || !p.module_key || !p.action) continue;
    if (!byModule.has(p.module_key)) byModule.set(p.module_key, {});
    const cells = byModule.get(p.module_key);
    if (cells[p.action]) continue;
    cells[p.action] = p;
    permissionCount += 1;
    counts.set(p.action, (counts.get(p.action) || 0) + 1);
  }

  const actions = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b));
  const modules = [...byModule.keys()].sort().map((moduleKey) => ({ moduleKey, cells: byModule.get(moduleKey) }));

  return { actions, modules, permissionCount };
}
