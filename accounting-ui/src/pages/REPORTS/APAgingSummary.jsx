import { useEffect, useState } from "react";
import ReportPeriodFilter, { ReportPeriodLabel } from "./ReportPeriodFilter.jsx";
import { downloadCsvText, reportRowsToCsv } from "./reportCsv.mjs";
import useReportPeriod from "./useReportPeriod.js";
import { AS_OF, periodCsvRows, reportCsvFilename } from "./reportPeriod.mjs";
import "./TrialBalance.css";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function formatMoney(amount) {
  return Number(amount || 0).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function APAgingSummary() {
  const period = useReportPeriod({ defaultMode: AS_OF });
  const { asOfDate } = period;
  const [currencyFilter, setCurrencyFilter] = useState("");
  const [currencies, setCurrencies] = useState([]);

  const [parties, setParties] = useState([]);
  const [loading, setLoading] = useState(false);
  const [generated, setGenerated] = useState(false);
  const [runInfo, setRunInfo] = useState({ pageNo: 1, runDate: "", runTime: "" });

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/currencies`, { credentials: "include", headers: authHeaders() });
        if (res.ok) setCurrencies(await res.json());
      } catch (err) {
        console.error("LOAD CURRENCIES ERROR:", err);
      }
    })();
  }, []);

  async function generateReport() {
    const applied = period.apply();
    if (!applied) return;
    setLoading(true);

    const now = new Date();
    setRunInfo({
      pageNo: 1,
      runDate: now.toLocaleDateString("en-US"),
      runTime: now.toLocaleTimeString("en-US", { hour12: false }),
    });

    try {
      const params = new URLSearchParams({ ...applied.params, status: "OPEN" });
      if (currencyFilter) params.set("currency", currencyFilter);

      const res = await fetch(`${API_URL}/api/reports/ap-aging-summary?${params.toString()}`, {
        credentials: "include",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Failed to fetch AP Aging Summary");

      const data = await res.json();
      setParties(Array.isArray(data.parties) ? data.parties : []);
    } catch (err) {
      console.error(err);
      alert("Failed to generate AP Aging Summary Report.");
      setParties([]);
    } finally {
      setGenerated(true);
      setLoading(false);
    }
  }

  const grandTotal = parties.reduce((sum, p) => sum + p.baseBalance, 0);

  function exportCsv() {
    const csvRows = [
      ["AP AGING SUMMARY REPORT"],
      ...periodCsvRows(period.applied),
      ["Status", "OPEN"],
      ...(currencyFilter ? [["Currency", currencyFilter]] : []),
      [],
      ["supplier", "document_count", "base_balance", "foreign_breakdown"],
      ...parties.map((p) => [
        p.partyName,
        p.documentCount,
        p.baseBalance,
        Object.entries(p.foreignByCurrency)
          .map(([code, fc]) => `${code} ${fc.balance}`)
          .join("; "),
      ]),
    ];
    downloadCsvText(reportCsvFilename("AP_Aging_Summary", period.applied), reportRowsToCsv(csvRows));
  }

  return (
    <div className="tb-page">
      <div className="tb-header">
        <h1>AP Aging Summary Report</h1>
      </div>

      <div className="tb-filters">
        <h2>Report Filters</h2>

        <div className="tb-filter-grid">
          <ReportPeriodFilter period={period} idPrefix="aps" />

          <div>
            <label>Currency</label>
            <select value={currencyFilter} onChange={(e) => setCurrencyFilter(e.target.value)}>
              <option value="">All Currencies</option>
              {currencies.map((c) => (
                <option key={c.id} value={c.currencyCode}>{c.currencyCode}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="tb-actions">
          <button className="primary" onClick={generateReport} disabled={loading}>
            {loading ? "Generating..." : "Generate Report"}
          </button>

          <button className="secondary" onClick={() => { setParties([]); setGenerated(false); setCurrencyFilter(""); }}>
            Clear Filters
          </button>

          <button className="secondary" onClick={exportCsv} disabled={!generated || parties.length === 0}>
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
              <h2>ACCOUNTS PAYABLE AGING SUMMARY</h2>
              <ReportPeriodLabel period={period.applied} />
              <p style={{ fontSize: 11, color: "var(--text-secondary, #888)", margin: "4px 0 0" }}>
                Grouped by supplier. Foreign balances are shown per currency and are never summed with base or other currencies.
              </p>
            </div>

            <div className="tb-run-info">
              <p><span>Page No</span>: {runInfo.pageNo}</p>
              <p><span>RunDate</span>: {runInfo.runDate}</p>
              <p><span>RunTime</span>: {runInfo.runTime}</p>
            </div>
          </div>

          <div className="aging-table-wrapper">
            <table className="tb-report-table aging-summary-table">
              <thead>
                <tr>
                  <th>SUPPLIER</th>
                  <th>DOCUMENTS</th>
                  <th>FOREIGN BALANCES</th>
                  <th className="amount-head">BASE BALANCE</th>
                </tr>
              </thead>

              <tbody>
                {parties.map((p) => (
                  <tr key={p.partyId ?? p.partyName}>
                    <td>{p.partyName}</td>
                    <td style={{ textAlign: "center" }}>{p.documentCount}</td>
                    <td>
                      {Object.entries(p.foreignByCurrency).length === 0
                        ? "-"
                        : Object.entries(p.foreignByCurrency).map(([code, fc]) => (
                            <span key={code} className="aging-currency-badge" style={{ marginRight: 6 }}>
                              {code} {formatMoney(fc.balance)}
                            </span>
                          ))}
                    </td>
                    <td className="amount">{formatMoney(p.baseBalance)}</td>
                  </tr>
                ))}
                {parties.length === 0 && (
                  <tr>
                    <td colSpan={4} style={{ textAlign: "center", padding: "20px" }}>No outstanding payables found.</td>
                  </tr>
                )}
              </tbody>

              <tfoot>
                <tr>
                  <td colSpan={3}>GRAND TOTAL (Base Currency)</td>
                  <td>{formatMoney(grandTotal)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}