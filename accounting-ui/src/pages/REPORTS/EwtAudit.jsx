import { useState } from "react";
import "./AccountAnalysis.css";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Reports Batch 2: EWT Audit's backend (GET /api/reports/ewt-audit) has
// existed since Phase 7L/Batch 8/Batch 9 with no UI at all - this is the
// first page for it. The From/To/ATC filters are additive read-query
// conditions the backend added for this page; the mismatch/recompute
// algorithm itself, its 0.01 tolerance, and Batch 9's company isolation
// are all untouched. The canonical document-date field across every
// audited module (APV/CV/PO/Invoice/OR) is `transaction_date` - verified
// directly against each header table's schema, not assumed.
export default function EwtAudit() {
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [atcCode, setAtcCode] = useState("");
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState({ generatedAt: "", totalChecked: 0, flaggedCount: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [generated, setGenerated] = useState(false);

  const formatMoney = (amount) =>
    amount === null || amount === undefined
      ? "—"
      : Number(amount).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const diff = (computed, stored) =>
    stored === null || stored === undefined ? null : Number(computed || 0) - Number(stored || 0);

  async function generateReport() {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (fromDate) params.set("from", fromDate);
      if (toDate) params.set("to", toDate);
      if (atcCode.trim()) params.set("atcCode", atcCode.trim());

      const res = await fetch(`${API_URL}/api/reports/ewt-audit?${params.toString()}`, {
        credentials: "include",
        headers: authHeaders(),
      });

      if (!res.ok) throw new Error("Failed to generate EWT Audit report");

      const data = await res.json();
      setRows(Array.isArray(data.flagged) ? data.flagged : []);
      setSummary({
        generatedAt: data.generatedAt || "",
        totalChecked: data.totalChecked || 0,
        flaggedCount: data.flaggedCount || 0,
      });
      setGenerated(true);
    } catch (err) {
      console.error(err);
      setError("Failed to generate EWT Audit report. Please check backend/server.");
      setRows([]);
      setSummary({ generatedAt: "", totalChecked: 0, flaggedCount: 0 });
      setGenerated(true);
    } finally {
      setLoading(false);
    }
  }

  function clearFilters() {
    setRows([]);
    setSummary({ generatedAt: "", totalChecked: 0, flaggedCount: 0 });
    setGenerated(false);
    setError("");
  }

  const downloadCSV = () => {
    if (!rows.length) {
      alert("Please generate the report first.");
      return;
    }

    const csvRows = [
      ["EWT AUDIT"],
      [`Period: ${fromDate || "(all)"} to ${toDate || "(all)"}`],
      atcCode ? [`ATC: ${atcCode}`] : [],
      [],
      [
        "DOCUMENT DATE", "DOCUMENT NO.", "SOURCE TYPE", "PAYEE", "TIN", "ATC",
        "STORED TAXABLE BASE", "RECOMPUTED TAXABLE BASE", "BASE DIFFERENCE",
        "STORED EWT", "RECOMPUTED EWT", "TAX DIFFERENCE", "FINDING",
      ],
      ...rows.map((r) => [
        r.transactionDate || "",
        r.voucherNo || "",
        String(r.module || "").toUpperCase(),
        r.partyName || "",
        r.partyTin || "",
        r.atcCode || "",
        r.storedTaxableBase == null ? "" : Number(r.storedTaxableBase).toFixed(2),
        Number(r.computedTaxableBase || 0).toFixed(2),
        diff(r.computedTaxableBase, r.storedTaxableBase) == null ? "" : diff(r.computedTaxableBase, r.storedTaxableBase).toFixed(2),
        Number(r.storedTaxWithheldAmount || 0).toFixed(2),
        Number(r.computedTaxWithheldAmount || 0).toFixed(2),
        diff(r.computedTaxWithheldAmount, r.storedTaxWithheldAmount) == null ? "" : diff(r.computedTaxWithheldAmount, r.storedTaxWithheldAmount).toFixed(2),
        r.reason || "",
      ]),
    ];

    const csvContent = csvRows
      .map((row) => row.map((cell) => `"${String(cell || "").replace(/"/g, '""')}"`).join(","))
      .join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `EWT_Audit_${toDate || "all"}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="aa-page">
      <div className="aa-header">
        <h1>EWT Audit</h1>
      </div>

      <div className="aa-filters">
        <h2>Report Filters</h2>

        <div className="aa-filter-grid">
          <div>
            <label>From Date</label>
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </div>

          <div>
            <label>To Date</label>
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </div>

          <div>
            <label>ATC</label>
            <input
              type="text"
              value={atcCode}
              onChange={(e) => setAtcCode(e.target.value)}
              placeholder="e.g. WC160"
            />
          </div>
        </div>

        <div className="aa-actions">
          <button className="primary" onClick={generateReport} disabled={loading}>
            {loading ? "Generating..." : "Generate Report"}
          </button>

          <button className="secondary" onClick={clearFilters}>
            Clear
          </button>

          <button className="dark" onClick={() => window.print()}>
            Export PDF
          </button>

          <button className="dark" onClick={downloadCSV}>
            Export CSV
          </button>
        </div>
      </div>

      {error && <div className="aa-report-card" role="alert">{error}</div>}

      {generated && !error && (
        <div className="aa-report-card">
          <div className="aa-report-title">
            <h2>EWT AUDIT</h2>
            <p>
              Period: {fromDate || "(all)"} to {toDate || "(all)"}
              {atcCode ? ` — ATC ${atcCode}` : ""}
            </p>
            <p>
              {summary.totalChecked} document(s) checked, {summary.flaggedCount} flagged
              {summary.generatedAt ? ` — generated ${new Date(summary.generatedAt).toLocaleString()}` : ""}
            </p>
          </div>

          <table className="aa-table">
            <thead>
              <tr>
                <th>DOCUMENT DATE</th>
                <th>DOCUMENT NO.</th>
                <th>SOURCE TYPE</th>
                <th>PAYEE</th>
                <th>TIN</th>
                <th>ATC</th>
                <th className="amount">STORED TAXABLE BASE</th>
                <th className="amount">RECOMPUTED TAXABLE BASE</th>
                <th className="amount">BASE DIFFERENCE</th>
                <th className="amount">STORED EWT</th>
                <th className="amount">RECOMPUTED EWT</th>
                <th className="amount">TAX DIFFERENCE</th>
                <th>FINDING</th>
              </tr>
            </thead>

            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan="13" className="empty">No mismatches found.</td>
                </tr>
              ) : (
                rows.map((row, index) => {
                  const baseDiff = diff(row.computedTaxableBase, row.storedTaxableBase);
                  const taxDiff = diff(row.computedTaxWithheldAmount, row.storedTaxWithheldAmount);
                  return (
                    <tr key={index}>
                      <td>{row.transactionDate || "—"}</td>
                      <td>{row.voucherNo}</td>
                      <td>{String(row.module || "").toUpperCase()}</td>
                      <td>{row.partyName || "—"}</td>
                      <td>{row.partyTin || "—"}</td>
                      <td>{row.atcCode}</td>
                      <td className="amount">{formatMoney(row.storedTaxableBase)}</td>
                      <td className="amount">{formatMoney(row.computedTaxableBase)}</td>
                      <td className="amount">{formatMoney(baseDiff)}</td>
                      <td className="amount">{formatMoney(row.storedTaxWithheldAmount)}</td>
                      <td className="amount">{formatMoney(row.computedTaxWithheldAmount)}</td>
                      <td className="amount">{formatMoney(taxDiff)}</td>
                      <td>{row.reason}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
