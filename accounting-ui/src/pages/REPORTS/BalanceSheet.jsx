import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { downloadCsvText } from "./reportCsv.mjs";
import {
  statementToCsv,
  statementFilename,
  balanceSheetScreenParams,
  toQueryString,
  statementWarnings,
  formatScreenAmount,
} from "./statementModel.mjs";
import StatementView from "./StatementView.jsx";
import StatementPrintView from "./StatementPrintView.jsx";
import ReportExportMenu from "./ReportExportMenu.jsx";
import "./BalanceSheet.css";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default function BalanceSheet() {
  const navigate = useNavigate();
  const today = new Date().toISOString().slice(0, 10);

  const [toDate, setToDate] = useState(today);
  const [compareTo, setCompareTo] = useState("");
  const [mode, setMode] = useState("condensed");

  const [model, setModel] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const req = useMemo(
    () => balanceSheetScreenParams({ to: toDate, compareTo, mode }),
    [toDate, compareTo, mode]
  );

  async function generateReport() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/reports/balance-sheet?${toQueryString(req.params)}`, {
        credentials: "include",
        headers: authHeaders(),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setModel(null);
        setError(body.message || "Unable to generate the Balance Sheet for the selected filters.");
        return;
      }
      setModel(body);
    } catch (err) {
      console.error("BALANCE SHEET ERROR:", err);
      setModel(null);
      setError("Unable to reach the server. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  // Re-fetch the canonical structured report when the report shape changes
  // (mode, or the comparative as-of). Detailed is never faked client-side.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (model || error) generateReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, compareTo]);

  function clearReport() {
    setModel(null);
    setError(null);
  }

  function exportCSV() {
    if (!model) return alert("Generate the report first.");
    downloadCsvText(statementFilename(model), statementToCsv(model));
  }

  function openAccount(accountCode) {
    navigate(
      `/reports/account-analysis?accountCode=${encodeURIComponent(accountCode)}&from=2026-01-01&to=${toDate}`
    );
  }

  const warnings = statementWarnings(model);

  return (
    <div className="bs-page">
      <h1>Balance Sheet</h1>

      <div className="bs-card no-print">
        <h2>Report Filters</h2>

        <div className="bs-grid">
          <div>
            <label htmlFor="bs-asof">As Of</label>
            <input id="bs-asof" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </div>

          <div>
            <label htmlFor="bs-compare">Compare To (optional)</label>
            <input id="bs-compare" type="date" value={compareTo} onChange={(e) => setCompareTo(e.target.value)} />
          </div>

          <div>
            <label htmlFor="bs-mode">Report Mode</label>
            <select id="bs-mode" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="condensed">Condensed</option>
              <option value="detailed">Detailed</option>
            </select>
          </div>
        </div>

        <div className="bs-actions">
          <button className="primary" onClick={generateReport} disabled={loading}>
            {loading ? "Generating..." : "Generate Report"}
          </button>
          <button className="secondary" onClick={clearReport} disabled={loading}>
            Clear Filters
          </button>
          <ReportExportMenu
            disabled={!model}
            onPrint={() => window.print()}
            onExportCsv={exportCSV}
          />
        </div>
      </div>

      {loading ? <div className="stmt-loading">Generating the Balance Sheet…</div> : null}

      {error ? (
        <div className="stmt-error" role="alert">
          {error}
        </div>
      ) : null}

      {warnings.unclassified.show ? (
        <div className="stmt-warning" role="status">
          <strong>Group Code classification incomplete</strong>
          {warnings.unclassified.message}
        </div>
      ) : null}

      {warnings.balance.show ? (
        <div className="stmt-warning" role="status">
          <strong>Balance Sheet is out of balance</strong>
          {warnings.balance.message}
          {warnings.balance.columns.length ? (
            <ul>
              {warnings.balance.columns.map((c) => (
                <li key={c.key}>
                  {c.label}: difference of {formatScreenAmount(c.delta)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {model ? (
        <>
          <StatementView model={model} onAccountClick={openAccount} />
          <StatementPrintView model={model} />
        </>
      ) : !loading && !error ? (
        <div className="stmt-empty">Choose an as-of date and click Generate Report.</div>
      ) : null}
    </div>
  );
}
