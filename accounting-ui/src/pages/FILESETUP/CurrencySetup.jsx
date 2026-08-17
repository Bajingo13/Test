import { useEffect, useMemo, useState } from "react";
import usePermissions from "../../hooks/usePermissions";
import CurrencyRateHistoryModal from "../../components/CurrencyRateHistoryModal";
import { formatCurrency } from "../../utils/currencyFormat";
import "./FileSetupPages.css";
import "./CurrencySetup.css";

const API_BASE = import.meta.env.VITE_API_URL || "";
const MODULE_KEY = "FILESETUP.CURRENCY_SETUP";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Convenience presets only - the Currency Code field accepts any 3-letter
// ISO 4217 code, not limited to this list (per spec: "Do NOT limit the
// system to this list. The design should support additional ISO
// currencies.").
const COMMON_CURRENCIES = [
  { code: "PHP", name: "Philippine Peso", symbol: "₱", decimals: 2 },
  { code: "USD", name: "US Dollar", symbol: "$", decimals: 2 },
  { code: "JPY", name: "Japanese Yen", symbol: "¥", decimals: 0 },
  { code: "EUR", name: "Euro", symbol: "€", decimals: 2 },
  { code: "GBP", name: "British Pound", symbol: "£", decimals: 2 },
  { code: "AUD", name: "Australian Dollar", symbol: "A$", decimals: 2 },
  { code: "CAD", name: "Canadian Dollar", symbol: "C$", decimals: 2 },
  { code: "SGD", name: "Singapore Dollar", symbol: "S$", decimals: 2 },
  { code: "CNY", name: "Chinese Yuan", symbol: "¥", decimals: 2 },
  { code: "HKD", name: "Hong Kong Dollar", symbol: "HK$", decimals: 2 },
  { code: "CHF", name: "Swiss Franc", symbol: "CHF", decimals: 2 },
  { code: "KRW", name: "South Korean Won", symbol: "₩", decimals: 0 },
  { code: "THB", name: "Thai Baht", symbol: "฿", decimals: 2 },
  { code: "MYR", name: "Malaysian Ringgit", symbol: "RM", decimals: 2 },
];

const RATE_MODE_LABELS = {
  BASE: "Base",
  MANUAL: "Manual",
  FIXED: "Fixed",
  AUTOMATIC: "Automatic (coming soon)",
  DAILY: "Daily (coming soon)",
  TRANSACTION_SPECIFIC: "Transaction-Specific",
};

// AUTOMATIC/DAILY are selectable as a currency's intended future mode
// (catalog-only, per spec: "may appear as future-supported modes only if
// that does not confuse users") but Phase 1 never makes a live rate call
// for them - only MANUAL/FIXED rates can actually be recorded.
const RATE_MODE_OPTIONS = ["MANUAL", "FIXED", "AUTOMATIC", "DAILY", "TRANSACTION_SPECIFIC"];

const EMPTY_FORM = {
  id: null,
  currencyCode: "",
  currencyName: "",
  currencySymbol: "",
  isoNumericCode: "",
  decimalPlaces: 2,
  symbolPosition: "BEFORE",
  spaceAfterSymbol: false,
  decimalSeparator: ".",
  thousandSeparator: ",",
  defaultRateMode: "MANUAL",
  isActive: true,
  notes: "",
};

