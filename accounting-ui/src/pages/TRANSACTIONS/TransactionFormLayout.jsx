import React, { useMemo, useState } from "react";
import "./TransactionFormLayout.css";

const API_BASE = "http://localhost:8080";

const accountOptions = [
  { id: 1, code: "1010", name: "Cash on Hand", type: "Asset" },
  { id: 2, code: "1011", name: "Cash in Bank", type: "Asset" },
  { id: 3, code: "1100", name: "Accounts Receivable", type: "Asset" },
  { id: 4, code: "2000", name: "Accounts Payable", type: "Liability" },
  { id: 5, code: "4000", name: "Sales Revenue", type: "Revenue" },
  { id: 6, code: "5000", name: "Office Supplies Expense", type: "Expense" },
  { id: 7, code: "5100", name: "Utilities Expense", type: "Expense" },
  { id: 8, code: "5200", name: "Salary Expense", type: "Expense" },
];

function createLine() {
  return {
    id: crypto.randomUUID(),
    accountId: "",
    particulars: "",
    debit: "",
    credit: "",
  };
}

function formatMoney(value) {
  return Number(value || 0).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function TransactionFormLayout({
  title,
  code,
  partyLabel,
  showCheckNo = false,
  defaultDescription = "",
  defaultLines = [createLine(), createLine()],
}) {
  const [form, setForm] = useState({
    date: new Date().toISOString().split("T")[0],
    referenceNo: "",
    party: "",
    description: defaultDescription,
    checkNo: "",
    status: "Draft",
  });

  const [lines, setLines] = useState(defaultLines);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const totals = useMemo(() => {
    const totalDebit = lines.reduce((sum, line) => sum + Number(line.debit || 0), 0);
    const totalCredit = lines.reduce((sum, line) => sum + Number(line.credit || 0), 0);

    return {
      totalDebit,
      totalCredit,
      balanced: totalDebit === totalCredit && totalDebit > 0,
    };
  }, [lines]);

  function updateForm(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function updateLine(id, field, value) {
    setLines((prev) =>
      prev.map((line) => {
        if (line.id !== id) return line;

        const updated = { ...line, [field]: value };

        if (field === "debit" && value !== "") updated.credit = "";
        if (field === "credit" && value !== "") updated.debit = "";

        return updated;
      })
    );
  }

  function addLine() {
    setLines((prev) => [...prev, createLine()]);
  }

  function removeLine(id) {
    if (lines.length <= 2) return;
    setLines((prev) => prev.filter((line) => line.id !== id));
  }

  function validate() {
    if (!form.date) return "Date is required.";
    if (!form.referenceNo.trim()) return "Reference number is required.";
    if (!form.party.trim()) return `${partyLabel} is required.`;

    for (const line of lines) {
      const debit = Number(line.debit || 0);
      const credit = Number(line.credit || 0);

      if (!line.accountId) return "Each line must have an account selected.";
      if (debit > 0 && credit > 0) return "A line cannot have both debit and credit.";
      if (debit <= 0 && credit <= 0) return "Each line must have either debit or credit.";
    }

    if (lines.length < 2) return "At least two lines are required.";
    if (!totals.balanced) return "Debit and Credit totals must be equal.";

    return "";
  }

  async function handleSave(status) {
    const validationError = validate();

    if (validationError) {
      setError(validationError);
      return;
    }

    setError("");
    setSaving(true);

    try {
      const payload = {
        voucherNo: form.referenceNo,
        supplierId: null,
        supplierName: form.party,
        transactionDate: form.date,
        dueDate: form.date,
        referenceNo: form.referenceNo,
        description: form.description,
        remarks: form.checkNo,
        status,
        totalDebit: totals.totalDebit,
        totalCredit: totals.totalCredit,
        lines: lines.map((line) => {
          const selectedAccount = accountOptions.find(
            (account) => String(account.id) === String(line.accountId)
          );

          return {
            accountId: Number(line.accountId),
            accountCode: selectedAccount?.code || "",
            accountTitle: selectedAccount?.name || "",
            particulars: line.particulars,
            debit: Number(line.debit || 0),
            credit: Number(line.credit || 0),
          };
        }),
      };

      const res = await fetch(`${API_BASE}/api/apv`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.message || "Failed to save APV.");
        return;
      }

      setForm((prev) => ({
        ...prev,
        status,
      }));

      alert(`${title} ${status} saved successfully.`);
    } catch (err) {
      console.error("SAVE APV ERROR:", err);
      alert("Unable to connect to server.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="transaction-page">
      <div className="transaction-wrapper">
        <div className="transaction-topbar">
          <div>
            <h1 className="transaction-title">{title}</h1>
            <p className="transaction-subtitle"></p>
          </div>

          <div className="transaction-status-pill">{form.status}</div>
        </div>

        <div className="transaction-card">
          <div className="transaction-grid">
            <div className="transaction-field">
              <label className="transaction-label">Date</label>
              <input
                type="date"
                value={form.date}
                onChange={(e) => updateForm("date", e.target.value)}
                className="transaction-input"
              />
            </div>

            <div className="transaction-field">
              <label className="transaction-label">Reference No.</label>
              <input
                type="text"
                value={form.referenceNo}
                onChange={(e) => updateForm("referenceNo", e.target.value)}
                placeholder={`${code}-000001`}
                className="transaction-input"
              />
            </div>

            <div className="transaction-field">
              <label className="transaction-label">{partyLabel}</label>
              <input
                type="text"
                value={form.party}
                onChange={(e) => updateForm("party", e.target.value)}
                placeholder={`Enter ${partyLabel.toLowerCase()}`}
                className="transaction-input"
              />
            </div>

            <div className="transaction-field">
              <label className="transaction-label">
                {showCheckNo ? "Check No." : "Transaction Type"}
              </label>
              <input
                type="text"
                value={showCheckNo ? form.checkNo : title}
                onChange={(e) => {
                  if (showCheckNo) updateForm("checkNo", e.target.value);
                }}
                readOnly={!showCheckNo}
                placeholder={showCheckNo ? "Enter check number" : ""}
                className={`transaction-input ${!showCheckNo ? "transaction-input-readonly" : ""}`}
              />
            </div>
          </div>

          <div className="transaction-memo-wrap">
            <label className="transaction-label">Description / Memo</label>
            <textarea
              value={form.description}
              onChange={(e) => updateForm("description", e.target.value)}
              rows={3}
              placeholder="Enter transaction details"
              className="transaction-textarea"
            />
          </div>
        </div>

        <div className="transaction-card">
          <div className="transaction-section-header">
            <div>
              <h2 className="transaction-section-title">Journal Entries</h2>
              <p className="transaction-section-subtext">Minimum of one debit and one credit</p>
            </div>

            <button onClick={addLine} className="transaction-add-button">
              + Add Line
            </button>
          </div>

          <div className="transaction-table-container">
            <table className="transaction-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Particulars</th>
                  <th className="text-right">Debit</th>
                  <th className="text-right">Credit</th>
                  <th className="text-center">Action</th>
                </tr>
              </thead>

              <tbody>
                {lines.map((line) => (
                  <tr key={line.id}>
                    <td>
                      <select
                        value={line.accountId}
                        onChange={(e) => updateLine(line.id, "accountId", e.target.value)}
                        className="transaction-table-input"
                      >
                        <option value="">Select account</option>
                        {accountOptions.map((account) => (
                          <option key={account.id} value={account.id}>
                            {account.code} - {account.name}
                          </option>
                        ))}
                      </select>
                    </td>

                    <td>
                      <input
                        type="text"
                        value={line.particulars}
                        onChange={(e) => updateLine(line.id, "particulars", e.target.value)}
                        placeholder="Entry description"
                        className="transaction-table-input"
                      />
                    </td>

                    <td>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={line.debit}
                        onChange={(e) => updateLine(line.id, "debit", e.target.value)}
                        placeholder="0.00"
                        className="transaction-table-input transaction-table-input-right"
                      />
                    </td>

                    <td>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={line.credit}
                        onChange={(e) => updateLine(line.id, "credit", e.target.value)}
                        placeholder="0.00"
                        className="transaction-table-input transaction-table-input-right"
                      />
                    </td>

                    <td className="text-center">
                      <button
                        onClick={() => removeLine(line.id)}
                        disabled={lines.length <= 2}
                        className="transaction-remove-button"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>

              <tfoot>
                <tr>
                  <td colSpan={2} className="transaction-total-label">Totals</td>
                  <td className="transaction-total-amount">₱ {formatMoney(totals.totalDebit)}</td>
                  <td className="transaction-total-amount">₱ {formatMoney(totals.totalCredit)}</td>
                  <td className="transaction-total-status">
                    <span className={`transaction-balance-badge ${totals.balanced ? "balanced" : "not-balanced"}`}>
                      {totals.balanced ? "Balanced" : "Not Balanced"}
                    </span>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {error ? <div className="transaction-error-box">{error}</div> : null}
        </div>

        <div className="transaction-bottom-bar">
          <button
            onClick={() => handleSave("Draft")}
            className="transaction-secondary-button"
            disabled={saving}
          >
            {saving ? "Saving..." : "Save Draft"}
          </button>

          <button
            onClick={() => handleSave("Posted")}
            className="transaction-primary-button"
            disabled={saving}
          >
            {saving ? "Saving..." : "Post Transaction"}
          </button>
        </div>
      </div>
    </div>
  );
}