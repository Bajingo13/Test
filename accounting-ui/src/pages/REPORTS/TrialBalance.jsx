import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import "./TrialBalance.css";

const API_URL = import.meta.env.VITE_API_URL || "";

export default function TrialBalance() {
  const navigate = useNavigate();

  const [fromDate, setFromDate] = useState("2026-01-01");
  const [toDate, setToDate] = useState(new Date().toISOString().slice(0, 10));
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [generated, setGenerated] = useState(false);
  const [runInfo, setRunInfo] = useState({
    pageNo: 1,
    runDate: "",
    runTime: "",
  });

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

  const formatAsOfDate = (dateValue) => {
    if (!dateValue) return "";
    const date = new Date(dateValue);
    return date
      .toLocaleDateString("en-US", {
        month: "long",
        day: "2-digit",
        year: "numeric",
      })
      .toUpperCase();
  };

  const openAccountAnalysis = (row) => {
    navigate(
      `/reports/account-analysis?accountCode=${encodeURIComponent(
        row.account_code
      )}&from=${fromDate}&to=${toDate}`
    );
  };

  async function generateTrialBalance() {
    setLoading(true);

    const now = new Date();

    setRunInfo({
      pageNo: 1,
      runDate: now.toLocaleDateString("en-US"),
      runTime: now.toLocaleTimeString("en-US", { hour12: false }),
    });

    try {
      const res = await fetch(
        `${API_URL}/api/reports/trial-balance?from=${fromDate}&to=${toDate}`
      );

      if (!res.ok) throw new Error("Failed to fetch trial balance");

      const data = await res.json();
      const finalRows = Array.isArray(data) ? data : data.data || [];

      setRows(finalRows);

      const totalDebit = finalRows.reduce(
        (sum, row) => sum + Number(row.debit || 0),
        0
      );

      const totalCredit = finalRows.reduce(
        (sum, row) => sum + Number(row.credit || 0),
        0
      );

      const difference = Math.abs(totalDebit - totalCredit);

      if (difference > 0.009) {
        alert(
          `DEBIT AND CREDIT NOT BALANCED BY A\nDIFFERENCE OF ${formatMoney(
            difference
          )}\n\nClick OK to continue.`
        );
      }
    } catch (err) {
      console.error(err);
      alert("Failed to generate Trial Balance. Please check the backend/server.");
      setRows([]);
    } finally {
      setGenerated(true);
      setLoading(false);
    }
  }

  const downloadCSV = () => {
    if (!rows.length) {
      alert("Please generate the Trial Balance first.");
      return;
    }

    const csvRows = [
      ["TRIAL BALANCE"],
      [`AS OF ${formatAsOfDate(toDate)}`],
      [],
      ["CODE", "TITLE", "DEBIT", "CREDIT", "CLASS"],
      ...rows.map((row) => [
        row.account_code,
        row.account_name,
        Number(row.debit || 0) > 0 ? Number(row.debit || 0).toFixed(2) : "",
        Number(row.credit || 0) > 0 ? Number(row.credit || 0).toFixed(2) : "",
        row.account_class || "",
      ]),
      [],
      ["", "TOTAL", totals.debit.toFixed(2), totals.credit.toFixed(2), ""],
    ];

    const csvContent = csvRows
      .map((row) =>
        row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")
      )
      .join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `Trial_Balance_${toDate}.csv`;
    link.click();

    URL.revokeObjectURL(url);
  };

  const downloadExcel = () => {
    if (!rows.length) {
      alert("Please generate the Trial Balance first.");
      return;
    }

    const htmlTable = `
      <table border="1">
        <tr><th colspan="5">TRIAL BALANCE</th></tr>
        <tr><th colspan="5">AS OF ${formatAsOfDate(toDate)}</th></tr>
        <tr></tr>
        <tr>
          <th>CODE</th>
          <th>TITLE</th>
          <th>DEBIT</th>
          <th>CREDIT</th>
          <th>CLASS</th>
        </tr>
        ${rows
          .map(
            (row) => `
              <tr>
                <td>${row.account_code || ""}</td>
                <td>${row.account_name || ""}</td>
                <td>${Number(row.debit || 0) > 0 ? Number(row.debit || 0).toFixed(2) : ""}</td>
                <td>${Number(row.credit || 0) > 0 ? Number(row.credit || 0).toFixed(2) : ""}</td>
                <td>${row.account_class || ""}</td>
              </tr>
            `
          )
          .join("")}
        <tr>
          <td></td>
          <td><b>TOTAL</b></td>
          <td><b>${totals.debit.toFixed(2)}</b></td>
          <td><b>${totals.credit.toFixed(2)}</b></td>
          <td></td>
        </tr>
      </table>
    `;

    const blob = new Blob([htmlTable], {
      type: "application/vnd.ms-excel",
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `Trial_Balance_${toDate}.xls`;
    link.click();

    URL.revokeObjectURL(url);
  };

  return (
    <div className="tb-page">
      <div className="tb-header">
        <h1>Trial Balance</h1>
      </div>

      <div className="tb-filters">
        <h2>Report Filters</h2>

        <div className="tb-filter-grid">
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
            <label>Company</label>
            <select>
              <option>Select Company</option>
            </select>
          </div>

          <div>
            <label>Branch / Department</label>
            <select>
              <option>All Branches</option>
            </select>
          </div>

          <div>
            <label>Status</label>
            <select>
              <option>All</option>
              <option>Posted</option>
              <option>Draft</option>
            </select>
          </div>
        </div>

        <div className="tb-actions">
          <button
            className="primary"
            onClick={generateTrialBalance}
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
        <div className="tb-report-card">
          <div className="tb-report-top">
            <div></div>

            <div className="tb-report-title">
              <h2>TRIAL BALANCE</h2>
              <h3>AS OF {formatAsOfDate(toDate)}</h3>
            </div>

            <div className="tb-run-info">
              <p><span>Page No</span>: {runInfo.pageNo}</p>
              <p><span>RunDate</span>: {runInfo.runDate}</p>
              <p><span>RunTime</span>: {runInfo.runTime}</p>
            </div>
          </div>

          <table className="tb-report-table">
            <thead>
              <tr>
                <th>CODE</th>
                <th>TITLE</th>
                <th>DEBIT</th>
                <th>CREDIT</th>
                <th>CLASS</th>
              </tr>
            </thead>

            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  <td>{row.account_code}</td>

                  <td
                    className="tb-clickable-account"
                    title="Open Account Analysis"
                    onClick={() => openAccountAnalysis(row)}
                  >
                    {row.account_name}
                  </td>

                  <td className="amount">
                    {Number(row.debit) > 0 ? formatMoney(row.debit) : ""}
                  </td>

                  <td className="amount">
                    {Number(row.credit) > 0 ? formatMoney(row.credit) : ""}
                  </td>

                  <td className="class-column">{row.account_class}</td>
                </tr>
              ))}
            </tbody>

            <tfoot>
              <tr>
                <td></td>
                <td style={{ textAlign: "center" }}>TOTAL</td>
                <td className="amount">{formatMoney(totals.debit)}</td>
                <td className="amount">{formatMoney(totals.credit)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}