import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import usePermissions from "../../hooks/usePermissions";
import "../FILESETUP/FileSetupPages.css";
import "../FILESETUP/BranchManagement.css";
import "./CompanyManagement.css";

// Company Management - Super Admin creates a NEW company (FILESETUP.COMPANIES /
// CREATE, granted to no role). The API enforces it; this page only reflects it.
// Creating a company makes the company row and its PHP base currency, nothing
// else: its Admin is then assigned in User Settings and adds its branches in
// Branches. No delete (there is no company deletion model).
const API_BASE = import.meta.env.VITE_API_URL || "";
const EMPTY = { name: "", tin: "", branchCode: "", address: "", zip: "", telephone: "", email: "", vatRegistered: true };

function fieldFor(code = "") {
  if (code.startsWith("COMPANY_NAME")) return "name";
  if (code.startsWith("COMPANY_TIN")) return "tin";
  if (code.startsWith("COMPANY_BRANCH_CODE")) return "branchCode";
  if (code.startsWith("COMPANY_EMAIL")) return "email";
  if (code.startsWith("COMPANY_ADDRESS")) return "address";
  if (code.startsWith("COMPANY_ZIP")) return "zip";
  if (code.startsWith("COMPANY_TELEPHONE")) return "telephone";
  return null;
}

