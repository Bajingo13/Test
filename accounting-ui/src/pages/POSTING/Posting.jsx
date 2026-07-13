import { useEffect, useState } from "react";
import "./Posting.css";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const AR_TYPES = ["INV", "OR"];
const AP_TYPES = ["APV", "CV", "PO"];

const TYPE_LABELS = {
  INV: "Invoice",
  OR: "Official Receipt",
  APV: "Accounts Payable Voucher",
  CV: "Check Voucher",
  PO: "Purchase Order",
};

export default function Posting() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [posting, setPosting] = useState(false);

  useEffect(() => {
    loadPending();
  }, []);

  const formatMoney = (amount) =>
    Number(amount || 0).toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  async function loadPending() {
    setLoading(true);

    try {
      const res = await fetch(`${API_URL}/api/posting/pending`, {
        headers: authHeaders(),
      });

      const data = await res.json();
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("LOAD PENDING POSTING ERROR:", err);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  async function postScope(scope) {
    const count =
      scope === "ar"
        ? rows.filter((r) => AR_TYPES.includes(r.sourceType)).length
        : scope === "ap"
        ? rows.filter((r) => AP_TYPES.includes(r.sourceType)).length
        : rows.length;

    if (count === 0) {
      alert("No draft transactions to post.");
      return;
    }

    const scopeLabel = scope === "ar" ? "AR " : scope === "ap" ? "AP " : "";

    if (!window.confirm(`Post ${count} draft ${scopeLabel}transaction(s)? This cannot be undone.`)) {
      return;
    }

    setPosting(true);

    try {
      const res = await fetch(`${API_URL}/api/posting/post`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({ scope }),
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.message || "Failed to post transactions.");
        return;
      }

      alert(data.message);
      await loadPending();
    } catch (err) {
      console.error("BULK POST ERROR:", err);
      alert("Unable to connect to server.");
    } finally {
      setPosting(false);
    }
  }

  const arCount = rows.filter((r) => AR_TYPES.includes(r.sourceType)).length;
  const apCount = rows.filter((r) => AP_TYPES.includes(r.sourceType)).length;

  return (
    <div className="posting-page">
      <div className="posting-header">
        <h1>Posting</h1>
        <p>Finalize draft transactions so they reflect in reports and the ledger.</p>
      </div>

      <div className="posting-card">
        <div className="posting-actions">
          <button
            className="posting-btn posting-btn-primary"
            onClick={() => postScope("all")}
            disabled={posting || loading || rows.length === 0}
          >
            {posting ? "Posting..." : `Post All (${rows.length})`}
          </button>

          <button
            className="posting-btn"
            onClick={() => postScope("ar")}
            disabled={posting || loading || arCount === 0}
          >
            AR Posting ({arCount})
          </button>

          <button
            className="posting-btn"
            onClick={() => postScope("ap")}
            disabled={posting || loading || apCount === 0}
          >
            AP Posting ({apCount})
          </button>

          <button className="posting-btn posting-btn-secondary" onClick={loadPending} disabled={loading}>
            Refresh
          </button>
        </div>

        <div className="posting-table-container">
          <table className="posting-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Voucher No.</th>
                <th>Date</th>
                <th>Party</th>
                <th className="text-right">Amount</th>
                <th>Status</th>
              </tr>
            </thead>

            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="6" className="posting-empty">Loading...</td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan="6" className="posting-empty">No draft transactions to post.</td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={`${row.sourceType}-${row.id}`}>
                    <td>
                      <span className="posting-type-badge">{TYPE_LABELS[row.sourceType] || row.sourceType}</span>
                    </td>
                    <td>{row.voucherNo}</td>
                    <td>{row.transactionDate}</td>
                    <td>{row.party}</td>
                    <td className="text-right">₱ {formatMoney(row.amount)}</td>
                    <td>{row.status}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
