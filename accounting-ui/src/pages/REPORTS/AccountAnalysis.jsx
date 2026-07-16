import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import "./AccountAnalysis.css";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const SOURCE_ROUTES = {
  APV: "/transactions/apv",
  CV: "/transactions/cv",
  INV: "/transactions/invoice",
  OR: "/transactions/or",
};

export default function AccountAnalysis() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

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

  // Drill-down links (from Trial Balance / Income Statement / Balance Sheet) land here
  // with accountCode/from/to in the URL. Generate immediately from the URL params instead
  // of waiting for the accounts dropdown to finish loading first - loadAccounts() is only
  // needed to display the account title, not to run the report, so gating on it just adds
  // a second sequential API round-trip before anything appears.
  useEffect(() => {
    const code = searchParams.get("accountCode");
    const from = searchParams.get("from");
    const to = searchParams.get("to");

    if (from) setFromDate(from);
    if (to) setToDate(to);

    if (code) {
      setAccountCode(code);
      generateReport(code, from || fromDate, to || toDate);
    }
  }, [searchParams]);

  async function loadAccounts() {
    try {
      const res = await fetch(`${API_URL}/api/coa`, { headers: authHeaders() });
      const data = await res.json();
      setAccounts(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("Failed to load COA:", err);
    }
  }

  const selectedAccount = accounts.find((acc) => acc.code === accountCode);

  const totals = useMemo(() => {
    const debit = rows.reduce((sum, row) => sum + Number(row.debit || 0), 0);
    const credit = rows.reduce((sum, row) => sum + Number(row.credit || 0), 0);
    return { debit, credit };
  }, [rows]);

  const formatMoney = (amount) =>
    Number(amount || 0).toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  async function generateReport(codeOverride = null, fromOverride = null, toOverride = null) {
    const finalAccountCode = codeOverride || accountCode;
    const finalFromDate = fromOverride || fromDate;
    const finalToDate = toOverride || toDate;

    if (!finalAccountCode) {
      alert("Please select an account first.");
      return;
    }

    setLoading(true);

    try {
      const res = await fetch(
        `${API_URL}/api/reports/account-analysis?from=${finalFromDate}&to=${finalToDate}&accountCode=${finalAccountCode}`
      );

      if (!res.ok) throw new Error("Failed to generate account analysis");

      const data = await res.json();
      setRows(Array.isArray(data) ? data : []);
      setGenerated(true);
    } catch (err) {
      console.error(err);
      alert("Failed to generate Account Analysis. Please check backend/server.");
      setRows([]);
      setGenerated(true);
    } finally {
      setLoading(false);
    }
  }

  const downloadCSV = () => {
    if (!rows.length) {
      alert("Please generate the report first.");
      return;
    }

    const csvRows = [
      ["ACCOUNT ANALYSIS"],
      [`${accountCode} - ${selectedAccount?.title || ""}`],
      [`Period: ${fromDate} to ${toDate}`],
      [],
      ["DATE", "DOC REF", "PARTICULARS", "DEBIT", "CREDIT"],
      ...rows.map((row) => [
        row.transaction_date,
        row.reference_no,
        row.particulars,
        Number(row.debit || 0) > 0 ? Number(row.debit || 0).toFixed(2) : "",
        Number(row.credit || 0) > 0 ? Number(row.credit || 0).toFixed(2) : "",
      ]),
      [],
      ["", "", "TOTAL", totals.debit.toFixed(2), totals.credit.toFixed(2)],
    ];

    const csvContent = csvRows
      .map((row) =>
        row.map((cell) => `"${String(cell || "").replace(/"/g, '""')}"`).join(",")
      )
      .join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `Account_Analysis_${accountCode}_${toDate}.csv`;
    link.click();

    URL.revokeObjectURL(url);
  };

  const downloadExcel = () => {
    if (!rows.length) {
      alert("Please generate the report first.");
      return;
    }

    const htmlTable = `
      <table border="1">
        <tr><th colspan="5">ACCOUNT ANALYSIS</th></tr>
        <tr><th colspan="5">${accountCode} - ${selectedAccount?.title || ""}</th></tr>
        <tr><th colspan="5">Period: ${fromDate} to ${toDate}</th></tr>
        <tr>
          <th>DATE</th>
          <th>DOC REF</th>
          <th>PARTICULARS</th>
          <th>DEBIT</th>
          <th>CREDIT</th>
        </tr>
        ${rows
          .map(
            (row) => `
              <tr>
                <td>${row.transaction_date || ""}</td>
                <td>${row.reference_no || ""}</td>
                <td>${row.particulars || ""}</td>
                <td>${Number(row.debit || 0) > 0 ? Number(row.debit || 0).toFixed(2) : ""}</td>
                <td>${Number(row.credit || 0) > 0 ? Number(row.credit || 0).toFixed(2) : ""}</td>
              </tr>
            `
          )
          .join("")}
        <tr>
          <td></td>
          <td></td>
          <td><b>TOTAL</b></td>
          <td><b>${totals.debit.toFixed(2)}</b></td>
          <td><b>${totals.credit.toFixed(2)}</b></td>
        </tr>
      </table>
    `;

    const blob = new Blob([htmlTable], {
      type: "application/vnd.ms-excel",
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `Account_Analysis_${accountCode}_${toDate}.xls`;
    link.click();

    URL.revokeObjectURL(url);
  };

  return (
    <div className="aa-page">
      <div className="aa-header">
        <h1>Account Analysis</h1>
      </div>

      <div className="aa-filters">
        <h2>Report Filters</h2>

        <div className="aa-filter-grid">
          <div>
            <label>Date From</label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
            />
          </div>

          <div>
            <label>Date To</label>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
            />
          </div>

          <div>
            <label>Account</label>
            <select
              value={accountCode}
              onChange={(e) => setAccountCode(e.target.value)}
            >
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
          <button
            className="primary"
            onClick={() => generateReport()}
            disabled={loading}
          >
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

          <button className="dark" onClick={downloadExcel}>
            Export Excel
          </button>

          <button className="dark" onClick={downloadCSV}>
            Export CSV
          </button>
        </div>
      </div>

      {generated && (
        <div className="aa-report-card">
          <div className="aa-report-title">
            <h2>ACCOUNT ANALYSIS</h2>
            <h3>
              {accountCode} - {selectedAccount?.title || ""}
            </h3>
            <p>
              Period: {fromDate} to {toDate}
            </p>
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
                  <td colSpan="6" className="empty">
                    No data found.
                  </td>
                </tr>
              ) : (
                rows.map((row, index) => {
                  const route = SOURCE_ROUTES[row.source_type];
                  const clickable = Boolean(route && row.transaction_id);

                  return (
                    <tr
                      key={index}
                      className={clickable ? "aa-clickable-row" : ""}
                      title={clickable ? "Open source transaction" : ""}
                      onClick={
                        clickable
                          ? () => navigate(`${route}?id=${row.transaction_id}`)
                          : undefined
                      }
                    >
                      <td>{row.transaction_date}</td>
                      <td>{row.source_type}</td>
                      <td>{row.reference_no}</td>
                      <td>{row.particulars}</td>
                      <td className="amount">
                        {Number(row.debit) > 0 ? formatMoney(row.debit) : ""}
                      </td>
                      <td className="amount">
                        {Number(row.credit) > 0 ? formatMoney(row.credit) : ""}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>

            <tfoot>
              <tr>
                <td></td>
                <td></td>
                <td style={{ textAlign: "center" }}>TOTAL</td>
                <td></td>
                <td className="amount">{formatMoney(totals.debit)}</td>
                <td className="amount">{formatMoney(totals.credit)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}