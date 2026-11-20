import { useEffect, useMemo, useState } from "react";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import { downloadCsvText, typedRowsToCsv } from "./reportCsv.mjs";
import ReportExportMenu from "./ReportExportMenu.jsx";
import ReportPeriodFilter, { ReportPeriodLabel } from "./ReportPeriodFilter.jsx";
import useReportPeriod from "./useReportPeriod.js";
import { periodCsvRows, periodFileSlug } from "./reportPeriod.mjs";
import "./LedgerReport.css";

// AP Statement of Accounts (TC-REPORT-015) - the supplier-side mirror of
// ArStatementOfAccounts.jsx (same layout, filters, export / print), backed by
// GET /api/reports/ap-statement-of-accounts. Supplier picker: GET /api/genlib
// filtered client-side to party_type === "SUPPLIER" && status === "ACTIVE".
// Debit = payments and supplier debit memos (reduce AP); Credit = APVs (at
// their AP control amount), AP beginning balances and supplier credit memos
// (increase AP); Running Balance = amount payable. All amounts are computed
// server-side; no financial math happens in this file.

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

export default function ApStatementOfAccounts() {
  const period = useReportPeriod({ defaultFrom: "2026-01-01", defaultTo: new Date().toISOString().slice(0, 10) });
  const { toDate } = period;
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

  const suppliers = useMemo(
    () => parties.filter((p) => p.type === "SUPPLIER" && p.status === "ACTIVE"),
    [parties]
  );

  async function generateReport() {
    const applied = period.apply();
    if (!applied) return;
    if (!partyId) {
      setError("Please select a supplier.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ partyId, ...applied.params });
      const res = await fetch(`${API_URL}/api/reports/ap-statement-of-accounts?${params.toString()}`, {
        credentials: "include",
        headers: authHeaders(),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        setStatement(null);
        setError(body.message || "Unable to generate the AP Statement of Accounts for the selected filters.");
        return;
      }
      setStatement(body);
    } catch (err) {
      console.error("AP STATEMENT OF ACCOUNTS ERROR:", err);
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
      [T("AP STATEMENT OF ACCOUNTS")],
      [T(`${statement.partyCode || ""} - ${statement.partyName || ""}`)],
      ...periodCsvRows(period.applied),
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

    const safeTo = periodFileSlug(period.applied);
    downloadCsvText(`AP_Statement_of_Accounts_${safeTo}.csv`, typedRowsToCsv(csvRows));
  }

  const generated = statement !== null;

  return (
    <div className="lgr-page">
      <div className="lgr-header">
        <h1>AP Statement of Accounts</h1>
      </div>

      <div className="lgr-filters">
        <h2>Report Filters</h2>

        <div className="lgr-filter-grid">
          <div>
            <label htmlFor="aps-supplier">Supplier</label>
            <select id="aps-supplier" value={partyId} onChange={(e) => setPartyId(e.target.value)}>
              <option value="">Select a supplier...</option>
              {suppliers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} - {c.name}
                </option>
              ))}
            </select>
          </div>

          <ReportPeriodFilter period={period} idPrefix="aps" />
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
            <h2>AP STATEMENT OF ACCOUNTS</h2>
            <h3>{statement.partyCode} - {statement.partyName}</h3>
            <ReportPeriodLabel period={period.applied} />
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
        <div className="lgr-empty">Select a supplier and date range, then click Generate Report.</div>
      ) : null}
    </div>
  );
}
