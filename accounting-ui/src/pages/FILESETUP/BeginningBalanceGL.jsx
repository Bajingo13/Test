import { useMemo, useState } from "react";
import "./BeginningBalanceGL.css";

const emptyEntry = {
  id: null,
  project: "MNL",
  dept: "OPS",
  code: "",
  title: "",
  otherDebit: "",
  otherCredit: "",
  debitBased: "",
  creditBased: "",
  debitOrigCurr: "",
  creditOrigCurr: "",
};

export default function BeginningBalance() {
  const [header, setHeader] = useState({
    filterCode: "NON",
    date: "2023-09-30",
    currency: "PHP",
    currencyName: "PHILIPPINE PESO",
  });

  const [rows, setRows] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [entry, setEntry] = useState(emptyEntry);
  const [editing, setEditing] = useState(false);

  const selectedRow = rows.find((row) => row.id === selectedId);

  const totals = useMemo(() => {
    return rows.reduce(
      (sum, row) => ({
        debit: sum.debit + Number(row.debitBased || 0),
        credit: sum.credit + Number(row.creditBased || 0),
      }),
      { debit: 0, credit: 0 }
    );
  }, [rows]);

  function formatAmount(value) {
    return Number(value || 0).toLocaleString("en-PH", {
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
    });
  }

  function handleEntryChange(field, value) {
    setEntry((prev) => ({
      ...prev,
      [field]: value,
      ...(field === "otherDebit"
        ? {
            debitBased: value,
            debitOrigCurr: value,
            otherCredit: "",
            creditBased: "",
            creditOrigCurr: "",
          }
        : {}),
      ...(field === "otherCredit"
        ? {
            creditBased: value,
            creditOrigCurr: value,
            otherDebit: "",
            debitBased: "",
            debitOrigCurr: "",
          }
        : {}),
    }));
  }

  function insertEntry() {
    setEntry(emptyEntry);
    setEditing(true);
    setSelectedId(null);
  }

  function editEntry() {
    if (!selectedRow) {
      alert("Please select a row to edit.");
      return;
    }

    setEntry(selectedRow);
    setEditing(true);
  }

  function removeEntry() {
    if (!selectedRow) {
      alert("Please select a row to remove.");
      return;
    }

    if (!confirm("Remove selected beginning balance?")) return;

    setRows((prev) => prev.filter((row) => row.id !== selectedId));
    setSelectedId(null);
    setEntry(emptyEntry);
  }

  function saveEntry() {
    if (!entry.code.trim()) return alert("Account code is required.");
    if (!entry.title.trim()) return alert("Account title is required.");

    const debit = Number(entry.otherDebit || 0);
    const credit = Number(entry.otherCredit || 0);

    if (debit <= 0 && credit <= 0) {
      return alert("Enter either debit or credit amount.");
    }

    if (debit > 0 && credit > 0) {
      return alert("Debit and credit cannot both have amount.");
    }

    if (entry.id) {
      setRows((prev) =>
        prev.map((row) => (row.id === entry.id ? entry : row))
      );
    } else {
      const newRow = {
        ...entry,
        id: crypto.randomUUID(),
      };

      setRows((prev) => [...prev, newRow]);
      setSelectedId(newRow.id);
    }

    setEditing(false);
    setEntry(emptyEntry);
  }

  function cancelEntry() {
    setEditing(false);
    setEntry(emptyEntry);
  }

  function saveAll() {
    console.log("SAVE GL BEGINNING BALANCE:", {
      header,
      rows,
    });

    alert("Beginning Balance ready to save to database.");
  }

  return (
    <div className="glbb-page">
      <div className="glbb-card">
        <div className="glbb-header">
          <div>
            <h1>GL Beginning Balance</h1>
            <p>Manage opening general ledger balances before live transactions.</p>
          </div>

          <div className="glbb-header-actions">
            <button onClick={insertEntry}>+ Add Entry</button>
            <button onClick={saveAll} className="primary">Save</button>
          </div>
        </div>

        <div className="glbb-info-grid">
          <div>
            <label>Filter Code</label>
            <input
              value={header.filterCode}
              onChange={(e) =>
                setHeader({ ...header, filterCode: e.target.value })
              }
            />
          </div>

          <div>
            <label>Date</label>
            <input
              type="date"
              value={header.date}
              onChange={(e) => setHeader({ ...header, date: e.target.value })}
            />
          </div>

          <div>
            <label>Currency</label>
            <input
              value={header.currency}
              onChange={(e) =>
                setHeader({ ...header, currency: e.target.value })
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
        </div>
      </div>

      <div className="glbb-card">
        <div className="glbb-section-title">
          <h2>Beginning Balance Entries</h2>

          <div className="glbb-actions">
            <button onClick={insertEntry}>Insert</button>
            <button onClick={editEntry}>Edit</button>
            <button onClick={removeEntry} className="danger">Remove</button>
          </div>
        </div>

        <div className="glbb-table-wrap">
          <table className="glbb-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Title</th>
                <th>Project</th>
                <th>Dept</th>
                <th>Other Debit</th>
                <th>Other Credit</th>
                <th>Debit Based</th>
                <th>Credit Based</th>
              </tr>
            </thead>

            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan="8" className="empty">
                    No beginning balance entries yet.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr
                    key={row.id}
                    onClick={() => setSelectedId(row.id)}
                    className={selectedId === row.id ? "selected" : ""}
                  >
                    <td>{row.code}</td>
                    <td>{row.title}</td>
                    <td>{row.project}</td>
                    <td>{row.dept}</td>
                    <td className="amount">{formatAmount(row.otherDebit)}</td>
                    <td className="amount">{formatAmount(row.otherCredit)}</td>
                    <td className="amount">{formatAmount(row.debitBased)}</td>
                    <td className="amount">{formatAmount(row.creditBased)}</td>
                  </tr>
                ))
              )}
            </tbody>

            <tfoot>
              <tr>
                <td colSpan="6">Totals</td>
                <td className="amount">₱ {formatAmount(totals.debit)}</td>
                <td className="amount">₱ {formatAmount(totals.credit)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="glbb-card">
        <h2>{editing ? "Entry Form" : "Selected Entry Details"}</h2>

        {editing ? (
          <>
            <div className="glbb-form-grid">
              <div>
                <label>Project</label>
                <input
                  value={entry.project}
                  onChange={(e) => handleEntryChange("project", e.target.value)}
                />
              </div>

              <div>
                <label>Dept</label>
                <input
                  value={entry.dept}
                  onChange={(e) => handleEntryChange("dept", e.target.value)}
                />
              </div>

              <div>
                <label>Account Code</label>
                <input
                  value={entry.code}
                  onChange={(e) => handleEntryChange("code", e.target.value)}
                  placeholder="101001"
                />
              </div>

              <div>
                <label>Account Title</label>
                <input
                  value={entry.title}
                  onChange={(e) => handleEntryChange("title", e.target.value)}
                  placeholder="PETTY CASH FUND"
                />
              </div>

              <div>
                <label>Debit</label>
                <input
                  type="number"
                  value={entry.otherDebit}
                  onChange={(e) =>
                    handleEntryChange("otherDebit", e.target.value)
                  }
                  placeholder="0.0000"
                />
              </div>

              <div>
                <label>Credit</label>
                <input
                  type="number"
                  value={entry.otherCredit}
                  onChange={(e) =>
                    handleEntryChange("otherCredit", e.target.value)
                  }
                  placeholder="0.0000"
                />
              </div>
            </div>

            <div className="glbb-footer-actions">
              <button onClick={cancelEntry}>Cancel</button>
              <button onClick={saveEntry} className="primary">
                Save Entry
              </button>
            </div>
          </>
        ) : selectedRow ? (
          <div className="glbb-detail-grid">
            <div><span>Project</span><strong>{selectedRow.project}</strong></div>
            <div><span>Dept</span><strong>{selectedRow.dept}</strong></div>
            <div><span>Code</span><strong>{selectedRow.code}</strong></div>
            <div><span>Title</span><strong>{selectedRow.title}</strong></div>
            <div><span>Debit</span><strong>{formatAmount(selectedRow.otherDebit)}</strong></div>
            <div><span>Credit</span><strong>{formatAmount(selectedRow.otherCredit)}</strong></div>
            <div><span>Debit Based</span><strong>{formatAmount(selectedRow.debitBased)}</strong></div>
            <div><span>Credit Based</span><strong>{formatAmount(selectedRow.creditBased)}</strong></div>
            <div><span>Debit Orig Curr</span><strong>{formatAmount(selectedRow.debitOrigCurr)}</strong></div>
            <div><span>Credit Orig Curr</span><strong>{formatAmount(selectedRow.creditOrigCurr)}</strong></div>
          </div>
        ) : (
          <p className="glbb-muted">Select an entry from the table or click Add Entry.</p>
        )}
      </div>
    </div>
  );
}