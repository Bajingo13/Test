import { useEffect, useMemo, useState } from "react";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import "./FileSetupPages.css";

const API_BASE = import.meta.env.VITE_API_URL || "";

// Phase 6D: reference-only VAT catalog. This page owns Code/Description/
// Applies To/Rate/Status only - it does NOT own accounting account
// mapping, calculation mode, zero-rated/exempt treatment, purchase
// classification, BIR form, or effective dating (see the Phase 6B/6C/6D
// architecture reports). No Delete action anywhere - Active/Inactive is
// the only supported way to retire a code, a deliberate improvement over
// EWT Library's own unconditional hard-delete, not a copy of it.
const APPLIES_TO_OPTIONS = ["INPUT", "OUTPUT", "BOTH"];
const APPLIES_TO_LABELS = { INPUT: "Input VAT", OUTPUT: "Output VAT", BOTH: "Both" };
const STATUS_OPTIONS = ["ACTIVE", "INACTIVE"];

const EMPTY_FORM = {
  id: null,
  code: "",
  description: "",
  appliesTo: "BOTH",
  rate: "",
  status: "ACTIVE",
};

// Mirrors the backend's own limits exactly (server.js's
// validateVatRatePayload, itself mirroring vat_rate_codes' real DDL).
const CODE_MAX_LEN = 20;
const DESCRIPTION_MAX_LEN = 255;
const RATE_MAX_VALUE = 999.999;

