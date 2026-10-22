import { useEffect, useState } from "react";
import "./UserAccessDrawer.css";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Mirrors userService's ASSIGNABLE_ROLES_BY_ACTOR / MANAGEABLE_ROLES_BY_ACTOR.
// The server is the authority (it rejects anything else); this only keeps
// the form from offering changes the actor isn't allowed to make.
export const ASSIGNABLE_ROLES_BY_ACTOR = {
  SUPER_ADMIN: ["ADMIN", "ACCOUNTANT"],
  ADMIN: ["ACCOUNTANT"],
};

export const MANAGEABLE_ROLES_BY_ACTOR = {
  SUPER_ADMIN: ["SUPER_ADMIN", "ADMIN", "ACCOUNTANT"],
  ADMIN: ["ACCOUNTANT"],
};

// Everything the form needs before it can be saved. If any request fails
// the form stays disabled (with a Retry) rather than saving a membership
// list built from partial data.
const LOOKUPS = [
  { key: "roles", path: "/api/roles", label: "roles" },
  { key: "companies", path: "/api/companies", label: "companies" },
  { key: "branches", path: "/api/branches", label: "branches" },
];

const EMPTY_FORM = { fullName: "", roleId: "", companyIds: [], branchIds: [] };

export default function UserAccessDrawer({ open, userId, currentUser, onClose, onSaved }) {
  const [user, setUser] = useState(null);
  const [roles, setRoles] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [branches, setBranches] = useState([]);

  const [form, setForm] = useState(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setLoadError("");
    setError("");
    setUser(null);
    setForm(EMPTY_FORM);

    const failed = [];
    const loaded = {};
    let userData = null;
    let userError = "";

    await Promise.all([
      (async () => {
        try {
          const res = await fetch(`${API_URL}/api/users/${userId}`, { headers: authHeaders() });
          const data = await res.json().catch(() => null);
          if (!res.ok || !data || !Array.isArray(data.companies) || !Array.isArray(data.branches)) {
            userError = data?.message || "Could not load this user.";
            return;
          }
          userData = data;
        } catch {
          userError = "Could not load this user.";
        }
      })(),
      ...LOOKUPS.map(async ({ key, path, label }) => {
        try {
          const res = await fetch(`${API_URL}${path}`, { headers: authHeaders() });
          const data = await res.json().catch(() => null);
          if (!res.ok || !Array.isArray(data)) {
            failed.push(label);
            return;
          }
          loaded[key] = data;
        } catch {
          failed.push(label);
        }
      }),
    ]);

    if (userError || failed.length) {
      setLoadError(
        [userError, failed.length ? `Could not load ${failed.join(", ")}.` : ""].filter(Boolean).join(" ") +
          " Changes can't be saved until this loads - try again."
      );
      setLoading(false);
      return;
    }

    const companyScope = new Set(loaded.companies.map((c) => c.id));
    const branchScope = new Set(loaded.branches.map((b) => b.id));
    setUser(userData);
    setRoles(loaded.roles);
    setCompanies(loaded.companies);
    setBranches(loaded.branches);
    // Only in-scope memberships are editable here; the server keeps the rest.
    setForm({
      fullName: userData.full_name || "",
      roleId: userData.role_id ? String(userData.role_id) : "",
      companyIds: userData.companies.map((c) => c.id).filter((id) => companyScope.has(id)),
      branchIds: userData.branches.map((b) => b.id).filter((id) => branchScope.has(id)),
    });
    setLoading(false);
  }

  useEffect(() => {
    if (!open || !userId) return;
    load();
  }, [open, userId]);

  if (!open) return null;

  const actorRole = currentUser?.roleCode || "";
  const isSelf = !!user && Number(user.id) === Number(currentUser?.id);
  const companyScope = new Set(companies.map((c) => c.id));
  const branchScope = new Set(branches.map((b) => b.id));
  const outOfScopeCompanies = user ? user.companies.filter((c) => !companyScope.has(c.id)) : [];
  const outOfScopeBranches = user ? user.branches.filter((b) => !branchScope.has(b.id)) : [];
  const hasOutOfScope = outOfScopeCompanies.length > 0 || outOfScopeBranches.length > 0;

  const assignableCodes = ASSIGNABLE_ROLES_BY_ACTOR[actorRole] || [];
  const canChangeRole =
    !!user &&
    !isSelf &&
    user.role_code !== "SUPER_ADMIN" &&
    (MANAGEABLE_ROLES_BY_ACTOR[actorRole] || []).includes(user.role_code);
  const roleOptions = canChangeRole
    ? roles.filter((r) => assignableCodes.includes(r.code))
    : roles.filter((r) => user && r.id === user.role_id);

  const formReady = !loading && !loadError && !!user;

  function toggleCompany(id) {
    setForm((prev) => ({
      ...prev,
      companyIds: prev.companyIds.includes(id) ? prev.companyIds.filter((c) => c !== id) : [...prev.companyIds, id],
    }));
  }

  function toggleBranch(id) {
    setForm((prev) => ({
      ...prev,
      branchIds: prev.branchIds.includes(id) ? prev.branchIds.filter((b) => b !== id) : [...prev.branchIds, id],
    }));
  }

  async function handleSave() {
    setError("");
    if (!formReady) {
      setError("The form hasn't finished loading. Please retry loading it first.");
      return;
    }
    const finalRoleCode = roles.find((r) => String(r.id) === String(form.roleId))?.code || user.role_code;
    if (finalRoleCode !== "SUPER_ADMIN" && form.companyIds.length + outOfScopeCompanies.length === 0) {
      setError("Select at least one company for this user.");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          fullName: form.fullName,
          roleId: canChangeRole ? form.roleId : user.role_id,
          companyIds: form.companyIds,
          branchIds: form.branchIds,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || "Failed to save changes");
        return;
      }
      onSaved?.();
      onClose();
    } catch (err) {
      console.error("SAVE USER ACCESS ERROR:", err);
      setError("Unable to connect to the server.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="uad-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="uad-drawer" role="dialog" aria-modal="true" aria-label="Edit User Access">
        <div className="uad-header">
          <h2>Edit User Access</h2>
          <button type="button" className="uad-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        <div className="uad-body">
          {loading ? (
            <p className="uad-muted">Loading...</p>
          ) : loadError ? (
            <div className="uad-error-banner uad-load-error" role="alert">
              <span>{loadError}</span>
              <button type="button" className="uad-btn-secondary uad-retry" onClick={load}>
                Retry
              </button>
            </div>
          ) : (
            <>
              <p className="uad-muted">
                {user.username} · Currently <strong>{user.role_name}</strong>
              </p>

              {isSelf && (
                <div className="uad-notice uad-notice-warning" role="note">
                  You are editing your own account. Your role can't be changed here.
                </div>
              )}

              {hasOutOfScope && (
                <div className="uad-notice" role="note">
                  Access outside your management scope is preserved.
                </div>
              )}

              <div className="uad-field">
                <label htmlFor="uad-full-name">Full Name</label>
                <input
                  id="uad-full-name"
                  value={form.fullName}
                  onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                />
              </div>

              <div className="uad-field">
                <label htmlFor="uad-role">Role</label>
                <select
                  id="uad-role"
                  value={form.roleId}
                  disabled={!canChangeRole}
                  onChange={(e) => setForm({ ...form, roleId: e.target.value })}
                >
                  {roleOptions.map((r) => (
                    <option key={r.id} value={String(r.id)}>{r.name}</option>
                  ))}
                </select>
                {!canChangeRole && !isSelf && (
                  <span className="uad-hint">This user's role can't be changed by you.</span>
                )}
              </div>

              <div className="uad-field">
                <label>Companies (at least one)</label>
                <div className="uad-checkbox-group">
                  {companies.map((c) => (
                    <label key={c.id} className="uad-checkbox">
                      <input type="checkbox" checked={form.companyIds.includes(c.id)} onChange={() => toggleCompany(c.id)} />
                      <span>{c.name}</span>
                    </label>
                  ))}
                  {companies.length === 0 && <p className="uad-empty">No companies available.</p>}
                </div>
              </div>

              <div className="uad-field">
                <label>Branches</label>
                <div className="uad-checkbox-group">
                  {branches.map((b) => (
                    <label key={b.id} className="uad-checkbox">
                      <input type="checkbox" checked={form.branchIds.includes(b.id)} onChange={() => toggleBranch(b.id)} />
                      <span>{b.name}</span>
                    </label>
                  ))}
                  {branches.length === 0 && <p className="uad-empty">No branches available.</p>}
                </div>
              </div>

              {error && <div className="uad-error-banner" role="alert">{error}</div>}
            </>
          )}
        </div>

        <div className="uad-footer">
          <button type="button" className="uad-btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="uad-btn-primary" onClick={handleSave} disabled={saving || !formReady}>
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
