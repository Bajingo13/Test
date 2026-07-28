import { useState } from "react";
import "./LedgerReport.css";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function formatMoney(amount) {
  return Number(amount || 0).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatAsOfDate(dateValue) {
  if (!dateValue) return "";
  return new Date(dateValue)
    .toLocaleDateString("en-US", { month: "long", day: "2-digit", year: "numeric" })
    .toUpperCase();
}

// Cash Receipts & Disbursements: same LedgerReportService engine as the
// General Ledger, just scoped server-side to accounts flagged BANK / CASH
// (via bank_codes) instead of every account. No Operating/Investing/
// Financing classification - the schema has no field to support that split.
export default function CashFlowStatement() {
  const [fromDate, setFromDate] = useState("2026-01-01");
  const [toDate, setToDate] = useState(new Date().toISOString().slice(0, 10));
  const [accounts, setAccounts] = useState([]);
  const [totals, setTotals] = useState({ beginning: 0, ending: 0 });
  const [loading, setLoading] = useState(false);
  const [generated, setGenerated] = useState(false);

  async function generateReport() {
    setLoading(true);
    try {
      const params = new URLSearchParams({ from: fromDate, to: toDate });

      const res = await fetch(`${API_URL}/api/reports/cash-flow-statement?${params.toString()}`, {
        credentials: "include",
        headers: authHeaders(),
      });

      if (!res.ok) throw new Error("Failed to fetch cash flow statement");

      const data = await res.json();
      setAccounts(data.accounts || []);
      setTotals({
        beginning: Number(data.totalBeginningBalance || 0),
        ending: Number(data.totalEndingBalance || 0),
      });
    } catch (err) {
      console.error(err);
      alert("Failed to generate Cash Flow Statement. Please check the backend/server.");
      setAccounts([]);
    } finally {
      setGenerated(true);
      setLoading(false);
    }
  }

  const totalInflows = accounts.reduce(
    (sum, a) => sum + a.rows.reduce((s, r) => s + Number(r.debit || 0), 0),
    0
  );
  const totalOutflows = accounts.reduce(
    (sum, a) => sum + a.rows.reduce((s, r) => s + Number(r.credit || 0), 0),
    0
  );

  function downloadCSV() {
    if (!accounts.length) return alert("Please generate the Cash Flow Statement first.");

    const csvRows = [
      ["CASH FLOW STATEMENT"],
      [`FOR THE PERIOD ${formatAsOfDate(fromDate)} TO ${formatAsOfDate(toDate)}`],
      [],
      ["", "TOTAL BEGINNING CASH", totals.beginning.toFixed(2)],
      ["", "TOTAL CASH INFLOWS", totalInflows.toFixed(2)],
      ["", "TOTAL CASH OUTFLOWS", totalOutflows.toFixed(2)],
      ["", "TOTAL ENDING CASH", totals.ending.toFixed(2)],
      [],
    ];

    for (const account of accounts) {
      csvRows.push([`${account.accountCode} - ${account.accountTitle}`]);
      csvRows.push(["DATE", "SOURCE", "REFERENCE", "PARTICULARS", "DEBIT", "CREDIT", "BALANCE"]);
      csvRows.push(["", "", "", "BEGINNING BALANCE", "", "", account.beginningBalance.toFixed(2)]);
      for (const row of account.rows) {
        csvRows.push([
          row.transaction_date,
          row.source_type,
          row.reference_no || "",
          row.particulars || "",
          Number(row.debit || 0) > 0 ? Number(row.debit).toFixed(2) : "",
          Number(row.credit || 0) > 0 ? Number(row.credit).toFixed(2) : "",
          (account.beginningBalance + Number(row.running_balance || 0)).toFixed(2),
        ]);
      }
      csvRows.push(["", "", "", "ENDING BALANCE", "", "", account.endingBalance.toFixed(2)]);
      csvRows.push([]);
    }

    const csvContent = csvRows
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `Cash_Flow_Statement_${toDate}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function downloadExcel() {
    if (!accounts.length) return alert("Please generate the Cash Flow Statement first.");

    const htmlAccounts = accounts
      .map(
        (account) => `
          <tr><td colspan="7"><b>${account.accountCode} - ${account.accountTitle}</b></td></tr>
          <tr>
            <th>DATE</th><th>SOURCE</th><th>REFERENCE</th><th>PARTICULARS</th>
            <th>DEBIT</th><th>CREDIT</th><th>BALANCE</th>
          </tr>
          <tr>
            <td></td><td></td><td></td><td>BEGINNING BALANCE</td><td></td><td></td>
            <td>${account.beginningBalance.toFixed(2)}</td>
          </tr>
          ${account.rows
            .map(
              (row) => `
                <tr>
                  <td>${row.transaction_date}</td>
                  <td>${row.source_type}</td>
                  <td>${row.reference_no || ""}</td>
                  <td>${row.particulars || ""}</td>
                  <td>${Number(row.debit || 0) > 0 ? Number(row.debit).toFixed(2) : ""}</td>
                  <td>${Number(row.credit || 0) > 0 ? Number(row.credit).toFixed(2) : ""}</td>
                  <td>${(account.beginningBalance + Number(row.running_balance || 0)).toFixed(2)}</td>
                </tr>
              `
            )
            .join("")}
          <tr><td colspan="7"></td></tr>
        `
      )
      .join("");

    const htmlTable = `
      <table border="1">
        <tr><th colspan="7">CASH FLOW STATEMENT</th></tr>
        <tr><th colspan="7">FOR THE PERIOD ${formatAsOfDate(fromDate)} TO ${formatAsOfDate(toDate)}</th></tr>
        <tr></tr>
        <tr><td colspan="2">TOTAL BEGINNING CASH</td><td>${totals.beginning.toFixed(2)}</td></tr>
        <tr><td colspan="2">TOTAL CASH INFLOWS</td><td>${totalInflows.toFixed(2)}</td></tr>
        <tr><td colspan="2">TOTAL CASH OUTFLOWS</td><td>${totalOutflows.toFixed(2)}</td></tr>
        <tr><td colspan="2">TOTAL ENDING CASH</td><td>${totals.ending.toFixed(2)}</td></tr>
        <tr></tr>
        ${htmlAccounts}
      </table>
    `;

    const blob = new Blob([htmlTable], { type: "application/vnd.ms-excel" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `Cash_Flow_Statement_${toDate}.xls`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="lgr-page">
      <div className="lgr-header">
        <h1>Cash Flow Statement</h1>
      </div>

      <div className="lgr-filters">
        <h2>Report Filters</h2>

        <div className="lgr-filter-grid">
          <div>
            <label>Date From</label>
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </div>

          <div>
            <label>Date To</label>
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </div>
        </div>

        <div className="lgr-actions">
          <button className="primary" onClick={generateReport} disabled={loading}>
            {loading ? "Generating..." : "Generate Report"}
          </button>

          <button
            className="secondary"
            onClick={() => {
              setAccounts([]);
              setGenerated(false);
            }}
          >
            Clear Filters
          </button>

          <button className="dark" onClick={() => window.print()}>
            Export PDF
          </button>

          <button className="dark" onClick={downloadExcel}>
            Export Excel
          </button>

          <button className="dark" onClick={downloadCSV}>
            Export CSV
          </button>
        </div>
      </div>

      {generated && (
        <div className="lgr-report-card">
          <div className="lgr-report-title">
            <h2>CASH FLOW STATEMENT</h2>
            <h3>
              FOR THE PERIOD {formatAsOfDate(fromDate)} TO {formatAsOfDate(toDate)}
            </h3>
          </div>

          {accounts.length === 0 ? (
            <div className="lgr-empty">
              No accounts are flagged "BANK / CASH" in the Chart of Accounts yet, or there was
              no cash activity for the selected period.
            </div>
          ) : (
            <>
              <div className="lgr-summary-grid">
                <div className="lgr-summary-item">
                  <div className="label">Total Beginning Cash</div>
                  <div className="value">₱ {formatMoney(totals.beginning)}</div>
                </div>
                <div className="lgr-summary-item">
                  <div className="label">Total Cash Inflows</div>
                  <div className="value">₱ {formatMoney(totalInflows)}</div>
                </div>
                <div className="lgr-summary-item">
                  <div className="label">Total Cash Outflows</div>
                  <div className="value">₱ {formatMoney(totalOutflows)}</div>
                </div>
                <div className="lgr-summary-item">
                  <div className="label">Total Ending Cash</div>
                  <div className="value">₱ {formatMoney(totals.ending)}</div>
                </div>
              </div>

              {accounts.map((account) => (
                <div className="lgr-account-section" key={account.accountCode}>
                  <div className="lgr-account-header">
                    <span className="name">
                      {account.accountCode} - {account.accountTitle}
                    </span>
                    <span className="balances">
                      Beginning: ₱ {formatMoney(account.beginningBalance)} &nbsp;|&nbsp; Ending: ₱{" "}
                      {formatMoney(account.endingBalance)}
                    </span>
                  </div>

                  {account.rows.length === 0 ? (
                    <div className="lgr-empty">No cash activity in this period.</div>
                  ) : (
                    <table className="lgr-table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Source</th>
                          <th>Reference</th>
                          <th>Particulars</th>
                          <th>Debit</th>
                          <th>Credit</th>
                          <th>Balance</th>
                        </tr>
                      </thead>

                      <tbody>
                        {account.rows.map((row, idx) => (
                          <tr key={idx}>
                            <td>{row.transaction_date}</td>
                            <td>{row.source_type}</td>
                            <td>{row.reference_no}</td>
                            <td>{row.particulars}</td>
                            <td className="amount">
                              {Number(row.debit) > 0 ? formatMoney(row.debit) : ""}
                            </td>
                            <td className="amount">
                              {Number(row.credit) > 0 ? formatMoney(row.credit) : ""}
                            </td>
                            <td className="amount">
                              {formatMoney(account.beginningBalance + Number(row.running_balance || 0))}
                            </td>
                          </tr>
                        ))}
                      </tbody>

                      <tfoot>
                        <tr>
                          <td colSpan={6} style={{ textAlign: "right" }}>
                            Ending Balance
                          </td>
                          <td className="amount">{formatMoney(account.endingBalance)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
