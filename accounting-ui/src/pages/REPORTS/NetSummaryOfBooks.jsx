import { useState } from "react";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import { downloadCsvText, typedRowsToCsv } from "./reportCsv.mjs";
import ReportExportMenu from "./ReportExportMenu.jsx";
import "./LedgerReport.css";

// Net Summary of Books - second of the 9 "Coming Soon" reports identified
// in the technical documentation audit (reportsMenuConfig.js's
// net-summary-of-books item, previously path: null).
//
// Same page shape as SummaryOfBooksByTotals.jsx (its sibling report, one
// row per Book) - the difference is a `net` column (= Total Debit - Total
// Credit) alongside the same Total Debit/Total Credit columns, backed by
// GET /api/reports/books/net-summary. Net is displayed as "0.00" rather
// than blank even when zero, since a Book's net SHOULD be 0.00 in a
// healthy system (every individually-posted voucher is itself balanced) -
// this report's purpose is to make a non-zero net (a data-integrity
// anomaly) visible at a glance, so a value of exactly zero is meaningful
// information, not "no data". Negative values use a plain minus sign, no
// parentheses - the same convention statementModel.mjs documents for
// Income Statement figures. No financial math happens in this file -
// every figure comes verbatim from the backend's
// LedgerReportService.getNetSummaryOfBooks, which itself only adds a
// derived field on top of the unchanged getBooksSummaryTotals().

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

export default function NetSummaryOfBooks() {
  const [fromDate, setFromDate] = useState("2026-01-01");
  const [toDate, setToDate] = useState(new Date().toISOString().slice(0, 10));
  const [summary, setSummary] = useState(null); // null = not yet generated
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function generateReport() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ from: fromDate, to: toDate });
      const res = await fetch(`${API_URL}/api/reports/books/net-summary?${params.toString()}`, {
        credentials: "include",
        headers: authHeaders(),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        setSummary(null);
        setError(body.message || "Unable to generate the Net Summary of Books for the selected filters.");
        return;
      }
      setSummary(body);
    } catch (err) {
      console.error("NET SUMMARY OF BOOKS ERROR:", err);
      setSummary(null);
      setError("Unable to reach the server. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function clearFilters() {
    setSummary(null);
    setError(null);
  }

  function exportCSV() {
    if (!summary || !summary.books || !summary.books.length) return;
    const T = (v) => ({ t: "text", v: v == null ? "" : String(v) });
    const N = (v) => ({ t: "num", v: Number(v || 0).toFixed(2) });

    const csvRows = [
      [T("NET SUMMARY OF BOOKS")],
      [T(`For the period ${fromDate} to ${toDate}`)],
      [],
      [T("Book"), T("Transactions"), T("Total Debit"), T("Total Credit"), T("Net")],
      ...summary.books.map((b) => [T(b.label), N(b.transactionCount), N(b.totalDebit), N(b.totalCredit), N(b.net)]),
      [],
      [T("GRAND TOTAL"), T(""), N(summary.grandTotalDebit), N(summary.grandTotalCredit), N(summary.grandTotalNet)],
    ];

    const safeTo = String(toDate).replace(/[^0-9A-Za-z_-]/g, "_");
    downloadCsvText(`Net_Summary_of_Books_${safeTo}.csv`, typedRowsToCsv(csvRows));
  }

  const generated = summary !== null;

  return (
    <div className="lgr-page">
      <div className="lgr-header">
        <h1>Net Summary of Books</h1>
      </div>

      <div className="lgr-filters">
        <h2>Report Filters</h2>

        <div className="lgr-filter-grid">
          <div>
            <label htmlFor="nsb-from">Date From</label>
            <input id="nsb-from" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </div>

          <div>
            <label htmlFor="nsb-to">Date To</label>
            <input id="nsb-to" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
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
            disabled={!summary || !summary.books || !summary.books.length}
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
            <h2>NET SUMMARY OF BOOKS</h2>
            <h3>
              FOR THE PERIOD {formatAsOfDate(fromDate)} TO {formatAsOfDate(toDate)}
            </h3>
          </div>

          {summary.books.length === 0 ? (
            <div className="lgr-empty">No Posted records found for the selected dates.</div>
          ) : (
            <table className="lgr-table">
              <thead>
                <tr>
                  <th>Book</th>
                  <th>Transactions</th>
                  <th>Total Debit</th>
                  <th>Total Credit</th>
                  <th>Net</th>
                </tr>
              </thead>

              <tbody>
                {summary.books.map((b) => (
                  <tr key={b.book}>
                    <td>{b.label}</td>
                    <td>{b.transactionCount}</td>
                    <td className="amount">{Number(b.totalDebit) > 0 ? formatMoney(b.totalDebit) : ""}</td>
                    <td className="amount">{Number(b.totalCredit) > 0 ? formatMoney(b.totalCredit) : ""}</td>
                    <td className="amount">{formatMoney(b.net)}</td>
                  </tr>
                ))}
              </tbody>

              <tfoot>
                <tr>
                  <td colSpan={2} style={{ textAlign: "right" }}>
                    GRAND TOTAL
                  </td>
                  <td className="amount">{formatMoney(summary.grandTotalDebit)}</td>
                  <td className="amount">{formatMoney(summary.grandTotalCredit)}</td>
                  <td className="amount">{formatMoney(summary.grandTotalNet)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      )}

      {!generated && !error ? (
        <div className="lgr-empty">Choose a date range and click Generate Report.</div>
      ) : null}
    </div>
  );
}
