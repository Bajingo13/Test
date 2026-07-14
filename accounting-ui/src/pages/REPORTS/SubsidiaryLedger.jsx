import { useEffect, useMemo, useState } from "react";
import "./AccountAnalysis.css";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default function SubsidiaryLedger() {
  const [ledgerType, setLedgerType] = useState("AR");
  const [fromDate, setFromDate] = useState("2026-01-01");
  const [toDate, setToDate] = useState(new Date().toISOString().slice(0, 10));
  const [parties, setParties] = useState([]);
  const [partyId, setPartyId] = useState("");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [generated, setGenerated] = useState(false);

  useEffect(() => {
    loadParties();
  }, []);

  useEffect(() => {
    setPartyId("");
    setRows([]);
    setGenerated(false);
  }, [ledgerType]);

  async function loadParties() {
    try {
      const res = await fetch(`${API_URL}/api/genlib`, { headers: authHeaders() });
      const data = await res.json();
      setParties(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("Failed to load General Libraries:", err);
    }
  }

  const partyType = ledgerType === "AR" ? "CUSTOMER" : "SUPPLIER";
  const filteredParties = useMemo(
    () => parties.filter((p) => p.type === partyType && p.status === "ACTIVE"),
    [parties, partyType]
  );

  const selectedParty = filteredParties.find((p) => String(p.id) === String(partyId));

  const totals = useMemo(() => {
    const debit = rows.reduce((sum, row) => sum + Number(row.debit || 0), 0);
    const credit = rows.reduce((sum, row) => sum + Number(row.credit || 0), 0);
    const endingBalance = rows.length ? Number(rows[rows.length - 1].running_balance || 0) : 0;
    return { debit, credit, endingBalance };
  }, [rows]);

  const formatMoney = (amount) =>
    Number(amount || 0).toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  async function generateReport() {
    if (!partyId) {
      alert(`Please select a ${ledgerType === "AR" ? "customer" : "supplier"} first.`);
      return;
    }

    setLoading(true);

    try {
      const res = await fetch(
        `${API_URL}/api/reports/subsidiary-ledger?type=${ledgerType}&partyId=${partyId}&from=${fromDate}&to=${toDate}`
      );

      if (!res.ok) throw new Error("Failed to generate subsidiary ledger");

      const data = await res.json();
      setRows(Array.isArray(data) ? data : []);
      setGenerated(true);
    } catch (err) {
      console.error(err);
      alert("Failed to generate Subsidiary Ledger. Please check backend/server.");
      setRows([]);
      setGenerated(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="aa-page">
      <div className="aa-header">
        <h1>Subsidiary Ledger</h1>
      </div>

      <div className="aa-filters">
        <h2>Report Filters</h2>

        <div className="aa-filter-grid">
          <div>
            <label>Ledger</label>
            <select value={ledgerType} onChange={(e) => setLedgerType(e.target.value)}>
              <option value="AR">Accounts Receivable (AR)</option>
              <option value="AP">Accounts Payable (AP)</option>
            </select>
          </div>

          <div>
            <label>Date From</label>
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </div>

          <div>
            <label>Date To</label>
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </div>

          <div>
            <label>{ledgerType === "AR" ? "Customer" : "Supplier"}</label>
            <select value={partyId} onChange={(e) => setPartyId(e.target.value)}>
              <option value="">Select {ledgerType === "AR" ? "Customer" : "Supplier"}</option>
              {filteredParties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} - {p.name}
                </option>
              ))}
            </select>
          </div>
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
        </div>
      </div>

      {generated && (
        <div className="aa-report-card">
          <div className="aa-report-title">
            <h2>{ledgerType} SUBSIDIARY LEDGER</h2>
            <h3>{selectedParty?.code} - {selectedParty?.name}</h3>
            <p>Period: {fromDate} to {toDate}</p>
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
                <th>BALANCE</th>
              </tr>
            </thead>

            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan="7" className="empty">No data found.</td>
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
                    <td className="amount">{formatMoney(row.running_balance)}</td>
                  </tr>
                ))
              )}
            </tbody>

            <tfoot>
              <tr>
                <td colSpan="4" style={{ textAlign: "center" }}>TOTAL</td>
                <td className="amount">{formatMoney(totals.debit)}</td>
                <td className="amount">{formatMoney(totals.credit)}</td>
                <td className="amount">{formatMoney(totals.endingBalance)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
