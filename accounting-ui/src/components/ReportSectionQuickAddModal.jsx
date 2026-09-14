import { useEffect, useRef, useState } from "react";
import "./ReportSectionQuickAddModal.css";

const API_BASE = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function emptyForm(accountClass) {
  return { code: "", name: "", accountClass, displayOrder: "", status: "ACTIVE" };
}

// Phase M.1: quick-create a Report Section from Group Code's own form
// without leaving the page - mirrors the existing PartyQuickAddModal.jsx
// pattern (same overlay/header/body/footer shape, same open/onClose/
// onCreated contract) triggered by the "+" button beside Group Code's
// Report Section dropdown. Reuses the exact same POST /api/report-sections
// endpoint and validation the full Report Sections page
// (pages/FILESETUP/ReportSections.jsx) uses - no separate recognition
// logic. Inherits the Account Class already selected on Group Code and
// keeps it fixed (changing the class here would defeat the point of
// "add a section for the class I'm currently on").
export default function ReportSectionQuickAddModal({ open, accountClass, onClose, onCreated }) {
  const [form, setForm] = useState(() => emptyForm(accountClass));
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState("");
  const [success, setSuccess] = useState(false);
  const [dirty, setDirty] = useState(false);
  const codeInputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setForm(emptyForm(accountClass));
    setErrors({});
    setServerError("");
    setSuccess(false);
    setDirty(false);
    const focusTimer = setTimeout(() => codeInputRef.current?.focus(), 50);
    return () => clearTimeout(focusTimer);
  }, [open, accountClass]);

  function requestClose() {
    if (dirty && !window.confirm("You have unsaved Report Section information. Discard changes?")) {
      return;
    }
    onClose();
  }

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e) {
      if (e.key === "Escape") requestClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dirty]);

  if (!open) return null;

  function updateField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }

  function validate() {
    const next = {};
    if (!form.code.trim()) next.code = "Code is required.";
    if (!form.name.trim()) next.name = "Name is required.";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSave(e) {
    e.preventDefault();
    if (saving) return;
    if (!validate()) return;

    setSaving(true);
    setServerError("");

    try {
      const res = await fetch(`${API_BASE}/api/report-sections`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        credentials: "include",
        body: JSON.stringify({
          code: form.code.trim().toUpperCase(),
          name: form.name.trim(),
          accountClass: form.accountClass,
          displayOrder: form.displayOrder === "" ? null : Number(form.displayOrder),
          status: form.status,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setServerError(data.message || "Failed to save report section.");
        return;
      }

      setSuccess(true);
      const created = { ...form, code: form.code.trim().toUpperCase(), id: data.id };

      setTimeout(() => {
        onCreated(created);
      }, 500);
    } catch (err) {
      console.error("SAVE REPORT SECTION QUICK-ADD ERROR:", err);
      setServerError("Unable to connect to server.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rsqam-overlay" onClick={(e) => e.target === e.currentTarget && requestClose()}>
      <div className="rsqam-modal" role="dialog" aria-modal="true" aria-label="Add New Report Section">
        <div className="rsqam-header">
          <h2>Add New Report Section</h2>
          <button type="button" className="rsqam-close" onClick={requestClose} aria-label="Close">
            &times;
          </button>
        </div>

        <form onSubmit={handleSave}>
          <div className="rsqam-body">
            {serverError && <div className="rsqam-error-banner">{serverError}</div>}
            {success && <div className="rsqam-success-banner">Report Section created successfully.</div>}

            <div className="rsqam-grid">
              <div className="rsqam-field">
                <label>Account Class</label>
                <input value={form.accountClass} disabled />
              </div>

              <div className="rsqam-field">
                <label>Code *</label>
                <input
                  ref={codeInputRef}
                  value={form.code}
                  onChange={(e) => updateField("code", e.target.value.toUpperCase())}
                  className={errors.code ? "rsqam-input-error" : ""}
                  placeholder="Example: CURRENT_ASSET"
                />
                {errors.code && <span className="rsqam-field-error">{errors.code}</span>}
              </div>

              <div className="rsqam-field rsqam-field-wide">
                <label>Name *</label>
                <input
                  value={form.name}
                  onChange={(e) => updateField("name", e.target.value)}
                  className={errors.name ? "rsqam-input-error" : ""}
                  placeholder="Example: Current Assets"
                />
                {errors.name && <span className="rsqam-field-error">{errors.name}</span>}
              </div>

              <div className="rsqam-field">
                <label>Display Order</label>
                <input
                  type="number"
                  step="1"
                  value={form.displayOrder}
                  onChange={(e) => updateField("displayOrder", e.target.value)}
                  placeholder="blank = auto"
                />
              </div>

              <div className="rsqam-field">
                <label>Status</label>
                <select value={form.status} onChange={(e) => updateField("status", e.target.value)}>
                  <option value="ACTIVE">ACTIVE</option>
                  <option value="INACTIVE">INACTIVE</option>
                </select>
              </div>
            </div>
          </div>

          <div className="rsqam-footer">
            <button type="button" className="rsqam-btn-secondary" onClick={requestClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="rsqam-btn-primary" disabled={saving}>
              {saving ? "Saving..." : "Save Report Section"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
