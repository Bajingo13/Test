import { useEffect, useState } from "react";
import ReportPeriodFilter, { ReportPeriodLabel } from "./ReportPeriodFilter.jsx";
import { csvAmount, downloadCsvText, reportRowsToCsv } from "./reportCsv.mjs";
import useReportPeriod from "./useReportPeriod.js";
import { AS_OF, periodCsvRows, reportCsvFilename } from "./reportPeriod.mjs";
import "./AccountAnalysis.css";
import "./PrepaidReports.css";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default function PrepaidSubsidiary() {
  const [prepaidAccounts, setPrepaidAccounts] = useState([]);
  const [prepaidId, setPrepaidId] = useState("");
  const period = useReportPeriod({ defaultMode: AS_OF });
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [generated, setGenerated] = useState(false);
  // Generation failure message (replaces a native alert) - shown above the report.
  const [reportError, setReportError] = useState("");
  // Inline validation message (replaces a native alert) - shown above the report, announced by screen readers.
  const [validationError, setValidationError] = useState("");

  useEffect(() => {
    loadPrepaidAccounts();
  }, []);

  // The picker comes from the REPORT endpoints (REPORTS.FINANCIAL / VIEW, the
  // permission this report already needs) - not the File Setup list, which
  // requires FILESETUP.PREPAID_ACCOUNTS / VIEW and is administration. The
  // active list and the lapsed list together are every prepaid account the
  // prepaid reports cover (Cancelled ones are excluded, as in every other
  // prepaid report). Newest first, as before.
  async function loadPrepaidAccounts() {
    try {
      const lists = await Promise.all(
        ["/api/reports/prepaid-list", "/api/reports/lapsed-prepayments"].map(async (path) => {
          const res = await fetch(`${API_URL}${path}`, {
            credentials: "include",
            headers: authHeaders(),
          });
          if (!res.ok) return [];
          const data = await res.json();
          return Array.isArray(data) ? data : [];
        })
      );
      const byId = new Map();
      for (const p of lists.flat()) byId.set(p.id, p);
      setPrepaidAccounts([...byId.values()].sort((x, y) => Number(y.id) - Number(x.id)));
    } catch (err) {
      console.error("Failed to load prepaid accounts:", err);
    }
  }

  const formatMoney = (amount) =>
    Number(amount || 0).toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  function exportCSV() {
    if (!report) return alert("Please generate the report first.");
    const csvRows = [
      ["PREPAID SUBSIDIARY"],
      ...periodCsvRows(period.applied),
      ["Prepaid Code", report.prepaidCode],
      ["Description", report.description],
      ["Amount", csvAmount(report.amount)],
      ["Term (Months)", report.termMonths],
      ["Start Date", String(report.startDate || "").slice(0, 10)],
      [],
      ["PERIOD", "AMORTIZATION", "CUMULATIVE", "REMAINING BALANCE", "STATUS"],
      ...report.schedule.map((row) => [
        row.period,
        csvAmount(row.amortization),
        csvAmount(row.cumulativeAmortized),
        csvAmount(row.remainingBalance),
        row.lapsed ? "Lapsed" : "Active",
      ]),
    ];
    downloadCsvText(reportCsvFilename("Prepaid_Subsidiary", period.applied, report.prepaidCode), reportRowsToCsv(csvRows));
  }

  async function generateReport() {
    const applied = period.apply();
    if (!applied) return;
    if (!prepaidId) {
      setValidationError("Please select a prepaid account first.");
      return;
    }
    setValidationError("");

    setReportError("");
    setLoading(true);

    try {
      const res = await fetch(
        `${API_URL}/api/reports/prepaid-subsidiary?prepaidId=${prepaidId}&${new URLSearchParams(applied.params)}`,
        { credentials: "include", headers: authHeaders() }
      );

      if (!res.ok) {
        const failBody = await res.json().catch(() => ({}));
        throw Object.assign(new Error("Failed to generate prepaid subsidiary report"), { userMessage: res.status === 400 || res.status === 403 ? failBody?.message : null });
      }

      const data = await res.json();
      setReport(data);
      setGenerated(true);
    } catch (err) {
      console.error(err);
      setReportError(err.userMessage || "Failed to generate Prepaid Subsidiary report. Please check backend/server.");
      setReport(null);
      setGenerated(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="aa-page">
      <div className="aa-header">
        <h1>Prepaid Subsidiary</h1>
      </div>

      <div className="aa-filters">
        <h2>Report Filters</h2>

        <div className="aa-filter-grid">
          <ReportPeriodFilter period={period} idPrefix="pps" />

          <div>
            <label htmlFor="pps-account">Prepaid Account</label>
            <select id="pps-account" value={prepaidId} onChange={(e) => setPrepaidId(e.target.value)}>
              <option value="">Select Prepaid Account</option>
              {prepaidAccounts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.prepaidCode} - {p.description}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="aa-actions">
          <button className="primary" onClick={generateReport} disabled={loading}>
            {loading ? "Generating..." : "Generate Report"}
          </button>

          <button
            className="secondary"
            onClick={() => {
              setReport(null);
              setGenerated(false);
            }}
          >
            Clear
          </button>

          <button className="dark" onClick={() => window.print()}>
            Export PDF
          </button>

          <button className="dark" onClick={exportCSV} disabled={!report}>
            Export CSV
          </button>
        </div>

        {validationError ? (
          <p className="aa-error" role="alert" id="pps-validation">
            {validationError}
          </p>
        ) : null}
      </div>

      {reportError ? (
        <div className="aa-error" role="alert" id="pps-error">
          {reportError}
        </div>
      ) : null}

      {generated && report && (
        <div className="aa-report-card">
          <div className="aa-report-title">
            <h2>PREPAID SUBSIDIARY</h2>
            <h3>{report.prepaidCode} - {report.description}</h3>
            <ReportPeriodLabel period={period.applied} />
            <p>
              Amount: {formatMoney(report.amount)} over {report.termMonths} month(s), starting {report.startDate}
            </p>
          </div>

          <table className="aa-table prepaid-table">
            <thead>
              <tr>
                <th>PERIOD</th>
                <th>AMORTIZATION</th>
                <th>CUMULATIVE</th>
                <th>REMAINING BALANCE</th>
                <th>STATUS</th>
              </tr>
            </thead>

            <tbody>
              {report.schedule.map((row, index) => (
                <tr key={index}>
                  <td>{row.period}</td>
                  <td className="amount">{formatMoney(row.amortization)}</td>
                  <td className="amount">{formatMoney(row.cumulativeAmortized)}</td>
                  <td className="amount">{formatMoney(row.remainingBalance)}</td>
                  <td>{row.lapsed ? "Lapsed" : "Active"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
