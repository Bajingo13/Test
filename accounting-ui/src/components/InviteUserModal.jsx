import { useEffect, useState } from "react";
import "./InviteUserModal.css";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Mirrors invitationService's INVITABLE_ROLES_BY_INVITER - the server is
// the authority (it rejects anything else); this only keeps the dropdown
// from offering roles the inviter isn't allowed to choose.
const INVITABLE_ROLES_BY_INVITER = {
  SUPER_ADMIN: ["ADMIN", "ACCOUNTANT"],
  ADMIN: ["ACCOUNTANT"],
};

// Everything the form needs before it can be submitted. If any request
// fails the form stays disabled (with a Retry) rather than submitting an
// invitation built from partial data.
const LOOKUPS = [
  { key: "roles", path: "/api/roles", label: "roles" },
  { key: "companies", path: "/api/companies", label: "companies" },
  { key: "branches", path: "/api/branches", label: "branches" },
  { key: "templates", path: "/api/permission-templates", label: "permission templates" },
];

export default function InviteUserModal({ open, onClose, onInvited, inviterRoleCode = "" }) {
  const [roles, setRoles] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [branches, setBranches] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [lookupsLoading, setLookupsLoading] = useState(false);
  const [lookupError, setLookupError] = useState("");

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

  async function loadLookups() {
    setLookupsLoading(true);
    setLookupError("");
    const failed = [];
    const loaded = {};
    await Promise.all(
      LOOKUPS.map(async ({ key, path, label }) => {
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
      })
    );
    setRoles(loaded.roles || []);
    setCompanies(loaded.companies || []);
    setBranches(loaded.branches || []);
    setTemplates(loaded.templates || []);
    if (failed.length) {
      setLookupError(`Could not load ${failed.join(", ")}. The invitation can't be sent until this loads - try again.`);
    }
    setLookupsLoading(false);
  }

  useEffect(() => {
    if (!open) return;
    setForm({ email: "", fullName: "", roleId: "", companyIds: [], branchIds: [], expiresInDays: 7, permissionTemplateId: "" });
    setError("");
    setResult(null);
    loadLookups();
  }, [open]);

  if (!open) return null;

  const allowedRoleCodes = INVITABLE_ROLES_BY_INVITER[inviterRoleCode] || [];
  const invitableRoles = roles.filter((r) => allowedRoleCodes.includes(r.code));
  const formReady = !lookupsLoading && !lookupError;

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

    if (!formReady) {
      setError("The form hasn't finished loading. Please retry loading it first.");
      return;
    }
    if (!form.email.trim() || !form.fullName.trim() || !form.roleId) {
      setError("Email, full name, and role are required.");
      return;
    }
    if (form.companyIds.length === 0) {
      setError("Select at least one company for the invited user.");
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
              {result.emailDelivered === false ? (
                <>
                  <p>Invitation created — email not sent. Share the invitation link manually.</p>
                  <p className="ium-muted">Invitation link for <strong>{result.email}</strong>:</p>
                  <code className="ium-link-box">{result.acceptUrl}</code>
                </>
              ) : (
                <p>Invitation sent to <strong>{result.email}</strong>.</p>
              )}
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              {lookupsLoading && <p className="ium-muted">Loading roles and companies...</p>}
              {lookupError && (
                <div className="ium-error-banner" role="alert">
                  {lookupError}{" "}
                  <button type="button" className="ium-btn-secondary" onClick={loadLookups}>
                    Retry
                  </button>
                </div>
              )}

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
                  {invitableRoles.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </div>

              <div className="ium-field">
                <label>Companies (at least one)</label>
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
                <button type="submit" className="ium-btn-primary" disabled={submitting || !formReady}>
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
