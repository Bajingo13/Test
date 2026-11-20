import { useEffect, useMemo, useState } from "react";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import usePermissions from "../../hooks/usePermissions";
import "./FileSetupPages.css";
import "./BranchManagement.css";

// Company Branch Management (ONE company -> MANY branches). Master data only.
// The API (/api/company-branches) enforces permissions and company isolation;
// this page only REFLECTS them (controls hidden without the permission).
const API_BASE = import.meta.env.VITE_API_URL || "";
const MODULE_KEY = "FILESETUP.BRANCHES";
const EMPTY_FORM = { id: null, companyId: "", code: "", name: "", address: "", telephone: "", email: "" };

// server error code -> the field it belongs to (everything else is a banner)
function fieldFor(code = "") {
  if (code.startsWith("BRANCH_CODE")) return "code";
  if (code.startsWith("BRANCH_NAME")) return "name";
  if (code.startsWith("BRANCH_EMAIL")) return "email";
  if (code.startsWith("BRANCH_TELEPHONE")) return "telephone";
  if (code.startsWith("BRANCH_ADDRESS")) return "address";
  if (code.startsWith("COMPANY_") || code === "BRANCH_COMPANY_INVALID") return "companyId";
  return null;
}

export default function BranchManagement() {
  const { can, loading: permsLoading } = usePermissions();
  const canView = permsLoading || can(MODULE_KEY, "VIEW");
  const canCreate = can(MODULE_KEY, "CREATE");
  const canEdit = can(MODULE_KEY, "EDIT");
  const canActivate = can(MODULE_KEY, "ACTIVATE");
  const canDeactivate = can(MODULE_KEY, "DEACTIVATE");
  const hasActions = canEdit || canActivate || canDeactivate;

  const [branches, setBranches] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [companyFilter, setCompanyFilter] = useState("");
  const [form, setForm] = useState(null); // null = no form open
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState({ tone: "", text: "" });
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const multiCompany = companies.length > 1;

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/companies`, { credentials: "include", headers: authHeaders() });
        if (!res.ok) { handleAuthError(res.status); return; }
        const data = await res.json();
        setCompanies(Array.isArray(data) ? data : []);
      } catch (err) {
        console.error("LOAD COMPANIES ERROR:", err);
      }
    })();
  }, []);

  async function loadBranches() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("search", search.trim());
      if (statusFilter !== "ALL") params.set("status", statusFilter);
      if (companyFilter) params.set("companyId", companyFilter);
      const res = await fetch(`${API_BASE}/api/company-branches?${params}`, { credentials: "include", headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        if (res.status === 403) return; // the page shows its no-permission message
        setNotice({ tone: "error", text: data.message || "Failed to load branches." });
        return;
      }
      setBranches(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("LOAD BRANCHES ERROR:", err);
      setNotice({ tone: "error", text: "Unable to connect to server." });
    } finally {
      setLoading(false);
    }
  }

  // server-side search / filters (debounced while typing)
  useEffect(() => {
    if (permsLoading || !can(MODULE_KEY, "VIEW")) { setLoading(false); return undefined; }
    const t = setTimeout(loadBranches, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, statusFilter, companyFilter, permsLoading]);

  const counts = useMemo(() => ({
    total: branches.length,
    inactive: branches.filter((b) => b.status === "INACTIVE").length,
  }), [branches]);

  function openAdd() {
    setForm({ ...EMPTY_FORM, companyId: multiCompany ? companyFilter || "" : String(companies[0]?.id || "") });
    setFieldErrors({});
    setFormError("");
    setNotice({ tone: "", text: "" });
  }

  function openEdit(b) {
    setForm({ id: b.id, companyId: String(b.companyId), companyName: b.companyName, code: b.code || "", name: b.name || "", address: b.address || "", telephone: b.telephone || "", email: b.email || "" });
    setFieldErrors({});
    setFormError("");
    setNotice({ tone: "", text: "" });
  }

  function closeForm() {
    setForm(null);
    setFieldErrors({});
    setFormError("");
  }

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
    setFieldErrors((e) => ({ ...e, [field]: undefined }));
  }

  async function save() {
    const errors = {};
    if (!form.code.trim()) errors.code = "Branch Code is required.";
    if (!form.name.trim()) errors.name = "Branch Name is required.";
    if (!form.id && multiCompany && !form.companyId) errors.companyId = "Company is required.";
    if (Object.keys(errors).length) { setFieldErrors(errors); return; }

    setSaving(true);
    setFormError("");
    try {
      const editing = Boolean(form.id);
      const body = { code: form.code, name: form.name, address: form.address, telephone: form.telephone, email: form.email };
      if (!editing && form.companyId) body.companyId = Number(form.companyId);
      const res = await fetch(`${API_BASE}/api/company-branches${editing ? `/${form.id}` : ""}`, {
        method: editing ? "PUT" : "POST",
        credentials: "include",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        const field = fieldFor(data.code);
        if (field) setFieldErrors({ [field]: data.message });
        else setFormError(data.message || "Failed to save branch.");
        return;
      }
      closeForm();
      setNotice({ tone: "success", text: `${data.message || "Branch saved."} ${data.branch?.code || ""} - ${data.branch?.name || ""}`.trim() });
      await loadBranches();
    } catch (err) {
      console.error("SAVE BRANCH ERROR:", err);
      setFormError("Unable to connect to server.");
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(b, status) {
    setBusyId(b.id);
    setNotice({ tone: "", text: "" });
    try {
      const res = await fetch(`${API_BASE}/api/company-branches/${b.id}/status`, {
        method: "PATCH",
        credentials: "include",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        setNotice({ tone: "error", text: data.message || "Failed to change branch status." });
        return;
      }
      setNotice({ tone: "success", text: `${b.code} - ${b.name}: ${data.message}` });
      await loadBranches();
    } catch (err) {
      console.error("BRANCH STATUS ERROR:", err);
      setNotice({ tone: "error", text: "Unable to connect to server." });
    } finally {
      setBusyId(null);
    }
  }

  if (!canView) {
    return (
      <div className="fs-page br-page">
        <div className="fs-card" role="alert">You do not have permission to view Branches.</div>
      </div>
    );
  }

  const filtersActive = Boolean(search.trim() || statusFilter !== "ALL" || companyFilter);
  const fieldClass = (f) => (fieldErrors[f] ? "fs-input-error" : "");

  return (
    <div className="fs-page br-page">
      <div className="fs-header">
        <div>
          <h1>Branches</h1>
          <p>The branches under each company. Inactive branches stay in the list and history but are no longer active branches.</p>
        </div>
        {canCreate ? (
          <button className="fs-btn primary" onClick={openAdd} disabled={Boolean(form)}>
            + Add Branch
          </button>
        ) : null}
      </div>

      {notice.text ? (
        <div className={notice.tone === "error" ? "fs-banner-error" : "br-banner-success"} role={notice.tone === "error" ? "alert" : "status"}>
          {notice.text}
        </div>
      ) : null}

      {form ? (
        <div className="fs-card br-form" aria-labelledby="br-form-title">
          <h2 id="br-form-title">{form.id ? "Edit Branch" : "Add Branch"}</h2>
          {formError ? <div className="fs-banner-error" role="alert">{formError}</div> : null}
          <div className="fs-grid">
            <div className="fs-field">
              <label htmlFor="br-company">Company</label>
              {!form.id && multiCompany ? (
                <select id="br-company" value={form.companyId} onChange={(e) => update("companyId", e.target.value)} className={fieldClass("companyId")} aria-invalid={Boolean(fieldErrors.companyId)}>
                  <option value="">Select a company...</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              ) : (
                <input id="br-company" value={form.id ? form.companyName : companies[0]?.name || ""} readOnly aria-readonly="true" className="br-readonly" />
              )}
              {form.id ? <span className="fs-field-hint">A branch's company cannot be changed.</span> : null}
              {fieldErrors.companyId ? <span className="fs-field-error" role="alert">{fieldErrors.companyId}</span> : null}
            </div>
            <div className="fs-field">
              <label htmlFor="br-code">Branch Code</label>
              <input id="br-code" value={form.code} onChange={(e) => update("code", e.target.value)} placeholder="MAIN" maxLength={50} className={fieldClass("code")} aria-invalid={Boolean(fieldErrors.code)} />
              {fieldErrors.code ? <span className="fs-field-error" role="alert">{fieldErrors.code}</span> : <span className="fs-field-hint">Unique within the company. Letters, numbers, - and _.</span>}
            </div>
            <div className="fs-field">
              <label htmlFor="br-name">Branch Name</label>
              <input id="br-name" value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="Main Branch" maxLength={255} className={fieldClass("name")} aria-invalid={Boolean(fieldErrors.name)} />
              {fieldErrors.name ? <span className="fs-field-error" role="alert">{fieldErrors.name}</span> : null}
            </div>
            <div className="fs-field">
              <label htmlFor="br-address">Address</label>
              <input id="br-address" value={form.address} onChange={(e) => update("address", e.target.value)} maxLength={255} className={fieldClass("address")} />
              {fieldErrors.address ? <span className="fs-field-error" role="alert">{fieldErrors.address}</span> : null}
            </div>
            <div className="fs-field">
              <label htmlFor="br-telephone">Telephone</label>
              <input id="br-telephone" value={form.telephone} onChange={(e) => update("telephone", e.target.value)} maxLength={50} className={fieldClass("telephone")} />
              {fieldErrors.telephone ? <span className="fs-field-error" role="alert">{fieldErrors.telephone}</span> : null}
            </div>
            <div className="fs-field">
              <label htmlFor="br-email">Email</label>
              <input id="br-email" type="email" value={form.email} onChange={(e) => update("email", e.target.value)} maxLength={255} className={fieldClass("email")} aria-invalid={Boolean(fieldErrors.email)} />
              {fieldErrors.email ? <span className="fs-field-error" role="alert">{fieldErrors.email}</span> : null}
            </div>
          </div>
          <div className="fs-actions">
            <button className="fs-btn" onClick={closeForm} disabled={saving}>Cancel</button>
            <button className="fs-btn primary" onClick={save} disabled={saving}>
              {saving ? "Saving..." : form.id ? "Update Branch" : "Save Branch"}
            </button>
          </div>
        </div>
      ) : null}

      <div className="fs-card">
        <div className="fs-toolbar br-toolbar">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search code, name or address..."
            aria-label="Search branches"
          />
          <div className="br-filters">
            {multiCompany ? (
              <select value={companyFilter} onChange={(e) => setCompanyFilter(e.target.value)} aria-label="Company">
                <option value="">All my companies</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            ) : null}
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Status">
              <option value="ALL">All statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
            </select>
          </div>
        </div>

        <p className="br-summary" aria-live="polite">
          {loading ? "Loading branches..." : `${counts.total} branch${counts.total === 1 ? "" : "es"}${counts.inactive ? ` (${counts.inactive} inactive)` : ""}`}
        </p>

        <table className="fs-table br-table">
          <thead>
            <tr>
              <th>Branch Code</th>
              <th>Branch Name</th>
              <th>Company</th>
              <th>Status</th>
              <th>Address / Contact</th>
              {hasActions ? <th>Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={hasActions ? 6 : 5} className="fs-empty">Loading...</td></tr>
            ) : branches.length === 0 ? (
              <tr>
                <td colSpan={hasActions ? 6 : 5} className="fs-empty">
                  {filtersActive ? "No branches match your search." : "No branches yet."}
                </td>
              </tr>
            ) : (
              branches.map((b) => (
                <tr key={b.id} className={b.status === "INACTIVE" ? "br-row-inactive" : undefined}>
                  <td className="br-code">{b.code}</td>
                  <td>{b.name}</td>
                  <td>{b.companyName}</td>
                  <td>
                    <span className={`br-status br-status--${b.status === "INACTIVE" ? "inactive" : "active"}`}>{b.status}</span>
                  </td>
                  <td className="br-contact">
                    {[b.address, b.telephone, b.email].filter(Boolean).join(" · ") || "—"}
                  </td>
                  {hasActions ? (
                    <td>
                      <div className="br-actions">
                        {canEdit ? <button className="fs-btn" onClick={() => openEdit(b)} disabled={Boolean(form) || busyId === b.id}>Edit</button> : null}
                        {b.status === "INACTIVE"
                          ? canActivate ? <button className="fs-btn" onClick={() => setStatus(b, "ACTIVE")} disabled={busyId === b.id}>Activate</button> : null
                          : canDeactivate ? <button className="fs-btn" onClick={() => setStatus(b, "INACTIVE")} disabled={busyId === b.id}>Deactivate</button> : null}
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
