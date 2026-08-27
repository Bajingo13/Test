import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import { computeEwtSummary } from "../../utils/ewtSummary.mjs";
import "./FileSetupPages.css";

const API_BASE = import.meta.env.VITE_API_URL || "";

// Phase 6A/6D: Tax File Setup is a management hub, not a second source of
// truth. EWT configuration lives only in ewt_library (EWT Library page);
// VAT rate configuration lives only in vat_rate_codes (VAT Rate Library
// page, Phase 6D). This page fetches the same GET endpoints those pages
// themselves use, derives counts, and never writes.
//
// computeEwtSummary() is a plain total/active/inactive-by-status counter
// with no EWT-specific logic inside it (see utils/ewtSummary.mjs) - reused
// here for VAT counts too rather than duplicating the same three lines
// under a new name, per the Phase 6C recommendation to reuse the same
// pure-summary architecture.
export default function TaxFileSetup() {
  const navigate = useNavigate();

  const [ewtSummary, setEwtSummary] = useState(null);
  const [ewtLoading, setEwtLoading] = useState(true);
  const [ewtError, setEwtError] = useState("");

  const [vatSummary, setVatSummary] = useState(null);
  const [vatLoading, setVatLoading] = useState(true);
  const [vatError, setVatError] = useState("");

  useEffect(() => {
    loadEwtSummary();
    loadVatSummary();
  }, []);

  async function loadEwtSummary() {
    try {
      setEwtLoading(true);
      setEwtError("");

      const res = await fetch(`${API_BASE}/api/ewt-library`, {
        credentials: "include",
        headers: authHeaders(),
      });
      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        setEwtError(data.message || "Unable to load EWT summary.");
        return;
      }

      setEwtSummary(computeEwtSummary(data));
    } catch (err) {
      console.error("LOAD EWT SUMMARY ERROR:", err);
      setEwtError("Unable to connect to server.");
    } finally {
      setEwtLoading(false);
    }
  }

  async function loadVatSummary() {
    try {
      setVatLoading(true);
      setVatError("");

      const res = await fetch(`${API_BASE}/api/vat-rate-codes`, {
        credentials: "include",
        headers: authHeaders(),
      });
      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        setVatError(data.message || "Unable to load VAT Rate Library summary.");
        return;
      }

      setVatSummary(computeEwtSummary(data));
    } catch (err) {
      console.error("LOAD VAT RATE LIBRARY SUMMARY ERROR:", err);
      setVatError("Unable to connect to server.");
    } finally {
      setVatLoading(false);
    }
  }

  return (
    <div className="fs-page">
      <div className="fs-header">
        <div>
          <h1>Tax File Setup</h1>
          <p>Overview of the system's tax configuration and where to manage it.</p>
        </div>
      </div>

      <div className="fs-card tax-hub-card">
        <h2 className="tax-hub-card-title">EWT Library</h2>
        <p className="tax-hub-card-subtitle">
          Expanded Withholding Tax ATC codes are managed entirely in EWT Library - this is a summary, not a copy.
        </p>

        {ewtLoading && <div className="tax-hub-status-note">Loading EWT summary...</div>}

        {!ewtLoading && ewtError && (
          <div className="tax-hub-status-note tax-hub-status-error">{ewtError}</div>
        )}

        {!ewtLoading && !ewtError && ewtSummary && (
          <div className="tax-hub-stat-grid">
            <div className="tax-hub-stat">
              <span className="tax-hub-stat-value">{ewtSummary.total}</span>
              <span className="tax-hub-stat-label">Total Codes</span>
            </div>
            <div className="tax-hub-stat">
              <span className="tax-hub-stat-value">{ewtSummary.active}</span>
              <span className="tax-hub-stat-label">Active</span>
            </div>
            <div className="tax-hub-stat">
              <span className="tax-hub-stat-value">{ewtSummary.inactive}</span>
              <span className="tax-hub-stat-label">Inactive</span>
            </div>
          </div>
        )}

        <button type="button" className="fs-btn primary" onClick={() => navigate("/ewt-library")}>
          Open EWT Library
        </button>
      </div>

      <div className="fs-card tax-hub-card">
        <h2 className="tax-hub-card-title">VAT Rate Library</h2>
        <p className="tax-hub-card-subtitle">
          Reference VAT codes and rates are managed entirely in VAT Rate Library - this is a summary, not a copy.
        </p>

        {vatLoading && <div className="tax-hub-status-note">Loading VAT Rate Library summary...</div>}

        {!vatLoading && vatError && (
          <div className="tax-hub-status-note tax-hub-status-error">{vatError}</div>
        )}

        {!vatLoading && !vatError && vatSummary && (
          <div className="tax-hub-stat-grid">
            <div className="tax-hub-stat">
              <span className="tax-hub-stat-value">{vatSummary.total}</span>
              <span className="tax-hub-stat-label">Total Codes</span>
            </div>
            <div className="tax-hub-stat">
              <span className="tax-hub-stat-value">{vatSummary.active}</span>
              <span className="tax-hub-stat-label">Active</span>
            </div>
            <div className="tax-hub-stat">
              <span className="tax-hub-stat-value">{vatSummary.inactive}</span>
              <span className="tax-hub-stat-label">Inactive</span>
            </div>
          </div>
        )}

        <button type="button" className="fs-btn primary" onClick={() => navigate("/vat-rate-library")}>
          Open VAT Rate Library
        </button>
      </div>
    </div>
  );
}
