import { Fragment, useEffect, useState } from "react";
import { formatCurrency } from "../utils/currencyFormat";
import "../pages/FILESETUP/CurrencySetup.css";

const API_BASE = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function formatRate(rate) {
  if (rate === null || rate === undefined) return "—";
  // Trim trailing zeros past 2dp without losing real precision (a rate of
  // 57.25 shouldn't print as 57.2500000000).
  return Number(rate).toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
}

const RATE_BASIS_LABELS = {
  AM_WEIGHTED_AVERAGE: "AM Weighted Average",
  PM_WEIGHTED_AVERAGE: "PM Weighted Average",
  DAILY_WEIGHTED_AVERAGE: "Daily Weighted Average",
  FX_SETTLEMENT_RATE: "FX Settlement Rate",
  DAILY_REFERENCE_RATE: "Daily Reference Rate",
  PHP_CROSS_RATE: "PHP Cross Rate",
  MONTHLY_AVERAGE: "Monthly Average",
  ANNUAL_AVERAGE: "Annual Average",
};

const STATUS_LABELS = {
  INDICATIVE: "Indicative",
  PROVISIONAL: "Provisional",
  FINAL: "Final",
  APPROVED: "Approved",
  STALE: "Stale",
  FAILED: "Failed",
  MANUAL: "Manual",
  FIXED: "Fixed",
};

