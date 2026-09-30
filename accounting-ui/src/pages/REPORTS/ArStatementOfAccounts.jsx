import { useEffect, useMemo, useState } from "react";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import { downloadCsvText, typedRowsToCsv } from "./reportCsv.mjs";
import ReportExportMenu from "./ReportExportMenu.jsx";
import "./LedgerReport.css";

// AR Statement of Accounts - fourth of the 9 "Coming Soon" reports
// identified in the technical documentation audit (reportsMenuConfig.js's
// ar-statement-of-accounts item, previously path: null).
//
// A single-customer statement (customer picker follows the exact pattern
// SubsidiaryLedger.jsx already established: GET /api/genlib, filtered
// client-side to party_type === "CUSTOMER" && status === "ACTIVE"), over a
// date range, backed by GET /api/reports/ar-statement-of-accounts. Columns:
// Date, Reference No., Type, Due Date (Invoice rows only), Particulars,
// Debit (Charge), Credit (Payment), Running Balance - plus a Beginning
// Balance row and an Ending Balance summary, all computed server-side; no
// financial math happens in this file. Negative balances (a customer credit
// position) use a plain minus sign, no parentheses, matching this report
// series' established convention.

const API_URL = import.meta.env.VITE_API_URL || "";

function formatMoney(amount) {
  return Number(amount || 0).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatDate(dateValue) {
  if (!dateValue) return "";
  return new Date(dateValue)
    .toLocaleDateString("en-US", { month: "long", day: "2-digit", year: "numeric" })
    .toUpperCase();
}

export default function ArStatementOfAccounts() {
  const [fromDate, setFromDate] = useState("2026-01-01");
  const [toDate, setToDate] = useState(new Date().toISOString().slice(0, 10));
  const [parties, setParties] = useState([]);
  const [partyId, setPartyId] = useState("");
  const [statement, setStatement] = useState(null); // null = not yet generated
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
    if (!partyId) {
      setError("Please select a customer.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ partyId, from: fromDate, to: toDate });
      const res = await fetch(`${API_URL}/api/reports/ar-statement-of-accounts?${params.toString()}`, {
        credentials: "include",
        headers: authHeaders(),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        setStatement(null);
        setError(body.message || "Unable to generate the AR Statement of Accounts for the selected filters.");
        return;
      }
      setStatement(body);
    } catch (err) {
      console.error("AR STATEMENT OF ACCOUNTS ERROR:", err);
      setStatement(null);
      setError("Unable to reach the server. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function clearFilters() {
    setStatement(null);
    setError(null);
  }

  function exportCSV() {
    if (!statement) return;
    const T = (v) => ({ t: "text", v: v == null ? "" : String(v) });
    const N = (v) => ({ t: "num", v: Number(v || 0).toFixed(2) });

    const csvRows = [
      [T("AR STATEMENT OF ACCOUNTS")],
      [T(`${statement.partyCode || ""} - ${statement.partyName || ""}`)],
      [T(`For the period ${fromDate} to ${toDate}`)],
      [],
      [T("Date"), T("Reference No."), T("Type"), T("Due Date"), T("Particulars"), T("Debit"), T("Credit"), T("Running Balance")],
      [T(""), T(""), T(""), T(""), T("BEGINNING BALANCE"), T(""), T(""), N(statement.beginningBalance)],
      ...statement.rows.map((r) => [
        T(r.transactionDate),
        T(r.referenceNo),
        T(r.sourceType),
        T(r.dueDate || ""),
        T(r.particulars),
        N(r.debit),
        N(r.credit),
        N(r.runningBalance),
      ]),
      [],
      [T(""), T(""), T(""), T(""), T("ENDING BALANCE"), T(""), T(""), N(statement.endingBalance)],
    ];

    const safeTo = String(toDate).replace(/[^0-9A-Za-z_-]/g, "_");
    downloadCsvText(`AR_Statement_of_Accounts_${safeTo}.csv`, typedRowsToCsv(csvRows));
  }

  const generated = statement !== null;

  return (
    <div className="lgr-page">
      <div className="lgr-header">
        <h1>AR Statement of Accounts</h1>
      </div>

      <div className="lgr-filters">
        <h2>Report Filters</h2>

        <div className="lgr-filter-grid">
          <div>
            <label htmlFor="ars-customer">Customer</label>
            <select id="ars-customer" value={partyId} onChange={(e) => setPartyId(e.target.value)}>
              <option value="">Select a customer...</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} - {c.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="ars-from">Date From</label>
            <input id="ars-from" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </div>

          <div>
            <label htmlFor="ars-to">Date To</label>
            <input id="ars-to" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
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
            disabled={!statement}
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
            <h2>AR STATEMENT OF ACCOUNTS</h2>
            <h3>{statement.partyCode} - {statement.partyName}</h3>
            <h3>
              FOR THE PERIOD {formatDate(statement.from)} TO {formatDate(statement.to)}
            </h3>
          </div>

          <table className="lgr-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Reference No.</th>
                <th>Type</th>
                <th>Due Date</th>
                <th>Particulars</th>
                <th>Debit</th>
                <th>Credit</th>
                <th>Running Balance</th>
              </tr>
            </thead>

            <tbody>
              <tr>
                <td colSpan={4}></td>
                <td style={{ fontStyle: "italic" }}>Beginning Balance</td>
                <td className="amount"></td>
                <td className="amount"></td>
                <td className="amount">{formatMoney(statement.beginningBalance)}</td>
              </tr>
              {statement.rows.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <div className="lgr-empty">No Posted transactions found for the selected dates.</div>
                  </td>
                </tr>
              ) : (
                statement.rows.map((r, idx) => (
                  <tr key={`${r.sourceType}-${r.referenceNo}-${idx}`}>
                    <td>{r.transactionDate}</td>
                    <td>{r.referenceNo}</td>
                    <td>{r.sourceType}</td>
                    <td>{r.dueDate || ""}</td>
                    <td>{r.particulars}</td>
                    <td className="amount">{Number(r.debit) > 0 ? formatMoney(r.debit) : ""}</td>
                    <td className="amount">{Number(r.credit) > 0 ? formatMoney(r.credit) : ""}</td>
                    <td className="amount">{formatMoney(r.runningBalance)}</td>
                  </tr>
                ))
              )}
            </tbody>

            <tfoot>
              <tr>
                <td colSpan={4}></td>
                <td style={{ textAlign: "right", fontWeight: "bold" }}>ENDING BALANCE</td>
                <td className="amount"></td>
                <td className="amount"></td>
                <td className="amount">{formatMoney(statement.endingBalance)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {!generated && !error ? (
        <div className="lgr-empty">Select a customer and date range, then click Generate Report.</div>
      ) : null}
    </div>
  );
}
