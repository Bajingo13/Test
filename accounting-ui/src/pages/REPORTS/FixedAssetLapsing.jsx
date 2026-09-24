import { useState } from "react";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import { downloadCsvText, typedRowsToCsv } from "./reportCsv.mjs";
import ReportExportMenu from "./ReportExportMenu.jsx";
import "./LedgerReport.css";

// Fixed Asset Lapsing Report - the last of the 9 "Coming Soon" reports
// identified in the technical documentation audit (reportsMenuConfig.js's
// fixed-asset-lapsing item, previously path: null).
//
// A period depreciation roll-forward (Beginning Accumulated Depreciation
// -> Depreciation Expense for the Period -> Ending Accumulated
// Depreciation) for every ACTIVE fixed asset, built on
// GET /api/reports/fixed-asset-lapsing, which reuses the existing Fixed
// Asset Register's own straight-line formula unchanged, evaluated at two
// as-of dates (From/To) instead of one. No financial math happens in
// this file - every figure comes verbatim from the backend.
//
// Known, inherited limitation (not fixed here): fixed_assets has no
// company_id/branch_id column, so - like the existing Fixed Asset
// Register - this report is not company- or branch-scoped.

const API_URL = import.meta.env.VITE_API_URL || "";

function formatMoney(amount) {
  return Number(amount || 0).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function FixedAssetLapsing() {
  const today = new Date().toISOString().slice(0, 10);
  const [fromDate, setFromDate] = useState(new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10));
  const [toDate, setToDate] = useState(today);
  const [report, setReport] = useState(null); // null = not yet generated
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function generateReport() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ from: fromDate, to: toDate });
      const res = await fetch(`${API_URL}/api/reports/fixed-asset-lapsing?${params.toString()}`, {
        credentials: "include",
        headers: authHeaders(),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        setReport(null);
        setError(body.message || "Unable to generate the Fixed Asset Lapsing report for the selected filters.");
        return;
      }
      setReport(body);
    } catch (err) {
      console.error("FIXED ASSET LAPSING REPORT ERROR:", err);
      setReport(null);
      setError("Unable to reach the server. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function clearFilters() {
    setReport(null);
    setError(null);
  }

  function exportCSV() {
    if (!report || !report.rows) return;
    const T = (v) => ({ t: "text", v: v == null ? "" : String(v) });
    const N = (v) => ({ t: "num", v: Number(v || 0).toFixed(2) });

    const csvRows = [
      [T("FIXED ASSET LAPSING REPORT")],
      [T(`From ${report.from} to ${report.to}`)],
      [],
      [
        T("Asset Code"),
        T("Asset Name"),
        T("Category"),
        T("Acquisition Date"),
        T("Acquisition Cost"),
        T("Salvage Value"),
        T("Useful Life (Years)"),
        T("Monthly Depreciation"),
        T("Beginning Accum. Depreciation"),
        T("Depreciation Expense"),
        T("Ending Accum. Depreciation"),
        T("Beginning Book Value"),
        T("Ending Book Value"),
      ],
      ...report.rows.map((r) => [
        T(r.assetCode),
        T(r.assetName),
        T(r.category),
        T(r.acquisitionDate),
        N(r.acquisitionCost),
        N(r.salvageValue),
        T(r.usefulLifeYears),
        N(r.monthlyDepreciation),
        N(r.beginningAccumulatedDepreciation),
        N(r.depreciationExpense),
        N(r.endingAccumulatedDepreciation),
        N(r.beginningBookValue),
        N(r.endingBookValue),
      ]),
      [],
      [
        T("GRAND TOTAL"),
        T(""),
        T(""),
        T(""),
        N(report.grandTotals.acquisitionCost),
        N(report.grandTotals.salvageValue),
        T(""),
        N(report.grandTotals.monthlyDepreciation),
        N(report.grandTotals.beginningAccumulatedDepreciation),
        N(report.grandTotals.depreciationExpense),
        N(report.grandTotals.endingAccumulatedDepreciation),
        N(report.grandTotals.beginningBookValue),
        N(report.grandTotals.endingBookValue),
      ],
    ];

    const safeFrom = String(fromDate).replace(/[^0-9A-Za-z_-]/g, "_");
    const safeTo = String(toDate).replace(/[^0-9A-Za-z_-]/g, "_");
    downloadCsvText(`Fixed_Asset_Lapsing_${safeFrom}_to_${safeTo}.csv`, typedRowsToCsv(csvRows));
  }

  const generated = report !== null;

  return (
    <div className="lgr-page">
      <div className="lgr-header">
        <h1>Fixed Asset Lapsing Report</h1>
      </div>

      <div className="lgr-filters">
        <h2>Report Filters</h2>

        <div className="lgr-filter-grid">
          <div>
            <label htmlFor="fal-from">From Date</label>
            <input id="fal-from" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </div>

          <div>
            <label htmlFor="fal-to">To Date</label>
            <input id="fal-to" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </div>
        </div>

        <div className="lgr-actions">
          <button className="primary" onClick={generateReport} disabled={loading}>
            {loading ? "Generating..." : "Generate Report"}
          </button>
          <button className="secondary" onClick={clearFilters} disabled={loading}>
            Clear Filters
          </button>
          <ReportExportMenu
            disabled={!report || !report.rows || !report.rows.length}
            onPrint={() => window.print()}
            onExportCsv={exportCSV}
          />
        </div>
      </div>

      {error ? (
        <div className="lgr-error" role="alert">
          {error}
        </div>
      ) : null}

      {generated && !error && (
        <div className="lgr-report-card">
          <div className="lgr-report-title">
            <h2>FIXED ASSET LAPSING REPORT</h2>
            <h3>FROM {report.from} TO {report.to}</h3>
          </div>

          {report.rows.length === 0 ? (
            <div className="lgr-empty">No active fixed assets found.</div>
          ) : (
            <table className="lgr-table">
              <thead>
                <tr>
                  <th>Asset Code</th>
                  <th>Asset Name</th>
                  <th>Category</th>
                  <th>Acquisition Date</th>
                  <th>Acquisition Cost</th>
                  <th>Salvage Value</th>
                  <th>Useful Life (Yrs)</th>
                  <th>Monthly Depreciation</th>
                  <th>Beginning Accum. Depreciation</th>
                  <th>Depreciation Expense</th>
                  <th>Ending Accum. Depreciation</th>
                  <th>Beginning Book Value</th>
                  <th>Ending Book Value</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.assetCode}</td>
                    <td>{r.assetName}</td>
                    <td>{r.category}</td>
                    <td>{r.acquisitionDate}</td>
                    <td className="amount">{formatMoney(r.acquisitionCost)}</td>
                    <td className="amount">{formatMoney(r.salvageValue)}</td>
                    <td>{r.usefulLifeYears}</td>
                    <td className="amount">{formatMoney(r.monthlyDepreciation)}</td>
                    <td className="amount">{formatMoney(r.beginningAccumulatedDepreciation)}</td>
                    <td className="amount">{formatMoney(r.depreciationExpense)}</td>
                    <td className="amount">{formatMoney(r.endingAccumulatedDepreciation)}</td>
                    <td className="amount">{formatMoney(r.beginningBookValue)}</td>
                    <td className="amount">{formatMoney(r.endingBookValue)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4} style={{ textAlign: "right" }}>
                    GRAND TOTAL
                  </td>
                  <td className="amount">{formatMoney(report.grandTotals.acquisitionCost)}</td>
                  <td className="amount">{formatMoney(report.grandTotals.salvageValue)}</td>
                  <td></td>
                  <td className="amount">{formatMoney(report.grandTotals.monthlyDepreciation)}</td>
                  <td className="amount">{formatMoney(report.grandTotals.beginningAccumulatedDepreciation)}</td>
                  <td className="amount">{formatMoney(report.grandTotals.depreciationExpense)}</td>
                  <td className="amount">{formatMoney(report.grandTotals.endingAccumulatedDepreciation)}</td>
                  <td className="amount">{formatMoney(report.grandTotals.beginningBookValue)}</td>
                  <td className="amount">{formatMoney(report.grandTotals.endingBookValue)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      )}

      {!generated && !error ? (
        <div className="lgr-empty">Choose a From Date and To Date and click Generate Report.</div>
      ) : null}
    </div>
  );
}
