import { useEffect, useState } from "react";
import "./UserAccessDrawer.css";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default function UserAccessDrawer({ open, userId, onClose, onSaved }) {
  const [user, setUser] = useState(null);
  const [roles, setRoles] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [branches, setBranches] = useState([]);

  const [form, setForm] = useState({ fullName: "", roleId: "", companyIds: [], branchIds: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || !userId) return;
    setLoading(true);
    setError("");

    (async () => {
      const [userRes, rolesRes, companiesRes, branchesRes] = await Promise.all([
        fetch(`${API_URL}/api/users/${userId}`, { headers: authHeaders() }),
        fetch(`${API_URL}/api/roles`, { headers: authHeaders() }),
        fetch(`${API_URL}/api/companies`, { headers: authHeaders() }),
        fetch(`${API_URL}/api/branches`, { headers: authHeaders() }),
      ]);

      const userData = await userRes.json();
      if (!userRes.ok) {
        setError(userData.message || "Failed to load user");
        setLoading(false);
        return;
      }

      setUser(userData);
      setRoles(await rolesRes.json());
      setCompanies(await companiesRes.json());
      setBranches(await branchesRes.json());
      setForm({
        fullName: userData.full_name || "",
        roleId: userData.role_id || "",
        companyIds: userData.companies.map((c) => c.id),
        branchIds: userData.branches.map((b) => b.id),
      });
      setLoading(false);
    })();
  }, [open, userId]);

  if (!open) return null;

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
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`${API_URL}/api/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(form),
      });
      const data = await res.json();
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
          ) : (
            <>
              {user && (
                <p className="uad-muted">
                  {user.username} · Currently <strong>{user.role_name}</strong>
                </p>
              )}

              <div className="uad-field">
                <label>Full Name</label>
                <input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
              </div>

              <div className="uad-field">
                <label>Role</label>
                <select value={form.roleId} onChange={(e) => setForm({ ...form, roleId: e.target.value })}>
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </div>

              <div className="uad-field">
                <label>Companies</label>
                <div className="uad-checkbox-group">
                  {companies.map((c) => (
                    <label key={c.id} className="uad-checkbox">
                      <input type="checkbox" checked={form.companyIds.includes(c.id)} onChange={() => toggleCompany(c.id)} />
                      <span>{c.name}</span>
                    </label>
                  ))}
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
                </div>
              </div>

              {error && <div className="uad-error-banner">{error}</div>}
            </>
          )}
        </div>

        <div className="uad-footer">
          <button type="button" className="uad-btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="uad-btn-primary" onClick={handleSave} disabled={saving || loading}>
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
