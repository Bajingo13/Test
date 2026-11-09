import { useState } from "react";
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

export default function PrepaidListReportBase({ title, reportTitle, endpoint, showMonthsElapsed, filenamePrefix }) {
  const period = useReportPeriod({ defaultMode: AS_OF });
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [generated, setGenerated] = useState(false);

  const formatMoney = (amount) =>
    Number(amount || 0).toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  const totals = rows.reduce(
    (sum, row) => ({
      amount: sum.amount + Number(row.amount || 0),
      amortizedToDate: sum.amortizedToDate + Number(row.amortizedToDate || 0),
      remainingBalance: sum.remainingBalance + Number(row.remainingBalance || 0),
    }),
    { amount: 0, amortizedToDate: 0, remainingBalance: 0 }
  );

  function exportCSV() {
    if (!generated) return alert("Please generate the report first.");
    const header = ["CODE", "DESCRIPTION", "PARTY", "START DATE", "AMOUNT", "TERM (MOS)"];
    if (showMonthsElapsed) header.push("MOS ELAPSED");
    header.push("AMORTIZED", "BALANCE");
    const totalRow = ["", "TOTAL", "", "", csvAmount(totals.amount), ""];
    if (showMonthsElapsed) totalRow.push("");
    totalRow.push(csvAmount(totals.amortizedToDate), csvAmount(totals.remainingBalance));
    const csvRows = [
      [reportTitle],
      ...periodCsvRows(period.applied),
      [],
      header,
      ...rows.map((row) => {
        const out = [row.prepaidCode, row.description, row.partyName, row.startDate, csvAmount(row.amount), row.termMonths];
        if (showMonthsElapsed) out.push(row.monthsElapsed);
        out.push(csvAmount(row.amortizedToDate), csvAmount(row.remainingBalance));
        return out;
      }),
      totalRow,
    ];
    downloadCsvText(reportCsvFilename(filenamePrefix, period.applied), reportRowsToCsv(csvRows));
  }

  async function generateReport() {
    const applied = period.apply();
    if (!applied) return;
    setLoading(true);

    try {
      const res = await fetch(`${API_URL}${endpoint}?${new URLSearchParams(applied.params)}`, {
        credentials: "include",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Failed to generate report");

      const data = await res.json();
      setRows(Array.isArray(data) ? data : []);
      setGenerated(true);
    } catch (err) {
      console.error(err);
      alert(`Failed to generate ${title}. Please check backend/server.`);
      setRows([]);
      setGenerated(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="aa-page">
      <div className="aa-header">
        <h1>{title}</h1>
      </div>

      <div className="aa-filters">
        <h2>Report Filters</h2>

        <div className="aa-filter-grid">
          <ReportPeriodFilter period={period} idPrefix="ppl" />
        </div>

        <div className="aa-actions">
          <button className="primary" onClick={generateReport} disabled={loading}>
            {loading ? "Generating..." : "Generate Report"}
          </button>

          <button
            className="secondary"
            onClick={() => {
              setRows([]);
              setGenerated(false);
            }}
          >
            Clear
          </button>

          <button className="dark" onClick={() => window.print()}>
            Export PDF
          </button>

          <button className="dark" onClick={exportCSV} disabled={!generated}>
            Export CSV
          </button>
        </div>
      </div>

      {generated && (
        <div className="aa-report-card">
          <div className="aa-report-title">
            <h2>{reportTitle}</h2>
            <ReportPeriodLabel period={period.applied} />
          </div>

          <table className="aa-table prepaid-table">
            <thead>
              <tr>
                <th>CODE</th>
                <th>DESCRIPTION</th>
                <th>PARTY</th>
                <th>START DATE</th>
                <th>AMOUNT</th>
                <th>TERM (MOS)</th>
                {showMonthsElapsed && <th>MOS ELAPSED</th>}
                <th>AMORTIZED</th>
                <th>BALANCE</th>
              </tr>
            </thead>

            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={showMonthsElapsed ? 9 : 8} className="empty">No records found.</td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.prepaidCode}</td>
                    <td>{row.description}</td>
                    <td>{row.partyName}</td>
                    <td>{row.startDate}</td>
                    <td className="amount">{formatMoney(row.amount)}</td>
                    <td className="amount">{row.termMonths}</td>
                    {showMonthsElapsed && <td className="amount">{row.monthsElapsed}</td>}
                    <td className="amount">{formatMoney(row.amortizedToDate)}</td>
                    <td className="amount">{formatMoney(row.remainingBalance)}</td>
                  </tr>
                ))
              )}
            </tbody>

            <tfoot>
              <tr>
                <td colSpan={showMonthsElapsed ? 4 : 4} style={{ textAlign: "center" }}>TOTAL</td>
                <td className="amount">{formatMoney(totals.amount)}</td>
                <td></td>
                {showMonthsElapsed && <td></td>}
                <td className="amount">{formatMoney(totals.amortizedToDate)}</td>
                <td className="amount">{formatMoney(totals.remainingBalance)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
