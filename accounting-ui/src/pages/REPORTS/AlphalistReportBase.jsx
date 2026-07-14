import { useState } from "react";
import "./AccountAnalysis.css";
import "./PrepaidReports.css";

const API_URL = import.meta.env.VITE_API_URL || "";

export default function AlphalistReportBase({ title, reportTitle, taxType }) {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
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
      grossAmount: sum.grossAmount + Number(row.grossAmount || 0),
      taxWithheld: sum.taxWithheld + Number(row.taxWithheld || 0),
    }),
    { grossAmount: 0, taxWithheld: 0 }
  );

  async function generateReport() {
    setLoading(true);

    try {
      const res = await fetch(
        `${API_URL}/api/reports/alphalist?taxType=${taxType}&month=${month}`
      );

      if (!res.ok) throw new Error("Failed to generate alphalist report");

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
            <label>Month</label>
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
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
            <p>For the month of {month}</p>
          </div>

          <table className="aa-table prepaid-table">
            <thead>
              <tr>
                <th>PAYEE</th>
                <th>TIN</th>
                <th>ATC CODE</th>
                <th>TAX RATE</th>
                <th>NO. OF TRANSACTIONS</th>
                <th>GROSS AMOUNT</th>
                <th>TAX WITHHELD</th>
              </tr>
            </thead>

            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan="7" className="empty">
                    No withholding tax transactions found for this month.
                  </td>
                </tr>
              ) : (
                rows.map((row, index) => (
                  <tr key={index}>
                    <td>{row.payeeName}</td>
                    <td>{row.tin || "-"}</td>
                    <td>{row.atcCode}</td>
                    <td className="amount">{Number(row.taxRate).toFixed(2)}%</td>
                    <td className="amount">{row.transactionCount}</td>
                    <td className="amount">{formatMoney(row.grossAmount)}</td>
                    <td className="amount">{formatMoney(row.taxWithheld)}</td>
                  </tr>
                ))
              )}
            </tbody>

            <tfoot>
              <tr>
                <td colSpan="5" style={{ textAlign: "center" }}>TOTAL</td>
                <td className="amount">{formatMoney(totals.grossAmount)}</td>
                <td className="amount">{formatMoney(totals.taxWithheld)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
