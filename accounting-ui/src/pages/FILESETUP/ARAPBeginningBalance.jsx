import { useEffect, useMemo, useState } from "react";
import "./ARAPBeginningBalance.css";

const API_BASE = import.meta.env.VITE_API_URL || "";

function emptyLine(balanceType) {
  return {
    id: crypto.randomUUID(),
    partyId: "",
    partyCode: "",
    partyName: "",
    accountId: "",
    accountCode: "",
    accountTitle: "",
    particulars: "",
    referenceNo: "",
    dueDate: "",
    debit: balanceType === "AR" ? "" : "0",
    credit: balanceType === "AP" ? "" : "0",
    balanceAmount: "",
    scheduleDate: "",
    scheduleAmount: "",
  };
}

export default function ARAPBeginningBalance({ balanceType }) {
  const isAR = balanceType === "AR";
  const title = isAR ? "AR Beginning Balance" : "AP Beginning Balance";
  const partyLabel = isAR ? "Customer" : "Supplier";

  const [parties, setParties] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [rows, setRows] = useState([]);
  const [selectedId, setSelectedId] = useState(null);

  const [header, setHeader] = useState({
    balanceDate: new Date().toISOString().split("T")[0],
    currencyCode: "PHP",
    currencyName: "PHILIPPINE PESO",
    remarks: "",
  });

  const [form, setForm] = useState(emptyLine(balanceType));

  useEffect(() => {
    loadParties();
    loadAccounts();
    loadBalances();
    setForm(emptyLine(balanceType));
  }, [balanceType]);

  async function loadParties() {
    try {
      const res = await fetch(`${API_BASE}/api/genlib`, {
        credentials: "include",
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.message || "Failed to load General Libraries");
        return;
      }

      const filtered = data.filter((party) =>
        isAR ? party.type === "CUSTOMER" : party.type === "SUPPLIER"
      );

      setParties(filtered.filter((party) => party.status === "ACTIVE"));
    } catch (err) {
      console.error("LOAD PARTIES ERROR:", err);
    }
  }

  async function loadAccounts() {
    try {
      const res = await fetch(`${API_BASE}/api/coa`, {
        credentials: "include",
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.message || "Failed to load Chart of Accounts");
        return;
      }

      const filtered = data.filter((account) => {
        const accountTitle = String(account.title || "").toLowerCase();

        return isAR
          ? accountTitle.includes("receivable")
          : accountTitle.includes("payable");
      });

      setAccounts(filtered);
    } catch (err) {
      console.error("LOAD ACCOUNTS ERROR:", err);
    }
  }

  async function loadBalances() {
    try {
      const res = await fetch(
        `${API_BASE}/api/arap-beginning-balances/${balanceType}`,
        {
          credentials: "include",
        }
      );

      const data = await res.json();

      if (res.ok) {
        setRows(data);
      }
    } catch (err) {
      console.error("LOAD AR/AP BEGINNING BALANCES ERROR:", err);
    }
  }

  const totals = useMemo(() => {
    return rows.reduce(
      (sum, row) => ({
        debit: sum.debit + Number(row.debit || 0),
        credit: sum.credit + Number(row.credit || 0),
        balance: sum.balance + Number(row.balanceAmount || 0),
      }),
      { debit: 0, credit: 0, balance: 0 }
    );
  }, [rows]);

  function formatMoney(value) {
    return Number(value || 0).toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function handlePartyChange(value) {
    const party = parties.find((item) => String(item.id) === String(value));

    setForm((prev) => ({
      ...prev,
      partyId: party?.id || "",
      partyCode: party?.code || "",
      partyName: party?.name || "",
    }));
  }

  function handleAccountChange(value) {
    const account = accounts.find((item) => String(item.id) === String(value));

    setForm((prev) => ({
      ...prev,
      accountId: account?.id || "",
      accountCode: account?.code || "",
      accountTitle: account?.title || "",
    }));
  }

  function resetForm() {
    setSelectedId(null);
    setForm(emptyLine(balanceType));
  }

  function editRow(row) {
    setSelectedId(row.id);

    setForm({
      id: row.id,
      partyId: row.partyId || "",
      partyCode: row.partyCode || "",
      partyName: row.partyName || "",
      accountId: row.accountId || "",
      accountCode: row.accountCode || "",
      accountTitle: row.accountTitle || "",
      particulars: row.particulars || "",
      referenceNo: row.referenceNo || "",
      dueDate: row.dueDate || "",
      debit: row.debit || "",
      credit: row.credit || "",
      balanceAmount: row.balanceAmount || "",
      scheduleDate: row.scheduleDate || row.dueDate || "",
      scheduleAmount: row.scheduleAmount || row.balanceAmount || "",
    });
  }

  async function saveBalance() {
    if (!form.accountId) return alert("Account is required.");
    if (!form.partyId) return alert(`${partyLabel} code is required.`);
    if (!form.referenceNo.trim()) return alert("Reference No. is required.");
    if (!form.dueDate) return alert("Due date is required.");

    const amount = isAR ? Number(form.debit || 0) : Number(form.credit || 0);

    if (amount <= 0) {
      return alert(`${isAR ? "Debit" : "Credit"} amount is required.`);
    }

    const payload = {
      balanceType,
      ...header,
      line: {
        ...form,
        debit: isAR ? amount : 0,
        credit: isAR ? 0 : amount,
        balanceAmount: amount,
        scheduleDate: form.scheduleDate || form.dueDate,
        scheduleAmount: Number(form.scheduleAmount || amount),
      },
    };

    try {
      const res = await fetch(`${API_BASE}/api/arap-beginning-balances`, {
        method: selectedId ? "PUT" : "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.message || "Failed to save beginning balance.");
        return;
      }

      alert(`${title} saved successfully.`);
      resetForm();
      loadBalances();
    } catch (err) {
      console.error("SAVE AR/AP BEGINNING BALANCE ERROR:", err);
      alert("Unable to connect to server.");
    }
  }

  async function removeBalance(id) {
    if (!confirm("Remove selected beginning balance?")) return;

    try {
      const res = await fetch(`${API_BASE}/api/arap-beginning-balances/${id}`, {
        method: "DELETE",
        credentials: "include",
      });

      if (!res.ok) {
        alert("Failed to remove beginning balance.");
        return;
      }

      resetForm();
      loadBalances();
    } catch (err) {
      console.error("DELETE AR/AP BEGINNING BALANCE ERROR:", err);
    }
  }

  return (
    <div className="arap-page">
      <div className="arap-header-card">
        <div>
          <h1>{title}</h1>
          <p>
            Encode opening {isAR ? "customer receivables" : "supplier payables"} and payment schedules.
          </p>
        </div>

        <button onClick={resetForm} className="arap-btn primary">
          + New Entry
        </button>
      </div>

      <div className="arap-card">
        <div className="arap-grid">
          <div>
            <label>Beginning Date</label>
            <input
              type="date"
              value={header.balanceDate}
              onChange={(e) =>
                setHeader({ ...header, balanceDate: e.target.value })
              }
            />
          </div>

          <div>
            <label>Currency</label>
            <input
              value={header.currencyCode}
              onChange={(e) =>
                setHeader({ ...header, currencyCode: e.target.value })
              }
            />
          </div>

          <div>
            <label>Currency Name</label>
            <input
              value={header.currencyName}
              onChange={(e) =>
                setHeader({ ...header, currencyName: e.target.value })
              }
            />
          </div>

          <div>
            <label>Remarks</label>
            <input
              value={header.remarks}
              onChange={(e) =>
                setHeader({ ...header, remarks: e.target.value })
              }
              placeholder="Optional"
            />
          </div>
        </div>
      </div>

      <div className="arap-card">
        <h2>Balance Entry</h2>

        <div className="arap-entry-table-wrap">
          <table className="arap-entry-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Particulars</th>
                <th>Gen Ref</th>
                <th>Gen Name</th>
                <th>Reference No.</th>
                <th>Due Date</th>
                <th>{isAR ? "Debit" : "Credit"}</th>
                <th>Schedule Date</th>
              </tr>
            </thead>

            <tbody>
              <tr>
                <td>
                  <select
                    value={form.accountId}
                    onChange={(e) => handleAccountChange(e.target.value)}
                  >
                    <option value="">Select account</option>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.code} - {account.title}
                      </option>
                    ))}
                  </select>
                </td>

                <td>
                  <input
                    value={form.particulars || ""}
                    onChange={(e) =>
                      setForm({ ...form, particulars: e.target.value })
                    }
                    placeholder="Beginning balance"
                  />
                </td>

                <td>
                  <select
                    value={form.partyId}
                    onChange={(e) => handlePartyChange(e.target.value)}
                  >
                    <option value="">Select {partyLabel} code</option>
                    {parties.map((party) => (
                      <option key={party.id} value={party.id}>
                        {party.code}
                      </option>
                    ))}
                  </select>
                </td>

                <td>
                  <input value={form.partyName || ""} readOnly />
                </td>

                <td>
                  <input
                    value={form.referenceNo}
                    onChange={(e) =>
                      setForm({ ...form, referenceNo: e.target.value })
                    }
                    placeholder={isAR ? "AR-BEG-0001" : "AP-BEG-0001"}
                  />
                </td>

                <td>
                  <input
                    type="date"
                    value={form.dueDate}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        dueDate: e.target.value,
                        scheduleDate: form.scheduleDate || e.target.value,
                      })
                    }
                  />
                </td>

                <td>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={isAR ? form.debit : form.credit}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        debit: isAR ? e.target.value : 0,
                        credit: isAR ? 0 : e.target.value,
                        balanceAmount: e.target.value,
                        scheduleAmount: e.target.value,
                      })
                    }
                    placeholder="0.00"
                    className="arap-amount-input"
                  />
                </td>

                <td>
                  <input
                    type="date"
                    value={form.scheduleDate}
                    onChange={(e) =>
                      setForm({ ...form, scheduleDate: e.target.value })
                    }
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="arap-actions">
          <button onClick={resetForm}>Cancel</button>
          <button onClick={saveBalance} className="arap-btn primary">
            {selectedId ? "Update Balance" : "Save Balance"}
          </button>
        </div>
      </div>

      <div className="arap-card">
        <h2>{title} List</h2>

        <div className="arap-table-wrap">
          <table className="arap-table">
            <thead>
              <tr>
                <th>{partyLabel}</th>
                <th>Account</th>
                <th>Reference</th>
                <th>Due Date</th>
                <th>Debit</th>
                <th>Credit</th>
                <th>Balance</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>

            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan="9" className="arap-empty">
                    No {title} records yet.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.partyName}</td>
                    <td>
                      {row.accountCode} - {row.accountTitle}
                    </td>
                    <td>{row.referenceNo}</td>
                    <td>{row.dueDate}</td>
                    <td className="amount">₱ {formatMoney(row.debit)}</td>
                    <td className="amount">₱ {formatMoney(row.credit)}</td>
                    <td className="amount">
                      ₱ {formatMoney(row.balanceAmount)}
                    </td>
                    <td>{row.status}</td>
                    <td>
                      <button onClick={() => editRow(row)}>Edit</button>
                      <button
                        onClick={() => removeBalance(row.id)}
                        className="danger"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>

            <tfoot>
              <tr>
                <td colSpan="4">Totals</td>
                <td className="amount">₱ {formatMoney(totals.debit)}</td>
                <td className="amount">₱ {formatMoney(totals.credit)}</td>
                <td className="amount">₱ {formatMoney(totals.balance)}</td>
                <td colSpan="2"></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}