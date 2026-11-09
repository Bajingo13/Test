import { useEffect, useMemo, useRef, useState } from "react";
import ReportPeriodFilter, { ReportPeriodLabel } from "./ReportPeriodFilter.jsx";
import useReportPeriod from "./useReportPeriod.js";
import { periodCsvRows, periodModeQuery, reportCsvFilename } from "./reportPeriod.mjs";
import "./AccountAnalysis.css";
import { downloadCsv } from "./reportCsv";
import { createRequestGuard, isCompanyLocked, pickInitialCompany } from "../../utils/trialBalanceCompany.mjs";
import { accountAnalysisQuery } from "../../utils/accountAnalysisCompany.mjs";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default function InputVAT() {
  const period = useReportPeriod({ defaultFrom: "2026-01-01", defaultTo: new Date().toISOString().slice(0, 10) });
  const { toDate } = period;
  const [accounts, setAccounts] = useState([]);
  const [accountCode, setAccountCode] = useState("");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [generated, setGenerated] = useState(false);

  // Company context (same rule as Account Analysis, whose endpoint this
  // report reuses): a single-company user gets theirs; a Super Admin or
  // multi-company user must choose. No first/lowest-company default.
  const [companyState, setCompanyState] = useState({ status: "loading", companies: [], isSuperAdmin: false });
  const [companyId, setCompanyId] = useState("");
  const requestGuard = useRef(createRequestGuard());

  const companyLocked = companyState.status === "ready" && isCompanyLocked(companyState);
  const selectedCompany = companyState.companies.find((c) => String(c.id) === String(companyId)) || null;

  useEffect(() => {
    loadAccounts();
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
      console.error("INPUT VAT COMPANIES ERROR:", err?.message || "network error");
      requestGuard.current.invalidate();
      setCompanyState({ status: "error", companies: [], isSuperAdmin: false });
      setCompanyId("");
      setRows([]);
      setGenerated(false);
      setLoading(false);
    }
  }

  // Switching company drops the previous company's rows and any response
  // still in flight for it.
  function changeCompany(value) {
    requestGuard.current.invalidate();
    setCompanyId(value);
    setRows([]);
    setGenerated(false);
    setLoading(false);
  }

  async function loadAccounts() {
    try {
      const res = await fetch(`${API_URL}/api/coa`, { headers: authHeaders() });
      const data = await res.json();
      const list = Array.isArray(data) ? data : [];
      setAccounts(list);

      const defaultAccount = list.find((acc) =>
        (acc.title || "").toLowerCase().includes("input vat") ||
        (acc.title || "").toLowerCase().includes("input tax")
      );

      if (defaultAccount) setAccountCode(defaultAccount.code);
    } catch (err) {
      console.error("Failed to load COA:", err);
    }
  }

  const selectedAccount = accounts.find((acc) => acc.code === accountCode);

  const totals = useMemo(() => {
    const debit = rows.reduce((sum, row) => sum + Number(row.debit || 0), 0);
    const credit = rows.reduce((sum, row) => sum + Number(row.credit || 0), 0);
    return { debit, credit, net: debit - credit };
  }, [rows]);

  const formatMoney = (amount) =>
    Number(amount || 0).toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  // Input VAT reuses the Account Analysis endpoint (no separate backend) -
  // the CSV mirrors exactly the rows already on screen for the current
  // account + date range; it never re-queries.
  function exportCSV() {
    // An empty period still exports: its header says which period had no entries.
    if (!generated) {
      alert("Please generate the report first.");
      return;
    }
    const meta = [
      ["INPUT VAT REPORT"],
      [`Company: ${selectedCompany?.name || ""}`],
      [`${accountCode} - ${selectedAccount?.title || ""}`],
      ...periodCsvRows(period.applied),
      [],
    ];
    const header = ["DATE", "SOURCE", "DOC REF", "PARTICULARS", "DEBIT", "CREDIT"];
    const body = rows.map((r) => [
      r.transaction_date,
      r.source_type,
      r.reference_no,
      r.particulars,
      Number(r.debit || 0) > 0 ? Number(r.debit).toFixed(2) : "",
      Number(r.credit || 0) > 0 ? Number(r.credit).toFixed(2) : "",
    ]);
    const totalRow = ["", "", "", "TOTAL", totals.debit.toFixed(2), totals.credit.toFixed(2)];
    const netRow = ["", "", "", "", "TOTAL INPUT VAT", totals.net.toFixed(2)];
    downloadCsv(reportCsvFilename("Input_VAT", period.applied, accountCode), [...meta, header, ...body, totalRow, netRow]);
  }

  async function generateReport() {
    const applied = period.apply();
    if (!applied) return;
    if (!accountCode) {
      alert("Please select the Input VAT account first.");
      return;
    }

    const { fromDate, toDate } = applied;
    const query = accountAnalysisQuery({ from: fromDate, to: toDate, accountCode, companyId });
    if (!query) return; // no company selected - nothing is requested

    const ticket = requestGuard.current.next();
    setLoading(true);

    try {
      const res = await fetch(
        `${API_URL}/api/reports/account-analysis?${query}&${periodModeQuery(applied)}`,
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
        throw Object.assign(new Error("Failed to generate Input VAT report"), { userMessage: message });
      }

      const data = await res.json();
      if (!requestGuard.current.isCurrent(ticket)) return;
      setRows(Array.isArray(data) ? data : []);
      setGenerated(true);
    } catch (err) {
      if (!requestGuard.current.isCurrent(ticket)) return;
      console.error(err);
      alert(err.userMessage || "Failed to generate Input VAT Report. Please check backend/server.");
      setRows([]);
      setGenerated(true);
    } finally {
      if (requestGuard.current.isCurrent(ticket)) setLoading(false);
    }
  }

  return (
    <div className="aa-page">
      <div className="aa-header">
        <h1>Input VAT Report</h1>
      </div>

      <div className="aa-filters">
        <h2>Report Filters</h2>

        <div className="aa-filter-grid">
          <ReportPeriodFilter period={period} idPrefix="iv" />

          <div>
            <label>Input VAT Account</label>
            <select value={accountCode} onChange={(e) => setAccountCode(e.target.value)}>
              <option value="">Select Account</option>
              {accounts.map((acc) => (
                <option key={acc.id} value={acc.code}>
                  {acc.code} - {acc.title}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="ivat-company">Company</label>
            <select
              id="ivat-company"
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
        </div>

        {companyState.status === "error" && (
          <div className="aa-company-message error" role="alert">
            Unable to load your companies, so the Input VAT report cannot be generated.{" "}
            <button type="button" className="aa-link-btn" onClick={loadCompanies}>
              Retry
            </button>
          </div>
        )}
        {companyState.status === "ready" && companyState.companies.length === 0 && (
          <div className="aa-company-message error" role="alert">
            You are not assigned to any company, so the Input VAT report cannot be generated.
          </div>
        )}
        {companyState.status === "ready" && companyState.companies.length > 0 && !companyId && (
          <div className="aa-company-message">Select a company to continue.</div>
        )}

        <div className="aa-actions">
          <button className="primary" onClick={generateReport} disabled={loading || !companyId}>
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
            Clear
          </button>

          <button className="dark" onClick={() => window.print()}>
            Export PDF
          </button>

          <button className="dark" onClick={exportCSV}>
            Export CSV
          </button>
        </div>
      </div>

      {generated && (
        <div className="aa-report-card">
          <div className="aa-report-title">
            <h2>INPUT VAT REPORT</h2>
            {selectedCompany && <p className="aa-report-company">{selectedCompany.name}</p>}
            <h3>
              {accountCode} - {selectedAccount?.title || ""}
            </h3>
            <ReportPeriodLabel period={period.applied} />
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
                  <td colSpan="6" className="empty">No data found.</td>
                </tr>
              ) : (
                rows.map((row, index) => (
                  <tr key={index}>
                    <td>{row.transaction_date}</td>
                    <td>{row.source_type}</td>
                    <td>{row.reference_no}</td>
                    <td>{row.particulars}</td>
                    <td className="amount">{Number(row.debit) > 0 ? formatMoney(row.debit) : ""}</td>
                    <td className="amount">{Number(row.credit) > 0 ? formatMoney(row.credit) : ""}</td>
                  </tr>
                ))
              )}
            </tbody>

            <tfoot>
              <tr>
                <td colSpan="4" style={{ textAlign: "center" }}>TOTAL</td>
                <td className="amount">{formatMoney(totals.debit)}</td>
                <td className="amount">{formatMoney(totals.credit)}</td>
              </tr>
              <tr>
                <td colSpan="5" style={{ textAlign: "right" }}><b>TOTAL INPUT VAT</b></td>
                <td className="amount"><b>{formatMoney(totals.net)}</b></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
