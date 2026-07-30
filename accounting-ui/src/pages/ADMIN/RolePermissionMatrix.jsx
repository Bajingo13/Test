import { useEffect, useMemo, useState } from "react";
import "./RolePermissionMatrix.css";

const API_URL = import.meta.env.VITE_API_URL || "";
const ACTIONS = ["VIEW", "CREATE", "EDIT", "DELETE", "SUBMIT", "APPROVE", "POST", "EXPORT", "CONFIGURE"];

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default function RolePermissionMatrix() {
  const [isSuperAdmin, setIsSuperAdmin] = useState(null);
  const [roles, setRoles] = useState([]);
  const [selectedRoleId, setSelectedRoleId] = useState("");
  const [permissions, setPermissions] = useState([]);
  const [grants, setGrants] = useState({});
  const [originalGrants, setOriginalGrants] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    (async () => {
      const res = await fetch(`${API_URL}/api/me/permissions`, { headers: authHeaders() });
      const data = await res.json();
      const superAdmin = res.ok && data.user?.roleCode === "SUPER_ADMIN";
      setIsSuperAdmin(superAdmin);
      if (!superAdmin) return;

      const rolesRes = await fetch(`${API_URL}/api/roles`, { headers: authHeaders() });
      const rolesData = await rolesRes.json();
      const editable = rolesData.filter((r) => r.code !== "SUPER_ADMIN");
      setRoles(editable);
      if (editable.length) setSelectedRoleId(String(editable[0].id));
    })();
  }, []);

  useEffect(() => {
    if (!selectedRoleId) return;
    loadRolePermissions(selectedRoleId);
  }, [selectedRoleId]);

  async function loadRolePermissions(roleId) {
    setLoading(true);
    setError("");
    setSuccess("");
    try {
      const res = await fetch(`${API_URL}/api/roles/${roleId}/permissions`, { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || "Failed to load role permissions");
        return;
      }
      setPermissions(data.permissions);
      const g = {};
      data.permissions.forEach((p) => { g[p.permission_id] = !!p.granted; });
      setGrants(g);
      setOriginalGrants(g);
    } catch (err) {
      console.error("LOAD ROLE PERMISSIONS ERROR:", err);
      setError("Unable to connect to the server.");
    } finally {
      setLoading(false);
    }
  }

  const grouped = useMemo(() => {
    const byModule = {};
    permissions.forEach((p) => {
      if (!byModule[p.module_key]) byModule[p.module_key] = {};
      byModule[p.module_key][p.action] = p.permission_id;
    });
    return byModule;
  }, [permissions]);

  const isDirty = useMemo(() => {
    return Object.keys(grants).some((id) => grants[id] !== originalGrants[id]);
  }, [grants, originalGrants]);

  function toggle(permissionId) {
    setGrants((prev) => ({ ...prev, [permissionId]: !prev[permissionId] }));
  }

  function selectAllForModule(moduleKey) {
    const ids = Object.values(grouped[moduleKey]);
    setGrants((prev) => {
      const next = { ...prev };
      ids.forEach((id) => { next[id] = true; });
      return next;
    });
  }

  function clearAllForModule(moduleKey) {
    const ids = Object.values(grouped[moduleKey]);
    setGrants((prev) => {
      const next = { ...prev };
      ids.forEach((id) => { next[id] = false; });
      return next;
    });
  }

  function handleRoleChange(newRoleId) {
    if (isDirty && !confirm("You have unsaved changes. Discard them and switch roles?")) return;
    setSelectedRoleId(newRoleId);
  }

  function resetToLoaded() {
    setGrants(originalGrants);
  }

  async function handleSave() {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const grantsArray = Object.entries(grants).map(([permissionId, granted]) => ({
        permissionId: Number(permissionId),
        granted,
      }));
      const res = await fetch(`${API_URL}/api/roles/${selectedRoleId}/permissions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ grants: grantsArray }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || "Failed to save permissions");
        return;
      }
      setSuccess("Permissions saved.");
      loadRolePermissions(selectedRoleId);
    } catch (err) {
      console.error("SAVE ROLE PERMISSIONS ERROR:", err);
      setError("Unable to connect to the server.");
    } finally {
      setSaving(false);
    }
  }

  if (isSuperAdmin === null) {
    return <div className="rpm-page"><p className="rpm-muted">Loading...</p></div>;
  }

  if (isSuperAdmin === false) {
    return (
      <div className="rpm-page">
        <div className="rpm-card">
          <h1>Roles and Permissions</h1>
          <div className="rpm-error-banner">Only the Super Admin can configure role permissions.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="rpm-page">
      <h1>Roles and Permissions</h1>

      <div className="rpm-card">
        <div className="rpm-toolbar">
          <label className="rpm-role-select-label">
            Role
            <select value={selectedRoleId} onChange={(e) => handleRoleChange(e.target.value)}>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </label>

          {isDirty && <span className="rpm-unsaved-badge">Unsaved changes</span>}

          <div className="rpm-toolbar-actions">
            <button type="button" className="rpm-btn-secondary" onClick={resetToLoaded} disabled={!isDirty}>
              Reset to Loaded
            </button>
            <button type="button" className="rpm-btn-primary" onClick={handleSave} disabled={saving || !isDirty}>
              {saving ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </div>

        {error && <div className="rpm-error-banner">{error}</div>}
        {success && <div className="rpm-success-banner">{success}</div>}

        {loading ? (
          <p className="rpm-muted">Loading permissions...</p>
        ) : (
          <div className="rpm-table-wrap">
            <table className="rpm-table">
              <thead>
                <tr>
                  <th>Module</th>
                  {ACTIONS.map((a) => <th key={a}>{a}</th>)}
                  <th>Row Actions</th>
                </tr>
              </thead>
              <tbody>
                {Object.keys(grouped).sort().map((moduleKey) => (
                  <tr key={moduleKey}>
                    <td className="rpm-module-cell">{moduleKey}</td>
                    {ACTIONS.map((action) => {
                      const permId = grouped[moduleKey][action];
                      if (!permId) return <td key={action} className="rpm-na">-</td>;
                      return (
                        <td key={action}>
                          <input type="checkbox" checked={!!grants[permId]} onChange={() => toggle(permId)} />
                        </td>
                      );
                    })}
                    <td>
                      <button type="button" className="rpm-link-btn" onClick={() => selectAllForModule(moduleKey)}>All</button>{" "}
                      <button type="button" className="rpm-link-btn" onClick={() => clearAllForModule(moduleKey)}>None</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
