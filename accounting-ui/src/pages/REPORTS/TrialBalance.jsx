import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import TrialBalanceCheckerPanel from "../../components/TrialBalanceCheckerPanel";
import {
  createRequestGuard,
  isCompanyLocked,
  pickInitialCompany,
  statusMatchesCompany,
  trialBalanceQuery,
  trialBalanceStatusQuery,
} from "../../utils/trialBalanceCompany.mjs";
import "./TrialBalance.css";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

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
  const [balanceStatus, setBalanceStatus] = useState(null);
  const [checkerOpen, setCheckerOpen] = useState(false);

  // The Company filter is the single company context for this page: the
  // report, the status badge and the checker all use companyId. A user
  // with one company gets it automatically; a Super Admin or a user with
  // several companies must choose (no first/lowest-company default).
  const [companyState, setCompanyState] = useState({ status: "loading", companies: [], isSuperAdmin: false });
  const [companyId, setCompanyId] = useState("");
  const requestGuard = useRef(createRequestGuard());

  const companyLocked = companyState.status === "ready" && isCompanyLocked(companyState);
  const selectedCompany = companyState.companies.find((c) => String(c.id) === String(companyId)) || null;

  useEffect(() => {
    loadCompanies();
  }, []);

  async function loadCompanies() {
    setCompanyState((s) => ({ ...s, status: "loading" }));
    try {
      const [meRes, companiesRes] = await Promise.all([
        fetch(`${API_URL}/api/me/permissions`, { credentials: "include", headers: authHeaders() }),
        fetch(`${API_URL}/api/companies`, { credentials: "include", headers: authHeaders() }),
      ]);
      if (!meRes.ok || !companiesRes.ok) throw new Error(`HTTP ${meRes.ok ? companiesRes.status : meRes.status}`);
      const me = await meRes.json();
      const companies = await companiesRes.json();
      const list = Array.isArray(companies) ? companies : [];
      const isSuperAdmin = me?.user?.roleCode === "SUPER_ADMIN";
      setCompanyState({ status: "ready", companies: list, isSuperAdmin });
      setCompanyId((current) => pickInitialCompany({ companies: list, isSuperAdmin, current }));
    } catch (err) {
      console.error("TRIAL BALANCE COMPANIES ERROR:", err?.message || "network error");
      requestGuard.current.invalidate();
      setCompanyState({ status: "error", companies: [], isSuperAdmin: false });
      setCompanyId("");
      setRows([]);
      setBalanceStatus(null);
      setGenerated(false);
      setCheckerOpen(false);
    }
  }

  // Switching company drops everything shown for the previous one (and any
  // response still in flight for it), then reloads for the new company if
  // a report was on screen.
  function changeCompany(value) {
    const regenerate = generated && Boolean(value);
    requestGuard.current.invalidate();
    setCompanyId(value);
    setRows([]);
    setBalanceStatus(null);
    setGenerated(false);
    setCheckerOpen(false);
    setLoading(false);
    if (regenerate) generateTrialBalance(value);
  }

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

  async function generateTrialBalance(forCompanyId = companyId) {
    const query = trialBalanceQuery({ from: fromDate, to: toDate, companyId: forCompanyId });
    if (!query) return; // no company selected - nothing is requested

    const ticket = requestGuard.current.next();
    setLoading(true);

    const now = new Date();

    setRunInfo({
      pageNo: 1,
      runDate: now.toLocaleDateString("en-US"),
      runTime: now.toLocaleTimeString("en-US", { hour12: false }),
    });

    try {
      const res = await fetch(
        `${API_URL}/api/reports/trial-balance?${query}`,
        { credentials: "include", headers: authHeaders() }
      );
      if (!requestGuard.current.isCurrent(ticket)) return;

      if (!res.ok) {
        let body = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        const message = res.status === 400 || res.status === 403 ? body?.message : null;
        throw Object.assign(new Error("Failed to fetch trial balance"), { userMessage: message });
      }

      const data = await res.json();
      if (!requestGuard.current.isCurrent(ticket)) return;
      const finalRows = Array.isArray(data) ? data : data.data || [];

      setRows(finalRows);
      await loadBalanceStatus(forCompanyId, ticket);
    } catch (err) {
      if (!requestGuard.current.isCurrent(ticket)) return;
      console.error(err);
      alert(err.userMessage || "Failed to generate Trial Balance. Please check the backend/server.");
      setRows([]);
      setBalanceStatus(null);
    } finally {
      if (requestGuard.current.isCurrent(ticket)) {
        setGenerated(true);
        setLoading(false);
      }
    }
  }

  async function loadBalanceStatus(forCompanyId, ticket) {
    const query = trialBalanceStatusQuery({ from: fromDate, to: toDate, tolerance: "0.01", companyId: forCompanyId });
    if (!query) {
      setBalanceStatus(null);
      return;
    }
    try {
      const res = await fetch(
        `${API_URL}/api/reports/trial-balance-checker/status?${query}`,
        { credentials: "include", headers: authHeaders() }
      );
      if (!requestGuard.current.isCurrent(ticket)) return;

      if (!res.ok) {
        setBalanceStatus(null);
        return;
      }

      const data = await res.json();
      if (!requestGuard.current.isCurrent(ticket)) return;
      setBalanceStatus(statusMatchesCompany(data, forCompanyId) ? data : null);
    } catch (err) {
      if (!requestGuard.current.isCurrent(ticket)) return;
      console.error("TRIAL BALANCE STATUS ERROR:", err);
      setBalanceStatus(null);
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
            <label htmlFor="tb-company">Company</label>
            <select
              id="tb-company"
              value={companyId}
              onChange={(e) => changeCompany(e.target.value)}
              disabled={companyState.status !== "ready" || companyLocked || companyState.companies.length === 0}
            >
              {!companyLocked && (
                <option value="">{companyState.status === "loading" ? "Loading companies..." : "Select Company"}</option>
              )}
              {companyState.companies.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.name}
                </option>
              ))}
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

        {companyState.status === "error" && (
          <div className="tb-company-message error" role="alert">
            Unable to load your companies, so the Trial Balance cannot be generated.{" "}
            <button type="button" className="tb-link-btn" onClick={loadCompanies}>
              Retry
            </button>
          </div>
        )}
        {companyState.status === "ready" && companyState.companies.length === 0 && (
          <div className="tb-company-message error" role="alert">
            You are not assigned to any company, so the Trial Balance cannot be generated.
          </div>
        )}
        {companyState.status === "ready" && companyState.companies.length > 0 && !companyId && (
          <div className="tb-company-message">Select a company to continue.</div>
        )}

        <div className="tb-actions">
          <button
            className="primary"
            onClick={() => generateTrialBalance()}
            disabled={loading || !companyId}
          >
            {loading ? "Generating..." : "Generate Report"}
          </button>

          <button
            className="secondary"
            onClick={() => {
              requestGuard.current.invalidate();
              setLoading(false);
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
              {selectedCompany && <h3 className="tb-report-company">{selectedCompany.name}</h3>}
              <h3>AS OF {formatAsOfDate(toDate)}</h3>
            </div>

            <div className="tb-run-info">
              <p><span>Page No</span>: {runInfo.pageNo}</p>
              <p><span>RunDate</span>: {runInfo.runDate}</p>
              <p><span>RunTime</span>: {runInfo.runTime}</p>
            </div>
          </div>

          {balanceStatus && (
            <div className="tb-balance-banner">
              <span
                className={`tb-balance-badge ${
                  balanceStatus.status === "UNBALANCED" ? "unbalanced" : "balanced"
                }`}
              >
                {balanceStatus.status === "BALANCED" && "Trial Balance is balanced"}
                {balanceStatus.status === "WITHIN_TOLERANCE" && "Balanced within rounding tolerance"}
                {balanceStatus.status === "UNBALANCED" && "Trial Balance is unbalanced"}
              </span>
              <span className="tb-balance-difference">
                Difference: ₱ {formatMoney(Math.abs(Number(balanceStatus.difference || 0)))}
              </span>
              {balanceStatus.status === "UNBALANCED" && (
                <button
                  type="button"
                  className="tb-check-difference-btn"
                  onClick={() => setCheckerOpen(true)}
                >
                  Check Difference
                </button>
              )}
            </div>
          )}

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

      <TrialBalanceCheckerPanel
        open={checkerOpen}
        companyId={companyId}
        companyName={selectedCompany?.name || ""}
        from={fromDate}
        to={toDate}
        tolerance="0.01"
        onClose={() => setCheckerOpen(false)}
      />
    </div>
  );
}