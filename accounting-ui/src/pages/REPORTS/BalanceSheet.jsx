import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import "./BalanceSheet.css";

const API_URL = import.meta.env.VITE_API_URL || "";

export default function BalanceSheet() {
  const navigate = useNavigate();
  const today = new Date().toISOString().slice(0, 10);

  const [toDate, setToDate] = useState(today);
  const [rows, setRows] = useState([]);
  const [generated, setGenerated] = useState(false);
  const [loading, setLoading] = useState(false);

  const formatMoney = (amount) =>
    Number(amount || 0).toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  const assetRows = rows.filter(
    (r) =>
      String(r.group_name || "").toUpperCase().includes("ASSET") ||
      String(r.account_class || "").toUpperCase() === "ASSET"
  );

  const liabilityRows = rows.filter(
    (r) =>
      String(r.group_name || "").toUpperCase().includes("LIABIL") ||
      String(r.account_class || "").toUpperCase().includes("LIABIL")
  );

  const capitalRows = rows.filter(
    (r) =>
      String(r.group_name || "").toUpperCase().includes("EQUITY") ||
      String(r.group_name || "").toUpperCase().includes("CAPITAL") ||
      String(r.account_class || "").toUpperCase() === "CAPITAL"
  );

  const totals = useMemo(() => {
    const assets = assetRows.reduce((s, r) => s + Number(r.amount || 0), 0);
    const liabilities = liabilityRows.reduce((s, r) => s + Number(r.amount || 0), 0);
    const capital = capitalRows.reduce((s, r) => s + Number(r.amount || 0), 0);

    return {
      assets,
      liabilities,
      capital,
      liabilitiesAndCapital: liabilities + capital,
    };
  }, [rows]);

  async function generateReport() {
    setLoading(true);

    try {
      const res = await fetch(`${API_URL}/api/reports/balance-sheet?to=${toDate}`);

      if (!res.ok) throw new Error("Failed to generate balance sheet");

      const data = await res.json();
      setRows(Array.isArray(data) ? data : []);
      setGenerated(true);
    } catch (err) {
      console.error(err);
      alert("Failed to generate Balance Sheet. Check backend/server.");
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
      )}&from=2026-01-01&to=${toDate}`
    );
  }

  function exportCSV() {
    if (!rows.length) return alert("Generate report first.");

    const csvRows = [
      ["BALANCE SHEET"],
      [`As of ${toDate}`],
      [],
      ["ASSETS"],
      ...assetRows.map((r) => [r.account_code, r.account_title, r.amount]),
      ["", "TOTAL ASSETS", totals.assets],
      [],
      ["LIABILITIES"],
      ...liabilityRows.map((r) => [r.account_code, r.account_title, r.amount]),
      ["", "TOTAL LIABILITIES", totals.liabilities],
      [],
      ["CAPITAL"],
      ...capitalRows.map((r) => [r.account_code, r.account_title, r.amount]),
      ["", "TOTAL CAPITAL", totals.capital],
      [],
      ["", "TOTAL LIABILITIES & CAPITAL", totals.liabilitiesAndCapital],
    ];

    const csv = csvRows
      .map((row) => row.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(","))
      .join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");

    a.href = url;
    a.download = `Balance_Sheet_${toDate}.csv`;
    a.click();

    URL.revokeObjectURL(url);
  }

  return (
    <div className="bs-page">
      <h1>Balance Sheet</h1>

      <div className="bs-card no-print">
        <h2>Report Filters</h2>

        <div className="bs-grid">
          <div>
            <label>Date As Of</label>
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

        <div className="bs-actions">
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
        <div className="bs-report">
          <div className="bs-title">
            <h2>BALANCE SHEET</h2>
            <p>As of {toDate}</p>
          </div>

          <div className="section-title">ASSETS</div>
          {assetRows.map((row) => (
            <div className="report-row" key={row.account_code}>
              <span className="clickable" onClick={() => openAccount(row)}>
                {row.account_code} - {row.account_title}
              </span>
              <span>{formatMoney(row.amount)}</span>
            </div>
          ))}
          <div className="subtotal">
            <span>TOTAL ASSETS</span>
            <span>{formatMoney(totals.assets)}</span>
          </div>

          <div className="section-title">LIABILITIES</div>
          {liabilityRows.map((row) => (
            <div className="report-row" key={row.account_code}>
              <span className="clickable" onClick={() => openAccount(row)}>
                {row.account_code} - {row.account_title}
              </span>
              <span>{formatMoney(row.amount)}</span>
            </div>
          ))}
          <div className="subtotal">
            <span>TOTAL LIABILITIES</span>
            <span>{formatMoney(totals.liabilities)}</span>
          </div>

          <div className="section-title">CAPITAL</div>
          {capitalRows.map((row) => (
            <div className="report-row" key={row.account_code}>
              <span className="clickable" onClick={() => openAccount(row)}>
                {row.account_code} - {row.account_title}
              </span>
              <span>{formatMoney(row.amount)}</span>
            </div>
          ))}
          <div className="subtotal">
            <span>TOTAL CAPITAL</span>
            <span>{formatMoney(totals.capital)}</span>
          </div>

          <div className="grand-total">
            <span>TOTAL LIABILITIES & CAPITAL</span>
            <span>{formatMoney(totals.liabilitiesAndCapital)}</span>
          </div>
        </div>
      )}
    </div>
  );
}