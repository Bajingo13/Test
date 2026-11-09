import { useState } from "react";
import ReportPeriodFilter, { ReportPeriodLabel } from "./ReportPeriodFilter.jsx";
import { csvAmount, downloadCsvText, reportRowsToCsv } from "./reportCsv.mjs";
import useReportPeriod from "./useReportPeriod.js";
import { AS_OF, periodCsvRows, reportCsvFilename } from "./reportPeriod.mjs";
import "./AccountAnalysis.css";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default function FixedAssetReport() {
  const period = useReportPeriod({ defaultMode: AS_OF });
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

  function exportCSV() {
    if (!generated) return alert("Please generate the report first.");
    const csvRows = [
      ["FIXED ASSET REGISTER"],
      ...periodCsvRows(period.applied),
      [],
      ["ASSET CODE", "ASSET NAME", "ACQ. DATE", "COST", "ACCUM. DEPRECIATION", "BOOK VALUE"],
      ...rows.map((row) => [
        row.assetCode,
        row.assetName,
        row.acquisitionDate,
        csvAmount(row.acquisitionCost),
        csvAmount(row.accumulatedDepreciation),
        csvAmount(row.bookValue),
      ]),
      ["", "TOTAL", "", csvAmount(totals.cost), csvAmount(totals.accumulatedDepreciation), csvAmount(totals.bookValue)],
    ];
    downloadCsvText(reportCsvFilename("Fixed_Asset_Register", period.applied), reportRowsToCsv(csvRows));
  }

  async function generateReport() {
    const applied = period.apply();
    if (!applied) return;
    setLoading(true);

    try {
      const res = await fetch(`${API_URL}/api/reports/fixed-asset-register?${new URLSearchParams(applied.params)}`, {
        credentials: "include",
        headers: authHeaders(),
      });
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
          <ReportPeriodFilter period={period} idPrefix="far" />
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

          <button className="dark" onClick={exportCSV} disabled={!generated}>
            Export CSV
          </button>
        </div>
      </div>

      {generated && (
        <div className="aa-report-card">
          <div className="aa-report-title">
            <h2>FIXED ASSET REGISTER</h2>
            <ReportPeriodLabel period={period.applied} />
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
