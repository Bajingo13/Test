import { useEffect, useMemo, useState } from "react";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import { downloadCsvText, typedRowsToCsv } from "./reportCsv.mjs";
import ReportExportMenu from "./ReportExportMenu.jsx";
import "./LedgerReport.css";

// AR List of Overdue Accounts - sixth of the 9 "Coming Soon" reports
// identified in the technical documentation audit (reportsMenuConfig.js's
// ar-overdue-accounts item, previously path: null).
//
// Built on the existing AR Aging engine (AgingReportService, unchanged) via
// GET /api/reports/ar-overdue-accounts, which simply drops Aging's
// "current" (not-yet-due) bucket - this report shows only strictly
// overdue documents (Days Overdue >= 1), as both a per-customer summary
// and a document-level detail, as of a single reporting date. No
// financial math happens in this file - every figure comes verbatim from
// the backend.

const BUCKET_LABELS = {
  days1to30: "1-30 Days",
  days31to60: "31-60 Days",
  days61to90: "61-90 Days",
  over90: "Over 90 Days",
};
const BUCKET_KEYS = ["days1to30", "days31to60", "days61to90", "over90"];

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

export default function ArOverdueAccounts() {
  const [asOfDate, setAsOfDate] = useState(new Date().toISOString().slice(0, 10));
  const [parties, setParties] = useState([]);
  const [partyId, setPartyId] = useState("");
  const [report, setReport] = useState(null); // null = not yet generated
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadParties();
  }, []);

  async function loadParties() {
    try {
      const res = await fetch(`${API_URL}/api/genlib`, { headers: authHeaders() });
      const data = await res.json().catch(() => []);
      setParties(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("Failed to load General Libraries:", err);
    }
  }

  const customers = useMemo(
    () => parties.filter((p) => p.type === "CUSTOMER" && p.status === "ACTIVE"),
    [parties]
  );

  async function generateReport() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ asOf: asOfDate });
      if (partyId) params.set("partyId", partyId);
      const res = await fetch(`${API_URL}/api/reports/ar-overdue-accounts?${params.toString()}`, {
        credentials: "include",
        headers: authHeaders(),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        setReport(null);
        setError(body.message || "Unable to generate the AR List of Overdue Accounts report for the selected filters.");
        return;
      }
      setReport(body);
    } catch (err) {
      console.error("AR LIST OF OVERDUE ACCOUNTS ERROR:", err);
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
    if (!report || !report.rows) return;
    const T = (v) => ({ t: "text", v: v == null ? "" : String(v) });
    const N = (v) => ({ t: "num", v: Number(v || 0).toFixed(2) });

    const csvRows = [
      [T("AR LIST OF OVERDUE ACCOUNTS")],
      [T(`As of ${asOfDate}`)],
      [],
      [T("SUMMARY BY CUSTOMER")],
      [T("Customer"), T("Documents"), ...BUCKET_KEYS.map((k) => T(BUCKET_LABELS[k])), T("Total Overdue")],
      ...report.parties.map((p) => [
        T(p.partyName),
        N(p.documentCount),
        ...BUCKET_KEYS.map((k) => N(p.buckets[k])),
        N(p.baseBalance),
      ]),
      [],
      [T("DETAIL")],
      [T("Customer"), T("Reference No."), T("Type"), T("Transaction Date"), T("Due Date"), T("Days Overdue"), T("Aging Bucket"), T("Outstanding Balance")],
      ...report.rows.map((r) => [
        T(r.partyName),
        T(r.referenceNo),
        T(r.sourceType),
        T(r.transactionDate),
        T(r.dueDate || ""),
        N(r.daysOutstanding),
        T(BUCKET_LABELS[r.bucket] || r.bucket),
        N(r.baseBalance),
      ]),
      [],
      [T("GRAND TOTAL OVERDUE"), N(report.bucketTotals.base.total)],
    ];

    const safeDate = String(asOfDate).replace(/[^0-9A-Za-z_-]/g, "_");
    downloadCsvText(`AR_Overdue_Accounts_${safeDate}.csv`, typedRowsToCsv(csvRows));
  }

  const generated = report !== null;

  return (
    <div className="lgr-page">
      <div className="lgr-header">
        <h1>AR List of Overdue Accounts</h1>
      </div>

      <div className="lgr-filters">
        <h2>Report Filters</h2>

        <div className="lgr-filter-grid">
          <div>
            <label htmlFor="aoa-customer">Customer</label>
            <select id="aoa-customer" value={partyId} onChange={(e) => setPartyId(e.target.value)}>
              <option value="">All Customers</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} - {c.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="aoa-asof">As Of Date</label>
            <input id="aoa-asof" type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
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
            disabled={!report || !report.rows || !report.rows.length}
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
            <h2>AR LIST OF OVERDUE ACCOUNTS</h2>
            <h3>AS OF {formatAsOfDate(report.asOfDate)}</h3>
          </div>

          {report.rows.length === 0 ? (
            <div className="lgr-empty">No overdue AR accounts found for the selected filters.</div>
          ) : (
            <>
              <h3 style={{ marginTop: "1.5rem" }}>Summary by Customer</h3>
              <table className="lgr-table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Documents</th>
                    {BUCKET_KEYS.map((k) => (
                      <th key={k}>{BUCKET_LABELS[k]}</th>
                    ))}
                    <th>Total Overdue</th>
                  </tr>
                </thead>
                <tbody>
                  {report.parties.map((p) => (
                    <tr key={p.partyId ?? p.partyName}>
                      <td>{p.partyName}</td>
                      <td>{p.documentCount}</td>
                      {BUCKET_KEYS.map((k) => (
                        <td key={k} className="amount">
                          {Number(p.buckets[k]) > 0 ? formatMoney(p.buckets[k]) : ""}
                        </td>
                      ))}
                      <td className="amount">{formatMoney(p.baseBalance)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={2} style={{ textAlign: "right" }}>
                      GRAND TOTAL
                    </td>
                    {BUCKET_KEYS.map((k) => (
                      <td key={k} className="amount">{formatMoney(report.bucketTotals.base[k])}</td>
                    ))}
                    <td className="amount">{formatMoney(report.bucketTotals.base.total)}</td>
                  </tr>
                </tfoot>
              </table>

              <h3 style={{ marginTop: "1.5rem" }}>Detail</h3>
              <table className="lgr-table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Reference No.</th>
                    <th>Type</th>
                    <th>Transaction Date</th>
                    <th>Due Date</th>
                    <th>Days Overdue</th>
                    <th>Aging Bucket</th>
                    <th>Outstanding Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((r, idx) => (
                    <tr key={`${r.sourceType}-${r.sourceId}-${idx}`}>
                      <td>{r.partyName}</td>
                      <td>{r.referenceNo}</td>
                      <td>{r.sourceType}</td>
                      <td>{r.transactionDate}</td>
                      <td>{r.dueDate || ""}</td>
                      <td>{r.daysOutstanding}</td>
                      <td>{BUCKET_LABELS[r.bucket] || r.bucket}</td>
                      <td className="amount">{formatMoney(r.baseBalance)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={7} style={{ textAlign: "right" }}>
                      GRAND TOTAL OVERDUE
                    </td>
                    <td className="amount">{formatMoney(report.bucketTotals.base.total)}</td>
                  </tr>
                </tfoot>
              </table>
            </>
          )}
        </div>
      )}

      {!generated && !error ? (
        <div className="lgr-empty">Choose an As Of Date and click Generate Report.</div>
      ) : null}
    </div>
  );
}
