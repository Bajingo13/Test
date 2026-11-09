import { useState } from "react";
import ReportPeriodFilter, { ReportPeriodLabel } from "./ReportPeriodFilter.jsx";
import { downloadCsvText, reportRowsToCsv } from "./reportCsv.mjs";
import useReportPeriod from "./useReportPeriod.js";
import { periodCsvRows, periodFileSlug, reportPeriodText } from "./reportPeriod.mjs";
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

// Bank & Cash Movement Report (formerly mislabeled "Cash Flow Statement" -
// see the Reports Module Audit): same LedgerReportService engine as the
// General Ledger, just scoped server-side to accounts flagged BANK / CASH
// (via bank_codes) instead of every account. It shows opening balances,
// dated cash/bank movements, inflow/outflow totals and ending balances - it
// is NOT a GAAP Cash Flow Statement and deliberately makes no
// Operating/Investing/Financing split. A true Indirect Cash Flow Statement
// would need per-COA-account cash-flow activity classification + a non-cash
// flag, which is separate accounting-classification work (out of scope
// here). The route (/reports/cash-flow-statement) and API
// (GET /api/reports/cash-flow-statement) paths are intentionally kept for
// backward compatibility; only user-facing labels changed.
export default function CashFlowStatement() {
  const period = useReportPeriod({ defaultFrom: "2026-01-01", defaultTo: new Date().toISOString().slice(0, 10) });
  const { toDate } = period;
  const [accounts, setAccounts] = useState([]);
  const [totals, setTotals] = useState({ beginning: 0, ending: 0 });
  const [loading, setLoading] = useState(false);
  const [generated, setGenerated] = useState(false);

  async function generateReport() {
    const applied = period.apply();
    if (!applied) return;
    setLoading(true);
    try {
      const params = new URLSearchParams(applied.params);

      const res = await fetch(`${API_URL}/api/reports/cash-flow-statement?${params.toString()}`, {
        credentials: "include",
        headers: authHeaders(),
      });

      if (!res.ok) throw new Error("Failed to fetch bank & cash movement report");

      const data = await res.json();
      setAccounts(data.accounts || []);
      setTotals({
        beginning: Number(data.totalBeginningBalance || 0),
        ending: Number(data.totalEndingBalance || 0),
      });
    } catch (err) {
      console.error(err);
      alert("Failed to generate the Bank & Cash Movement Report. Please check the backend/server.");
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
    if (!accounts.length) return alert("Please generate the Bank & Cash Movement Report first.");
    const toDate = periodFileSlug(period.applied);
    const csvRows = [
      ["BANK & CASH MOVEMENT REPORT"],
      ...periodCsvRows(period.applied),
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

    downloadCsvText(`Bank_And_Cash_Movement_${toDate}.csv`, reportRowsToCsv(csvRows));
  }

  function downloadExcel() {
    if (!accounts.length) return alert("Please generate the Bank & Cash Movement Report first.");
    const toDate = periodFileSlug(period.applied);

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
        <tr><th colspan="7">BANK &amp; CASH MOVEMENT REPORT</th></tr>
        <tr><th colspan="7">${reportPeriodText(period.applied)}</th></tr>
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
    link.download = `Bank_And_Cash_Movement_${toDate}.xls`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="lgr-page">
      <div className="lgr-header">
        <h1>Bank &amp; Cash Movement Report</h1>
        <p className="lgr-subtitle">
          Shows opening balances, cash/bank account movements, inflows, outflows, and
          ending balances for the selected period.
        </p>
      </div>

      <div className="lgr-filters">
        <h2>Report Filters</h2>

        <div className="lgr-filter-grid">
          <ReportPeriodFilter period={period} idPrefix="cf" />
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
            <h2>BANK &amp; CASH MOVEMENT REPORT</h2>
            <ReportPeriodLabel period={period.applied} />
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
