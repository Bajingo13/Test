import { useEffect, useRef, useState } from "react";
import { generateNextCode } from "../utils/genLibCode";
import "./PartyQuickAddModal.css";

const API_BASE = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function emptyForm(type) {
  return {
    code: "",
    type,
    name: "",
    status: "ACTIVE",
    startDate: new Date().toISOString().slice(0, 10),
    address1: "",
    address2: "",
    address3: "",
    attention: "",
    position: "",
    telephone: "",
    fax: "",
    mobile: "",
    tin: "",
    email: "",
    atcCode: "",
    ewtCode: "",
    category: "REGULAR",
    branchCode: "",
    rdoCode: "",
    notes: "",
    isProspective: false,
    isClient: type === "CUSTOMER",
  };
}

// Quick-create a Customer/Supplier from a transaction form without leaving
// the page. Reuses the exact same /api/genlib POST endpoint, request shape,
// and (only) validation rule (code + name required) that the full General
// Libraries editor (pages/FILESETUP/GenLib.jsx) already uses - this modal
// only exposes the fields that genuinely exist in general_libraries today.
//
// partyType: "CUSTOMER" | "SUPPLIER" | "BOTH" (Debit/Credit Memo, which is
// legitimately used for both, shows a toggle defaulting to Customer).
export default function PartyQuickAddModal({ open, partyType, onClose, onCreated }) {
  const initialType = partyType === "BOTH" ? "CUSTOMER" : partyType;
  const [form, setForm] = useState(() => emptyForm(initialType || "CUSTOMER"));
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState("");
  const [success, setSuccess] = useState(false);
  // Phase 4: true the moment the user changes ANY field - a fresh/untouched
  // modal (including the auto-generated code and default startDate/status,
  // which are set programmatically below, not by the user) can close
  // without a prompt; anything the user actually typed cannot be discarded
  // silently. Reset to false whenever the modal is (re)opened.
  const [dirty, setDirty] = useState(false);
  const nameInputRef = useRef(null);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    const t = initialType || "CUSTOMER";
    setForm(emptyForm(t));
    setErrors({});
    setServerError("");
    setSuccess(false);
    setDirty(false);

    // Fetch a fresh copy of the table to compute an accurate next code -
    // the same generateNextCode() GenLib.jsx uses, over the same live data,
    // so a quick-add and a GenLib.jsx add can never collide.
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/genlib`, {
          credentials: "include",
          headers: authHeaders(),
        });
        const data = await res.json();
        if (!cancelled && res.ok) {
          setForm((prev) => ({ ...prev, code: generateNextCode(data) }));
        }
      } catch (err) {
        console.error("LOAD GENLIB FOR CODE-GEN ERROR:", err);
      }
    })();

    const focusTimer = setTimeout(() => nameInputRef.current?.focus(), 50);

    return () => {
      cancelled = true;
      clearTimeout(focusTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, partyType]);

  // Phase 4: the single guarded exit point for every close path (backdrop,
  // X, Cancel, Escape) - a dirty form always confirms before discarding,
  // matching this app's existing "discard unsaved changes?" pattern used
  // elsewhere (e.g. the Print Template Builder's own dirty guard).
  function requestClose() {
    if (dirty && !window.confirm(`You have unsaved ${label.toLowerCase()} information. Discard changes?`)) {
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
      const res = await fetch(`${API_BASE}/api/genlib`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        credentials: "include",
        body: JSON.stringify(form),
      });

      const data = await res.json();

      if (!res.ok) {
        setServerError(data.message || "Failed to save record");
        return;
      }

      setSuccess(true);
      const created = { ...form, id: data.id };

      setTimeout(() => {
        onCreated(created);
      }, 500);
    } catch (err) {
      console.error("SAVE PARTY QUICK-ADD ERROR:", err);
      setServerError("Unable to connect to server.");
    } finally {
      setSaving(false);
    }
  }

  const label =
    (partyType === "BOTH" ? form.type : partyType) === "SUPPLIER" ? "Supplier" : "Customer";

  return (
    <div className="pqam-overlay" onClick={(e) => e.target === e.currentTarget && requestClose()}>
      <div className="pqam-modal" role="dialog" aria-modal="true" aria-label={`Add New ${label}`}>
        <div className="pqam-header">
          <h2>Add New {label}</h2>
          <button type="button" className="pqam-close" onClick={requestClose} aria-label="Close">
            &times;
          </button>
        </div>

        <form onSubmit={handleSave}>
          <div className="pqam-body">
            {serverError && <div className="pqam-error-banner">{serverError}</div>}
            {success && <div className="pqam-success-banner">{label} created successfully.</div>}

            {partyType === "BOTH" && (
              <div className="pqam-type-toggle">
                <button
                  type="button"
                  className={form.type === "CUSTOMER" ? "active" : ""}
                  onClick={() => updateField("type", "CUSTOMER")}
                >
                  Customer
                </button>
                <button
                  type="button"
                  className={form.type === "SUPPLIER" ? "active" : ""}
                  onClick={() => updateField("type", "SUPPLIER")}
                >
                  Supplier
                </button>
              </div>
            )}

            <div className="pqam-grid">
              <div className="pqam-field">
                <label>Code</label>
                <input
                  value={form.code}
                  onChange={(e) => updateField("code", e.target.value)}
                  className={errors.code ? "pqam-input-error" : ""}
                />
                {errors.code && <span className="pqam-field-error">{errors.code}</span>}
              </div>

              <div className="pqam-field pqam-field-wide">
                <label>Name *</label>
                <input
                  ref={nameInputRef}
                  value={form.name}
                  onChange={(e) => updateField("name", e.target.value)}
                  className={errors.name ? "pqam-input-error" : ""}
                />
                {errors.name && <span className="pqam-field-error">{errors.name}</span>}
              </div>

              <div className="pqam-field">
                <label>Contact Person</label>
                <input value={form.attention} onChange={(e) => updateField("attention", e.target.value)} />
              </div>

              <div className="pqam-field pqam-field-wide">
                <label>Address</label>
                <input value={form.address1} onChange={(e) => updateField("address1", e.target.value)} />
              </div>

              <div className="pqam-field">
                <label>Telephone</label>
                <input value={form.telephone} onChange={(e) => updateField("telephone", e.target.value)} />
              </div>

              <div className="pqam-field">
                <label>Mobile</label>
                <input value={form.mobile} onChange={(e) => updateField("mobile", e.target.value)} />
              </div>

              <div className="pqam-field">
                <label>Email</label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => updateField("email", e.target.value)}
                />
              </div>

              <div className="pqam-field">
                <label>TIN</label>
                <input value={form.tin} onChange={(e) => updateField("tin", e.target.value)} />
              </div>

              <div className="pqam-field">
                <label>Status</label>
                <select value={form.status} onChange={(e) => updateField("status", e.target.value)}>
                  <option value="ACTIVE">ACTIVE</option>
                  <option value="INACTIVE">INACTIVE</option>
                </select>
              </div>
            </div>
          </div>

          <div className="pqam-footer">
            <button type="button" className="pqam-btn-secondary" onClick={requestClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="pqam-btn-primary" disabled={saving}>
              {saving ? "Saving..." : `Save ${label}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
