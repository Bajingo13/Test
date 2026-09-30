import { useEffect, useMemo, useState } from "react";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import { downloadCsvText, typedRowsToCsv } from "./reportCsv.mjs";
import ReportExportMenu from "./ReportExportMenu.jsx";
import "./LedgerReport.css";

// AP List of Payables and Payments - seventh of the 9 "Coming Soon"
// reports identified in the technical documentation audit
// (reportsMenuConfig.js's ap-payables-and-payments item, previously
// path: null).
//
// A PERIOD, multi-supplier summary - the AP structural mirror of AR
// Billings & Collections. Supplier filter is optional (an "All Suppliers"
// default, following the same GET /api/genlib picker pattern
// ArBillingsAndCollections.jsx already established, filtered to
// party_type === "SUPPLIER"), backed by
// GET /api/reports/ap-payables-and-payments. Columns: Supplier, Beginning
// Payable, Payables, Debit Memos, Payments, Credit Memos, Ending Payable -
// all computed server-side; no financial math happens in this file.
// Negative balances use a plain minus sign, matching this report series'
// established convention.

const API_URL = import.meta.env.VITE_API_URL || "";

function formatMoney(amount) {
  return Number(amount || 0).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function ApListOfPayablesAndPayments() {
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

  const suppliers = useMemo(
    () => parties.filter((p) => p.type === "SUPPLIER" && p.status === "ACTIVE"),
    [parties]
  );

  async function generateReport() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ from: fromDate, to: toDate });
      if (partyId) params.set("partyId", partyId);
      const res = await fetch(`${API_URL}/api/reports/ap-payables-and-payments?${params.toString()}`, {
        credentials: "include",
        headers: authHeaders(),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        setReport(null);
        setError(body.message || "Unable to generate the AP List of Payables and Payments report for the selected filters.");
        return;
      }
      setReport(body);
    } catch (err) {
      console.error("AP LIST OF PAYABLES AND PAYMENTS ERROR:", err);
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
    if (!report || !report.suppliers) return;
    const T = (v) => ({ t: "text", v: v == null ? "" : String(v) });
    const N = (v) => ({ t: "num", v: Number(v || 0).toFixed(2) });

    const csvRows = [
      [T("AP LIST OF PAYABLES AND PAYMENTS")],
      [T(`For the period ${fromDate} to ${toDate}`)],
      [],
      [T("Supplier"), T("Beginning Payable"), T("Payables"), T("Debit Memos"), T("Payments"), T("Credit Memos"), T("Ending Payable")],
      ...report.suppliers.map((s) => [
        T(`${s.partyCode} - ${s.partyName}`),
        N(s.beginningPayable),
        N(s.payables),
        N(s.debitMemos),
        N(s.payments),
        N(s.creditMemos),
        N(s.endingPayable),
      ]),
      [],
      [
        T("GRAND TOTAL"),
        N(report.grandTotalBeginningPayable),
        N(report.grandTotalPayables),
        N(report.grandTotalDebitMemos),
        N(report.grandTotalPayments),
        N(report.grandTotalCreditMemos),
        N(report.grandTotalEndingPayable),
      ],
    ];

    const safeTo = String(toDate).replace(/[^0-9A-Za-z_-]/g, "_");
    downloadCsvText(`AP_Payables_and_Payments_${safeTo}.csv`, typedRowsToCsv(csvRows));
  }

  const generated = report !== null;

  return (
    <div className="lgr-page">
      <div className="lgr-header">
        <h1>AP List of Payables and Payments</h1>
      </div>

      <div className="lgr-filters">
        <h2>Report Filters</h2>

        <div className="lgr-filter-grid">
          <div>
            <label htmlFor="apy-supplier">Supplier</label>
            <select id="apy-supplier" value={partyId} onChange={(e) => setPartyId(e.target.value)}>
              <option value="">All Suppliers</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} - {s.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="apy-from">Date From</label>
            <input id="apy-from" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </div>

          <div>
            <label htmlFor="apy-to">Date To</label>
            <input id="apy-to" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
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
            disabled={!report || !report.suppliers || !report.suppliers.length}
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
            <h2>AP LIST OF PAYABLES AND PAYMENTS</h2>
            <h3>FOR THE PERIOD {report.from} TO {report.to}</h3>
          </div>

          {report.suppliers.length === 0 ? (
            <div className="lgr-empty">No supplier AP activity found for the selected filters.</div>
          ) : (
            <table className="lgr-table">
              <thead>
                <tr>
                  <th>Supplier</th>
                  <th>Beginning Payable</th>
                  <th>Payables</th>
                  <th>Debit Memos</th>
                  <th>Payments</th>
                  <th>Credit Memos</th>
                  <th>Ending Payable</th>
                </tr>
              </thead>

              <tbody>
                {report.suppliers.map((s) => (
                  <tr key={s.partyId}>
                    <td>{s.partyCode} - {s.partyName}</td>
                    <td className="amount">{formatMoney(s.beginningPayable)}</td>
                    <td className="amount">{Number(s.payables) > 0 ? formatMoney(s.payables) : ""}</td>
                    <td className="amount">{Number(s.debitMemos) > 0 ? formatMoney(s.debitMemos) : ""}</td>
                    <td className="amount">{Number(s.payments) > 0 ? formatMoney(s.payments) : ""}</td>
                    <td className="amount">{Number(s.creditMemos) > 0 ? formatMoney(s.creditMemos) : ""}</td>
                    <td className="amount">{formatMoney(s.endingPayable)}</td>
                  </tr>
                ))}
              </tbody>

              <tfoot>
                <tr>
                  <td style={{ textAlign: "right" }}>GRAND TOTAL</td>
                  <td className="amount">{formatMoney(report.grandTotalBeginningPayable)}</td>
                  <td className="amount">{formatMoney(report.grandTotalPayables)}</td>
                  <td className="amount">{formatMoney(report.grandTotalDebitMemos)}</td>
                  <td className="amount">{formatMoney(report.grandTotalPayments)}</td>
                  <td className="amount">{formatMoney(report.grandTotalCreditMemos)}</td>
                  <td className="amount">{formatMoney(report.grandTotalEndingPayable)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      )}

      {!generated && !error ? (
        <div className="lgr-empty">Choose a supplier (optional) and date range, then click Generate Report.</div>
      ) : null}
    </div>
  );
}
