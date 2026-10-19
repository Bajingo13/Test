import { useEffect, useMemo, useState } from "react";
import "./LedgerReport.css";
import "./BookReport.css";

const API_URL = import.meta.env.VITE_API_URL || "";

// Standardized Books of Accounts columns for the General Ledger, used by the
// screen table, CSV and Excel export alike. Account grouping, the running
// balance and section totals are unchanged; Account Code/Title repeat on
// every row so exported rows are self-contained. Party name / TIN / General
// Reference / Document No. Ref. come resolved from the backend
// (LedgerReportService.getLedgerRows -> party_name, party_tin,
// general_reference, document_ref); Proj/Dept Code is blank until
// transactions carry such a field.
const GL_COLUMNS = [
  "Account Code",
  "Account Title",
  "Customer/Supplier Name",
  "TIN",
  "Debit",
  "Credit",
  "Balance",
  "General Reference",
  "Proj/Dept Code",
  "Document No. Ref.",
  "Source",
  "Date",
  "Particulars",
];

function amountOrBlank(value) {
  return Number(value || 0) > 0 ? Number(value).toFixed(2) : "";
}

// One exported row, in GL_COLUMNS order.
function exportRow(row, balance) {
  return [
    row.account_code,
    row.account_title,
    row.party_name || "",
    row.party_tin || "",
    amountOrBlank(row.debit),
    amountOrBlank(row.credit),
    balance.toFixed(2),
    row.general_reference || "",
    row.proj_dept_code || "",
    row.document_ref || row.reference_no || "",
    row.source_type,
    row.transaction_date,
    row.particulars || "",
  ];
}

// A section's opening-balance row, in GL_COLUMNS order: the amount under
// Balance and the label under Particulars (as before).
function beginningRow(section) {
  return [
    section.accountCode,
    section.accountTitle,
    "", "", "", "",
    section.beginningBalance.toFixed(2),
    "", "", "", "", "",
    "BEGINNING BALANCE",
  ];
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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

function formatAsOfDate(dateValue) {
  if (!dateValue) return "";
  return new Date(dateValue)
    .toLocaleDateString("en-US", { month: "long", day: "2-digit", year: "numeric" })
    .toUpperCase();
}

// Backend returns flat rows (one per transaction line, running_balance
// already computed per account_code) - group them into per-account sections
// here, same "flat rows in, sections rendered out" split trial-balance uses.
function groupByAccount(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.account_code)) {
      map.set(row.account_code, {
        accountCode: row.account_code,
        accountTitle: row.account_title,
        accountClass: row.account_class,
        beginningBalance: Number(row.beginning_balance) || 0,
        rows: [],
      });
    }
    map.get(row.account_code).rows.push(row);
  }
  return Array.from(map.values());
}

