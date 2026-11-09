import { useMemo, useState } from "react";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import { downloadCsvText, typedRowsToCsv } from "./reportCsv.mjs";
import ReportExportMenu from "./ReportExportMenu.jsx";
import ReportPeriodFilter, { ReportPeriodLabel } from "./ReportPeriodFilter.jsx";
import useReportPeriod from "./useReportPeriod.js";
import { periodCsvRows, periodFileSlug } from "./reportPeriod.mjs";
import "./LedgerReport.css";
import "./BookReport.css";

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
//
// Standardized Books of Accounts layout (legacy BOOKS.XLT order, with
// Customer/Supplier Name + TIN right after Account Title). Screen, CSV and
// print all use this same order:
//   Account Code | Account Title | Customer/Supplier Name | TIN | Debit |
//   Credit | General Reference | Proj/Dept Code | Document No. Ref. |
//   [typeColumn, e.g. Memo Type] | Date | Particulars
// Party name / TIN / General Reference / Document No. Ref. are resolved by
// the backend (getBookRows -> party_name, party_tin, general_reference,
// document_ref); this component only displays them. Proj/Dept Code is blank
// until transactions carry such a field (proj_dept_code is always null).

const API_URL = import.meta.env.VITE_API_URL || "";

function formatMoney(amount) {
  return Number(amount || 0).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
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
  const period = useReportPeriod({ defaultFrom: defaultFromDate });
  const { toDate } = period;
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState(null); // null = not yet generated
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function generateReport() {
    const applied = period.apply();
    if (!applied) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams(applied.params);
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
      const parts = [
        r.reference_no,
        r.account_code,
        r.account_title,
        r.particulars,
        r.party_name,
        r.party_tin,
        r.general_reference,
      ];
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
    // An empty period still exports: its header says which period had no entries.
    if (!rows) return;
    const T = (v) => ({ t: "text", v: v == null ? "" : String(v) });
    const N = (v) => ({ t: "num", v: Number(v || 0).toFixed(2) });

    // Same column order as the on-screen table below.
    const headerRow = [
      T("Account Code"),
      T("Account Title"),
      T("Customer/Supplier Name"),
      T("TIN"),
      T("Debit"),
      T("Credit"),
      T("General Reference"),
      T("Proj/Dept Code"),
      T("Document No. Ref."),
    ];
    if (typeColumn) headerRow.push(T(typeColumn.label));
    headerRow.push(T("Date"), T("Particulars"));

    const totalRow = [T(""), T("TOTAL"), T(""), T(""), N(totals.debit), N(totals.credit), T(""), T(""), T("")];
    if (typeColumn) totalRow.push(T(""));
    totalRow.push(T(""), T(""));

    const csvRows = [
      [T(title.toUpperCase())],
      ...periodCsvRows(period.applied),
      [],
      headerRow,
      ...filteredRows.map((r) => {
        const row = [
          T(r.account_code),
          T(r.account_title),
          T(r.party_name),
          T(r.party_tin),
          N(r.debit),
          N(r.credit),
          T(r.general_reference),
          T(r.proj_dept_code),
          T(r.document_ref),
        ];
        if (typeColumn) row.push(T(typeColumn.getValue(r)));
        row.push(T(r.transaction_date), T(r.particulars));
        return row;
      }),
      [],
      totalRow,
    ];

    const safeTo = periodFileSlug(period.applied);
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
          <ReportPeriodFilter period={period} idPrefix="bk" />

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
            disabled={!rows}
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
            <ReportPeriodLabel period={period.applied} />
          </div>

          {filteredRows.length === 0 ? (
            <div className="lgr-empty">
              {rows.length === 0
                ? emptyMessage || `No Posted records found for the selected dates.`
                : "No rows match your search."}
            </div>
          ) : (
            <div className="bkr-table-wrap">
              <table className="lgr-table bkr-table bkr-table--books">
                <colgroup>
                  <col className="bkr-col-code" />
                  <col className="bkr-col-title" />
                  <col className="bkr-col-party" />
                  <col className="bkr-col-tin" />
                  <col className="bkr-col-amount" />
                  <col className="bkr-col-amount" />
                  <col className="bkr-col-ref" />
                  <col className="bkr-col-proj" />
                  <col className="bkr-col-doc" />
                  {typeColumn ? <col className="bkr-col-type" /> : null}
                  <col className="bkr-col-date" />
                  <col className="bkr-col-particulars" />
                </colgroup>
                <thead>
                  <tr>
                    <th>Account Code</th>
                    <th>Account Title</th>
                    <th>Customer/Supplier Name</th>
                    <th>TIN</th>
                    <th className="amount">Debit</th>
                    <th className="amount">Credit</th>
                    <th>General Reference</th>
                    <th>Proj/Dept Code</th>
                    <th title={referenceLabel}>Document No. Ref.</th>
                    {typeColumn ? <th>{typeColumn.label}</th> : null}
                    <th>Date</th>
                    <th>Particulars</th>
                  </tr>
                </thead>

                <tbody>
                  {filteredRows.map((row) => (
                    <tr key={row.line_id}>
                      <td>{row.account_code}</td>
                      <td>{row.account_title}</td>
                      <td>{row.party_name}</td>
                      <td className="bkr-nowrap">{row.party_tin}</td>
                      <td className="amount">{Number(row.debit) > 0 ? formatMoney(row.debit) : ""}</td>
                      <td className="amount">{Number(row.credit) > 0 ? formatMoney(row.credit) : ""}</td>
                      <td>{row.general_reference}</td>
                      <td>{row.proj_dept_code}</td>
                      <td className="bkr-nowrap">{row.document_ref}</td>
                      {typeColumn ? <td>{typeColumn.getValue(row)}</td> : null}
                      <td className="bkr-nowrap">{row.transaction_date}</td>
                      <td>{row.particulars}</td>
                    </tr>
                  ))}
                </tbody>

                <tfoot>
                  <tr>
                    <td colSpan={4} style={{ textAlign: "right" }}>
                      TOTAL
                    </td>
                    <td className="amount">{formatMoney(totals.debit)}</td>
                    <td className="amount">{formatMoney(totals.credit)}</td>
                    <td colSpan={typeColumn ? 6 : 5} />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}

      {!generated && !error ? (
        <div className="lgr-empty">Choose a report period and click Generate Report.</div>
      ) : null}
    </div>
  );
}