export default function CompanyManagement() {
  const { can, loading: permsLoading } = usePermissions();
  const canCreate = can("FILESETUP.COMPANIES", "CREATE");
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState({ tone: "", text: "" });
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/company-management`, { credentials: "include", headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        if (res.status === 403) return; // the page shows its no-permission message
        setNotice({ tone: "error", text: data.message || "Failed to load companies." });
        return;
      }
      setCompanies(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("LOAD COMPANIES ERROR:", err);
      setNotice({ tone: "error", text: "Unable to connect to server." });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (permsLoading) return;
    if (canCreate) load();
    else setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permsLoading]);

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
    setFieldErrors((e) => ({ ...e, [field]: undefined }));
  }

  async function save() {
    const errors = {};
    if (!form.name.trim()) errors.name = "Company Name is required.";
    if (!form.tin.trim()) errors.tin = "TIN is required.";
    if (Object.keys(errors).length) { setFieldErrors(errors); return; }
    setSaving(true);
    setFormError("");
    try {
      const res = await fetch(`${API_BASE}/api/company-management`, {
        method: "POST",
        credentials: "include",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        const field = fieldFor(data.code);
        if (field) setFieldErrors({ [field]: data.message });
        else setFormError(data.message || "Failed to create company.");
        return;
      }
      setForm(null);
      setNotice({ tone: "success", text: `Company created: ${data.company?.name} (base currency ${data.company?.baseCurrency}). Next: assign its Admin in User Settings, then add its branches in Branches.` });
      await load();
    } catch (err) {
      console.error("CREATE COMPANY ERROR:", err);
      setFormError("Unable to connect to server.");
    } finally {
      setSaving(false);
    }
  }

  if (!permsLoading && !canCreate) {
    return (
      <div className="fs-page br-page">
        <div className="fs-card" role="alert">You do not have permission to manage companies.</div>
      </div>
    );
  }

  const err = (f) => (fieldErrors[f] ? <span className="fs-field-error" role="alert">{fieldErrors[f]}</span> : null);
  const cls = (f) => (fieldErrors[f] ? "fs-input-error" : "");

  return (
    <div className="fs-page br-page cm-page">
      <div className="fs-header">
        <div>
          <h1>Company Management</h1>
          <p>Create a new company. It starts empty - no customers, suppliers, transactions or history are copied - with PHP as its base currency.</p>
        </div>
        <button className="fs-btn primary" onClick={() => { setForm({ ...EMPTY }); setFieldErrors({}); setFormError(""); setNotice({ tone: "", text: "" }); }} disabled={Boolean(form)}>
          + Create Company
        </button>
      </div>

      {notice.text ? (
        <div className={notice.tone === "error" ? "fs-banner-error" : "br-banner-success"} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</div>
      ) : null}

      {form ? (
        <div className="fs-card br-form" aria-labelledby="cm-form-title">
          <h2 id="cm-form-title">Create Company</h2>
          {formError ? <div className="fs-banner-error" role="alert">{formError}</div> : null}
          <div className="fs-grid">
            <div className="fs-field">
              <label htmlFor="cm-name">Company Name</label>
              <input id="cm-name" value={form.name} onChange={(e) => update("name", e.target.value)} maxLength={255} className={cls("name")} aria-invalid={Boolean(fieldErrors.name)} />
              {err("name")}
            </div>
            <div className="fs-field">
              <label htmlFor="cm-tin">TIN</label>
              <input id="cm-tin" value={form.tin} onChange={(e) => update("tin", e.target.value)} placeholder="000-000-000-000" maxLength={20} className={cls("tin")} aria-invalid={Boolean(fieldErrors.tin)} />
              {err("tin")}
            </div>
            <div className="fs-field">
              <label htmlFor="cm-branch-code">BIR Branch Code</label>
              <input id="cm-branch-code" value={form.branchCode} onChange={(e) => update("branchCode", e.target.value)} placeholder="000" maxLength={20} className={cls("branchCode")} />
              {err("branchCode") || <span className="fs-field-hint">The TIN branch suffix (head office: 000) - not a Branch Management code.</span>}
            </div>
            <div className="fs-field">
              <label htmlFor="cm-address">Address</label>
              <input id="cm-address" value={form.address} onChange={(e) => update("address", e.target.value)} maxLength={255} className={cls("address")} />
              {err("address")}
            </div>
            <div className="fs-field">
              <label htmlFor="cm-zip">ZIP</label>
              <input id="cm-zip" value={form.zip} onChange={(e) => update("zip", e.target.value)} maxLength={20} className={cls("zip")} />
              {err("zip")}
            </div>
            <div className="fs-field">
              <label htmlFor="cm-telephone">Telephone</label>
              <input id="cm-telephone" value={form.telephone} onChange={(e) => update("telephone", e.target.value)} maxLength={50} className={cls("telephone")} />
              {err("telephone")}
            </div>
            <div className="fs-field">
              <label htmlFor="cm-email">Email</label>
              <input id="cm-email" type="email" value={form.email} onChange={(e) => update("email", e.target.value)} maxLength={255} className={cls("email")} />
              {err("email")}
            </div>
            <div className="fs-field cm-check">
              <label htmlFor="cm-vat">
                <input id="cm-vat" type="checkbox" checked={form.vatRegistered} onChange={(e) => update("vatRegistered", e.target.checked)} /> VAT registered
              </label>
            </div>
          </div>
          <div className="fs-actions">
            <button className="fs-btn" onClick={() => setForm(null)} disabled={saving}>Cancel</button>
            <button className="fs-btn primary" onClick={save} disabled={saving}>{saving ? "Creating..." : "Create Company"}</button>
          </div>
        </div>
      ) : null}

      <div className="fs-card">
        <p className="br-summary" aria-live="polite">{loading ? "Loading companies..." : `${companies.length} compan${companies.length === 1 ? "y" : "ies"}`}</p>
        <table className="fs-table br-table">
          <thead>
            <tr>
              <th>Company</th>
              <th>TIN</th>
              <th>Status</th>
              <th>Branches</th>
              <th>Users</th>
              <th>Base Currency</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="fs-empty">Loading...</td></tr>
            ) : companies.length === 0 ? (
              <tr><td colSpan={7} className="fs-empty">No companies yet.</td></tr>
            ) : (
              companies.map((c) => (
                <tr key={c.id}>
                  <td className="br-code">{c.name}</td>
                  <td>{c.tin || "—"}{c.branchCode ? ` · ${c.branchCode}` : ""}</td>
                  <td><span className={`br-status br-status--${c.status === "ACTIVE" ? "active" : "inactive"}`}>{c.status}</span></td>
                  <td>{c.branchCount}</td>
                  <td>{c.userCount}</td>
                  <td>{c.baseCurrency || "—"}</td>
                  <td><Link className="cm-link" to={`/company-profile?companyId=${c.id}`}>Company Profile</Link></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
