import { useEffect, useState } from "react";
import "./AccessRestrictions.css";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default function AccessRestrictions() {
  const [isSuperAdmin, setIsSuperAdmin] = useState(null);
  const [restrictions, setRestrictions] = useState([]);
  const [users, setUsers] = useState([]);
  const [permissions, setPermissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [form, setForm] = useState({ userId: "", permissionId: "", granted: "false", reason: "" });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await fetch(`${API_URL}/api/me/permissions`, { headers: authHeaders() });
      const data = await res.json();
      const superAdmin = res.ok && data.user?.roleCode === "SUPER_ADMIN";
      setIsSuperAdmin(superAdmin);
      if (!superAdmin) return;
      await loadAll();
    })();
  }, []);

  async function loadAll() {
    setLoading(true);
    setError("");
    try {
      const [restrictionsRes, usersRes, permissionsRes] = await Promise.all([
        fetch(`${API_URL}/api/access-restrictions`, { headers: authHeaders() }),
        fetch(`${API_URL}/api/users`, { headers: authHeaders() }),
        fetch(`${API_URL}/api/permissions`, { headers: authHeaders() }),
      ]);
      const restrictionsData = await restrictionsRes.json();
      if (!restrictionsRes.ok) {
        setError(restrictionsData.message || "Failed to load restrictions");
        return;
      }
      setRestrictions(restrictionsData);
      setUsers(await usersRes.json());
      setPermissions(await permissionsRes.json());
    } catch (err) {
      console.error("LOAD ACCESS RESTRICTIONS ERROR:", err);
      setError("Unable to connect to the server.");
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(e) {
    e.preventDefault();
    if (!form.userId || !form.permissionId) {
      alert("Select a user and a permission.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`${API_URL}/api/access-restrictions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          userId: Number(form.userId),
          permissionId: Number(form.permissionId),
          granted: form.granted === "true",
          reason: form.reason,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.message || "Failed to create restriction");
        return;
      }
      setForm({ userId: "", permissionId: "", granted: "false", reason: "" });
      loadAll();
    } catch (err) {
      console.error("CREATE RESTRICTION ERROR:", err);
      alert("Unable to connect to the server.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id) {
    if (!confirm("Remove this restriction? The user reverts to their role's default for this permission.")) return;
    try {
      const res = await fetch(`${API_URL}/api/access-restrictions/${id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.message || "Failed to remove restriction");
        return;
      }
      loadAll();
    } catch (err) {
      console.error("DELETE RESTRICTION ERROR:", err);
      alert("Unable to connect to the server.");
    }
  }

  if (isSuperAdmin === null) {
    return <div className="ar-page"><p className="ar-muted">Loading...</p></div>;
  }

  if (isSuperAdmin === false) {
    return (
      <div className="ar-page">
        <div className="ar-card">
          <h1>Access Restrictions</h1>
          <div className="ar-error-banner">Only the Super Admin can view or configure access restrictions.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="ar-page">
      <h1>Access Restrictions</h1>
      <p className="ar-intro">
        User-specific overrides take precedence over role defaults - use this to grant an exception
        or deny something a user's role would otherwise allow.
      </p>

      <div className="ar-card">
        <h2>Add Restriction</h2>
        <form className="ar-form" onSubmit={handleCreate}>
          <div className="ar-field">
            <label>User</label>
            <select value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })} required>
              <option value="">Select user</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.full_name} ({u.role_name})</option>
              ))}
            </select>
          </div>

          <div className="ar-field">
            <label>Permission</label>
            <select value={form.permissionId} onChange={(e) => setForm({ ...form, permissionId: e.target.value })} required>
              <option value="">Select permission</option>
              {permissions.map((p) => (
                <option key={p.id} value={p.id}>{p.module_key} - {p.action}</option>
              ))}
            </select>
          </div>

          <div className="ar-field">
            <label>Effect</label>
            <select value={form.granted} onChange={(e) => setForm({ ...form, granted: e.target.value })}>
              <option value="false">Deny</option>
              <option value="true">Allow</option>
            </select>
          </div>

          <div className="ar-field ar-field-wide">
            <label>Reason (optional)</label>
            <input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="Why this exception exists" />
          </div>

          <button type="submit" className="ar-btn-primary" disabled={submitting}>
            {submitting ? "Adding..." : "Add Restriction"}
          </button>
        </form>
      </div>

      <div className="ar-card">
        <h2>Active Restrictions</h2>
        {error && <div className="ar-error-banner">{error}</div>}
        {loading ? (
          <p className="ar-muted">Loading...</p>
        ) : restrictions.length === 0 ? (
          <p className="ar-muted">No user-specific restrictions configured.</p>
        ) : (
          <div className="ar-table-wrap">
            <table className="ar-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Permission</th>
                  <th>Effect</th>
                  <th>Reason</th>
                  <th>Set By</th>
                  <th>Date</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {restrictions.map((r) => (
                  <tr key={r.id}>
                    <td>{r.full_name}</td>
                    <td>{r.module_key} - {r.action}</td>
                    <td>
                      <span className={`ar-badge ${r.granted ? "ar-badge-allow" : "ar-badge-deny"}`}>
                        {r.granted ? "Allow" : "Deny"}
                      </span>
                    </td>
                    <td>{r.reason || "-"}</td>
                    <td>{r.created_by_username}</td>
                    <td>{new Date(r.created_at).toLocaleDateString()}</td>
                    <td>
                      <button type="button" className="ar-link-btn" onClick={() => handleDelete(r.id)}>Remove</button>
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
