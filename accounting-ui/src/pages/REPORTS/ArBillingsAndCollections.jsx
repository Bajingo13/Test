import { useEffect, useMemo, useState } from "react";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import { downloadCsvText, typedRowsToCsv } from "./reportCsv.mjs";
import ReportExportMenu from "./ReportExportMenu.jsx";
import "./LedgerReport.css";

// AR Billings & Collections - fifth of the 9 "Coming Soon" reports
// identified in the technical documentation audit (reportsMenuConfig.js's
// ar-billings-and-collections item, previously path: null).
//
// A PERIOD, multi-customer summary - distinct from AR Statement of
// Accounts (the single-customer chronological ledger completed just
// before this report). Customer filter is optional here (an "All
// Customers" default, following the same GET /api/genlib picker pattern
// ArStatementOfAccounts.jsx/SubsidiaryLedger.jsx already established),
// backed by GET /api/reports/ar-billings-and-collections. Columns:
// Customer, Beginning AR, Billings, Debit Memos, Collections, Credit
// Memos, Ending AR - all computed server-side; no financial math happens
// in this file. Negative balances use a plain minus sign, matching this
// report series' established convention.

const API_URL = import.meta.env.VITE_API_URL || "";

function formatMoney(amount) {
  return Number(amount || 0).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function ArBillingsAndCollections() {
  const [fromDate, setFromDate] = useState("2026-01-01");
  const [toDate, setToDate] = useState(new Date().toISOString().slice(0, 10));
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
      const params = new URLSearchParams({ from: fromDate, to: toDate });
      if (partyId) params.set("partyId", partyId);
      const res = await fetch(`${API_URL}/api/reports/ar-billings-and-collections?${params.toString()}`, {
        credentials: "include",
        headers: authHeaders(),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        setReport(null);
        setError(body.message || "Unable to generate the AR Billings & Collections report for the selected filters.");
        return;
      }
      setReport(body);
    } catch (err) {
      console.error("AR BILLINGS & COLLECTIONS ERROR:", err);
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
    if (!report || !report.customers) return;
    const T = (v) => ({ t: "text", v: v == null ? "" : String(v) });
    const N = (v) => ({ t: "num", v: Number(v || 0).toFixed(2) });

    const csvRows = [
      [T("AR BILLINGS & COLLECTIONS")],
      [T(`For the period ${fromDate} to ${toDate}`)],
      [],
      [T("Customer"), T("Beginning AR"), T("Billings"), T("Debit Memos"), T("Collections"), T("Credit Memos"), T("Ending AR")],
      ...report.customers.map((c) => [
        T(`${c.partyCode} - ${c.partyName}`),
        N(c.beginningBalance),
        N(c.billings),
        N(c.debitMemos),
        N(c.collections),
        N(c.creditMemos),
        N(c.endingBalance),
      ]),
      [],
      [
        T("GRAND TOTAL"),
        N(report.grandTotalBeginningBalance),
        N(report.grandTotalBillings),
        N(report.grandTotalDebitMemos),
        N(report.grandTotalCollections),
        N(report.grandTotalCreditMemos),
        N(report.grandTotalEndingBalance),
      ],
    ];

    const safeTo = String(toDate).replace(/[^0-9A-Za-z_-]/g, "_");
    downloadCsvText(`AR_Billings_and_Collections_${safeTo}.csv`, typedRowsToCsv(csvRows));
  }

  const generated = report !== null;

  return (
    <div className="lgr-page">
      <div className="lgr-header">
        <h1>AR Billings &amp; Collections</h1>
      </div>

      <div className="lgr-filters">
        <h2>Report Filters</h2>

        <div className="lgr-filter-grid">
          <div>
            <label htmlFor="abc-customer">Customer</label>
            <select id="abc-customer" value={partyId} onChange={(e) => setPartyId(e.target.value)}>
              <option value="">All Customers</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} - {c.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="abc-from">Date From</label>
            <input id="abc-from" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </div>

          <div>
            <label htmlFor="abc-to">Date To</label>
            <input id="abc-to" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
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
            disabled={!report || !report.customers || !report.customers.length}
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
            <h2>AR BILLINGS &amp; COLLECTIONS</h2>
            <h3>FOR THE PERIOD {report.from} TO {report.to}</h3>
          </div>

          {report.customers.length === 0 ? (
            <div className="lgr-empty">No customer AR activity found for the selected filters.</div>
          ) : (
            <table className="lgr-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Beginning AR</th>
                  <th>Billings</th>
                  <th>Debit Memos</th>
                  <th>Collections</th>
                  <th>Credit Memos</th>
                  <th>Ending AR</th>
                </tr>
              </thead>

              <tbody>
                {report.customers.map((c) => (
                  <tr key={c.partyId}>
                    <td>{c.partyCode} - {c.partyName}</td>
                    <td className="amount">{formatMoney(c.beginningBalance)}</td>
                    <td className="amount">{Number(c.billings) > 0 ? formatMoney(c.billings) : ""}</td>
                    <td className="amount">{Number(c.debitMemos) > 0 ? formatMoney(c.debitMemos) : ""}</td>
                    <td className="amount">{Number(c.collections) > 0 ? formatMoney(c.collections) : ""}</td>
                    <td className="amount">{Number(c.creditMemos) > 0 ? formatMoney(c.creditMemos) : ""}</td>
                    <td className="amount">{formatMoney(c.endingBalance)}</td>
                  </tr>
                ))}
              </tbody>

              <tfoot>
                <tr>
                  <td style={{ textAlign: "right" }}>GRAND TOTAL</td>
                  <td className="amount">{formatMoney(report.grandTotalBeginningBalance)}</td>
                  <td className="amount">{formatMoney(report.grandTotalBillings)}</td>
                  <td className="amount">{formatMoney(report.grandTotalDebitMemos)}</td>
                  <td className="amount">{formatMoney(report.grandTotalCollections)}</td>
                  <td className="amount">{formatMoney(report.grandTotalCreditMemos)}</td>
                  <td className="amount">{formatMoney(report.grandTotalEndingBalance)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      )}

      {!generated && !error ? (
        <div className="lgr-empty">Choose a customer (optional) and date range, then click Generate Report.</div>
      ) : null}
    </div>
  );
}