export default function VatRateLibrary() {
  const [records, setRecords] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [mode, setMode] = useState("add");
  const [search, setSearch] = useState("");
  const [appliesToFilter, setAppliesToFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadVatCodes();
  }, []);

  const filteredRecords = useMemo(() => {
    const q = search.trim().toLowerCase();

    return records.filter((item) => {
      const matchesSearch =
        !q || [item.code, item.description, String(item.rate ?? "")].join(" ").toLowerCase().includes(q);
      const matchesApplies = !appliesToFilter || item.appliesTo === appliesToFilter;
      return matchesSearch && matchesApplies;
    });
  }, [records, search, appliesToFilter]);

  async function loadVatCodes() {
    try {
      setLoading(true);

      const res = await fetch(`${API_BASE}/api/vat-rate-codes`, {
        credentials: "include",
        headers: authHeaders(),
      });
      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to load VAT Rate Library.");
        return;
      }

      setRecords(data);
    } catch (err) {
      console.error("LOAD VAT RATE LIBRARY ERROR:", err);
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

  // Mirrors the backend's own validateVatRatePayload() exactly, so an
  // invalid value is caught before ever reaching the network - the
  // backend remains the final authority either way.
  function validateForm() {
    const errors = {};
    const code = form.code.trim();
    const description = form.description.trim();

    if (!code) errors.code = "VAT Code is required.";
    else if (code.length > CODE_MAX_LEN) errors.code = `VAT Code must be at most ${CODE_MAX_LEN} characters.`;

    if (description.length > DESCRIPTION_MAX_LEN) errors.description = `Description must be at most ${DESCRIPTION_MAX_LEN} characters.`;

    if (form.rate === "" || form.rate === null || form.rate === undefined) {
      errors.rate = "Rate is required.";
    } else {
      const rateNum = Number(form.rate);
      if (!Number.isFinite(rateNum) || rateNum < 0) errors.rate = "Rate must be a valid non-negative number.";
      else if (rateNum > RATE_MAX_VALUE) errors.rate = `Rate must be at most ${RATE_MAX_VALUE}.`;
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
          ? `${API_BASE}/api/vat-rate-codes`
          : `${API_BASE}/api/vat-rate-codes/${form.id}`;

      const method = mode === "add" ? "POST" : "PUT";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", ...authHeaders() },
        credentials: "include",
        body: JSON.stringify({ ...form, code: form.code.trim(), description: form.description.trim() }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        setFormError(data.message || "Failed to save VAT code.");
        return;
      }

      alert(data.message || "VAT code saved successfully.");
      handleNew();
      await loadVatCodes();
    } catch (err) {
      console.error("SAVE VAT RATE LIBRARY ERROR:", err);
      setFormError("Unable to connect to server.");
    } finally {
      setSaving(false);
    }
  }

  // Not a separate endpoint - a normal PUT with only status flipped,
  // matching this project's established style (EWT Library also has no
  // dedicated status route, just its full edit form's Status select).
  async function handleToggleStatus(item) {
    const nextStatus = item.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    try {
      const res = await fetch(`${API_BASE}/api/vat-rate-codes/${item.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        credentials: "include",
        body: JSON.stringify({ ...item, status: nextStatus }),
      });
      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to update status.");
        return;
      }

      await loadVatCodes();
    } catch (err) {
      console.error("TOGGLE VAT RATE STATUS ERROR:", err);
      alert("Unable to connect to server.");
    }
  }

  return (
    <div className="fs-page">
      <div className="fs-header">
        <div>
          <h1>VAT Rate Library</h1>
          <p>Maintain reference VAT codes and rates for Invoice/APV VAT entry. Semantic codes are recommended, e.g. STANDARD_VAT.</p>
        </div>

        <button className="fs-btn primary" onClick={handleNew}>
          + Add VAT Code
        </button>
      </div>

      <div className="fs-card">
        <div className="fs-toolbar">
          <input
            placeholder="Search VAT code, description, or rate..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          <select value={appliesToFilter} onChange={(e) => setAppliesToFilter(e.target.value)}>
            <option value="">All Applies To</option>
            {APPLIES_TO_OPTIONS.map((a) => (
              <option key={a} value={a}>{APPLIES_TO_LABELS[a]}</option>
            ))}
          </select>
        </div>

        <table className="fs-table">
          <thead>
            <tr>
              <th>VAT Code</th>
              <th>Description</th>
              <th>Applies To</th>
              <th>Rate (%)</th>
              <th>Status</th>
              <th>Updated</th>
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
                <td colSpan="7">No VAT codes found.</td>
              </tr>
            ) : (
              filteredRecords.map((item) => (
                <tr key={item.id}>
                  <td>{item.code}</td>
                  <td>{item.description}</td>
                  <td>{APPLIES_TO_LABELS[item.appliesTo] || item.appliesTo}</td>
                  <td>{item.rate}%</td>
                  <td>{item.status}</td>
                  <td>{item.updatedAt ? String(item.updatedAt).slice(0, 10) : "—"}</td>
                  <td className="vat-rate-actions">
                    <button className="fs-btn" onClick={() => handleEdit(item)}>
                      Edit
                    </button>
                    <button className="fs-btn" onClick={() => handleToggleStatus(item)}>
                      {item.status === "ACTIVE" ? "Deactivate" : "Activate"}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="fs-card">
        <h2>{mode === "add" ? "Add VAT Code" : "Edit VAT Code"}</h2>

        {formError && <div className="fs-banner-error">{formError}</div>}

        <div className="fs-grid">
          <div className="fs-field">
            <label>VAT Code</label>
            <input
              value={form.code}
              onChange={(e) => updateField("code", e.target.value)}
              placeholder="STANDARD_VAT"
              className={fieldErrors.code ? "fs-input-error" : ""}
            />
            {fieldErrors.code && <span className="fs-field-error">{fieldErrors.code}</span>}
          </div>

          <div className="fs-field">
            <label>Description</label>
            <input
              value={form.description}
              onChange={(e) => updateField("description", e.target.value)}
              placeholder="Standard VAT"
              className={fieldErrors.description ? "fs-input-error" : ""}
            />
            {fieldErrors.description && <span className="fs-field-error">{fieldErrors.description}</span>}
          </div>

          <div className="fs-field">
            <label>Applies To</label>
            <select value={form.appliesTo} onChange={(e) => updateField("appliesTo", e.target.value)}>
              {APPLIES_TO_OPTIONS.map((a) => (
                <option key={a} value={a}>{APPLIES_TO_LABELS[a]}</option>
              ))}
            </select>
          </div>

          <div className="fs-field">
            <label>Rate (%)</label>
            <input
              type="number"
              step="0.001"
              value={form.rate}
              onChange={(e) => updateField("rate", e.target.value)}
              placeholder="12"
              className={fieldErrors.rate ? "fs-input-error" : ""}
            />
            {fieldErrors.rate && <span className="fs-field-error">{fieldErrors.rate}</span>}
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
            {saving ? "Saving..." : mode === "add" ? "Save VAT Code" : "Update VAT Code"}
          </button>
        </div>
      </div>
    </div>
  );
}
