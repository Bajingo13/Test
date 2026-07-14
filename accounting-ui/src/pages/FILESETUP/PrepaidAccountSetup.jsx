import { useEffect, useMemo, useState } from "react";
import "./GroupCodes.css";

const API_BASE = import.meta.env.VITE_API_URL || "";

const STATUS_OPTIONS = ["Active", "Cancelled"];

const EMPTY_FORM = {
  id: null,
  prepaidCode: "",
  description: "",
  partyName: "",
  accountCode: "",
  expenseAccountCode: "",
  startDate: new Date().toISOString().slice(0, 10),
  amount: "",
  termMonths: "12",
  status: "Active",
};

export default function PrepaidAccountSetup() {
  const [records, setRecords] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [mode, setMode] = useState("add");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadPrepaidAccounts();
  }, []);

  const filteredRecords = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return records;

    return records.filter((item) =>
      [item.prepaidCode, item.description, item.partyName, item.status]
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [records, search]);

  async function loadPrepaidAccounts() {
    try {
      setLoading(true);

      const res = await fetch(`${API_BASE}/api/prepaid-accounts`, { credentials: "include" });
      const data = await res.json();

      if (!res.ok) {
        alert(data.message || "Failed to load prepaid accounts.");
        return;
      }

      setRecords(data);
    } catch (err) {
      console.error("LOAD PREPAID ACCOUNTS ERROR:", err);
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
    if (!form.prepaidCode.trim() || !form.description.trim()) {
      alert("Prepaid Code and Description are required.");
      return;
    }

    if (!form.startDate || Number(form.amount) <= 0) {
      alert("Start Date and a positive Amount are required.");
      return;
    }

    if (Number(form.termMonths) <= 0) {
      alert("Term (Months) must be greater than zero.");
      return;
    }

    try {
      const url =
        mode === "add"
          ? `${API_BASE}/api/prepaid-accounts`
          : `${API_BASE}/api/prepaid-accounts/${form.id}`;

      const method = mode === "add" ? "POST" : "PUT";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(form),
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.message || "Failed to save prepaid account.");
        return;
      }

      alert(data.message || "Prepaid account saved successfully.");
      handleNew();
      await loadPrepaidAccounts();
    } catch (err) {
      console.error("SAVE PREPAID ACCOUNT ERROR:", err);
      alert("Unable to save prepaid account.");
    }
  }

  async function handleDelete(id) {
    if (!window.confirm("Delete this prepaid account?")) return;

    try {
      const res = await fetch(`${API_BASE}/api/prepaid-accounts/${id}`, {
        method: "DELETE",
        credentials: "include",
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.message || "Failed to delete prepaid account.");
        return;
      }

      alert(data.message || "Prepaid account deleted successfully.");
      handleNew();
      await loadPrepaidAccounts();
    } catch (err) {
      console.error("DELETE PREPAID ACCOUNT ERROR:", err);
      alert("Unable to delete prepaid account.");
    }
  }

  return (
    <div className="group-page">
      <div className="group-header">
        <div>
          <p className="group-mini">File Setup</p>
          <h1>Prepaid Account Setup</h1>
          <p>Maintain prepaid expenses and their amortization terms.</p>
        </div>

        <button type="button" onClick={handleNew}>
          New Prepaid Account
        </button>
      </div>

      <div className="group-layout">
        <section className="group-card">
          <h2>{mode === "add" ? "Add Prepaid Account" : "Edit Prepaid Account"}</h2>

          <div className="group-form">
            <label>Prepaid Code</label>
            <input
              value={form.prepaidCode}
              onChange={(e) => updateField("prepaidCode", e.target.value)}
              placeholder="Example: PPD-0001"
            />

            <label>Description</label>
            <input
              value={form.description}
              onChange={(e) => updateField("description", e.target.value)}
              placeholder="Example: 1-Year Office Insurance"
            />

            <label>Payee / Party</label>
            <input
              value={form.partyName}
              onChange={(e) => updateField("partyName", e.target.value)}
              placeholder="Example: XYZ Insurance Co."
            />

            <label>Prepaid Asset Account Code</label>
            <input
              value={form.accountCode}
              onChange={(e) => updateField("accountCode", e.target.value)}
              placeholder="COA code for the prepaid asset"
            />

            <label>Expense Account Code</label>
            <input
              value={form.expenseAccountCode}
              onChange={(e) => updateField("expenseAccountCode", e.target.value)}
              placeholder="COA code to amortize into"
            />

            <label>Start Date</label>
            <input
              type="date"
              value={form.startDate}
              onChange={(e) => updateField("startDate", e.target.value)}
            />

            <label>Amount</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.amount}
              onChange={(e) => updateField("amount", e.target.value)}
            />

            <label>Term (Months)</label>
            <input
              type="number"
              min="1"
              step="1"
              value={form.termMonths}
              onChange={(e) => updateField("termMonths", e.target.value)}
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
              {mode === "add" ? "Save Prepaid Account" : "Update Prepaid Account"}
            </button>
          </div>
        </section>

        <section className="group-card">
          <div className="group-list-header">
            <h2>Prepaid Account List</h2>

            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search prepaid account..."
            />
          </div>

          <div className="group-table-wrap">
            <table className="group-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Description</th>
                  <th>Party</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>

              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan="5" className="empty-cell">Loading prepaid accounts...</td>
                  </tr>
                ) : filteredRecords.length > 0 ? (
                  filteredRecords.map((item) => (
                    <tr key={item.id}>
                      <td>{item.prepaidCode}</td>
                      <td>{item.description}</td>
                      <td>{item.partyName}</td>
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
                    <td colSpan="5" className="empty-cell">No prepaid accounts found.</td>
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
