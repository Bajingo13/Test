import { useMemo, useState } from "react";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import { downloadCsvText, typedRowsToCsv } from "./reportCsv.mjs";
import ReportExportMenu from "./ReportExportMenu.jsx";
import "./LedgerReport.css";

// Reports Phase L.2: shared, explicit, config-driven renderer for a single
// "Book of Accounts" report (Journal Book, Income Book, ...). Extracted from
// Phase L.1's standalone JournalBook.jsx once a second, near-identical Book
// (Income Book) made the duplication real - every caller still passes its
// OWN literal title/apiPath/labels, so behavior stays explicit and nothing
// here is guessed or derived dynamically. This component is presentation +
// fetch/CSV plumbing only: every row's debit/credit comes verbatim from the
// backend's canonical LedgerReportService union (source_type-filtered, via
// getBookRows), and totals are a plain sum of the rows already on screen -
// no financial math happens here.

const API_URL = import.meta.env.VITE_API_URL || "";

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

export default function BookReport({
  title,
  apiPath,
  referenceLabel = "Reference",
  filenamePrefix,
  defaultFromDate = "2026-01-01",
  emptyMessage,
  // Phase L.7, optional, default off: {label, getValue(row)}. Six of seven
  // Books never pass this - their JSON rows already carry a single implied
  // type from their one-element sourceTypes[], so nothing here changes for
  // them (verified by re-running all six of their suites unchanged). Only
  // the dual-source Debit/Credit Memo Book passes it, because its two
  // source types share one free-typed voucher_no column with no enforced
  // DM-/CM- prefix and would otherwise be indistinguishable on screen.
  typeColumn,
}) {
  const [fromDate, setFromDate] = useState(defaultFromDate);
  const [toDate, setToDate] = useState(new Date().toISOString().slice(0, 10));
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState(null); // null = not yet generated
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function generateReport() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ from: fromDate, to: toDate });
      const res = await fetch(`${API_URL}${apiPath}?${params.toString()}`, {
        credentials: "include",
        headers: authHeaders(),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        setRows(null);
        setError(body.message || `Unable to generate the ${title} for the selected filters.`);
        return;
      }
      setRows(Array.isArray(body) ? body : []);
    } catch (err) {
      console.error(`${title.toUpperCase()} ERROR:`, err);
      setRows(null);
      setError("Unable to reach the server. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function clearFilters() {
    setRows(null);
    setError(null);
    setSearch("");
  }

  // Search is an on-screen filter only - it narrows which already-fetched
  // rows are displayed, it never re-queries and never changes the totals
  // (see below), so it can't be mistaken for a different report population.
  const filteredRows = useMemo(() => {
    if (!rows) return [];
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const parts = [r.reference_no, r.account_code, r.account_title, r.particulars];
      if (typeColumn) parts.push(typeColumn.getValue(r));
      return parts.join(" ").toLowerCase().includes(q);
    });
  }, [rows, search, typeColumn]);

  // Totals reflect the actual generated report population (all rows for the
  // selected dates), not the search-narrowed view - the search box must
  // never change what the totals say. No balancing adjustment is invented:
  // if the selected Posted population is out of balance, that is what shows.
  const totals = useMemo(() => {
    const list = rows || [];
    let debit = 0;
    let credit = 0;
    for (const row of list) {
      debit += Number(row.debit || 0);
      credit += Number(row.credit || 0);
    }
    return { debit, credit };
  }, [rows]);

  function exportCSV() {
    if (!rows || !rows.length) return;
    const T = (v) => ({ t: "text", v: v == null ? "" : String(v) });
    const N = (v) => ({ t: "num", v: Number(v || 0).toFixed(2) });

    const headerRow = [T("Date"), T(referenceLabel)];
    if (typeColumn) headerRow.push(T(typeColumn.label));
    headerRow.push(T("Particulars"), T("Account Code"), T("Account Title"), T("Debit"), T("Credit"));

    const totalRow = [T(""), T("")];
    if (typeColumn) totalRow.push(T(""));
    totalRow.push(T(""), T(""), T("TOTAL"), N(totals.debit), N(totals.credit));

    const csvRows = [
      [T(title.toUpperCase())],
      [T(`For the period ${fromDate} to ${toDate}`)],
      [],
      headerRow,
      ...filteredRows.map((r) => {
        const row = [T(r.transaction_date), T(r.reference_no)];
        if (typeColumn) row.push(T(typeColumn.getValue(r)));
        row.push(T(r.particulars), T(r.account_code), T(r.account_title), N(r.debit), N(r.credit));
        return row;
      }),
      [],
      totalRow,
    ];

    const safeTo = String(toDate).replace(/[^0-9A-Za-z_-]/g, "_");
    downloadCsvText(`${filenamePrefix}_${safeTo}.csv`, typedRowsToCsv(csvRows));
  }

  const generated = rows !== null;

  return (
    <div className="lgr-page">
      <div className="lgr-header">
        <h1>{title}</h1>
      </div>

      <div className="lgr-filters">
        <h2>Report Filters</h2>

        <div className="lgr-filter-grid">
          <div>
            <label htmlFor="bk-from">Date From</label>
            <input id="bk-from" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </div>

          <div>
            <label htmlFor="bk-to">Date To</label>
            <input id="bk-to" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </div>

          <div>
            <label htmlFor="bk-search">Search</label>
            <input
              id="bk-search"
              type="text"
              placeholder={`${referenceLabel}, account, particulars...`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
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
            disabled={!rows || !rows.length}
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
            <h2>{title.toUpperCase()}</h2>
            <h3>
              FOR THE PERIOD {formatAsOfDate(fromDate)} TO {formatAsOfDate(toDate)}
            </h3>
          </div>

          {filteredRows.length === 0 ? (
            <div className="lgr-empty">
              {rows.length === 0
                ? emptyMessage || `No Posted records found for the selected dates.`
                : "No rows match your search."}
            </div>
          ) : (
            <table className="lgr-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>{referenceLabel}</th>
                  {typeColumn ? <th>{typeColumn.label}</th> : null}
                  <th>Particulars</th>
                  <th>Account Code</th>
                  <th>Account Title</th>
                  <th>Debit</th>
                  <th>Credit</th>
                </tr>
              </thead>

              <tbody>
                {filteredRows.map((row) => (
                  <tr key={row.line_id}>
                    <td>{row.transaction_date}</td>
                    <td>{row.reference_no}</td>
                    {typeColumn ? <td>{typeColumn.getValue(row)}</td> : null}
                    <td>{row.particulars}</td>
                    <td>{row.account_code}</td>
                    <td>{row.account_title}</td>
                    <td className="amount">{Number(row.debit) > 0 ? formatMoney(row.debit) : ""}</td>
                    <td className="amount">{Number(row.credit) > 0 ? formatMoney(row.credit) : ""}</td>
                  </tr>
                ))}
              </tbody>

              <tfoot>
                <tr>
                  <td colSpan={typeColumn ? 6 : 5} style={{ textAlign: "right" }}>
                    TOTAL
                  </td>
                  <td className="amount">{formatMoney(totals.debit)}</td>
                  <td className="amount">{formatMoney(totals.credit)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      )}

      {!generated && !error ? (
        <div className="lgr-empty">Choose a date range and click Generate Report.</div>
      ) : null}
    </div>
  );
}
