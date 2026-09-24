import { useState } from "react";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import { downloadCsvText, typedRowsToCsv } from "./reportCsv.mjs";
import ReportExportMenu from "./ReportExportMenu.jsx";
import "./LedgerReport.css";

// Summary of Books by Totals - first of the 9 "Coming Soon" reports
// identified in the technical documentation audit (reportsMenuConfig.js's
// summary-of-books-totals item, previously path: null).
//
// Deliberately NOT a BookReport.jsx wrapper: that shared component renders
// one row per transaction LINE for a single Book (source_type-filtered).
// This report shows one row per BOOK (7 rows) with each Book's own
// pre-aggregated Total Debit/Total Credit, from the new backend endpoint
// GET /api/reports/books/summary-totals - a different data shape, so it
// gets its own small page, following the same filter/fetch/export pattern
// (same CSS, same ReportExportMenu, same authHeaders/handleAuthError) so it
// looks and behaves consistently with every other Reports page. No
// financial math happens here - every total comes verbatim from the
// backend's LedgerReportService.getBooksSummaryTotals, which itself is a
// pure re-aggregation of the same 7 canonical per-Book row sets the
// individual Book of Accounts pages already use.

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

export default function SummaryOfBooksByTotals() {
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
      const res = await fetch(`${API_URL}/api/reports/books/summary-totals?${params.toString()}`, {
        credentials: "include",
        headers: authHeaders(),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        setSummary(null);
        setError(body.message || "Unable to generate the Summary of Books by Totals for the selected filters.");
        return;
      }
      setSummary(body);
    } catch (err) {
      console.error("SUMMARY OF BOOKS BY TOTALS ERROR:", err);
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
      [T("SUMMARY OF BOOKS BY TOTALS")],
      [T(`For the period ${fromDate} to ${toDate}`)],
      [],
      [T("Book"), T("Transactions"), T("Total Debit"), T("Total Credit")],
      ...summary.books.map((b) => [T(b.label), N(b.transactionCount), N(b.totalDebit), N(b.totalCredit)]),
      [],
      [T("GRAND TOTAL"), T(""), N(summary.grandTotalDebit), N(summary.grandTotalCredit)],
    ];

    const safeTo = String(toDate).replace(/[^0-9A-Za-z_-]/g, "_");
    downloadCsvText(`Summary_of_Books_by_Totals_${safeTo}.csv`, typedRowsToCsv(csvRows));
  }

  const generated = summary !== null;

  return (
    <div className="lgr-page">
      <div className="lgr-header">
        <h1>Summary of Books by Totals</h1>
      </div>

      <div className="lgr-filters">
        <h2>Report Filters</h2>

        <div className="lgr-filter-grid">
          <div>
            <label htmlFor="sbt-from">Date From</label>
            <input id="sbt-from" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </div>

          <div>
            <label htmlFor="sbt-to">Date To</label>
            <input id="sbt-to" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
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
            <h2>SUMMARY OF BOOKS BY TOTALS</h2>
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
                </tr>
              </thead>

              <tbody>
                {summary.books.map((b) => (
                  <tr key={b.book}>
                    <td>{b.label}</td>
                    <td>{b.transactionCount}</td>
                    <td className="amount">{Number(b.totalDebit) > 0 ? formatMoney(b.totalDebit) : ""}</td>
                    <td className="amount">{Number(b.totalCredit) > 0 ? formatMoney(b.totalCredit) : ""}</td>
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
