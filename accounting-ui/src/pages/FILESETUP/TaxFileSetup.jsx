import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import { DEFAULT_VAT_RATE } from "../../utils/vatCalculations";
import { computeEwtSummary } from "../../utils/ewtSummary.mjs";
import "./FileSetupPages.css";

const API_BASE = import.meta.env.VITE_API_URL || "";

// Phase 6A: Tax File Setup is a management hub, not a second source of
// truth. EWT configuration lives only in ewt_library (EWT Library page) -
// this page fetches the same GET /api/ewt-library EWT Library itself uses,
// derives counts from it, and never writes. VAT has no catalog yet, so its
// panel is purely informational, sourced from the one existing
// DEFAULT_VAT_RATE constant rather than a new duplicate.
export default function TaxFileSetup() {
  const navigate = useNavigate();
  const [ewtSummary, setEwtSummary] = useState(null);
  const [ewtLoading, setEwtLoading] = useState(true);
  const [ewtError, setEwtError] = useState("");

  useEffect(() => {
    loadEwtSummary();
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
        <h2 className="tax-hub-card-title">VAT Configuration</h2>
        <ul className="tax-hub-info-list">
          <li>Current VAT default: {DEFAULT_VAT_RATE}%</li>
          <li>VAT rate is currently entered/overridden per transaction entry.</li>
          <li>No centralized VAT rate catalog exists yet.</li>
        </ul>
        <p className="tax-hub-status-note">
          Future VAT Rate Setup can be added as a separate configuration module once accounting requirements are approved.
        </p>
      </div>
    </div>
  );
}