export default function GeneralLedger() {
  const [fromDate, setFromDate] = useState("2026-01-01");
  const [toDate, setToDate] = useState(new Date().toISOString().slice(0, 10));
  const [accountCode, setAccountCode] = useState("");
  const [accounts, setAccounts] = useState([]);
  const [sections, setSections] = useState([]);
  const [loading, setLoading] = useState(false);
  const [generated, setGenerated] = useState(false);

  useEffect(() => {
    loadAccounts();
  }, []);

  async function loadAccounts() {
    try {
      const res = await fetch(`${API_URL}/api/coa`, {
        credentials: "include",
        headers: authHeaders(),
      });
      if (!res.ok) return;
      const data = await res.json();
      setAccounts(data);
    } catch (err) {
      console.error("LOAD COA FOR GL ERROR:", err);
    }
  }

  async function generateReport() {
    setLoading(true);
    try {
      const params = new URLSearchParams({ from: fromDate, to: toDate });
      if (accountCode) params.set("accountCode", accountCode);

      const res = await fetch(`${API_URL}/api/reports/general-ledger?${params.toString()}`, {
        credentials: "include",
        headers: authHeaders(),
      });

      if (!res.ok) throw new Error("Failed to fetch general ledger");

      const rows = await res.json();
      setSections(groupByAccount(rows));
    } catch (err) {
      console.error(err);
      alert("Failed to generate General Ledger. Please check the backend/server.");
      setSections([]);
    } finally {
      setGenerated(true);
      setLoading(false);
    }
  }

  const grandTotals = useMemo(() => {
    let debit = 0;
    let credit = 0;
    for (const section of sections) {
      for (const row of section.rows) {
        debit += Number(row.debit || 0);
        credit += Number(row.credit || 0);
      }
    }
    return { debit, credit };
  }, [sections]);

  function downloadCSV() {
    if (!sections.length) return alert("Please generate the General Ledger first.");

    const csvRows = [["GENERAL LEDGER"], [`FOR THE PERIOD ${formatAsOfDate(fromDate)} TO ${formatAsOfDate(toDate)}`], []];

    for (const section of sections) {
      csvRows.push([`${section.accountCode} - ${section.accountTitle}`]);
      csvRows.push(GL_COLUMNS);
      csvRows.push(beginningRow(section));
      for (const row of section.rows) {
        csvRows.push(exportRow(row, section.beginningBalance + Number(row.running_balance || 0)));
      }
      csvRows.push([]);
    }

    const csvContent = csvRows
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `General_Ledger_${toDate}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function downloadExcel() {
    if (!sections.length) return alert("Please generate the General Ledger first.");

    const span = GL_COLUMNS.length;
    const cells = (values, tag = "td") => values.map((v) => `<${tag}>${escapeHtml(v)}</${tag}>`).join("");

    const htmlSections = sections
      .map(
        (section) => `
          <tr><td colspan="${span}"><b>${escapeHtml(`${section.accountCode} - ${section.accountTitle}`)}</b></td></tr>
          <tr>${cells(GL_COLUMNS, "th")}</tr>
          <tr>${cells(beginningRow(section))}</tr>
          ${section.rows
            .map(
              (row) =>
                `<tr>${cells(exportRow(row, section.beginningBalance + Number(row.running_balance || 0)))}</tr>`
            )
            .join("")}
          <tr><td colspan="${span}"></td></tr>
        `
      )
      .join("");

    const htmlTable = `
      <table border="1">
        <tr><th colspan="${span}">GENERAL LEDGER</th></tr>
        <tr><th colspan="${span}">FOR THE PERIOD ${formatAsOfDate(fromDate)} TO ${formatAsOfDate(toDate)}</th></tr>
        <tr></tr>
        ${htmlSections}
      </table>
    `;

    const blob = new Blob([htmlTable], { type: "application/vnd.ms-excel" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `General_Ledger_${toDate}.xls`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="lgr-page">
      <div className="lgr-header">
        <h1>General Ledger</h1>
      </div>

      <div className="lgr-filters">
        <h2>Report Filters</h2>

        <div className="lgr-filter-grid">
          <div>
            <label>Date From</label>
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </div>

          <div>
            <label>Date To</label>
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </div>

          <div>
            <label>Account (optional)</label>
            <select value={accountCode} onChange={(e) => setAccountCode(e.target.value)}>
              <option value="">All Accounts</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.code}>
                  {a.code} - {a.title}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="lgr-actions">
          <button className="primary" onClick={generateReport} disabled={loading}>
            {loading ? "Generating..." : "Generate Report"}
          </button>

          <button
            className="secondary"
            onClick={() => {
              setSections([]);
              setGenerated(false);
            }}
          >
            Clear Filters
          </button>

          <button className="dark" onClick={() => window.print()}>
            Export PDF
          </button>

          <button className="dark" onClick={downloadExcel}>
            Export Excel
          </button>

          <button className="dark" onClick={downloadCSV}>
            Export CSV
          </button>
        </div>
      </div>

      {generated && (
        <div className="lgr-report-card">
          <div className="lgr-report-title">
            <h2>GENERAL LEDGER</h2>
            <h3>
              FOR THE PERIOD {formatAsOfDate(fromDate)} TO {formatAsOfDate(toDate)}
            </h3>
          </div>

          {sections.length === 0 ? (
            <div className="lgr-empty">No activity found for the selected filters.</div>
          ) : (
            <>
              {sections.map((section) => (
                <div className="lgr-account-section" key={section.accountCode}>
                  <div className="lgr-account-header">
                    <span className="name">
                      {section.accountCode} - {section.accountTitle}
                    </span>
                    <span className="balances">
                      Beginning: ₱ {formatMoney(section.beginningBalance)}
                    </span>
                  </div>

                  <div className="bkr-table-wrap">
                    <table className="lgr-table bkr-table bkr-table--gl">
                      <colgroup>
                        <col className="bkr-col-code" />
                        <col className="bkr-col-title" />
                        <col className="bkr-col-party" />
                        <col className="bkr-col-tin" />
                        <col className="bkr-col-amount" />
                        <col className="bkr-col-amount" />
                        <col className="bkr-col-amount" />
                        <col className="bkr-col-ref" />
                        <col className="bkr-col-proj" />
                        <col className="bkr-col-doc" />
                        <col className="bkr-col-source" />
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
                          <th className="amount">Balance</th>
                          <th>General Reference</th>
                          <th>Proj/Dept Code</th>
                          <th>Document No. Ref.</th>
                          <th>Source</th>
                          <th>Date</th>
                          <th>Particulars</th>
                        </tr>
                      </thead>

                      <tbody>
                        {section.rows.map((row, idx) => (
                          <tr key={idx}>
                            <td>{row.account_code}</td>
                            <td>{row.account_title}</td>
                            <td>{row.party_name}</td>
                            <td className="bkr-nowrap">{row.party_tin}</td>
                            <td className="amount">
                              {Number(row.debit) > 0 ? formatMoney(row.debit) : ""}
                            </td>
                            <td className="amount">
                              {Number(row.credit) > 0 ? formatMoney(row.credit) : ""}
                            </td>
                            <td className="amount">
                              {formatMoney(section.beginningBalance + Number(row.running_balance || 0))}
                            </td>
                            <td>{row.general_reference}</td>
                            <td>{row.proj_dept_code}</td>
                            <td>{row.document_ref || row.reference_no}</td>
                            <td>{row.source_type}</td>
                            <td className="bkr-nowrap">{row.transaction_date}</td>
                            <td>{row.particulars}</td>
                          </tr>
                        ))}
                      </tbody>

                      <tfoot>
                        <tr>
                          <td colSpan={6} style={{ textAlign: "right" }}>
                            Ending Balance
                          </td>
                          <td className="amount">
                            {formatMoney(
                              section.beginningBalance +
                                Number(section.rows[section.rows.length - 1]?.running_balance || 0)
                            )}
                          </td>
                          <td colSpan={6} />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              ))}

              <div className="lgr-summary-grid">
                <div className="lgr-summary-item">
                  <div className="label">Total Debit</div>
                  <div className="value">₱ {formatMoney(grandTotals.debit)}</div>
                </div>
                <div className="lgr-summary-item">
                  <div className="label">Total Credit</div>
                  <div className="value">₱ {formatMoney(grandTotals.credit)}</div>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
