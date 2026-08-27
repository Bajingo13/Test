import { useEffect, useMemo, useState } from "react";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import "./FileSetupPages.css";

const API_BASE = import.meta.env.VITE_API_URL || "";

const TAX_TYPES = ["EWT", "FINAL"];
const TAX_TYPE_LABELS = { EWT: "Expanded Withholding Tax", FINAL: "Final Tax" };
const BIR_FORMS = ["1601-EQ", "0619-E", "2307"];
const STATUS_OPTIONS = ["ACTIVE", "INACTIVE"];

const EMPTY_FORM = {
  id: null,
  atcCode: "",
  description: "",
  taxType: "EWT",
  rate: "",
  birForm: "1601-EQ",
  status: "ACTIVE",
};

// Mirrors the backend's own limits exactly (server.js's validateEwtPayload,
// itself mirroring ewt_library's real DDL) - never enforced by truncating
// what the user typed, only by rejecting with a message on Save.
const ATC_CODE_MAX_LEN = 20;
const DESCRIPTION_MAX_LEN = 255;
const RATE_MAX_VALUE = 999.999;

export default function EWTLibrary() {
  const [records, setRecords] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [mode, setMode] = useState("add");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [loading, setLoading] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadEwtCodes();
  }, []);

  const filteredRecords = useMemo(() => {
    const q = search.trim().toLowerCase();
    // createdAt filtering compares plain "YYYY-MM-DD" string prefixes
    // against the <input type="date"> values, avoiding a timezone-shifted
    // Date object comparison for what's meant to be a whole-day range.
    const fromKey = dateFrom || null;
    const toKey = dateTo || null;

    return records.filter((item) => {
      const matchesSearch =
        !q || [item.atcCode, item.description, String(item.rate ?? "")].join(" ").toLowerCase().includes(q);
      const matchesType = !typeFilter || item.taxType === typeFilter;
      const createdDateKey = item.createdAt ? String(item.createdAt).slice(0, 10) : null;
      const matchesFrom = !fromKey || (createdDateKey && createdDateKey >= fromKey);
      const matchesTo = !toKey || (createdDateKey && createdDateKey <= toKey);
      return matchesSearch && matchesType && matchesFrom && matchesTo;
    });
  }, [records, search, typeFilter, dateFrom, dateTo]);

  async function loadEwtCodes() {
    try {
      setLoading(true);

      const res = await fetch(`${API_BASE}/api/ewt-library`, {
        credentials: "include",
        headers: authHeaders(),
      });
      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to load EWT library.");
        return;
      }

      setRecords(data);
    } catch (err) {
      console.error("LOAD EWT LIBRARY ERROR:", err);
      alert("Unable to connect to server.");
    } finally {
      setLoading(false);
    }
  }

  function updateField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleNew() {
    setForm({ ...EMPTY_FORM });
    setMode("add");
    setFieldErrors({});
    setFormError("");
  }

  function handleEdit(item) {
    setForm({ ...item });
    setMode("edit");
    setFieldErrors({});
    setFormError("");
  }

  // Mirrors the backend's own validateEwtPayload() exactly (same limits,
  // same rules) so an invalid value is caught before ever reaching the
  // network - the backend remains the final authority either way.
  function validateForm() {
    const errors = {};
    const atcCode = form.atcCode.trim();
    const description = form.description.trim();

    if (!atcCode) errors.atcCode = "EWT Code is required.";
    else if (atcCode.length > ATC_CODE_MAX_LEN) errors.atcCode = `EWT Code must be at most ${ATC_CODE_MAX_LEN} characters.`;

    if (!description) errors.description = "Nature of Income Payment is required.";
    else if (description.length > DESCRIPTION_MAX_LEN) errors.description = `Nature of Income Payment must be at most ${DESCRIPTION_MAX_LEN} characters.`;

    if (form.rate === "" || form.rate === null || form.rate === undefined) {
      errors.rate = "Tax Rate is required.";
    } else {
      const rateNum = Number(form.rate);
      if (!Number.isFinite(rateNum) || rateNum < 0) errors.rate = "Tax Rate must be a valid non-negative number.";
      else if (rateNum > RATE_MAX_VALUE) errors.rate = `Tax Rate must be at most ${RATE_MAX_VALUE}.`;
    }

    return errors;
  }

  async function handleSave() {
    const errors = validateForm();
    setFieldErrors(errors);
    setFormError("");
    if (Object.keys(errors).length > 0) return;

    setSaving(true);
    try {
      const url =
        mode === "add"
          ? `${API_BASE}/api/ewt-library`
          : `${API_BASE}/api/ewt-library/${form.id}`;

      const method = mode === "add" ? "POST" : "PUT";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", ...authHeaders() },
        credentials: "include",
        body: JSON.stringify({ ...form, atcCode: form.atcCode.trim(), description: form.description.trim() }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        setFormError(data.message || "Failed to save EWT code.");
        return;
      }

      alert(data.message || "EWT code saved successfully.");
      handleNew();
      await loadEwtCodes();
    } catch (err) {
      console.error("SAVE EWT LIBRARY ERROR:", err);
      setFormError("Unable to connect to server.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id) {
    if (!window.confirm("Delete this EWT/ATC code?")) return;

    try {
      const res = await fetch(`${API_BASE}/api/ewt-library/${id}`, {
        method: "DELETE",
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to delete EWT code.");
        return;
      }

      alert(data.message || "EWT code deleted successfully.");
      handleNew();
      await loadEwtCodes();
    } catch (err) {
      console.error("DELETE EWT LIBRARY ERROR:", err);
      alert("Unable to delete EWT code.");
    }
  }

  return (
    <div className="fs-page">
      <div className="fs-header">
        <div>
          <h1>EWT / ATC Library</h1>
          <p>
            Maintain Expanded Withholding Tax (EWT) rates and ATC codes for BIR compliance.
          </p>
        </div>

        <button className="fs-btn primary" onClick={handleNew}>
          + Add EWT Code
        </button>
      </div>

      <div className="fs-card">
        <div className="fs-toolbar">
          <input
            placeholder="Search ATC code, Nature of Income Payment, or rate..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="">All Tax Types</option>
            {TAX_TYPES.map((t) => (
              <option key={t} value={t}>{TAX_TYPE_LABELS[t]}</option>
            ))}
          </select>

          <label className="fs-filter-date-label">
            Created From
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </label>
          <label className="fs-filter-date-label">
            Created To
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </label>
        </div>

        <table className="fs-table">
          <thead>
            <tr>
              <th>ATC Code</th>
              <th>Nature of Income Payment</th>
              <th>Tax Rate (%)</th>
              <th>BIR Form</th>
              <th>Status</th>
              <th>Created</th>
              <th>Action</th>
            </tr>
          </thead>

          <tbody>
            {loading ? (
              <tr>
                <td colSpan="7">Loading...</td>
              </tr>
            ) : filteredRecords.length === 0 ? (
              <tr>
                <td colSpan="7">No EWT/ATC codes found.</td>
              </tr>
            ) : (
              filteredRecords.map((item) => (
                <tr key={item.id}>
                  <td>{item.atcCode}</td>
                  <td>{item.description}</td>
                  <td>{item.rate}%</td>
                  <td>{item.birForm}</td>
                  <td>{item.status}</td>
                  <td>{item.createdAt ? String(item.createdAt).slice(0, 10) : "—"}</td>
                  <td>
                    <button className="fs-btn" onClick={() => handleEdit(item)}>
                      Edit
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="fs-card">
        <h2>{mode === "add" ? "Add EWT / ATC Code" : "Edit EWT / ATC Code"}</h2>

        {formError && <div className="fs-banner-error">{formError}</div>}

        <div className="fs-grid">
          <div className="fs-field">
            <label>ATC Code</label>
            <input
              value={form.atcCode}
              onChange={(e) => updateField("atcCode", e.target.value)}
              placeholder="WI158"
              className={fieldErrors.atcCode ? "fs-input-error" : ""}
            />
            {fieldErrors.atcCode && <span className="fs-field-error">{fieldErrors.atcCode}</span>}
          </div>

          <div className="fs-field">
            <label>Nature of Income Payment</label>
            <input
              value={form.description}
              onChange={(e) => updateField("description", e.target.value)}
              placeholder="Professional Fees"
              className={fieldErrors.description ? "fs-input-error" : ""}
            />
            {fieldErrors.description && <span className="fs-field-error">{fieldErrors.description}</span>}
          </div>

          <div className="fs-field">
            <label>Tax Rate (%)</label>
            <input
              type="number"
              step="0.001"
              value={form.rate}
              onChange={(e) => updateField("rate", e.target.value)}
              placeholder="10"
              className={fieldErrors.rate ? "fs-input-error" : ""}
            />
            {fieldErrors.rate && <span className="fs-field-error">{fieldErrors.rate}</span>}
          </div>

          <div className="fs-field">
            <label>BIR Form</label>
            <select value={form.birForm} onChange={(e) => updateField("birForm", e.target.value)}>
              {BIR_FORMS.map((f) => (
                <option key={f}>{f}</option>
              ))};
            </select>
          </div>

          <div className="fs-field">
            <label>Tax Type</label>
            <select value={form.taxType} onChange={(e) => updateField("taxType", e.target.value)}>
              {TAX_TYPES.map((t) => (
                <option key={t} value={t}>{TAX_TYPE_LABELS[t]}</option>
              ))}
            </select>
          </div>

          <div className="fs-field">
            <label>Status</label>
            <select value={form.status} onChange={(e) => updateField("status", e.target.value)}>
              {STATUS_OPTIONS.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="fs-actions">
          <button className="fs-btn" onClick={handleNew} disabled={saving}>
            Cancel
          </button>

          <button className="fs-btn primary" onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : mode === "add" ? "Save EWT Code" : "Update EWT Code"}
          </button>
        </div>
      </div>
    </div>
  );
}
