import { useEffect, useMemo, useState } from "react";
import "./AccountAnalysis.css";

const API_URL = import.meta.env.VITE_API_URL || "";

export default function OutputVAT() {
  const [fromDate, setFromDate] = useState("2026-01-01");
  const [toDate, setToDate] = useState(new Date().toISOString().slice(0, 10));
  const [accounts, setAccounts] = useState([]);
  const [accountCode, setAccountCode] = useState("");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [generated, setGenerated] = useState(false);

  useEffect(() => {
    loadAccounts();
  }, []);

  async function loadAccounts() {
    try {
      const res = await fetch(`${API_URL}/api/coa`);
      const data = await res.json();
      const list = Array.isArray(data) ? data : [];
      setAccounts(list);

      const defaultAccount = list.find((acc) =>
        (acc.title || "").toLowerCase().includes("output vat") ||
        (acc.title || "").toLowerCase().includes("output tax")
      );

      if (defaultAccount) setAccountCode(defaultAccount.code);
    } catch (err) {
      console.error("Failed to load COA:", err);
    }
  }

  const selectedAccount = accounts.find((acc) => acc.code === accountCode);

  const totals = useMemo(() => {
    const debit = rows.reduce((sum, row) => sum + Number(row.debit || 0), 0);
    const credit = rows.reduce((sum, row) => sum + Number(row.credit || 0), 0);
    return { debit, credit, net: credit - debit };
  }, [rows]);

  const formatMoney = (amount) =>
    Number(amount || 0).toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  async function generateReport() {
    if (!accountCode) {
      alert("Please select the Output VAT account first.");
      return;
    }

    setLoading(true);

    try {
      const res = await fetch(
        `${API_URL}/api/reports/output-vat?from=${fromDate}&to=${toDate}&accountCode=${accountCode}`
      );

      if (!res.ok) throw new Error("Failed to generate Output VAT report");

      const data = await res.json();
      setRows(Array.isArray(data) ? data : []);
      setGenerated(true);
    } catch (err) {
      console.error(err);
      alert("Failed to generate Output VAT Report. Please check backend/server.");
      setRows([]);
      setGenerated(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="aa-page">
      <div className="aa-header">
        <h1>Output VAT Report</h1>
      </div>

      <div className="aa-filters">
        <h2>Report Filters</h2>

        <div className="aa-filter-grid">
          <div>
            <label>Date From</label>
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </div>

          <div>
            <label>Date To</label>
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </div>

          <div>
            <label>Output VAT Account</label>
            <select value={accountCode} onChange={(e) => setAccountCode(e.target.value)}>
              <option value="">Select Account</option>
              {accounts.map((acc) => (
                <option key={acc.id} value={acc.code}>
                  {acc.code} - {acc.title}
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
            <h2>OUTPUT VAT REPORT</h2>
            <h3>
              {accountCode} - {selectedAccount?.title || ""}
            </h3>
            <p>Period: {fromDate} to {toDate}</p>
          </div>

          <table className="aa-table">
            <thead>
              <tr>
                <th>DATE</th>
                <th>SOURCE</th>
                <th>DOC REF</th>
                <th>PARTICULARS</th>
                <th>DEBIT</th>
                <th>CREDIT</th>
              </tr>
            </thead>

            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan="6" className="empty">No data found.</td>
                </tr>
              ) : (
                rows.map((row, index) => (
                  <tr key={index}>
                    <td>{row.transaction_date}</td>
                    <td>{row.source_type}</td>
                    <td>{row.reference_no}</td>
                    <td>{row.particulars}</td>
                    <td className="amount">{Number(row.debit) > 0 ? formatMoney(row.debit) : ""}</td>
                    <td className="amount">{Number(row.credit) > 0 ? formatMoney(row.credit) : ""}</td>
                  </tr>
                ))
              )}
            </tbody>

            <tfoot>
              <tr>
                <td colSpan="4" style={{ textAlign: "center" }}>TOTAL</td>
                <td className="amount">{formatMoney(totals.debit)}</td>
                <td className="amount">{formatMoney(totals.credit)}</td>
              </tr>
              <tr>
                <td colSpan="5" style={{ textAlign: "right" }}><b>TOTAL OUTPUT VAT</b></td>
                <td className="amount"><b>{formatMoney(totals.net)}</b></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
