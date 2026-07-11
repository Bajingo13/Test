import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import "./IncomeStatement.css";

const API_URL = import.meta.env.VITE_API_URL || "";

export function IncomeStatement() {
  const navigate = useNavigate();
  const today = new Date().toISOString().slice(0, 10);

  const [fromDate, setFromDate] = useState("2026-01-01");
  const [toDate, setToDate] = useState(today);
  const [rows, setRows] = useState([]);
  const [generated, setGenerated] = useState(false);
  const [loading, setLoading] = useState(false);

  const formatMoney = (amount) =>
    Number(amount || 0).toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  const revenueRows = rows.filter(
    (r) =>
      String(r.group_name || "").toUpperCase().includes("REVENUE") ||
      String(r.account_class || "").toUpperCase() === "INCOME"
  );

  const expenseRows = rows.filter(
    (r) =>
      String(r.group_name || "").toUpperCase().includes("EXPENSE") ||
      String(r.account_class || "").toUpperCase() === "EXPENSE"
  );

  const totals = useMemo(() => {
    const revenue = revenueRows.reduce((s, r) => s + Number(r.amount || 0), 0);
    const expenses = expenseRows.reduce((s, r) => s + Number(r.amount || 0), 0);
    return { revenue, expenses, netIncome: revenue - expenses };
  }, [rows]);

  async function generateReport() {
    setLoading(true);
    try {
      const res = await fetch(
        `${API_URL}/api/reports/income-statement?from=${fromDate}&to=${toDate}`
      );

      if (!res.ok) throw new Error("Failed to generate income statement");

      const data = await res.json();
      setRows(Array.isArray(data) ? data : []);
      setGenerated(true);
    } catch (err) {
      console.error(err);
      alert("Failed to generate Income Statement. Check backend/server.");
      setRows([]);
      setGenerated(true);
    } finally {
      setLoading(false);
    }
  }

  function openAccount(row) {
    navigate(
      `/reports/account-analysis?accountCode=${encodeURIComponent(
        row.account_code
      )}&from=${fromDate}&to=${toDate}`
    );
  }

  function exportCSV() {
    if (!rows.length) return alert("Generate report first.");

    const csvRows = [
      ["INCOME STATEMENT"],
      [`For the period ${fromDate} to ${toDate}`],
      [],
      ["REVENUE"],
      ...revenueRows.map((r) => [r.account_code, r.account_title, r.amount]),
      ["", "TOTAL REVENUE", totals.revenue],
      [],
      ["EXPENSES"],
      ...expenseRows.map((r) => [r.account_code, r.account_title, r.amount]),
      ["", "TOTAL EXPENSES", totals.expenses],
      [],
      ["", "NET INCOME / LOSS", totals.netIncome],
    ];

    const csv = csvRows
      .map((row) => row.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(","))
      .join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Income_Statement_${toDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="is-page">
      <h1>Income Statement</h1>

      <div className="is-card no-print">
        <h2>Report Filters</h2>

        <div className="is-grid">
          <div>
            <label>Date From</label>
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </div>

          <div>
            <label>Date To</label>
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </div>

          <div>
            <label>Company</label>
            <select>
              <option>Select Company</option>
            </select>
          </div>

          <div>
            <label>Branch / Department</label>
            <select>
              <option>All Branches</option>
            </select>
          </div>

          <div>
            <label>Status</label>
            <select>
              <option>All</option>
              <option>Posted</option>
              <option>Draft</option>
            </select>
          </div>
        </div>

        <div className="is-actions">
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
            Clear Filters
          </button>
          <button className="dark" onClick={() => window.print()}>Export PDF</button>
          <button className="dark" onClick={exportCSV}>Export CSV</button>
        </div>
      </div>

      {generated && (
        <div className="is-report">
          <div className="is-title">
            <h2>INCOME STATEMENT</h2>
            <p>For the period {fromDate} to {toDate}</p>
          </div>

          <div className="section-title">REVENUE</div>
          {revenueRows.map((row) => (
            <div className="report-row" key={row.account_code}>
              <span className="clickable" onClick={() => openAccount(row)}>
                {row.account_code} - {row.account_title}
              </span>
              <span>{formatMoney(row.amount)}</span>
            </div>
          ))}
          <div className="subtotal">
            <span>TOTAL REVENUE</span>
            <span>{formatMoney(totals.revenue)}</span>
          </div>

          <div className="section-title">LESS: EXPENSES</div>
          {expenseRows.map((row) => (
            <div className="report-row" key={row.account_code}>
              <span className="clickable" onClick={() => openAccount(row)}>
                {row.account_code} - {row.account_title}
              </span>
              <span>{formatMoney(row.amount)}</span>
            </div>
          ))}
          <div className="subtotal">
            <span>TOTAL EXPENSES</span>
            <span>{formatMoney(totals.expenses)}</span>
          </div>

          <div className="grand-total">
            <span>NET INCOME / LOSS</span>
            <span>{formatMoney(totals.netIncome)}</span>
          </div>
        </div>
      )}
    </div>
    
  );
}