import { useState } from "react";
import "./AccountAnalysis.css";

const API_URL = import.meta.env.VITE_API_URL || "";

export default function FixedAssetReport() {
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
      cost: sum.cost + Number(row.acquisitionCost || 0),
      accumulatedDepreciation: sum.accumulatedDepreciation + Number(row.accumulatedDepreciation || 0),
      bookValue: sum.bookValue + Number(row.bookValue || 0),
    }),
    { cost: 0, accumulatedDepreciation: 0, bookValue: 0 }
  );

  async function generateReport() {
    setLoading(true);

    try {
      const res = await fetch(`${API_URL}/api/reports/fixed-asset-register?asOf=${asOfDate}`);
      if (!res.ok) throw new Error("Failed to generate fixed asset register");

      const data = await res.json();
      setRows(Array.isArray(data) ? data : []);
      setGenerated(true);
    } catch (err) {
      console.error(err);
      alert("Failed to generate Fixed Asset Account Report. Please check backend/server.");
      setRows([]);
      setGenerated(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="aa-page">
      <div className="aa-header">
        <h1>Fixed Asset Account Reports</h1>
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
            <h2>FIXED ASSET REGISTER</h2>
            <p>As Of {asOfDate}</p>
          </div>

          <table className="aa-table fa-table">
            <thead>
              <tr>
                <th>ASSET CODE</th>
                <th>ASSET NAME</th>
                <th>ACQ. DATE</th>
                <th>COST</th>
                <th>ACCUM. DEPRECIATION</th>
                <th>BOOK VALUE</th>
              </tr>
            </thead>

            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan="6" className="empty">No active fixed assets found.</td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.assetCode}</td>
                    <td>{row.assetName}</td>
                    <td>{row.acquisitionDate}</td>
                    <td className="amount">{formatMoney(row.acquisitionCost)}</td>
                    <td className="amount">{formatMoney(row.accumulatedDepreciation)}</td>
                    <td className="amount">{formatMoney(row.bookValue)}</td>
                  </tr>
                ))
              )}
            </tbody>

            <tfoot>
              <tr>
                <td colSpan="3" style={{ textAlign: "center" }}>TOTAL</td>
                <td className="amount">{formatMoney(totals.cost)}</td>
                <td className="amount">{formatMoney(totals.accumulatedDepreciation)}</td>
                <td className="amount">{formatMoney(totals.bookValue)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