export default function CurrencyRateHistoryModal({ currency, canSetRate, canEnterOfficial, canImport, canRefresh, onClose, onRateChanged }) {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState("quick"); // quick | official | import

  // Quick manual/fixed rate (Phase 1 behavior, unchanged)
  const [rateMode, setRateMode] = useState(currency.defaultRateMode === "FIXED" ? "FIXED" : "MANUAL");
  const [rate, setRate] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(new Date().toISOString().split("T")[0]);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  // Official rate entry (Phase 2 section 24) - source is BAP/BSP but
  // entry method is manual, recorded distinctly from an automated fetch.
  const [officialProvider, setOfficialProvider] = useState("BAP");
  const [officialBasis, setOfficialBasis] = useState("DAILY_WEIGHTED_AVERAGE");
  const [officialRate, setOfficialRate] = useState("");
  const [officialDate, setOfficialDate] = useState(new Date().toISOString().split("T")[0]);
  const [officialReference, setOfficialReference] = useState("");
  const [officialError, setOfficialError] = useState("");
  const [officialSaving, setOfficialSaving] = useState(false);

  // Official file import (Phase 2 section 23)
  const [importFile, setImportFile] = useState(null);
  const [importPreview, setImportPreview] = useState(null);
  const [importError, setImportError] = useState("");
  const [importBusy, setImportBusy] = useState(false);

  const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState(null);
  const [expandedDerivation, setExpandedDerivation] = useState({}); // rateId -> components[]

  useEffect(() => {
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currency.id]);

  async function loadHistory() {
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetch(`${API_BASE}/api/currencies/${currency.id}/rate-history`, { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) {
        setLoadError(data.message || "Failed to load rate history.");
        return;
      }
      setHistory(data);
    } catch (err) {
      console.error("LOAD RATE HISTORY ERROR:", err);
      setLoadError("Unable to connect to server.");
    } finally {
      setLoading(false);
    }
  }

  async function handleRecordRate() {
    setFormError("");
    const numeric = Number(rate);
    if (rate === "" || Number.isNaN(numeric)) return setFormError("Exchange rate must be a valid number.");
    if (numeric <= 0) return setFormError("Exchange rate must be greater than zero.");
    if (!effectiveDate) return setFormError("Effective date is required.");

    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/currencies/${currency.id}/rates`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ rateMode, rate: numeric, effectiveDate, reason: reason || undefined }),
      });
      const data = await res.json();
      if (!res.ok) return setFormError(data.message || "Failed to record exchange rate.");
      setRate("");
      setReason("");
      await loadHistory();
      onRateChanged?.();
    } catch (err) {
      console.error("RECORD RATE ERROR:", err);
      setFormError("Unable to connect to server.");
    } finally {
      setSaving(false);
    }
  }

  async function handleOfficialEntry() {
    setOfficialError("");
    const numeric = Number(officialRate);
    if (officialRate === "" || Number.isNaN(numeric)) return setOfficialError("Rate must be a valid number.");
    if (numeric <= 0) return setOfficialError("Rate must be greater than zero.");
    if (!officialDate) return setOfficialError("Effective date is required.");

    setOfficialSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/exchange-rates/official-rate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          currencyId: currency.id,
          provider: officialProvider,
          rateBasis: officialBasis,
          rate: numeric,
          effectiveDate: officialDate,
          sourceReference: officialReference || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) return setOfficialError(data.message || "Failed to record official rate.");
      setOfficialRate("");
      setOfficialReference("");
      await loadHistory();
      onRateChanged?.();
    } catch (err) {
      console.error("OFFICIAL RATE ENTRY ERROR:", err);
      setOfficialError("Unable to connect to server.");
    } finally {
      setOfficialSaving(false);
    }
  }

  async function handleImportPreview() {
    if (!importFile) return setImportError("Choose a CSV or Excel file first.");
    setImportError("");
    setImportBusy(true);
    try {
      const form = new FormData();
      form.append("file", importFile);
      form.append("currencyId", currency.id);
      const res = await fetch(`${API_BASE}/api/exchange-rates/import/preview`, {
        method: "POST",
        headers: authHeaders(),
        body: form,
      });
      const data = await res.json();
      if (!res.ok) return setImportError(data.message || "Failed to parse file.");
      setImportPreview(data);
    } catch (err) {
      console.error("IMPORT PREVIEW ERROR:", err);
      setImportError("Unable to connect to server.");
    } finally {
      setImportBusy(false);
    }
  }

  async function handleImportConfirm() {
    if (!importPreview) return;
    setImportBusy(true);
    setImportError("");
    try {
      const res = await fetch(`${API_BASE}/api/exchange-rates/import/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ companyId: importPreview.companyId, rows: importPreview.rows.filter((r) => r.validationStatus === "VALID") }),
      });
      const data = await res.json();
      if (!res.ok) return setImportError(data.message || "Failed to import rates.");
      setImportPreview(null);
      setImportFile(null);
      await loadHistory();
      onRateChanged?.();
    } catch (err) {
      console.error("IMPORT CONFIRM ERROR:", err);
      setImportError("Unable to connect to server.");
    } finally {
      setImportBusy(false);
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    setRefreshMessage(null);
    try {
      const res = await fetch(`${API_BASE}/api/exchange-rates/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ currencyId: currency.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRefreshMessage({ type: "error", text: data.message || "Refresh failed." });
        return;
      }
      if (data.stored) {
        setRefreshMessage({ type: "success", text: `Updated from ${data.provider}: 1 ${currency.currencyCode} = ${formatRate(data.rate)}.` });
        await loadHistory();
        onRateChanged?.();
      } else {
        setRefreshMessage({
          type: "info",
          text: data.errorMessage || `No new rate available from ${data.provider || "any provider"} - using the last approved rate.`,
        });
      }
    } catch (err) {
      console.error("REFRESH RATE ERROR:", err);
      setRefreshMessage({ type: "error", text: "Unable to connect to server." });
    } finally {
      setRefreshing(false);
    }
  }

  async function toggleDerivation(rateId) {
    if (expandedDerivation[rateId]) {
      setExpandedDerivation((prev) => ({ ...prev, [rateId]: undefined }));
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/exchange-rates/derivation/${rateId}`, { headers: authHeaders() });
      const data = await res.json();
      setExpandedDerivation((prev) => ({ ...prev, [rateId]: res.ok ? data : [] }));
    } catch {
      setExpandedDerivation((prev) => ({ ...prev, [rateId]: [] }));
    }
  }

  return (
    <div className="cs-overlay" role="dialog" aria-modal="true">
      <div className="cs-modal">
        <div className="cs-modal-header">
          <h2>{currency.currencyCode} Rate Configuration</h2>
          <button className="cs-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        <div className="cs-modal-body">
          {currency.isBaseCurrency ? (
            <div className="cs-banner cs-banner-success">
              {currency.currencyCode} is the base currency. Its exchange rate is always exactly 1 and cannot be changed here.
            </div>
          ) : (
            <>
              <div className="cs-rate-current">
                {currency.currentRate != null ? (
                  <>
                    Current rate: <strong>1 {currency.currencyCode} = {formatRate(currency.currentRate)} (base currency unit)</strong>
                    <span className="cs-rate-example">
                      {" "}— {formatCurrency(1000, currency)} converts to {formatRate(1000 * currency.currentRate)} in the base currency.
                    </span>
                  </>
                ) : (
                  <>No rate has been recorded yet for {currency.currencyCode}.</>
                )}
                {canRefresh && (
                  <button className="fs-btn cs-btn-sm cs-refresh-btn" onClick={handleRefresh} disabled={refreshing}>
                    {refreshing ? "Refreshing…" : "Refresh"}
                  </button>
                )}
              </div>
              {refreshMessage && <div className={`cs-banner cs-banner-${refreshMessage.type}`}>{refreshMessage.text}</div>}

              {(canSetRate || canEnterOfficial || canImport) && (
                <div className="cs-tabs">
                  {canSetRate && <button className={`cs-tab ${tab === "quick" ? "cs-tab-active" : ""}`} onClick={() => setTab("quick")}>Manual / Fixed Rate</button>}
                  {canEnterOfficial && <button className={`cs-tab ${tab === "official" ? "cs-tab-active" : ""}`} onClick={() => setTab("official")}>Enter Official Rate</button>}
                  {canImport && <button className={`cs-tab ${tab === "import" ? "cs-tab-active" : ""}`} onClick={() => setTab("import")}>Import Official Rate</button>}
                </div>
              )}

              {tab === "quick" && canSetRate && (
                <div className="cs-rate-form">
                  {formError && <div className="cs-banner cs-banner-error">{formError}</div>}
                  <div className="fs-grid">
                    <div className="fs-field">
                      <label>Rate Mode</label>
                      <select value={rateMode} onChange={(e) => setRateMode(e.target.value)}>
                        <option value="MANUAL">Manual</option>
                        <option value="FIXED">Fixed</option>
                      </select>
                    </div>
                    <div className="fs-field">
                      <label>Exchange Rate ({currency.currencyCode} → base)</label>
                      <input type="number" step="0.0000000001" min="0" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="57.250000" />
                    </div>
                    <div className="fs-field">
                      <label>Effective Date</label>
                      <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
                    </div>
                    <div className="fs-field">
                      <label>Reason (optional)</label>
                      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Monthly rate update" />
                    </div>
                  </div>
                  <button className="cs-btn-primary cs-rate-submit" onClick={handleRecordRate} disabled={saving}>
                    {saving ? "Saving…" : `Save ${rateMode === "FIXED" ? "Fixed" : "Manual"} Rate`}
                  </button>
                </div>
              )}

              {tab === "official" && canEnterOfficial && (
                <div className="cs-rate-form">
                  <p className="cs-tab-hint">
                    Records an official BAP/BSP rate you looked up yourself. The audit trail marks the source as {officialProvider} but the
                    entry method as Manual - it is never shown as if it were automatically retrieved.
                  </p>
                  {officialError && <div className="cs-banner cs-banner-error">{officialError}</div>}
                  <div className="fs-grid">
                    <div className="fs-field">
                      <label>Source</label>
                      <select value={officialProvider} onChange={(e) => setOfficialProvider(e.target.value)}>
                        <option value="BAP">BAP (Bankers Association of the Philippines)</option>
                        <option value="BSP">BSP (Bangko Sentral ng Pilipinas)</option>
                      </select>
                    </div>
                    <div className="fs-field">
                      <label>Rate Basis</label>
                      <select value={officialBasis} onChange={(e) => setOfficialBasis(e.target.value)}>
                        {(officialProvider === "BAP"
                          ? ["AM_WEIGHTED_AVERAGE", "PM_WEIGHTED_AVERAGE", "DAILY_WEIGHTED_AVERAGE", "FX_SETTLEMENT_RATE"]
                          : ["DAILY_REFERENCE_RATE", "PHP_CROSS_RATE", "MONTHLY_AVERAGE", "ANNUAL_AVERAGE"]
                        ).map((b) => (
                          <option key={b} value={b}>{RATE_BASIS_LABELS[b]}</option>
                        ))}
                      </select>
                    </div>
                    <div className="fs-field">
                      <label>Rate ({currency.currencyCode} → base)</label>
                      <input type="number" step="0.0000000001" min="0" value={officialRate} onChange={(e) => setOfficialRate(e.target.value)} placeholder="57.250000" />
                    </div>
                    <div className="fs-field">
                      <label>Effective Date</label>
                      <input type="date" value={officialDate} onChange={(e) => setOfficialDate(e.target.value)} />
                    </div>
                    <div className="fs-field">
                      <label>Publication Reference (optional)</label>
                      <input value={officialReference} onChange={(e) => setOfficialReference(e.target.value)} placeholder="e.g. RERB bulletin no." />
                    </div>
                  </div>
                  <button className="cs-btn-primary cs-rate-submit" onClick={handleOfficialEntry} disabled={officialSaving}>
                    {officialSaving ? "Saving…" : `Save Official ${officialProvider} Rate`}
                  </button>
                </div>
              )}

              {tab === "import" && canImport && (
                <div className="cs-rate-form">
                  <p className="cs-tab-hint">
                    Upload a CSV or Excel export of official BAP/BSP rates you downloaded yourself. Nothing is saved until you review and confirm the preview.
                  </p>
                  {importError && <div className="cs-banner cs-banner-error">{importError}</div>}
                  <div className="cs-import-row">
                    <input type="file" accept=".csv,.xls,.xlsx" onChange={(e) => { setImportFile(e.target.files?.[0] || null); setImportPreview(null); }} />
                    <button className="fs-btn cs-btn-sm" onClick={handleImportPreview} disabled={importBusy || !importFile}>
                      {importBusy ? "Parsing…" : "Preview"}
                    </button>
                  </div>

                  {importPreview && (
                    <>
                      <table className="fs-table cs-history-table cs-import-preview">
                        <thead>
                          <tr>
                            <th>Pair</th><th>Rate</th><th>Basis</th><th>Effective</th><th>Source</th><th>Existing</th><th>New</th><th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {importPreview.rows.map((r, idx) => (
                            <tr key={idx} className={r.validationStatus === "INVALID" ? "cs-row-invalid" : ""}>
                              <td>{r.currencyPair}</td>
                              <td>{formatRate(r.rate)}</td>
                              <td>{r.rateType || "—"}</td>
                              <td>{r.effectiveDate || "—"}</td>
                              <td>{r.source || "—"}</td>
                              <td>{formatRate(r.existingRate)}</td>
                              <td>{formatRate(r.newRate)}</td>
                              <td title={r.validationMessages.join(" ")}>{r.validationStatus}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div className="cs-import-summary">{importPreview.validCount} of {importPreview.totalCount} rows valid.</div>
                      <button className="cs-btn-primary cs-rate-submit" onClick={handleImportConfirm} disabled={importBusy || importPreview.validCount === 0}>
                        {importBusy ? "Importing…" : `Confirm Import (${importPreview.validCount})`}
                      </button>
                    </>
                  )}
                </div>
              )}

              {!canSetRate && !canEnterOfficial && !canImport && (
                <div className="cs-banner cs-banner-info">You do not have permission to change exchange rates.</div>
              )}
            </>
          )}

          <h3 className="cs-history-title">Rate History</h3>
          {loading ? (
            <div className="fs-empty">Loading history…</div>
          ) : loadError ? (
            <div className="fs-empty cs-error-text">{loadError}</div>
          ) : history.length === 0 ? (
            <div className="fs-empty">No rate changes recorded yet.</div>
          ) : (
            <table className="fs-table cs-history-table">
              <thead>
                <tr>
                  <th>Effective Date</th>
                  <th>Source</th>
                  <th>Basis</th>
                  <th>Old Rate</th>
                  <th>New Rate</th>
                  <th>Status</th>
                  <th>Ingestion</th>
                  <th>Changed By</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <Fragment key={h.id}>
                    <tr>
                      <td>{h.effectiveDate}</td>
                      <td>{h.provider || h.rateMode}</td>
                      <td>{RATE_BASIS_LABELS[h.rateBasis] || h.providerRateDescription || "—"}</td>
                      <td>{formatRate(h.oldRate)}</td>
                      <td>{formatRate(h.newRate)}</td>
                      <td>{STATUS_LABELS[h.status] || h.status || "—"}</td>
                      <td>
                        {h.ingestionMethod || "—"}
                        {h.derivationMethod === "CROSS_VIA_USD" && (
                          <button className="cs-derivation-link" onClick={() => toggleDerivation(h.id)}>
                            {expandedDerivation[h.id] ? "hide derivation" : "view derivation"}
                          </button>
                        )}
                      </td>
                      <td>{h.createdByUsername || "—"}</td>
                      <td>{h.reason || "—"}</td>
                    </tr>
                    {expandedDerivation[h.id] && (
                      <tr key={`${h.id}-derivation`}>
                        <td colSpan={9} className="cs-derivation-detail">
                          {expandedDerivation[h.id].length === 0 ? (
                            "No derivation components stored."
                          ) : (
                            <ul>
                              {expandedDerivation[h.id].map((c) => (
                                <li key={c.id}>
                                  {c.currencyPair}: {formatRate(c.rate)} (source: {c.provider}{c.rateBasis ? `, ${RATE_BASIS_LABELS[c.rateBasis] || c.rateBasis}` : ""}, effective {c.effectiveDate})
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="cs-modal-footer">
          <button className="cs-btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
