import { useEffect, useMemo, useState } from "react";
import "./FileSetupPages.css";

const API_BASE = import.meta.env.VITE_API_URL || "";

const STATUS_OPTIONS = ["ACTIVE", "INACTIVE"];

const EMPTY_FORM = {
  id: null,
  bankCode: "",
  bankName: "",
  accountNo: "",
  accountName: "",
  status: "ACTIVE",
};

export default function BankCodes() {
  const [records, setRecords] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [mode, setMode] = useState("add");
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    syncThenLoad();
  }, []);

  async function loadBankCodes() {
    try {
      setLoading(true);

      const res = await fetch(`${API_BASE}/api/bank-codes`, { credentials: "include" });
      const data = await res.json();

      if (!res.ok) {
        alert(data.message || "Failed to load bank codes.");
        return;
      }

      setRecords(data);
    } catch (err) {
      console.error("LOAD BANK CODES ERROR:", err);
    } finally {
      setLoading(false);
    }
  }

  async function syncThenLoad() {
    await syncFromCoa(true);
    await loadBankCodes();
  }

  async function syncFromCoa(silent = false) {
    try {
      setSyncing(true);

      const res = await fetch(`${API_BASE}/api/bank-codes/sync`, {
        method: "POST",
        credentials: "include",
      });

      const data = await res.json();

      if (!res.ok) {
        if (!silent) alert(data.message || "Failed to sync from Chart of Accounts.");
        return;
      }

      if (!silent && data.addedCount > 0) {
        alert(data.message);
      }

      await loadBankCodes();
    } catch (err) {
      console.error("SYNC BANK CODES ERROR:", err);
      if (!silent) alert("Unable to connect to server.");
    } finally {
      setSyncing(false);
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
    if (!form.bankCode.trim() || !form.bankName.trim()) {
      alert("Bank Code and Bank Name are required.");
      return;
    }

    try {
      const url =
        mode === "add"
          ? `${API_BASE}/api/bank-codes`
          : `${API_BASE}/api/bank-codes/${form.id}`;

      const method = mode === "add" ? "POST" : "PUT";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(form),
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.message || "Failed to save bank code.");
        return;
      }

      alert(data.message || "Bank code saved successfully.");
      handleNew();
      await loadBankCodes();
    } catch (err) {
      console.error("SAVE BANK CODE ERROR:", err);
      alert("Unable to save bank code.");
    }
  }

  async function handleDelete(id) {
    if (!window.confirm("Delete this bank code?")) return;

    try {
      const res = await fetch(`${API_BASE}/api/bank-codes/${id}`, {
        method: "DELETE",
        credentials: "include",
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.message || "Failed to delete bank code.");
        return;
      }

      alert(data.message || "Bank code deleted successfully.");
      handleNew();
      await loadBankCodes();
    } catch (err) {
      console.error("DELETE BANK CODE ERROR:", err);
      alert("Unable to delete bank code.");
    }
  }

  const sortedRecords = useMemo(
    () => [...records].sort((a, b) => (a.bankCode || "").localeCompare(b.bankCode || "")),
    [records]
  );

  return (
    <div className="fs-page">
      <div className="fs-header">
        <div>
          <h1>Bank Codes</h1>
          <p>
            Maintain company bank accounts. Any Chart of Accounts entry tagged
            "BANK / CASH" is added here automatically &mdash; used for Bank Reconciliation.
          </p>
        </div>
        <div style={{ display: "flex", gap: "10px" }}>
          <button className="fs-btn" onClick={() => syncFromCoa(false)} disabled={syncing}>
            {syncing ? "Syncing..." : "Sync from Chart of Accounts"}
          </button>
          <button className="fs-btn primary" onClick={handleNew}>
            + Add Bank
          </button>
        </div>
      </div>

      <div className="fs-card">
        <table className="fs-table">
          <thead>
            <tr>
              <th>Bank Code</th>
              <th>Bank Name</th>
              <th>Account No.</th>
              <th>Account Name</th>
              <th>Source</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan="7" className="fs-empty">Loading bank codes...</td></tr>
            ) : sortedRecords.length === 0 ? (
              <tr><td colSpan="7" className="fs-empty">No bank codes yet.</td></tr>
            ) : (
              sortedRecords.map((item) => (
                <tr key={item.id}>
                  <td>{item.bankCode}</td>
                  <td>{item.bankName}</td>
                  <td>{item.accountNo || "-"}</td>
                  <td>{item.accountName}</td>
                  <td>{item.coaCode ? `COA (${item.coaCode})` : "Manual"}</td>
                  <td>{item.status}</td>
                  <td>
                    <button className="fs-btn" onClick={() => handleEdit(item)}>Edit</button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="fs-card">
        <h2>{mode === "add" ? "Add Bank" : "Edit Bank"}</h2>
        <div className="fs-grid">
          <div className="fs-field">
            <label>Bank Code</label>
            <input
              value={form.bankCode}
              onChange={(e) => updateField("bankCode", e.target.value)}
              placeholder="BPI"
            />
          </div>

          <div className="fs-field">
            <label>Bank Name</label>
            <input
              value={form.bankName}
              onChange={(e) => updateField("bankName", e.target.value)}
              placeholder="Bank name"
            />
          </div>

          <div className="fs-field">
            <label>Account No.</label>
            <input
              value={form.accountNo}
              onChange={(e) => updateField("accountNo", e.target.value)}
              placeholder="0000-0000-0000"
            />
          </div>

          <div className="fs-field">
            <label>Account Name</label>
            <input
              value={form.accountName}
              onChange={(e) => updateField("accountName", e.target.value)}
              placeholder="Company name"
            />
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
          <button className="fs-btn" onClick={handleNew}>Cancel</button>
          <button className="fs-btn primary" onClick={handleSave}>
            {mode === "add" ? "Save Bank" : "Update Bank"}
          </button>
        </div>
      </div>
    </div>
  );
}
