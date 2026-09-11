import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { downloadCsvText } from "./reportCsv.mjs";
import {
  statementToCsv,
  statementFilename,
  incomeStatementScreenParams,
  toQueryString,
  statementWarnings,
} from "./statementModel.mjs";
import StatementView from "./StatementView.jsx";
import StatementPrintView from "./StatementPrintView.jsx";
import ReportExportMenu from "./ReportExportMenu.jsx";
import "./IncomeStatement.css";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function IncomeStatement() {
  const navigate = useNavigate();
  const today = new Date().toISOString().slice(0, 10);

  const [fromDate, setFromDate] = useState("2026-01-01");
  const [toDate, setToDate] = useState(today);
  const [mode, setMode] = useState("condensed");
  const [comparePrevWanted, setComparePrevWanted] = useState(true);

  const [model, setModel] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // request shape (also drives the enabled/disabled state of the compact
  // "Previous Month" comparison checkbox) - all logic lives in the pure
  // helper; previous-month comparison is only offered for a full calendar
  // month.
  const req = useMemo(
    () => incomeStatementScreenParams({ from: fromDate, to: toDate, mode, comparePrevWanted }),
    [fromDate, toDate, mode, comparePrevWanted]
  );

  async function generateReport() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/reports/income-statement?${toQueryString(req.params)}`, {
        credentials: "include",
        headers: authHeaders(),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setModel(null);
        setError(body.message || "Unable to generate the Income Statement for the selected filters.");
        return;
      }
      setModel(body);
    } catch (err) {
      console.error("INCOME STATEMENT ERROR:", err);
      setModel(null);
      setError("Unable to reach the server. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  // Changing the report shape (mode / comparison) re-fetches from the
  // canonical structured endpoint - Detailed is never faked client-side.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (model || error) generateReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, comparePrevWanted]);

  function clearReport() {
    setModel(null);
    setError(null);
  }

  function exportCSV() {
    if (!model) return alert("Generate the report first.");
    // The CSV is the exact statement currently on screen - same mode, dates
    // and comparison - because it serializes the displayed model.
    downloadCsvText(statementFilename(model), statementToCsv(model));
  }

  function openAccount(accountCode) {
    navigate(
      `/reports/account-analysis?accountCode=${encodeURIComponent(accountCode)}&from=${fromDate}&to=${toDate}`
    );
  }

  const warnings = statementWarnings(model);

  return (
    <div className="is-page">
      <h1>Income Statement</h1>

      <div className="is-card no-print">
        <h2>Report Filters</h2>

        <div className="is-grid">
          <div>
            <label htmlFor="is-from">Date From</label>
            <input id="is-from" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </div>

          <div>
            <label htmlFor="is-to">Date To</label>
            <input id="is-to" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </div>

          <div>
            <label htmlFor="is-mode">Report Mode</label>
            <select id="is-mode" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="condensed">Condensed</option>
              <option value="detailed">Detailed</option>
            </select>
          </div>

          <div className="is-compare-field">
            <label className={`is-compare-check${!req.wholeMonth ? " is-compare-check--disabled" : ""}`}>
              <input
                type="checkbox"
                checked={req.comparePrevActive}
                disabled={!req.wholeMonth}
                onChange={(e) => setComparePrevWanted(e.target.checked)}
                aria-describedby={req.comparePrevDisabledReason ? "is-compare-hint" : undefined}
              />
              <span>Previous Month</span>
            </label>
            {req.comparePrevDisabledReason ? (
              <span id="is-compare-hint" className="is-compare-hint">
                {req.comparePrevDisabledReason}
              </span>
            ) : null}
          </div>
        </div>

        <div className="is-actions">
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

      {loading ? <div className="stmt-loading">Generating the Income Statement…</div> : null}

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

      {model ? (
        <>
          <StatementView model={model} onAccountClick={openAccount} />
          <StatementPrintView model={model} />
        </>
      ) : !loading && !error ? (
        <div className="stmt-empty">Choose a date range and click Generate Report.</div>
      ) : null}
    </div>
  );
}
