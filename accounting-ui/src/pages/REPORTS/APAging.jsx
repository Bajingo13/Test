import { useEffect, useMemo, useState } from "react";
import "./TrialBalance.css";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const BUCKET_LABELS = {
  current: "Current",
  days1to30: "1-30",
  days31to60: "31-60",
  days61to90: "61-90",
  over90: "Over 90",
};

function formatMoney(amount) {
  return Number(amount || 0).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatAsOfDate(dateValue) {
  if (!dateValue) return "";
  return new Date(dateValue)
    .toLocaleDateString("en-US", { month: "long", day: "2-digit", year: "numeric" })
    .toUpperCase();
}

function csvEscape(value) {
  const str = String(value ?? "");
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

export default function APAging() {
  const [asOfDate, setAsOfDate] = useState(new Date().toISOString().slice(0, 10));
  const [currencyFilter, setCurrencyFilter] = useState("");
  const [partyFilter, setPartyFilter] = useState("");
  const [bucketFilter, setBucketFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("OPEN");

  const [currencies, setCurrencies] = useState([]);
  const [parties, setParties] = useState([]);

  const [rows, setRows] = useState([]);
  const [bucketTotals, setBucketTotals] = useState(null);
  const [loading, setLoading] = useState(false);
  const [generated, setGenerated] = useState(false);
  const [runInfo, setRunInfo] = useState({ pageNo: 1, runDate: "", runTime: "" });

  useEffect(() => {
    (async () => {
      try {
        const [curRes, genlibRes] = await Promise.all([
          fetch(`${API_URL}/api/currencies`, { credentials: "include", headers: authHeaders() }),
          fetch(`${API_URL}/api/genlib`, { credentials: "include", headers: authHeaders() }),
        ]);
        if (curRes.ok) setCurrencies(await curRes.json());
        if (genlibRes.ok) {
          const data = await genlibRes.json();
          setParties(data.filter((p) => p.type === "SUPPLIER" && p.status === "ACTIVE"));
        }
      } catch (err) {
        console.error("LOAD AGING FILTERS ERROR:", err);
      }
    })();
  }, []);

  const filteredRows = useMemo(() => {
    if (!bucketFilter) return rows;
    return rows.filter((r) => r.bucket === bucketFilter);
  }, [rows, bucketFilter]);

  async function generateReport() {
    setLoading(true);

    const now = new Date();
    setRunInfo({
      pageNo: 1,
      runDate: now.toLocaleDateString("en-US"),
      runTime: now.toLocaleTimeString("en-US", { hour12: false }),
    });

    try {
      const params = new URLSearchParams({ asOf: asOfDate, status: statusFilter });
      if (currencyFilter) params.set("currency", currencyFilter);
      if (partyFilter) params.set("partyId", partyFilter);

      const res = await fetch(`${API_URL}/api/reports/ap-aging?${params.toString()}`, {
        credentials: "include",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Failed to fetch AP Aging");

      const data = await res.json();
      setRows(Array.isArray(data.rows) ? data.rows : []);
      setBucketTotals(data.bucketTotals || null);
    } catch (err) {
      console.error(err);
      alert("Failed to generate AP Aging Report.");
      setRows([]);
      setBucketTotals(null);
    } finally {
      setGenerated(true);
      setLoading(false);
    }
  }

  function exportCsv() {
    const headers = [
      "supplier", "reference_no", "document_date", "due_date", "days_outstanding", "aging_bucket",
      "currency_code", "currency_symbol", "foreign_original", "foreign_paid", "foreign_balance",
      "historical_rate", "base_original", "base_paid", "base_balance",
    ];
    const lines = [headers.join(",")];

    for (const r of filteredRows) {
      lines.push(
        [
          r.partyName, r.referenceNo, r.transactionDate, r.dueDate, r.daysOutstanding, BUCKET_LABELS[r.bucket] || r.bucket,
          r.currencyCode || "", r.currencySymbol || "",
          r.isForeign ? r.foreignOriginal : "", r.isForeign ? r.foreignPaid : "", r.isForeign ? r.foreignBalance : "",
          r.isForeign ? r.historicalRate : "", r.baseOriginal, r.basePaid, r.baseBalance,
        ]
          .map(csvEscape)
          .join(",")
      );
    }

    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `ap-aging-detailed-${asOfDate}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <div className="tb-page">
      <div className="tb-header">
        <h1>AP Detailed Aging Report</h1>
      </div>

      <div className="tb-filters">
        <h2>Report Filters</h2>

        <div className="tb-filter-grid">
          <div>
            <label>As Of Date</label>
            <input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
          </div>

          <div>
            <label>Supplier</label>
            <select value={partyFilter} onChange={(e) => setPartyFilter(e.target.value)}>
              <option value="">All Suppliers</option>
              {parties.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label>Currency</label>
            <select value={currencyFilter} onChange={(e) => setCurrencyFilter(e.target.value)}>
              <option value="">All Currencies</option>
              {currencies.map((c) => (
                <option key={c.id} value={c.currencyCode}>{c.currencyCode}</option>
              ))}
            </select>
          </div>

          <div>
            <label>Aging Bucket</label>
            <select value={bucketFilter} onChange={(e) => setBucketFilter(e.target.value)}>
              <option value="">All Buckets</option>
              {Object.entries(BUCKET_LABELS).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </div>

          <div>
            <label>Status</label>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="OPEN">Open</option>
              <option value="PAID">Paid</option>
              <option value="ALL">All</option>
            </select>
          </div>
        </div>

        <div className="tb-actions">
          <button className="primary" onClick={generateReport} disabled={loading}>
            {loading ? "Generating..." : "Generate Report"}
          </button>

          <button
            className="secondary"
            onClick={() => {
              setRows([]);
              setBucketTotals(null);
              setGenerated(false);
              setCurrencyFilter("");
              setPartyFilter("");
              setBucketFilter("");
              setStatusFilter("OPEN");
            }}
          >
            Clear Filters
          </button>

          <button className="secondary" onClick={exportCsv} disabled={!generated || filteredRows.length === 0}>
            Export CSV
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
              <h2>ACCOUNTS PAYABLE DETAILED AGING REPORT</h2>
              <h3>AS OF {formatAsOfDate(asOfDate)}</h3>
              <p style={{ fontSize: 11, color: "var(--text-secondary, #888)", margin: "4px 0 0" }}>
                Base Currency amounts shown in the CURRENT/1-30/.../BALANCE columns. Foreign amounts are
                carried at each document's own historical rate and are never converted at today's rate.
              </p>
            </div>

            <div className="tb-run-info">
              <p><span>Page No</span>: {runInfo.pageNo}</p>
              <p><span>RunDate</span>: {runInfo.runDate}</p>
              <p><span>RunTime</span>: {runInfo.runTime}</p>
            </div>
          </div>

          <div className="aging-table-wrapper">
            <table className="tb-report-table aging-table">
              <thead>
                <tr>
                  <th>SUPPLIER</th>
                  <th>REF NO</th>
                  <th>DOC DATE</th>
                  <th>DUE DATE</th>
                  <th>CCY</th>
                  <th className="amount-head">FOREIGN ORIG</th>
                  <th className="amount-head">FOREIGN PAID</th>
                  <th className="amount-head">FOREIGN BAL</th>
                  <th className="amount-head">RATE</th>
                  <th className="amount-head">CURRENT</th>
                  <th className="amount-head">1-30</th>
                  <th className="amount-head">31-60</th>
                  <th className="amount-head">61-90</th>
                  <th className="amount-head">OVER 90</th>
                  <th className="amount-head">BASE BALANCE</th>
                </tr>
              </thead>

              <tbody>
                {filteredRows.map((row, index) => (
                  <tr key={`${row.sourceType}-${row.sourceId}-${index}`}>
                    <td className="party-cell">{row.partyName}</td>
                    <td>{row.referenceNo}</td>
                    <td>{row.transactionDate}</td>
                    <td>{row.dueDate}</td>
                    <td>
                      {row.isForeign ? (
                        <span className="aging-currency-badge">{row.currencyCode}</span>
                      ) : (
                        <span className="muted">{row.currencyCode || "PHP"}</span>
                      )}
                    </td>
                    <td className="amount">{row.isForeign ? formatMoney(row.foreignOriginal) : "-"}</td>
                    <td className="amount">{row.isForeign ? formatMoney(row.foreignPaid) : "-"}</td>
                    <td className="amount">{row.isForeign ? formatMoney(row.foreignBalance) : "-"}</td>
                    <td className="amount">{row.isForeign ? Number(row.historicalRate).toFixed(6) : "-"}</td>
                    <td className="amount">{row.bucket === "current" ? formatMoney(row.baseBalance) : ""}</td>
                    <td className="amount">{row.bucket === "days1to30" ? formatMoney(row.baseBalance) : ""}</td>
                    <td className="amount">{row.bucket === "days31to60" ? formatMoney(row.baseBalance) : ""}</td>
                    <td className="amount">{row.bucket === "days61to90" ? formatMoney(row.baseBalance) : ""}</td>
                    <td className="amount">{row.bucket === "over90" ? formatMoney(row.baseBalance) : ""}</td>
                    <td className="amount">{formatMoney(row.baseBalance)}</td>
                  </tr>
                ))}
                {filteredRows.length === 0 && (
                  <tr>
                    <td colSpan={15} style={{ textAlign: "center", padding: "20px" }}>No outstanding payables found.</td>
                  </tr>
                )}
              </tbody>

              {bucketTotals && (
                <tfoot>
                  <tr>
                    <td colSpan={9}>BASE CURRENCY TOTAL</td>
                    <td>{formatMoney(bucketTotals.base.current)}</td>
                    <td>{formatMoney(bucketTotals.base.days1to30)}</td>
                    <td>{formatMoney(bucketTotals.base.days31to60)}</td>
                    <td>{formatMoney(bucketTotals.base.days61to90)}</td>
                    <td>{formatMoney(bucketTotals.base.over90)}</td>
                    <td>{formatMoney(bucketTotals.base.total)}</td>
                  </tr>
                  {Object.entries(bucketTotals.byCurrency).map(([code, t]) => (
                    <tr key={code}>
                      <td colSpan={9}>{code} FOREIGN TOTAL (not summed with base or other currencies)</td>
                      <td>{formatMoney(t.current)}</td>
                      <td>{formatMoney(t.days1to30)}</td>
                      <td>{formatMoney(t.days31to60)}</td>
                      <td>{formatMoney(t.days61to90)}</td>
                      <td>{formatMoney(t.over90)}</td>
                      <td>{formatMoney(t.total)}</td>
                    </tr>
                  ))}
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}
    </div>
  );
}