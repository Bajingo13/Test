import { useState } from "react";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import { downloadCsvText, typedRowsToCsv } from "./reportCsv.mjs";
import ReportExportMenu from "./ReportExportMenu.jsx";
import "./LedgerReport.css";

// Daily Cash Position Report - third of the 9 "Coming Soon" reports
// identified in the technical documentation audit (reportsMenuConfig.js's
// daily-cash-position item, previously path: null).
//
// A point-in-time snapshot (single "As Of Date", not a From/To range - same
// single-date convention Balance Sheet already uses), one row per active
// Cash/Bank account (the same bank_codes-flagged account universe Cash Flow
// Statement/Bank Reconciliation already use), backed by
// GET /api/reports/daily-cash-position. Columns: Beginning Cash, Cash
// Receipts, Cash Disbursements, Net Movement, Ending Cash - all computed
// server-side (GET /api/reports/daily-cash-position); no financial math
// happens in this file. Negative values use a plain minus sign, no
// parentheses, matching statementModel.mjs's convention.

const API_URL = import.meta.env.VITE_API_URL || "";

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

export default function DailyCashPositionReport() {
  const [asOfDate, setAsOfDate] = useState(new Date().toISOString().slice(0, 10));
  const [report, setReport] = useState(null); // null = not yet generated
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function generateReport() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ date: asOfDate });
      const res = await fetch(`${API_URL}/api/reports/daily-cash-position?${params.toString()}`, {
        credentials: "include",
        headers: authHeaders(),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        setReport(null);
        setError(body.message || "Unable to generate the Daily Cash Position report for the selected date.");
        return;
      }
      setReport(body);
    } catch (err) {
      console.error("DAILY CASH POSITION REPORT ERROR:", err);
      setReport(null);
      setError("Unable to reach the server. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function clearFilters() {
    setReport(null);
    setError(null);
  }

  function exportCSV() {
    if (!report || !report.accounts || !report.accounts.length) return;
    const T = (v) => ({ t: "text", v: v == null ? "" : String(v) });
    const N = (v) => ({ t: "num", v: Number(v || 0).toFixed(2) });

    const csvRows = [
      [T("DAILY CASH POSITION REPORT")],
      [T(`As of ${asOfDate}`)],
      [],
      [T("Account"), T("Beginning Cash"), T("Cash Receipts"), T("Cash Disbursements"), T("Net Movement"), T("Ending Cash")],
      ...report.accounts.map((a) => [
        T(`${a.accountCode} - ${a.accountTitle}`),
        N(a.beginningBalance),
        N(a.cashReceipts),
        N(a.cashDisbursements),
        N(a.netMovement),
        N(a.endingBalance),
      ]),
      [],
      [
        T("GRAND TOTAL"),
        N(report.totalBeginningBalance),
        N(report.totalCashReceipts),
        N(report.totalCashDisbursements),
        N(report.totalNetMovement),
        N(report.totalEndingBalance),
      ],
    ];

    const safeDate = String(asOfDate).replace(/[^0-9A-Za-z_-]/g, "_");
    downloadCsvText(`Daily_Cash_Position_${safeDate}.csv`, typedRowsToCsv(csvRows));
  }

  const generated = report !== null;

  return (
    <div className="lgr-page">
      <div className="lgr-header">
        <h1>Daily Cash Position Report</h1>
      </div>

      <div className="lgr-filters">
        <h2>Report Filters</h2>

        <div className="lgr-filter-grid">
          <div>
            <label htmlFor="dcp-asof">As Of Date</label>
            <input id="dcp-asof" type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
          </div>
        </div>

        <div className="lgr-actions">
          <button className="primary" onClick={generateReport} disabled={loading}>
            {loading ? "Generating..." : "Generate Report"}
          </button>
          <button className="secondary" onClick={clearFilters} disabled={loading}>
            Clear Filters
          </button>
          <ReportExportMenu
            disabled={!report || !report.accounts || !report.accounts.length}
            onPrint={() => window.print()}
            onExportCsv={exportCSV}
          />
        </div>
      </div>

      {error ? (
        <div className="lgr-error" role="alert">
          {error}
        </div>
      ) : null}

      {generated && !error && (
        <div className="lgr-report-card">
          <div className="lgr-report-title">
            <h2>DAILY CASH POSITION REPORT</h2>
            <h3>AS OF {formatAsOfDate(report.asOfDate)}</h3>
          </div>

          {report.accounts.length === 0 ? (
            <div className="lgr-empty">No active Cash/Bank accounts are configured (see Bank Codes under File Setup).</div>
          ) : (
            <table className="lgr-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Beginning Cash</th>
                  <th>Cash Receipts</th>
                  <th>Cash Disbursements</th>
                  <th>Net Movement</th>
                  <th>Ending Cash</th>
                </tr>
              </thead>

              <tbody>
                {report.accounts.map((a) => (
                  <tr key={a.accountCode}>
                    <td>{a.accountCode} - {a.accountTitle}</td>
                    <td className="amount">{formatMoney(a.beginningBalance)}</td>
                    <td className="amount">{Number(a.cashReceipts) > 0 ? formatMoney(a.cashReceipts) : ""}</td>
                    <td className="amount">{Number(a.cashDisbursements) > 0 ? formatMoney(a.cashDisbursements) : ""}</td>
                    <td className="amount">{formatMoney(a.netMovement)}</td>
                    <td className="amount">{formatMoney(a.endingBalance)}</td>
                  </tr>
                ))}
              </tbody>

              <tfoot>
                <tr>
                  <td style={{ textAlign: "right" }}>GRAND TOTAL</td>
                  <td className="amount">{formatMoney(report.totalBeginningBalance)}</td>
                  <td className="amount">{formatMoney(report.totalCashReceipts)}</td>
                  <td className="amount">{formatMoney(report.totalCashDisbursements)}</td>
                  <td className="amount">{formatMoney(report.totalNetMovement)}</td>
                  <td className="amount">{formatMoney(report.totalEndingBalance)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      )}

      {!generated && !error ? (
        <div className="lgr-empty">Choose an As Of Date and click Generate Report.</div>
      ) : null}
    </div>
  );
}
