import { useEffect, useState } from "react";
import "./AccountAnalysis.css";
import { downloadCsv } from "./reportCsv";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const EMPTY_TOTALS = {
  vatableSales: 0,
  zeroRatedSales: 0,
  exemptSales: 0,
  vatAmount: 0,
  grossAmount: 0,
};

export default function OutputVAT() {
  const [fromDate, setFromDate] = useState("2026-01-01");
  const [toDate, setToDate] = useState(new Date().toISOString().slice(0, 10));
  const [accounts, setAccounts] = useState([]);
  const [accountCode, setAccountCode] = useState("");
  const [rows, setRows] = useState([]);
  const [totals, setTotals] = useState(EMPTY_TOTALS);
  const [inclusionRule, setInclusionRule] = useState("");
  const [loading, setLoading] = useState(false);
  const [generated, setGenerated] = useState(false);

  useEffect(() => {
    loadAccounts();
  }, []);

  async function loadAccounts() {
    try {
      const res = await fetch(`${API_URL}/api/coa`, { headers: authHeaders() });
      const data = await res.json();
      const list = Array.isArray(data) ? data : [];
      setAccounts(list);

      // Phase 7F: the GL fallback path needs an Output VAT account to scan
      // for historical (pre-structured) rows. Prefer an account explicitly
      // tagged with the OUTPUT VAT validation rule (Phase d77eb31); fall
      // back to a title match only if no account carries that validation.
      const validated = list.find((acc) =>
        (acc.validations || []).some((v) => String(v).trim().toUpperCase() === "OUTPUT VAT")
      );
      const byTitle = list.find((acc) =>
        (acc.title || "").toLowerCase().includes("output vat") ||
        (acc.title || "").toLowerCase().includes("output tax")
      );
      const chosen = validated || byTitle;
      if (chosen) setAccountCode(chosen.code);
    } catch (err) {
      console.error("Failed to load COA:", err);
    }
  }

  const selectedAccount = accounts.find((acc) => acc.code === accountCode);

  const formatMoney = (amount) =>
    Number(amount || 0).toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  // "—" for a GL-fallback row's unknown bucket (net/base was never recorded),
  // a formatted number otherwise.
  const cell = (value) => (value === null || value === undefined ? "—" : formatMoney(value));

  // Raw numeric for CSV: "" for an unknown bucket, a fixed-2 string otherwise
  // (no thousands separators, no em-dash - spreadsheet-safe).
  const csvNum = (value) => (value === null || value === undefined ? "" : Number(value).toFixed(2));

  function exportCSV() {
    if (!rows.length) {
      alert("Please generate the report first.");
      return;
    }
    const meta = [
      ["OUTPUT VAT REPORT"],
      selectedAccount ? [`GL fallback account: ${accountCode} - ${selectedAccount.title}`] : [],
      [`Period: ${fromDate} to ${toDate}`],
      inclusionRule ? [inclusionRule] : [],
      [],
    ];
    const header = [
      "DATE", "SOURCE", "DOC REF", "CUSTOMER", "TIN",
      "VATABLE SALES (STANDARD)", "ZERO-RATED SALES", "VAT-EXEMPT SALES",
      "VAT AMOUNT", "GROSS / TOTAL",
    ];
    const body = rows.map((r) => [
      r.date,
      `${r.sourceType || ""}${r.source === "gl" ? " (GL)" : ""}`,
      r.docRef,
      r.customer,
      r.tin || "",
      csvNum(r.vatableSales),
      csvNum(r.zeroRatedSales),
      csvNum(r.exemptSales),
      Number(r.vatAmount || 0).toFixed(2),
      Number(r.grossAmount || 0).toFixed(2),
    ]);
    const totalRow = [
      "", "", "", "", "TOTALS",
      Number(totals.vatableSales || 0).toFixed(2),
      Number(totals.zeroRatedSales || 0).toFixed(2),
      Number(totals.exemptSales || 0).toFixed(2),
      Number(totals.vatAmount || 0).toFixed(2),
      Number(totals.grossAmount || 0).toFixed(2),
    ];
    downloadCsv(`Output_VAT_${toDate}.csv`, [...meta, header, ...body, totalRow]);
  }

  async function generateReport() {
    setLoading(true);
    try {
      const params = new URLSearchParams({ from: fromDate, to: toDate });
      if (accountCode) params.set("accountCode", accountCode);
      const res = await fetch(`${API_URL}/api/reports/output-vat?${params.toString()}`, {
        credentials: "include",
        headers: authHeaders(),
      });

      if (!res.ok) throw new Error("Failed to generate Output VAT report");

      const data = await res.json();
      setRows(Array.isArray(data.rows) ? data.rows : []);
      setTotals(data.totals || EMPTY_TOTALS);
      setInclusionRule(data.inclusionRule || "");
      setGenerated(true);
    } catch (err) {
      console.error(err);
      alert("Failed to generate Output VAT Report. Please check backend/server.");
      setRows([]);
      setTotals(EMPTY_TOTALS);
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
            <label>Output VAT Account (historical GL fallback)</label>
            <select value={accountCode} onChange={(e) => setAccountCode(e.target.value)}>
              <option value="">None (structured entries only)</option>
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
              setTotals(EMPTY_TOTALS);
              setGenerated(false);
            }}
          >
            Clear
          </button>

          <button className="dark" onClick={() => window.print()}>
            Export PDF
          </button>

          <button className="dark" onClick={exportCSV}>
            Export CSV
          </button>
        </div>
      </div>

      {generated && (
        <div className="aa-report-card">
          <div className="aa-report-title">
            <h2>OUTPUT VAT REPORT</h2>
            {selectedAccount ? (
              <h3>GL fallback account: {accountCode} - {selectedAccount.title}</h3>
            ) : null}
            <p>Period: {fromDate} to {toDate}</p>
            {inclusionRule ? <p>{inclusionRule}</p> : null}
          </div>

          <table className="aa-table">
            <thead>
              <tr>
                <th>DATE</th>
                <th>SOURCE</th>
                <th>DOC REF</th>
                <th>CUSTOMER</th>
                <th>TIN</th>
                <th className="amount">VATABLE SALES</th>
                <th className="amount">ZERO-RATED SALES</th>
                <th className="amount">VAT-EXEMPT SALES</th>
                <th className="amount">VAT AMOUNT</th>
                <th className="amount">GROSS / TOTAL</th>
              </tr>
            </thead>

            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan="10" className="empty">No data found.</td>
                </tr>
              ) : (
                rows.map((row, index) => (
                  <tr key={index}>
                    <td>{row.date}</td>
                    <td>
                      {row.sourceType}
                      {row.source === "gl" ? " (GL)" : ""}
                    </td>
                    <td>{row.docRef}</td>
                    <td>{row.customer}</td>
                    <td>{row.tin || ""}</td>
                    <td className="amount">{cell(row.vatableSales)}</td>
                    <td className="amount">{cell(row.zeroRatedSales)}</td>
                    <td className="amount">{cell(row.exemptSales)}</td>
                    <td className="amount">{formatMoney(row.vatAmount)}</td>
                    <td className="amount">{formatMoney(row.grossAmount)}</td>
                  </tr>
                ))
              )}
            </tbody>

            <tfoot>
              <tr>
                <td colSpan="5" style={{ textAlign: "right" }}><b>TOTALS</b></td>
                <td className="amount"><b>{formatMoney(totals.vatableSales)}</b></td>
                <td className="amount"><b>{formatMoney(totals.zeroRatedSales)}</b></td>
                <td className="amount"><b>{formatMoney(totals.exemptSales)}</b></td>
                <td className="amount"><b>{formatMoney(totals.vatAmount)}</b></td>
                <td className="amount"><b>{formatMoney(totals.grossAmount)}</b></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