export default function CurrencySetup() {
  const { can, loading: permsLoading } = usePermissions();

  const [currencies, setCurrencies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [banner, setBanner] = useState(null); // { type: "success" | "error", message }

  const [showFormModal, setShowFormModal] = useState(false);
  const [formMode, setFormMode] = useState("add");
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  const [rateModalCurrency, setRateModalCurrency] = useState(null);
  const [confirmAction, setConfirmAction] = useState(null); // { type, currency }
  const [confirmBusy, setConfirmBusy] = useState(false);

  const [refreshAllBusy, setRefreshAllBusy] = useState(false);
  const [refreshAllResults, setRefreshAllResults] = useState(null);
  const [showProviderPanel, setShowProviderPanel] = useState(false);
  const [providerStatus, setProviderStatus] = useState(null);
  const [providerStatusLoading, setProviderStatusLoading] = useState(false);

  // Checkpoint 3FX: company-level Realized FX Gain/Loss account config.
  const [showFxPanel, setShowFxPanel] = useState(false);
  const [fxAccounts, setFxAccounts] = useState(null);
  const [fxAccountsLoading, setFxAccountsLoading] = useState(false);
  const [fxAccountOptions, setFxAccountOptions] = useState([]);
  const [fxGainSelection, setFxGainSelection] = useState("");
  const [fxLossSelection, setFxLossSelection] = useState("");
  // Checkpoint 4: separate, explicitly-configured Unrealized FX accounts -
  // never silently reuses the Realized accounts above.
  const [unrealizedGainSelection, setUnrealizedGainSelection] = useState("");
  const [unrealizedLossSelection, setUnrealizedLossSelection] = useState("");
  const [fxSaving, setFxSaving] = useState(false);

  useEffect(() => {
    loadCurrencies();
  }, []);

  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner(null), 5000);
    return () => clearTimeout(t);
  }, [banner]);

  async function loadCurrencies({ silent = false } = {}) {
    silent ? setRefreshing(true) : setLoading(true);
    setLoadError("");
    try {
      const res = await fetch(`${API_BASE}/api/currencies`, { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) {
        setLoadError(data.message || "Failed to load currencies.");
        return;
      }
      setCurrencies(data);
    } catch (err) {
      console.error("LOAD CURRENCIES ERROR:", err);
      setLoadError("Unable to connect to server.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  const sortedCurrencies = useMemo(
    () => [...currencies].sort((a, b) => (b.isBaseCurrency - a.isBaseCurrency) || a.currencyCode.localeCompare(b.currencyCode)),
    [currencies]
  );

  function openAdd() {
    setForm(EMPTY_FORM);
    setFormMode("add");
    setFormError("");
    setShowFormModal(true);
  }

  function openEdit(currency) {
    setForm({
      id: currency.id,
      currencyCode: currency.currencyCode,
      currencyName: currency.currencyName,
      currencySymbol: currency.currencySymbol,
      isoNumericCode: currency.isoNumericCode || "",
      decimalPlaces: currency.decimalPlaces,
      symbolPosition: currency.symbolPosition,
      spaceAfterSymbol: currency.spaceAfterSymbol,
      decimalSeparator: currency.decimalSeparator,
      thousandSeparator: currency.thousandSeparator,
      defaultRateMode: currency.defaultRateMode,
      isActive: currency.isActive,
      notes: currency.notes || "",
    });
    setFormMode("edit");
    setFormError("");
    setShowFormModal(true);
  }

  function applyPreset(code) {
    const preset = COMMON_CURRENCIES.find((c) => c.code === code);
    setForm((prev) => ({
      ...prev,
      currencyCode: code,
      currencyName: preset ? preset.name : prev.currencyName,
      currencySymbol: preset ? preset.symbol : prev.currencySymbol,
      decimalPlaces: preset ? preset.decimals : prev.decimalPlaces,
    }));
  }

  function updateField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    if (!form.currencyCode.trim() || !form.currencyName.trim() || !form.currencySymbol.trim()) {
      setFormError("Currency Code, Currency Name, and Currency Symbol are required.");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      const url = formMode === "add" ? `${API_BASE}/api/currencies` : `${API_BASE}/api/currencies/${form.id}`;
      const method = formMode === "add" ? "POST" : "PUT";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) {
        setFormError(data.message || "Failed to save currency.");
        return;
      }
      setShowFormModal(false);
      setBanner({ type: "success", message: `${data.currencyCode} ${formMode === "add" ? "created" : "updated"} successfully.` });
      await loadCurrencies({ silent: true });
    } catch (err) {
      console.error("SAVE CURRENCY ERROR:", err);
      setFormError("Unable to connect to server.");
    } finally {
      setSaving(false);
    }
  }

  function requestStatusChange(currency, isActive) {
    if (!isActive) {
      setConfirmAction({ type: "deactivate", currency });
      return;
    }
    performStatusChange(currency, true);
  }

  async function performStatusChange(currency, isActive) {
    setConfirmBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/currencies/${currency.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ isActive }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBanner({ type: "error", message: data.message || "Failed to update currency status." });
        return;
      }
      setBanner({ type: "success", message: `${currency.currencyCode} ${isActive ? "activated" : "deactivated"}.` });
      await loadCurrencies({ silent: true });
    } catch (err) {
      console.error("UPDATE STATUS ERROR:", err);
      setBanner({ type: "error", message: "Unable to connect to server." });
    } finally {
      setConfirmBusy(false);
      setConfirmAction(null);
    }
  }

  function requestSetBase(currency) {
    setConfirmAction({ type: "set-base", currency });
  }

  async function performSetBase(currency) {
    setConfirmBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/currencies/${currency.id}/set-base`, {
        method: "POST",
        headers: authHeaders(),
      });
      const data = await res.json();
      if (!res.ok) {
        setBanner({ type: "error", message: data.message || "Failed to set base currency." });
        return;
      }
      setBanner({ type: "success", message: `${currency.currencyCode} has been set as the base currency.` });
      await loadCurrencies({ silent: true });
    } catch (err) {
      console.error("SET BASE CURRENCY ERROR:", err);
      setBanner({ type: "error", message: "Unable to connect to server." });
    } finally {
      setConfirmBusy(false);
      setConfirmAction(null);
    }
  }

  async function handleRefreshAll() {
    setRefreshAllBusy(true);
    setRefreshAllResults(null);
    try {
      const res = await fetch(`${API_BASE}/api/exchange-rates/refresh-all`, { method: "POST", headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) {
        setBanner({ type: "error", message: data.message || "Failed to refresh rates." });
        return;
      }
      setRefreshAllResults(data.results);
      const updatedCount = data.results.filter((r) => r.stored).length;
      setBanner({ type: updatedCount ? "success" : "info", message: `Refresh complete: ${updatedCount} of ${data.results.length} currencies updated.` });
      await loadCurrencies({ silent: true });
    } catch (err) {
      console.error("REFRESH ALL ERROR:", err);
      setBanner({ type: "error", message: "Unable to connect to server." });
    } finally {
      setRefreshAllBusy(false);
    }
  }

  async function loadProviderStatus() {
    setProviderStatusLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/exchange-rates/provider-status`, { headers: authHeaders() });
      const data = await res.json();
      if (res.ok) setProviderStatus(data);
    } catch (err) {
      console.error("LOAD PROVIDER STATUS ERROR:", err);
    } finally {
      setProviderStatusLoading(false);
    }
  }

  async function loadFxAccounts() {
    setFxAccountsLoading(true);
    try {
      const [fxRes, coaRes] = await Promise.all([
        fetch(`${API_BASE}/api/currencies/fx-accounts`, { headers: authHeaders() }),
        fetch(`${API_BASE}/api/coa`, { headers: authHeaders() }),
      ]);
      const fxData = await fxRes.json();
      const coaData = await coaRes.json();
      if (fxRes.ok) {
        setFxAccounts(fxData);
        setFxGainSelection(fxData.gainAccountId ? String(fxData.gainAccountId) : "");
        setFxLossSelection(fxData.lossAccountId ? String(fxData.lossAccountId) : "");
        setUnrealizedGainSelection(fxData.unrealizedGainAccountId ? String(fxData.unrealizedGainAccountId) : "");
        setUnrealizedLossSelection(fxData.unrealizedLossAccountId ? String(fxData.unrealizedLossAccountId) : "");
      }
      if (coaRes.ok) setFxAccountOptions(Array.isArray(coaData) ? coaData : coaData.rows || []);
    } catch (err) {
      console.error("LOAD FX ACCOUNTS ERROR:", err);
    } finally {
      setFxAccountsLoading(false);
    }
  }

  async function handleSaveFxAccounts() {
    setFxSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/currencies/fx-accounts`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          companyId: fxAccounts?.companyId,
          gainAccountId: fxGainSelection || null,
          lossAccountId: fxLossSelection || null,
          unrealizedGainAccountId: unrealizedGainSelection || null,
          unrealizedLossAccountId: unrealizedLossSelection || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBanner({ type: "error", message: data.message || "Failed to save FX account configuration." });
        return;
      }
      setFxAccounts(data);
      setBanner({ type: "success", message: "FX account configuration saved." });
    } catch (err) {
      console.error("SAVE FX ACCOUNTS ERROR:", err);
      setBanner({ type: "error", message: "Unable to connect to server." });
    } finally {
      setFxSaving(false);
    }
  }

  const canView = permsLoading || can(MODULE_KEY, "VIEW");
  const canCreate = can(MODULE_KEY, "CREATE");
  const canEdit = can(MODULE_KEY, "EDIT");
  const canActivate = can(MODULE_KEY, "ACTIVATE");
  const canDeactivate = can(MODULE_KEY, "DEACTIVATE");
  const canSetBase = can(MODULE_KEY, "SET_BASE");
  const canViewRates = can(MODULE_KEY, "RATE_HISTORY");
  const canRefreshAll = can(MODULE_KEY, "REFRESH_RATE");
  const canViewProviderStatus = can(MODULE_KEY, "VIEW_PROVIDER_STATUS");
  const canConfigureFxAccounts = can(MODULE_KEY, "CONFIGURE_FX_ACCOUNTS");

  if (!canView) {
    return (
      <div className="fs-page">
        <div className="fs-card">You do not have permission to view Currency Setup.</div>
      </div>
    );
  }

  return (
    <div className="fs-page">
      <div className="fs-header">
        <div>
          <h1>Currency Setup</h1>
          <p>Configure the currencies available throughout the accounting system.</p>
        </div>
        <div className="cs-header-actions">
          {canViewProviderStatus && (
            <button
              className="fs-btn"
              onClick={() => {
                setShowProviderPanel((v) => !v);
                if (!providerStatus) loadProviderStatus();
              }}
            >
              Provider Status
            </button>
          )}
          {canRefreshAll && (
            <button className="fs-btn" onClick={handleRefreshAll} disabled={refreshAllBusy}>
              {refreshAllBusy ? "Refreshing…" : "Refresh Rates"}
            </button>
          )}
          <button
            className="fs-btn"
            onClick={() => {
              setShowFxPanel((v) => !v);
              if (!fxAccounts) loadFxAccounts();
            }}
          >
            FX Accounting
          </button>
          {canCreate && (
            <button className="fs-btn primary" onClick={openAdd}>
              + Add Currency
            </button>
          )}
        </div>
      </div>

      {banner && <div className={`cs-banner cs-banner-${banner.type}`}>{banner.message}</div>}

      {showFxPanel && (
        <div className="fs-card cs-provider-panel">
          <h2>FX Accounting</h2>
          <p>
            Which Chart of Accounts entries realized foreign exchange gains and losses post to when an OR/CV
            settles a foreign-currency Invoice/APV at a different rate than the original document.
          </p>
          {fxAccountsLoading ? (
            <div className="fs-empty">Loading…</div>
          ) : !fxAccounts ? (
            <div className="fs-empty">Unable to load FX account configuration.</div>
          ) : (
            <>
              <div className="fs-grid">
                <div className="fs-field">
                  <label>Realized FX Gain Account</label>
                  <select
                    value={fxGainSelection}
                    onChange={(e) => setFxGainSelection(e.target.value)}
                    disabled={!canConfigureFxAccounts}
                  >
                    <option value="">Not configured</option>
                    {fxAccountOptions.map((a) => (
                      <option key={a.id} value={a.id}>{a.code} — {a.title}</option>
                    ))}
                  </select>
                </div>
                <div className="fs-field">
                  <label>Realized FX Loss Account</label>
                  <select
                    value={fxLossSelection}
                    onChange={(e) => setFxLossSelection(e.target.value)}
                    disabled={!canConfigureFxAccounts}
                  >
                    <option value="">Not configured</option>
                    {fxAccountOptions.map((a) => (
                      <option key={a.id} value={a.id}>{a.code} — {a.title}</option>
                    ))}
                  </select>
                </div>
              </div>
              {!fxAccounts.gainAccountId && !fxAccounts.lossAccountId && (
                <p className="cs-error-text">
                  Neither account is configured yet - foreign-currency settlements can still post at the SAME rate
                  as their source document, but a different-rate settlement will be blocked until these are set.
                </p>
              )}

              <h3 style={{ marginTop: 18 }}>Unrealized FX (Month-End Revaluation)</h3>
              <p>
                Which Chart of Accounts entries month-end unrealized FX revaluation adjustments post to. Separate
                from the Realized accounts above - never reused automatically.
              </p>
              <div className="fs-grid">
                <div className="fs-field">
                  <label>Unrealized FX Gain Account</label>
                  <select
                    value={unrealizedGainSelection}
                    onChange={(e) => setUnrealizedGainSelection(e.target.value)}
                    disabled={!canConfigureFxAccounts}
                  >
                    <option value="">Not configured</option>
                    {fxAccountOptions.map((a) => (
                      <option key={a.id} value={a.id}>{a.code} — {a.title}</option>
                    ))}
                  </select>
                </div>
                <div className="fs-field">
                  <label>Unrealized FX Loss Account</label>
                  <select
                    value={unrealizedLossSelection}
                    onChange={(e) => setUnrealizedLossSelection(e.target.value)}
                    disabled={!canConfigureFxAccounts}
                  >
                    <option value="">Not configured</option>
                    {fxAccountOptions.map((a) => (
                      <option key={a.id} value={a.id}>{a.code} — {a.title}</option>
                    ))}
                  </select>
                </div>
              </div>
              {!fxAccounts.unrealizedGainAccountId && !fxAccounts.unrealizedLossAccountId && (
                <p className="cs-error-text">
                  Neither account is configured yet - Month-End FX Revaluation cannot post an unrealized gain/loss
                  until these are set.
                </p>
              )}

              {canConfigureFxAccounts && (
                <div className="cs-modal-footer" style={{ padding: "12px 0 0" }}>
                  <button className="cs-btn-primary" onClick={handleSaveFxAccounts} disabled={fxSaving}>
                    {fxSaving ? "Saving…" : "Save FX Accounts"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {showProviderPanel && (
        <div className="fs-card cs-provider-panel">
          <h2>Provider Status</h2>
          {providerStatusLoading ? (
            <div className="fs-empty">Loading…</div>
          ) : !providerStatus ? (
            <div className="fs-empty">Unable to load provider status.</div>
          ) : (
            <div className="cs-provider-grid">
              {Object.entries(providerStatus).map(([code, info]) => (
                <div key={code} className="cs-provider-card">
                  <div className="cs-provider-code">{code}</div>
                  <div className="cs-provider-label">{info.label}</div>
                  <span className={`cs-badge cs-provider-status-${info.status?.toLowerCase()}`}>{info.status}</span>
                  <p className="cs-provider-message">{info.message}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {refreshAllResults && (
        <div className="fs-card cs-refresh-results">
          <h2>Last Refresh Results</h2>
          <ul>
            {refreshAllResults.map((r) => (
              <li key={r.currencyCode}>
                <strong>{r.currencyCode}</strong>: {r.stored ? `Updated from ${r.provider}` : (r.errorMessage || `No update (${r.status})`)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="fs-card">
        <div className="fs-toolbar">
          <div className="cs-toolbar-meta">
            {refreshing && <span className="cs-refreshing">Refreshing…</span>}
          </div>
        </div>

        <table className="fs-table">
          <thead>
            <tr>
              <th>Currency</th>
              <th>Code</th>
              <th>Symbol</th>
              <th>Decimals</th>
              <th>Base</th>
              <th>Rate Mode</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan="8" className="fs-empty">Loading currencies…</td>
              </tr>
            ) : loadError ? (
              <tr>
                <td colSpan="8" className="fs-empty cs-error-text">{loadError}</td>
              </tr>
            ) : sortedCurrencies.length === 0 ? (
              <tr>
                <td colSpan="8" className="fs-empty">No currencies configured yet. Click "+ Add Currency" to get started.</td>
              </tr>
            ) : (
              sortedCurrencies.map((c) => (
                <tr key={c.id}>
                  <td>{c.currencyName}</td>
                  <td>{c.currencyCode}</td>
                  <td>{c.currencySymbol}</td>
                  <td>{c.decimalPlaces}</td>
                  <td>{c.isBaseCurrency ? <span className="cs-badge cs-badge-base">BASE</span> : "—"}</td>
                  <td>{RATE_MODE_LABELS[c.defaultRateMode] || c.defaultRateMode}</td>
                  <td>
                    <span className={`cs-badge ${c.isActive ? "cs-badge-active" : "cs-badge-inactive"}`}>
                      {c.isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="cs-actions-cell">
                    {canEdit && (
                      <button className="fs-btn cs-btn-sm" onClick={() => openEdit(c)}>Edit</button>
                    )}
                    {c.isActive && canDeactivate && !c.isBaseCurrency && (
                      <button className="fs-btn cs-btn-sm" onClick={() => requestStatusChange(c, false)}>Deactivate</button>
                    )}
                    {!c.isActive && canActivate && (
                      <button className="fs-btn cs-btn-sm" onClick={() => requestStatusChange(c, true)}>Activate</button>
                    )}
                    {!c.isBaseCurrency && c.isActive && canSetBase && (
                      <button className="fs-btn cs-btn-sm" onClick={() => requestSetBase(c)}>Set as Base</button>
                    )}
                    {canViewRates && (
                      <button className="fs-btn cs-btn-sm" onClick={() => setRateModalCurrency(c)}>Rates</button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {showFormModal && (
        <div className="cs-overlay" role="dialog" aria-modal="true">
          <div className="cs-modal">
            <div className="cs-modal-header">
              <h2>{formMode === "add" ? "Add Currency" : `Edit ${form.currencyCode}`}</h2>
              <button className="cs-close" onClick={() => setShowFormModal(false)} aria-label="Close">&times;</button>
            </div>

            <div className="cs-modal-body">
              {formError && <div className="cs-banner cs-banner-error">{formError}</div>}

              {formMode === "add" && (
                <div className="fs-field cs-preset-field">
                  <label>Quick Fill (optional)</label>
                  <select onChange={(e) => e.target.value && applyPreset(e.target.value)} defaultValue="">
                    <option value="">Choose a common currency…</option>
                    {COMMON_CURRENCIES.map((c) => (
                      <option key={c.code} value={c.code}>{c.code} — {c.name}</option>
                    ))}
                  </select>
                </div>
              )}

              <div className="fs-grid">
                <div className="fs-field">
                  <label>Currency Code</label>
                  <input
                    value={form.currencyCode}
                    onChange={(e) => updateField("currencyCode", e.target.value.toUpperCase())}
                    placeholder="USD"
                    maxLength={3}
                  />
                </div>
                <div className="fs-field">
                  <label>Currency Name</label>
                  <input
                    value={form.currencyName}
                    onChange={(e) => updateField("currencyName", e.target.value)}
                    placeholder="US Dollar"
                  />
                </div>
                <div className="fs-field">
                  <label>Currency Symbol</label>
                  <input
                    value={form.currencySymbol}
                    onChange={(e) => updateField("currencySymbol", e.target.value)}
                    placeholder="$"
                  />
                </div>
                <div className="fs-field">
                  <label>ISO Numeric Code</label>
                  <input
                    value={form.isoNumericCode}
                    onChange={(e) => updateField("isoNumericCode", e.target.value)}
                    placeholder="840"
                    maxLength={3}
                  />
                </div>
                <div className="fs-field">
                  <label>Decimal Places</label>
                  <input
                    type="number"
                    min="0"
                    max="4"
                    value={form.decimalPlaces}
                    onChange={(e) => updateField("decimalPlaces", Number(e.target.value))}
                  />
                </div>
                <div className="fs-field">
                  <label>Symbol Position</label>
                  <select value={form.symbolPosition} onChange={(e) => updateField("symbolPosition", e.target.value)}>
                    <option value="BEFORE">Before amount ($1,000.00)</option>
                    <option value="AFTER">After amount (1,000.00 €)</option>
                  </select>
                </div>
                <div className="fs-field">
                  <label>Space Between Symbol and Amount</label>
                  <select
                    value={form.spaceAfterSymbol ? "yes" : "no"}
                    onChange={(e) => updateField("spaceAfterSymbol", e.target.value === "yes")}
                  >
                    <option value="no">No ($1,000.00)</option>
                    <option value="yes">Yes ($ 1,000.00)</option>
                  </select>
                </div>
                <div className="fs-field">
                  <label>Decimal Separator</label>
                  <select value={form.decimalSeparator} onChange={(e) => updateField("decimalSeparator", e.target.value)}>
                    <option value=".">Period (.)</option>
                    <option value=",">Comma (,)</option>
                  </select>
                </div>
                <div className="fs-field">
                  <label>Thousands Separator</label>
                  <select value={form.thousandSeparator} onChange={(e) => updateField("thousandSeparator", e.target.value)}>
                    <option value=",">Comma (,)</option>
                    <option value=".">Period (.)</option>
                    <option value=" ">Space</option>
                    <option value="">None</option>
                  </select>
                </div>
                <div className="fs-field">
                  <label title="For a base currency this is fixed to Base and cannot be changed here.">
                    Default Rate Mode
                  </label>
                  <select
                    value={form.defaultRateMode}
                    onChange={(e) => updateField("defaultRateMode", e.target.value)}
                    disabled={formMode === "edit" && form.isActive === undefined}
                  >
                    {RATE_MODE_OPTIONS.map((m) => (
                      <option key={m} value={m}>{RATE_MODE_LABELS[m]}</option>
                    ))}
                  </select>
                </div>
                <div className="fs-field">
                  <label>Active</label>
                  <select value={form.isActive ? "yes" : "no"} onChange={(e) => updateField("isActive", e.target.value === "yes")}>
                    <option value="yes">Active</option>
                    <option value="no">Inactive</option>
                  </select>
                </div>
              </div>

              <div className="fs-field cs-notes-field">
                <label>Notes</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => updateField("notes", e.target.value)}
                  rows={2}
                  placeholder="Optional notes about this currency configuration"
                />
              </div>

              <div className="cs-preview">
                Preview: <strong>{formatCurrency(1250, {
                  currencySymbol: form.currencySymbol,
                  symbolPosition: form.symbolPosition,
                  spaceAfterSymbol: form.spaceAfterSymbol,
                  decimalPlaces: form.decimalPlaces,
                  decimalSeparator: form.decimalSeparator,
                  thousandSeparator: form.thousandSeparator,
                })}</strong>
              </div>
            </div>

            <div className="cs-modal-footer">
              <button className="cs-btn-secondary" onClick={() => setShowFormModal(false)} disabled={saving}>Cancel</button>
              <button className="cs-btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? "Saving…" : formMode === "add" ? "Save Currency" : "Update Currency"}
              </button>
            </div>
          </div>
        </div>
      )}

      {rateModalCurrency && (
        <CurrencyRateHistoryModal
          currency={rateModalCurrency}
          canSetRate={can(MODULE_KEY, "MANUAL_RATE") || can(MODULE_KEY, "FIXED_RATE")}
          canEnterOfficial={can(MODULE_KEY, "ENTER_OFFICIAL_RATE")}
          canImport={can(MODULE_KEY, "IMPORT_RATES")}
          canRefresh={can(MODULE_KEY, "REFRESH_RATE")}
          onClose={() => setRateModalCurrency(null)}
          onRateChanged={() => loadCurrencies({ silent: true })}
        />
      )}

      {confirmAction && (
        <div className="cs-overlay" role="dialog" aria-modal="true">
          <div className="cs-modal cs-modal-narrow">
            <div className="cs-modal-header">
              <h2>{confirmAction.type === "deactivate" ? "Deactivate Currency" : "Set Base Currency"}</h2>
              <button className="cs-close" onClick={() => setConfirmAction(null)} aria-label="Close">&times;</button>
            </div>
            <div className="cs-modal-body">
              {confirmAction.type === "deactivate" ? (
                <p>Deactivate <strong>{confirmAction.currency.currencyCode}</strong>? It will no longer be selectable for new transactions once multi-currency transactions are enabled.</p>
              ) : (
                <p>
                  Set <strong>{confirmAction.currency.currencyCode}</strong> as the company's base currency?
                  This is a sensitive accounting operation. If posted transactions already exist, the change will be blocked.
                </p>
              )}
            </div>
            <div className="cs-modal-footer">
              <button className="cs-btn-secondary" onClick={() => setConfirmAction(null)} disabled={confirmBusy}>Cancel</button>
              <button
                className="cs-btn-primary"
                disabled={confirmBusy}
                onClick={() =>
                  confirmAction.type === "deactivate"
                    ? performStatusChange(confirmAction.currency, false)
                    : performSetBase(confirmAction.currency)
                }
              >
                {confirmBusy ? "Working…" : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
