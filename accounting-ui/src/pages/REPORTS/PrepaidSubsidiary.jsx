import { useEffect, useState } from "react";
import "./AccountAnalysis.css";
import "./PrepaidReports.css";

const API_URL = import.meta.env.VITE_API_URL || "";

export default function PrepaidSubsidiary() {
  const [prepaidAccounts, setPrepaidAccounts] = useState([]);
  const [prepaidId, setPrepaidId] = useState("");
  const [asOfDate, setAsOfDate] = useState(new Date().toISOString().slice(0, 10));
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [generated, setGenerated] = useState(false);

  useEffect(() => {
    loadPrepaidAccounts();
  }, []);

  async function loadPrepaidAccounts() {
    try {
      const res = await fetch(`${API_URL}/api/prepaid-accounts`, { credentials: "include" });
      const data = await res.json();
      setPrepaidAccounts(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("Failed to load prepaid accounts:", err);
    }
  }

  const formatMoney = (amount) =>
    Number(amount || 0).toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  async function generateReport() {
    if (!prepaidId) {
      alert("Please select a prepaid account first.");
      return;
    }

    setLoading(true);

    try {
      const res = await fetch(
        `${API_URL}/api/reports/prepaid-subsidiary?prepaidId=${prepaidId}&asOf=${asOfDate}`
      );

      if (!res.ok) throw new Error("Failed to generate prepaid subsidiary report");

      const data = await res.json();
      setReport(data);
      setGenerated(true);
    } catch (err) {
      console.error(err);
      alert("Failed to generate Prepaid Subsidiary report. Please check backend/server.");
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
          <div>
            <label>As Of Date</label>
            <input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
          </div>

          <div>
            <label>Prepaid Account</label>
            <select value={prepaidId} onChange={(e) => setPrepaidId(e.target.value)}>
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
        </div>
      </div>

      {generated && report && (
        <div className="aa-report-card">
          <div className="aa-report-title">
            <h2>PREPAID SUBSIDIARY</h2>
            <h3>{report.prepaidCode} - {report.description}</h3>
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
