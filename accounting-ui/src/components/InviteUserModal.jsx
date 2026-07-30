import { useEffect, useState } from "react";
import "./InviteUserModal.css";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default function InviteUserModal({ open, onClose, onInvited }) {
  const [roles, setRoles] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [branches, setBranches] = useState([]);
  const [templates, setTemplates] = useState([]);

  const [form, setForm] = useState({
    email: "",
    fullName: "",
    roleId: "",
    companyIds: [],
    branchIds: [],
    expiresInDays: 7,
    permissionTemplateId: "",
  });

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!open) return;
    setForm({ email: "", fullName: "", roleId: "", companyIds: [], branchIds: [], expiresInDays: 7, permissionTemplateId: "" });
    setError("");
    setResult(null);

    (async () => {
      const [rolesRes, companiesRes, branchesRes, templatesRes] = await Promise.all([
        fetch(`${API_URL}/api/roles`, { headers: authHeaders() }),
        fetch(`${API_URL}/api/companies`, { headers: authHeaders() }),
        fetch(`${API_URL}/api/branches`, { headers: authHeaders() }),
        fetch(`${API_URL}/api/permission-templates`, { headers: authHeaders() }),
      ]);
      setRoles(await rolesRes.json());
      setCompanies(await companiesRes.json());
      setBranches(await branchesRes.json());
      setTemplates(await templatesRes.json());
    })();
  }, [open]);

  if (!open) return null;

  function toggleCompany(id) {
    setForm((prev) => ({
      ...prev,
      companyIds: prev.companyIds.includes(id)
        ? prev.companyIds.filter((c) => c !== id)
        : [...prev.companyIds, id],
    }));
  }

  function toggleBranch(id) {
    setForm((prev) => ({
      ...prev,
      branchIds: prev.branchIds.includes(id)
        ? prev.branchIds.filter((b) => b !== id)
        : [...prev.branchIds, id],
    }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

    if (!form.email.trim() || !form.fullName.trim() || !form.roleId) {
      setError("Email, full name, and role are required.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`${API_URL}/api/invitations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(form),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.message || "Failed to send invitation");
        return;
      }

      setResult(data);
      onInvited?.();
    } catch (err) {
      console.error("INVITE USER ERROR:", err);
      setError("Unable to connect to the server.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="ium-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ium-modal" role="dialog" aria-modal="true" aria-label="Invite User">
        <div className="ium-header">
          <h2>Invite User</h2>
          <button type="button" className="ium-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        <div className="ium-body">
          {result ? (
            <div className="ium-success-banner">
              <p>Invitation sent to <strong>{result.email}</strong>.</p>
              {result.emailDelivered === false && (
                <>
                  <p className="ium-muted">
                    Email delivery isn't configured yet - share this link with them manually:
                  </p>
                  <code className="ium-link-box">{result.acceptUrl}</code>
                </>
              )}
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              <div className="ium-field">
                <label>Email Address</label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  required
                />
              </div>

              <div className="ium-field">
                <label>Full Name</label>
                <input
                  type="text"
                  value={form.fullName}
                  onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                  required
                />
              </div>

              <div className="ium-field">
                <label>Role</label>
                <select value={form.roleId} onChange={(e) => setForm({ ...form, roleId: e.target.value })} required>
                  <option value="">Select role</option>
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </div>

              <div className="ium-field">
                <label>Companies</label>
                <div className="ium-checkbox-group">
                  {companies.map((c) => (
                    <label key={c.id} className="ium-checkbox">
                      <input type="checkbox" checked={form.companyIds.includes(c.id)} onChange={() => toggleCompany(c.id)} />
                      <span>{c.name}</span>
                    </label>
                  ))}
                  {companies.length === 0 && <p className="ium-muted">No companies available.</p>}
                </div>
              </div>

              <div className="ium-field">
                <label>Branches</label>
                <div className="ium-checkbox-group">
                  {branches.map((b) => (
                    <label key={b.id} className="ium-checkbox">
                      <input type="checkbox" checked={form.branchIds.includes(b.id)} onChange={() => toggleBranch(b.id)} />
                      <span>{b.name}</span>
                    </label>
                  ))}
                  {branches.length === 0 && <p className="ium-muted">No branches available.</p>}
                </div>
              </div>

              <div className="ium-field">
                <label>Permission Template (optional)</label>
                <select value={form.permissionTemplateId} onChange={(e) => setForm({ ...form, permissionTemplateId: e.target.value })}>
                  <option value="">Use role defaults</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>

              <div className="ium-field">
                <label>Invitation Expiration (days)</label>
                <input
                  type="number"
                  min="1"
                  max="30"
                  value={form.expiresInDays}
                  onChange={(e) => setForm({ ...form, expiresInDays: e.target.value })}
                />
              </div>

              {error && <div className="ium-error-banner">{error}</div>}

              <div className="ium-footer">
                <button type="button" className="ium-btn-secondary" onClick={onClose}>Cancel</button>
                <button type="submit" className="ium-btn-primary" disabled={submitting}>
                  {submitting ? "Sending..." : "Send Invitation"}
                </button>
              </div>
            </form>
          )}

          {result && (
            <div className="ium-footer">
              <button type="button" className="ium-btn-primary" onClick={onClose}>Done</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
