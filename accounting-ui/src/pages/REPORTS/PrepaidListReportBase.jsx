import { useState } from "react";
import "./AccountAnalysis.css";
import "./PrepaidReports.css";

const API_URL = import.meta.env.VITE_API_URL || "";

export default function PrepaidListReportBase({ title, reportTitle, endpoint, showMonthsElapsed }) {
  const [asOfDate, setAsOfDate] = useState(new Date().toISOString().slice(0, 10));
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

  async function generateReport() {
    setLoading(true);

    try {
      const res = await fetch(`${API_URL}${endpoint}?asOf=${asOfDate}`);
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
          <div>
            <label>As Of Date</label>
            <input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
          </div>
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
        </div>
      </div>

      {generated && (
        <div className="aa-report-card">
          <div className="aa-report-title">
            <h2>{reportTitle}</h2>
            <p>As Of {asOfDate}</p>
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
