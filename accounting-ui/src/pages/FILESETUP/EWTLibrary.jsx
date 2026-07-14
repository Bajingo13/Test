import { useEffect, useMemo, useState } from "react";
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

export default function EWTLibrary() {
  const [records, setRecords] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [mode, setMode] = useState("add");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadEwtCodes();
  }, []);

  const filteredRecords = useMemo(() => {
    const q = search.trim().toLowerCase();

    return records.filter((item) => {
      const matchesSearch =
        !q || [item.atcCode, item.description].join(" ").toLowerCase().includes(q);
      const matchesType = !typeFilter || item.taxType === typeFilter;
      return matchesSearch && matchesType;
    });
  }, [records, search, typeFilter]);

  async function loadEwtCodes() {
    try {
      setLoading(true);

      const res = await fetch(`${API_BASE}/api/ewt-library`, { credentials: "include" });
      const data = await res.json();

      if (!res.ok) {
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
  }

  function handleEdit(item) {
    setForm({ ...item });
    setMode("edit");
  }

  async function handleSave() {
    if (!form.atcCode.trim() || !form.description.trim()) {
      alert("ATC Code and Description are required.");
      return;
    }

    try {
      const url =
        mode === "add"
          ? `${API_BASE}/api/ewt-library`
          : `${API_BASE}/api/ewt-library/${form.id}`;

      const method = mode === "add" ? "POST" : "PUT";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(form),
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.message || "Failed to save EWT code.");
        return;
      }

      alert(data.message || "EWT code saved successfully.");
      handleNew();
      await loadEwtCodes();
    } catch (err) {
      console.error("SAVE EWT LIBRARY ERROR:", err);
      alert("Unable to save EWT code.");
    }
  }

  async function handleDelete(id) {
    if (!window.confirm("Delete this EWT/ATC code?")) return;

    try {
      const res = await fetch(`${API_BASE}/api/ewt-library/${id}`, {
        method: "DELETE",
        credentials: "include",
      });

      const data = await res.json();

      if (!res.ok) {
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
            placeholder="Search ATC or EWT code..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="">All Tax Types</option>
            {TAX_TYPES.map((t) => (
              <option key={t} value={t}>{TAX_TYPE_LABELS[t]}</option>
            ))}
          </select>
        </div>

        <table className="fs-table">
          <thead>
            <tr>
              <th>ATC Code</th>
              <th>EWT Name</th>
              <th>Tax Rate (%)</th>
              <th>BIR Form</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>

          <tbody>
            {loading ? (
              <tr>
                <td colSpan="6">Loading...</td>
              </tr>
            ) : filteredRecords.length === 0 ? (
              <tr>
                <td colSpan="6">No EWT/ATC codes found.</td>
              </tr>
            ) : (
              filteredRecords.map((item) => (
                <tr key={item.id}>
                  <td>{item.atcCode}</td>
                  <td>{item.description}</td>
                  <td>{item.rate}%</td>
                  <td>{item.birForm}</td>
                  <td>{item.status}</td>
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

        <div className="fs-grid">
          <div className="fs-field">
            <label>ATC Code</label>
            <input
              value={form.atcCode}
              onChange={(e) => updateField("atcCode", e.target.value)}
              placeholder="WI158"
            />
          </div>

          <div className="fs-field">
            <label>EWT Name</label>
            <input
              value={form.description}
              onChange={(e) => updateField("description", e.target.value)}
              placeholder="Professional Fees"
            />
          </div>

          <div className="fs-field">
            <label>Tax Rate (%)</label>
            <input
              type="number"
              step="0.001"
              value={form.rate}
              onChange={(e) => updateField("rate", e.target.value)}
              placeholder="10"
            />
          </div>

          <div className="fs-field">
            <label>BIR Form</label>
            <select value={form.birForm} onChange={(e) => updateField("birForm", e.target.value)}>
              {BIR_FORMS.map((f) => (
                <option key={f}>{f}</option>
              ))}
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
          <button className="fs-btn" onClick={handleNew}>
            Cancel
          </button>

          <button className="fs-btn primary" onClick={handleSave}>
            {mode === "add" ? "Save EWT Code" : "Update EWT Code"}
          </button>
        </div>
      </div>
    </div>
  );
}
