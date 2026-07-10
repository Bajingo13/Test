import { useMemo, useState } from "react";
import "./TrialBalance.css";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8080";

export default function APAging() {
  const [asOfDate, setAsOfDate] = useState(new Date().toISOString().slice(0, 10));
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [generated, setGenerated] = useState(false);
  const [runInfo, setRunInfo] = useState({ pageNo: 1, runDate: "", runTime: "" });

  const formatMoney = (amount) =>
    Number(amount || 0).toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  const formatAsOfDate = (dateValue) => {
    if (!dateValue) return "";
    return new Date(dateValue).toLocaleDateString("en-US", {
      month: "long",
      day: "2-digit",
      year: "numeric",
    }).toUpperCase();
  };

  const bucketedRows = useMemo(() => {
    return rows.map((row) => {
      const balance = Number(row.balance_amount || 0);
      const days = Number(row.days_past_due || 0);

      return {
        ...row,
        current: days === 0 ? balance : 0,
        days1to30: days >= 1 && days <= 30 ? balance : 0,
        days31to60: days >= 31 && days <= 60 ? balance : 0,
        days61to90: days >= 61 && days <= 90 ? balance : 0,
        over90: days > 90 ? balance : 0,
      };
    });
  }, [rows]);

  const totals = useMemo(() => {
    return bucketedRows.reduce(
      (sum, row) => ({
        current: sum.current + row.current,
        days1to30: sum.days1to30 + row.days1to30,
        days31to60: sum.days31to60 + row.days31to60,
        days61to90: sum.days61to90 + row.days61to90,
        over90: sum.over90 + row.over90,
        total: sum.total + Number(row.balance_amount || 0),
      }),
      { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0, total: 0 }
    );
  }, [bucketedRows]);

  async function generateReport() {
    setLoading(true);

    const now = new Date();
    setRunInfo({
      pageNo: 1,
      runDate: now.toLocaleDateString("en-US"),
      runTime: now.toLocaleTimeString("en-US", { hour12: false }),
    });

    try {
      const res = await fetch(`${API_URL}/api/reports/ap-aging?asOf=${asOfDate}`);
      if (!res.ok) throw new Error("Failed to fetch AP Aging");

      const data = await res.json();
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error(err);
      alert("Failed to generate AP Aging Report.");
      setRows([]);
    } finally {
      setGenerated(true);
      setLoading(false);
    }
  }

  return (
    <div className="tb-page">
      <div className="tb-header">
        <h1>AP Aging Report</h1>
      </div>

      <div className="tb-filters">
        <h2>Report Filters</h2>

        <div className="tb-filter-grid">
          <div>
            <label>As Of Date</label>
            <input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
          </div>
        </div>

        <div className="tb-actions">
          <button className="primary" onClick={generateReport} disabled={loading}>
            {loading ? "Generating..." : "Generate Report"}
          </button>

          <button className="secondary" onClick={() => { setRows([]); setGenerated(false); }}>
            Clear Filters
          </button>

          <button className="dark" onClick={() => window.print()}>
            Export PDF
          </button>
        </div>
      </div>

      {generated && (
        <div className="tb-report-card">
          <div className="tb-report-top">
            <div></div>

            <div className="tb-report-title">
              <h2>ACCOUNTS PAYABLE AGING REPORT</h2>
              <h3>AS OF {formatAsOfDate(asOfDate)}</h3>
            </div>

            <div className="tb-run-info">
              <p><span>Page No</span>: {runInfo.pageNo}</p>
              <p><span>RunDate</span>: {runInfo.runDate}</p>
              <p><span>RunTime</span>: {runInfo.runTime}</p>
            </div>
          </div>

          <table className="tb-report-table">
            <thead>
              <tr>
                <th>SUPPLIER</th>
                <th>REF NO</th>
                <th>DUE DATE</th>
                <th>CURRENT</th>
                <th>1-30</th>
                <th>31-60</th>
                <th>61-90</th>
                <th>OVER 90</th>
                <th>BALANCE</th>
              </tr>
            </thead>

            <tbody>
              {bucketedRows.map((row, index) => (
                <tr key={index}>
                  <td>{row.party_name}</td>
                  <td>{row.reference_no}</td>
                  <td>{row.due_date}</td>
                  <td className="amount">{row.current ? formatMoney(row.current) : ""}</td>
                  <td className="amount">{row.days1to30 ? formatMoney(row.days1to30) : ""}</td>
                  <td className="amount">{row.days31to60 ? formatMoney(row.days31to60) : ""}</td>
                  <td className="amount">{row.days61to90 ? formatMoney(row.days61to90) : ""}</td>
                  <td className="amount">{row.over90 ? formatMoney(row.over90) : ""}</td>
                  <td className="amount">{formatMoney(row.balance_amount)}</td>
                </tr>
              ))}
            </tbody>

            <tfoot>
              <tr>
                <td colSpan="3" style={{ textAlign: "center" }}>TOTAL</td>
                <td className="amount">{formatMoney(totals.current)}</td>
                <td className="amount">{formatMoney(totals.days1to30)}</td>
                <td className="amount">{formatMoney(totals.days31to60)}</td>
                <td className="amount">{formatMoney(totals.days61to90)}</td>
                <td className="amount">{formatMoney(totals.over90)}</td>
                <td className="amount">{formatMoney(totals.total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}