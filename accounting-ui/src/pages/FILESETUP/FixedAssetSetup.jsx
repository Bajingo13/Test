import { useEffect, useMemo, useState } from "react";
import "./GroupCodes.css";

const API_BASE = import.meta.env.VITE_API_URL || "";

const STATUS_OPTIONS = ["Active", "Disposed"];
const DEPRECIATION_METHODS = ["STRAIGHT_LINE"];

const EMPTY_FORM = {
  id: null,
  assetCode: "",
  assetName: "",
  category: "",
  acquisitionDate: new Date().toISOString().slice(0, 10),
  acquisitionCost: "",
  salvageValue: "0",
  usefulLifeYears: "5",
  depreciationMethod: "STRAIGHT_LINE",
  assetAccountCode: "",
  status: "Active",
};

export default function FixedAssetSetup() {
  const [records, setRecords] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [mode, setMode] = useState("add");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadAssets();
  }, []);

  const filteredRecords = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return records;

    return records.filter((item) =>
      [item.assetCode, item.assetName, item.category, item.status]
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [records, search]);

  async function loadAssets() {
    try {
      setLoading(true);

      const res = await fetch(`${API_BASE}/api/fixed-assets`, { credentials: "include" });
      const data = await res.json();

      if (!res.ok) {
        alert(data.message || "Failed to load fixed assets.");
        return;
      }

      setRecords(data);
    } catch (err) {
      console.error("LOAD FIXED ASSETS ERROR:", err);
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
    if (!form.assetCode.trim() || !form.assetName.trim()) {
      alert("Asset Code and Asset Name are required.");
      return;
    }

    if (!form.acquisitionDate || Number(form.acquisitionCost) <= 0) {
      alert("Acquisition Date and a positive Acquisition Cost are required.");
      return;
    }

    if (Number(form.usefulLifeYears) <= 0) {
      alert("Useful Life (Years) must be greater than zero.");
      return;
    }

    try {
      const url =
        mode === "add"
          ? `${API_BASE}/api/fixed-assets`
          : `${API_BASE}/api/fixed-assets/${form.id}`;

      const method = mode === "add" ? "POST" : "PUT";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(form),
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.message || "Failed to save fixed asset.");
        return;
      }

      alert(data.message || "Fixed asset saved successfully.");
      handleNew();
      await loadAssets();
    } catch (err) {
      console.error("SAVE FIXED ASSET ERROR:", err);
      alert("Unable to save fixed asset.");
    }
  }

  async function handleDelete(id) {
    if (!window.confirm("Delete this fixed asset?")) return;

    try {
      const res = await fetch(`${API_BASE}/api/fixed-assets/${id}`, {
        method: "DELETE",
        credentials: "include",
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.message || "Failed to delete fixed asset.");
        return;
      }

      alert(data.message || "Fixed asset deleted successfully.");
      handleNew();
      await loadAssets();
    } catch (err) {
      console.error("DELETE FIXED ASSET ERROR:", err);
      alert("Unable to delete fixed asset.");
    }
  }

  return (
    <div className="group-page">
      <div className="group-header">
        <div>
          <p className="group-mini">File Setup</p>
          <h1>Fixed Asset Setup</h1>
          <p>Maintain your fixed asset register for depreciation reporting.</p>
        </div>

        <button type="button" onClick={handleNew}>
          New Fixed Asset
        </button>
      </div>

      <div className="group-layout">
        <section className="group-card">
          <h2>{mode === "add" ? "Add Fixed Asset" : "Edit Fixed Asset"}</h2>

          <div className="group-form">
            <label>Asset Code</label>
            <input
              value={form.assetCode}
              onChange={(e) => updateField("assetCode", e.target.value)}
              placeholder="Example: FA-0001"
            />

            <label>Asset Name</label>
            <input
              value={form.assetName}
              onChange={(e) => updateField("assetName", e.target.value)}
              placeholder="Example: Office Delivery Van"
            />

            <label>Category</label>
            <input
              value={form.category}
              onChange={(e) => updateField("category", e.target.value)}
              placeholder="Example: Transportation Equipment"
            />

            <label>Acquisition Date</label>
            <input
              type="date"
              value={form.acquisitionDate}
              onChange={(e) => updateField("acquisitionDate", e.target.value)}
            />

            <label>Acquisition Cost</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.acquisitionCost}
              onChange={(e) => updateField("acquisitionCost", e.target.value)}
            />

            <label>Salvage Value</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.salvageValue}
              onChange={(e) => updateField("salvageValue", e.target.value)}
            />

            <label>Useful Life (Years)</label>
            <input
              type="number"
              min="1"
              step="1"
              value={form.usefulLifeYears}
              onChange={(e) => updateField("usefulLifeYears", e.target.value)}
            />

            <label>Depreciation Method</label>
            <select
              value={form.depreciationMethod}
              onChange={(e) => updateField("depreciationMethod", e.target.value)}
            >
              {DEPRECIATION_METHODS.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>

            <label>Asset Account Code</label>
            <input
              value={form.assetAccountCode}
              onChange={(e) => updateField("assetAccountCode", e.target.value)}
              placeholder="COA code for this asset"
            />

            <label>Status</label>
            <select
              value={form.status}
              onChange={(e) => updateField("status", e.target.value)}
            >
              {STATUS_OPTIONS.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>

            <button className="primary-btn" type="button" onClick={handleSave}>
              {mode === "add" ? "Save Fixed Asset" : "Update Fixed Asset"}
            </button>
          </div>
        </section>

        <section className="group-card">
          <div className="group-list-header">
            <h2>Fixed Asset List</h2>

            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search asset..."
            />
          </div>

          <div className="group-table-wrap">
            <table className="group-table">
              <thead>
                <tr>
                  <th>Asset Code</th>
                  <th>Asset Name</th>
                  <th>Category</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>

              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan="5" className="empty-cell">Loading fixed assets...</td>
                  </tr>
                ) : filteredRecords.length > 0 ? (
                  filteredRecords.map((item) => (
                    <tr key={item.id}>
                      <td>{item.assetCode}</td>
                      <td>{item.assetName}</td>
                      <td>{item.category}</td>
                      <td>{item.status}</td>
                      <td>
                        <button type="button" onClick={() => handleEdit(item)}>Edit</button>
                        <button
                          type="button"
                          className="danger-btn"
                          onClick={() => handleDelete(item.id)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan="5" className="empty-cell">No fixed assets found.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
