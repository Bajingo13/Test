import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import { createRequestGuard, isCompanyLocked, pickInitialCompany } from "../../utils/trialBalanceCompany.mjs";
import { accountAnalysisLink } from "../../utils/accountAnalysisCompany.mjs";
import {
  PRESETS,
  accessFromMe,
  activityVerb,
  canOpen,
  bucketLabel,
  cashOutlook,
  financialIndicators,
  formatCompact,
  formatDate,
  formatDateTime,
  formatMoney,
  hasSeriesData,
  moveItem,
  periodText,
  presetRange,
  readUserLayout,
  readUserPeriod,
  sectionState,
  seriesMax,
  summaryLines,
  todayLocal,
  validateRange,
  writeUserLayout,
  writeUserPeriod,
} from "../../utils/dashboardModel.mjs";
import "./Dashboard.css";

// The Dashboard is a VIEW of the accounting system: every figure below is
// read from GET /api/dashboard/summary, which reuses the report services
// (Income Statement, Balance Sheet, Daily Cash Position, AR / AP Aging,
// Audit Logs) for the selected company and period. Nothing is estimated or
// filled in here: no data shows an empty state, a failed request shows an
// error - never a zero.

const API_URL = import.meta.env.VITE_API_URL || "";

const WIDGET_LIBRARY = [
  { id: "aiAssistant", title: "Accounting Summary", category: "Overview", size: "hero" },
  { id: "revenue", title: "Revenue", category: "Income Statement", size: "small" },
  { id: "profit", title: "Net Profit", category: "Income Statement", size: "small" },
  { id: "cashForecast", title: "Cash Outlook", category: "Cash", size: "small" },
  { id: "revenueChart", title: "Revenue Overview", category: "Income Statement", size: "large" },
  { id: "accountOverview", title: "Account Overview", category: "Balance Sheet", size: "small" },
  { id: "receivables", title: "Receivables", category: "AR Aging", size: "medium" },
  { id: "payables", title: "Payables", category: "AP Aging", size: "medium" },
  { id: "cashFlowChart", title: "Cash Flow", category: "Bank & cash accounts (COA: BANK / CASH)", size: "large" },
  { id: "bankAccounts", title: "Bank & Cash Accounts", category: "COA: BANK / CASH", size: "small" },
  { id: "topCustomers", title: "Top Customers", category: "AR Aging", size: "medium" },
  { id: "financialHealth", title: "Financial Indicators", category: "Ratios", size: "medium" },
  { id: "aiAlerts", title: "Accounting Alerts", category: "Warnings", size: "medium" },
  { id: "quickActions", title: "Quick Actions", category: "Shortcuts", size: "medium" },
  { id: "recentTransactions", title: "Recent Transactions", category: "Latest records · not limited to the period", size: "large" },
  { id: "recentActivity", title: "Activity Timeline", category: "Latest company activity · not limited to the period", size: "large" },
  { id: "systemStatus", title: "System Status", category: "System", size: "medium" },
];
const LIBRARY_IDS = WIDGET_LIBRARY.map((w) => w.id);

const DEFAULT_WIDGETS = [
  "aiAssistant",
  "revenue",
  "profit",
  "cashForecast",
  "revenueChart",
  "accountOverview",
  "receivables",
  "payables",
  "cashFlowChart",
  "bankAccounts",
  "financialHealth",
  "aiAlerts",
  "recentTransactions",
  "quickActions",
];

// The browser's localStorage, or null where it is unavailable (the
// dashboard then still works for this visit, without saving).
function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// The signed-in user from the session saved at login - only a first guess
// so the layout appears at once; /api/me/permissions confirms it.
function sessionUser() {
  try {
    return JSON.parse(browserStorage()?.getItem("user") || "null");
  } catch {
    return null;
  }
}

function currentUsername() {
  const user = sessionUser();
  return user?.username || user?.name || "";
}

function WidgetFrame({ widget, children, onRemove, onMoveUp, onMoveDown }) {
  return (
    <section className={`dashboard-widget ${widget.size}`} aria-label={widget.title}>
      <div className="widget-toolbar">
        <div>
          <h3>{widget.title}</h3>
          <span>{widget.category}</span>
        </div>

        <div className="widget-controls">
          <button type="button" onClick={onMoveUp} title="Move up" aria-label={`Move ${widget.title} up`}>↑</button>
          <button type="button" onClick={onMoveDown} title="Move down" aria-label={`Move ${widget.title} down`}>↓</button>
          <button type="button" onClick={onRemove} title="Remove" aria-label={`Remove ${widget.title}`}>×</button>
        </div>
      </div>

      <div className="widget-body">{children}</div>
    </section>
  );
}

// Loading / error / no-permission states shared by every data widget.
function SectionGate({ state, onRetry, children }) {
  if (state.kind === "idle") return <p className="dash-state">Select a company to load the dashboard.</p>;
  if (state.kind === "loading") return <p className="dash-state dash-loading" role="status">Loading...</p>;
  if (state.kind === "forbidden") return <p className="dash-state">You do not have permission to view this information.</p>;
  if (state.kind === "error") {
    return (
      <div className="dash-state dash-error" role="alert">
        <span>Unable to load data. Please try again.</span>
        {onRetry ? <button type="button" onClick={onRetry}>Retry</button> : null}
      </div>
    );
  }
  return <div className={state.stale ? "dash-stale" : undefined}>{children(state.data)}</div>;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [showLibrary, setShowLibrary] = useState(false);
  const [showDeveloperModal, setShowDeveloperModal] = useState(false);
  // Layout and period are saved per user (see dashboardModel storageKeys).
  const [userId, setUserId] = useState(() => (sessionUser()?.id ? String(sessionUser().id) : ""));
  const userIdRef = useRef(userId);
  const [activeWidgetIds, setActiveWidgetIds] = useState(() => readUserLayout(browserStorage(), userId, LIBRARY_IDS, DEFAULT_WIDGETS));
  const [access, setAccess] = useState({ ready: false, superAdmin: false, granted: new Set() });

  const [period, setPeriod] = useState(() => readUserPeriod(browserStorage(), userId, todayLocal()));
  const [customDraft, setCustomDraft] = useState(() => ({ from: period.from, to: period.to }));
  const [customError, setCustomError] = useState("");

  const [companyState, setCompanyState] = useState({ status: "loading", companies: [], isSuperAdmin: false });
  const [companyId, setCompanyId] = useState("");
  const [request, setRequest] = useState({ status: "idle", data: null, message: "" });
  const guard = useRef(createRequestGuard());

  const activeWidgets = useMemo(
    () => activeWidgetIds.map((id) => WIDGET_LIBRARY.find((w) => w.id === id)).filter(Boolean),
    [activeWidgetIds]
  );

  // ---- company context (same rules as Trial Balance: one company is
  // automatic; Super Admin / several companies must choose) -------------
  const loadCompanies = useCallback(async () => {
    setCompanyState((s) => ({ ...s, status: "loading" }));
    try {
      const [meRes, companiesRes] = await Promise.all([
        fetch(`${API_URL}/api/me/permissions`, { credentials: "include", headers: authHeaders() }),
        fetch(`${API_URL}/api/companies`, { credentials: "include", headers: authHeaders() }),
      ]);
      if (handleAuthError(meRes.status) || handleAuthError(companiesRes.status)) return;
      if (!meRes.ok || !companiesRes.ok) throw new Error("companies");
      const me = await meRes.json();
      const companies = await companiesRes.json();
      const list = Array.isArray(companies) ? companies : [];
      const isSuperAdmin = me?.user?.roleCode === "SUPER_ADMIN";
      setAccess(accessFromMe(me));
      // The server's word on who is signed in wins over the saved session:
      // if they differ, show this user's own layout and period.
      const confirmedId = me?.user?.id ? String(me.user.id) : "";
      if (confirmedId !== userIdRef.current) {
        userIdRef.current = confirmedId;
        const storage = browserStorage();
        const nextPeriod = readUserPeriod(storage, confirmedId, todayLocal());
        setUserId(confirmedId);
        setActiveWidgetIds(readUserLayout(storage, confirmedId, LIBRARY_IDS, DEFAULT_WIDGETS));
        setPeriod(nextPeriod);
        setCustomDraft({ from: nextPeriod.from, to: nextPeriod.to });
      }
      setCompanyState({ status: "ready", companies: list, isSuperAdmin });
      setCompanyId((current) => pickInitialCompany({ companies: list, isSuperAdmin, current }));
    } catch {
      setCompanyState({ status: "error", companies: [], isSuperAdmin: false });
      setAccess({ ready: false, superAdmin: false, granted: new Set() });
      setCompanyId("");
    }
  }, []);

  useEffect(() => {
    loadCompanies();
  }, [loadCompanies]);

  // ---- summary -------------------------------------------------------
  const loadSummary = useCallback(async () => {
    if (!companyId) {
      guard.current.invalidate();
      setRequest({ status: "idle", data: null, message: "" });
      return;
    }
    const ticket = guard.current.next();
    // Keep showing the previous figures only while they belong to the same
    // company; a company switch clears them first.
    setRequest((r) => ({ status: "loading", data: r.data && String(r.data.meta.companyId) === String(companyId) ? r.data : null, message: "" }));
    const qs = new URLSearchParams({ companyId, from: period.from, to: period.to }).toString();
    try {
      const res = await fetch(`${API_URL}/api/dashboard/summary?${qs}`, { credentials: "include", headers: authHeaders() });
      if (handleAuthError(res.status)) return;
      const body = await res.json().catch(() => null);
      if (!guard.current.isCurrent(ticket)) return;
      if (!res.ok || !body?.sections) {
        setRequest({ status: "error", data: null, message: res.status < 500 && body?.message ? body.message : "Unable to load the dashboard." });
        return;
      }
      setRequest({ status: "ready", data: body, message: "" });
    } catch {
      if (guard.current.isCurrent(ticket)) setRequest({ status: "error", data: null, message: "Unable to reach the server." });
    }
  }, [companyId, period.from, period.to]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  // ---- layout --------------------------------------------------------
  function saveLayout(next) {
    setActiveWidgetIds(next);
    writeUserLayout(browserStorage(), userId, next);
  }

  function toggleWidget(id) {
    saveLayout(activeWidgetIds.includes(id) ? activeWidgetIds.filter((w) => w !== id) : [...activeWidgetIds, id]);
  }

  // ---- period --------------------------------------------------------
  function choosePreset(preset) {
    if (preset === "custom") {
      setPeriod((p) => ({ ...p, preset: "custom" }));
      setCustomDraft({ from: period.from, to: period.to });
      setCustomError("");
      return;
    }
    const next = { preset, ...presetRange(preset, todayLocal()) };
    setPeriod(next);
    writeUserPeriod(browserStorage(), userId, next);
  }

  function applyCustom(e) {
    e.preventDefault();
    const problem = validateRange(customDraft);
    setCustomError(problem);
    if (problem) return;
    const next = { preset: "custom", from: customDraft.from, to: customDraft.to };
    setPeriod(next);
    writeUserPeriod(browserStorage(), userId, next);
  }

  const summary = request.data;
  const currency = summary?.meta?.currency || null;
  const st = (key) => sectionState(request, key);
  const company = companyState.companies.find((c) => String(c.id) === String(companyId)) || null;
  const locked = companyState.status === "ready" && isCompanyLocked(companyState);

  function renderWidget(id) {
    const props = { st, currency, navigate, retry: loadSummary, summary, request, access };
    switch (id) {
      case "aiAssistant":
        return <SummaryWidget {...props} />;
      case "revenue":
        return <RevenueWidget {...props} />;
      case "profit":
        return <ProfitWidget {...props} />;
      case "cashForecast":
        return <CashOutlookWidget {...props} />;
      case "revenueChart":
        return <RevenueChartWidget {...props} />;
      case "accountOverview":
        return <AccountOverviewWidget {...props} />;
      case "receivables":
        return <AgingWidget {...props} sectionKey="receivables" kind="AR" />;
      case "payables":
        return <AgingWidget {...props} sectionKey="payables" kind="AP" />;
      case "cashFlowChart":
        return <CashFlowWidget {...props} />;
      case "bankAccounts":
        return <BankAccountsWidget {...props} />;
      case "topCustomers":
        return <TopCustomersWidget {...props} />;
      case "financialHealth":
        return <IndicatorsWidget {...props} />;
      case "aiAlerts":
        return <AlertsWidget {...props} />;
      case "quickActions":
        return <QuickActionsWidget navigate={navigate} summary={summary} access={access} />;
      case "recentTransactions":
        return <RecentTransactionsWidget {...props} />;
      case "recentActivity":
        return <ActivityWidget {...props} />;
      case "systemStatus":
        return <SystemStatusWidget {...props} companyState={companyState} />;
      default:
        return null;
    }
  }

  return (
    <div className="dashboard-page">
      <header className="dashboard-hero">
        <div className="hero-glow"></div>

        <div>
          <p className="dashboard-mini-label">AstreaBlue Accounting</p>
          <h1>DASHBOARD</h1>

          <p className="dashboard-subtext">
            Figures from your posted accounting records
            <span className="secret-period" onClick={() => setShowDeveloperModal(true)} title="Developer Info">
              .
            </span>
          </p>

          <div className="ai-status-row" aria-live="polite">
            <span className={`ai-pulse${request.status === "error" ? " dash-pulse-error" : ""}`}></span>
            <span>{company ? company.name : companyState.status === "loading" ? "Loading companies..." : "No company selected"}</span>
            <span>{periodText(period.from, period.to)}</span>
            <span>
              {request.status === "loading"
                ? "Updating..."
                : request.status === "error"
                ? "Not loaded"
                : summary
                ? `Data as of ${formatDateTime(summary.meta.generatedAt)}`
                : ""}
            </span>
          </div>
        </div>

        <div className="dashboard-header-actions">
          <button type="button" onClick={loadSummary} disabled={!companyId || request.status === "loading"}>
            Refresh
          </button>
          <button type="button" onClick={() => setShowLibrary((prev) => !prev)}>+ Add Widget</button>
          <button type="button" onClick={() => saveLayout(DEFAULT_WIDGETS)}>Reset Layout</button>
        </div>
      </header>

      <section className="dash-filters" aria-label="Dashboard filters">
        <div className="dash-company">
          <label htmlFor="dash-company">Company</label>
          {companyState.status === "error" ? (
            <span className="dash-inline-error" role="alert">
              Unable to load companies. <button type="button" onClick={loadCompanies}>Retry</button>
            </span>
          ) : locked ? (
            <strong id="dash-company">{company?.name || ""}</strong>
          ) : (
            <select id="dash-company" value={companyId} onChange={(e) => setCompanyId(e.target.value)} disabled={companyState.status !== "ready"}>
              <option value="">Select a company</option>
              {companyState.companies.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          )}
        </div>

        <div className="dash-presets" role="group" aria-label="Period">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={period.preset === p.id ? "active" : ""}
              aria-pressed={period.preset === p.id}
              onClick={() => choosePreset(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>

        {period.preset === "custom" ? (
          <form className="dash-custom" onSubmit={applyCustom}>
            <label>
              From
              <input type="date" value={customDraft.from} onChange={(e) => setCustomDraft((d) => ({ ...d, from: e.target.value }))} />
            </label>
            <label>
              To
              <input type="date" value={customDraft.to} onChange={(e) => setCustomDraft((d) => ({ ...d, to: e.target.value }))} />
            </label>
            <button type="submit">Apply</button>
            {customError ? <span className="dash-inline-error" role="alert">{customError}</span> : null}
          </form>
        ) : null}

        {request.status === "error" ? (
          <div className="dash-banner" role="alert">
            {request.message} <button type="button" onClick={loadSummary}>Try again</button>
          </div>
        ) : null}
      </section>

      {showLibrary && (
        <section className="widget-library">
          <div className="library-header">
            <div>
              <h2>Widget Library</h2>
              <p>Choose the widgets shown on your dashboard. The layout is saved in this browser.</p>
            </div>
          </div>

          <div className="library-grid">
            {WIDGET_LIBRARY.map((widget) => {
              const added = activeWidgetIds.includes(widget.id);
              return (
                <div key={widget.id} className={added ? "library-item added" : "library-item"}>
                  <div className="library-item-info">
                    <strong>{widget.title}</strong>
                    <span>{widget.category}</span>
                  </div>

                  <label className="widget-switch">
                    <input type="checkbox" checked={added} onChange={() => toggleWidget(widget.id)} aria-label={`Show ${widget.title}`} />
                    <span className="widget-switch-slider"></span>
                  </label>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <main className="dashboard-widget-grid">
        {activeWidgets.length === 0 ? (
          <p className="dash-state dash-empty-grid">No widgets selected. Use + Add Widget or Reset Layout.</p>
        ) : null}
        {activeWidgets.map((widget) => (
          <WidgetFrame
            key={widget.id}
            widget={widget}
            onRemove={() => saveLayout(activeWidgetIds.filter((w) => w !== widget.id))}
            onMoveUp={() => saveLayout(moveItem(activeWidgetIds, widget.id, "up"))}
            onMoveDown={() => saveLayout(moveItem(activeWidgetIds, widget.id, "down"))}
          >
            {renderWidget(widget.id)}
          </WidgetFrame>
        ))}
      </main>

      {showDeveloperModal && (
        <div className="simple-dev-modal" onClick={() => setShowDeveloperModal(false)}>
          <div className="simple-dev-box" onClick={(e) => e.stopPropagation()}>
            <button className="simple-dev-close" onClick={() => setShowDeveloperModal(false)}>
              ×
            </button>

            <p>Developed by JJ and DJ with JR </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Widgets

const SUMMARY_LINKS = [
  { label: "Generate Trial Balance", path: "/reports/trial-balance" },
  { label: "View Income Statement", path: "/reports/income-statement" },
  { label: "Review APV", path: "/transactions/apv" },
];

function SummaryWidget({ summary, request, navigate, retry, access }) {
  const links = SUMMARY_LINKS.filter((l) => canOpen(access, l.path));
  const name = currentUsername();
  const lines = summaryLines(summary);
  return (
    <div className="ai-assistant">
      <div className="ai-orb" aria-hidden="true">{(name || "A").slice(0, 2).toUpperCase()}</div>

      <div className="ai-assistant-content">
        <h2>{name ? `Good day, ${name}.` : "Good day."}</h2>
        {request.status === "error" ? (
          <div className="dash-state dash-error dash-on-dark" role="alert">
            <span>Unable to load data. Please try again.</span>
            <button type="button" onClick={retry}>Retry</button>
          </div>
        ) : !summary ? (
          <p>{request.status === "idle" ? "Select a company to see its figures." : "Loading the latest figures..."}</p>
        ) : (
          <>
            <p>
              {summary.meta.companyName} · {periodText(summary.meta.from, summary.meta.to)}
              {summary.meta.currency ? ` · ${summary.meta.currency.code}` : ""}
            </p>
            {lines.length ? (
              <div className="ai-insight-grid">
                {lines.map((l) => (
                  <div key={l.title}>
                    <strong>{l.title}</strong>
                    <span>{l.text}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p>You do not have permission to view the financial figures.</p>
            )}
          </>
        )}

        {links.length ? (
          <div className="ai-command-row">
            {links.map((l) => (
              <button key={l.path} type="button" onClick={() => navigate(l.path)}>{l.label}</button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function KpiValue({ label, amount, currency, note, tone }) {
  return (
    <div className="kpi-widget">
      <div className="kpi-top">
        <span>{label}</span>
      </div>
      <h2 className={tone === "negative" ? "dash-negative" : undefined}>{formatMoney(amount, currency)}</h2>
      {note ? <p>{note}</p> : null}
    </div>
  );
}

function RevenueWidget({ st, currency, retry, summary }) {
  return (
    <SectionGate state={st("income")} onRetry={retry}>
      {(inc) => (
        <KpiValue
          label="Revenue (Income Statement)"
          amount={inc.revenue}
          currency={currency}
          note={`Gross profit ${formatMoney(inc.grossProfit, currency)} · ${periodText(summary.meta.from, summary.meta.to)}`}
        />
      )}
    </SectionGate>
  );
}

function ProfitWidget({ st, currency, retry }) {
  return (
    <SectionGate state={st("income")} onRetry={retry}>
      {(inc) => (
        <KpiValue
          label="Net income"
          amount={inc.netIncome}
          currency={currency}
          tone={inc.netIncome < 0 ? "negative" : undefined}
          note={inc.netMargin === null ? "No revenue in this period" : `Net margin ${inc.netMargin.toFixed(2)}%`}
        />
      )}
    </SectionGate>
  );
}

function CashOutlookWidget({ st, currency, retry, summary }) {
  const cash = st("cash");
  return (
    <SectionGate state={cash} onRetry={retry}>
      {(c) => {
        if (!c.accounts.length) return <p className="dash-state">No bank accounts available.</p>;
        const outlook = cashOutlook(summary.sections);
        return (
          <div className="forecast-widget">
            <h2>{formatMoney(c.endingBalance, currency)}</h2>
            <p>Bank balance as of {formatDate(summary.meta.to)}</p>
            {outlook ? (
              <>
                <div className="forecast-list">
                  {outlook.horizons.map((h) => (
                    <div key={h.days}>
                      <span>If items due within {h.days} days settle</span>
                      <strong>{formatMoney(h.position, currency)}</strong>
                    </div>
                  ))}
                </div>
                <p className="dash-footnote">Bank balance + open receivables − open payables due by then (overdue included). Not a forecast.</p>
              </>
            ) : (
              <p className="dash-footnote">Receivables and payables access is needed for the due-date outlook.</p>
            )}
          </div>
        );
      }}
    </SectionGate>
  );
}

function BarChart({ series, granularity, bars, currency, ariaLabel }) {
  const keys = bars.map((b) => b.key);
  const max = seriesMax(series, keys) || 1;
  const hasNegative = series.some((p) => keys.some((k) => Number(p[k]) < 0));
  const height = 160;
  const zero = hasNegative ? height / 2 : height;
  const scale = (hasNegative ? height / 2 : height) / max;
  const groupWidth = 100 / series.length;
  const barWidth = (groupWidth * 0.7) / bars.length;
  return (
    <figure className="dash-chart">
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" role="img" aria-label={ariaLabel}>
        <line x1="0" x2="100" y1={zero} y2={zero} className="dash-axis" />
        {series.map((p, i) =>
          bars.map((b, j) => {
            const v = Number(p[b.key]) || 0;
            const h = Math.abs(v) * scale;
            const x = i * groupWidth + groupWidth * 0.15 + j * barWidth;
            return (
              <rect key={`${i}-${b.key}`} x={x} width={barWidth * 0.92} y={v >= 0 ? zero - h : zero} height={Math.max(h, v ? 0.6 : 0)} className={b.className}>
                <title>{`${bucketLabel(p, granularity)} · ${b.label}: ${formatMoney(v, currency)}`}</title>
              </rect>
            );
          })
        )}
      </svg>
      <div className="dash-chart-labels" style={{ gridTemplateColumns: `repeat(${series.length}, 1fr)` }}>
        {series.map((p) => (
          <span key={p.from}>{bucketLabel(p, granularity)}</span>
        ))}
      </div>
      <figcaption className="dash-legend">
        {bars.map((b) => (
          <span key={b.key}><i className={b.className} aria-hidden="true"></i>{b.label}</span>
        ))}
        <span className="dash-legend-scale">max {formatCompact(max)}</span>
      </figcaption>
    </figure>
  );
}

function RevenueChartWidget({ st, currency, retry }) {
  return (
    <SectionGate state={st("income")} onRetry={retry}>
      {(inc) =>
        hasSeriesData(inc.series, ["revenue", "netIncome"]) ? (
          <BarChart
            series={inc.series}
            granularity={inc.granularity}
            currency={currency}
            ariaLabel="Revenue and net income by period"
            bars={[
              { key: "revenue", label: "Revenue", className: "dash-bar-revenue" },
              { key: "netIncome", label: "Net income", className: "dash-bar-net" },
            ]}
          />
        ) : (
          <p className="dash-state">No revenue or expenses recorded in this period.</p>
        )
      }
    </SectionGate>
  );
}

function CashFlowWidget({ st, currency, retry }) {
  return (
    <SectionGate state={st("cash")} onRetry={retry}>
      {(c) => {
        if (!c.accounts.length) return <p className="dash-state">No bank accounts available.</p>;
        return (
          <>
            <div className="dash-figures">
              <div><span>Opening</span><strong>{formatMoney(c.openingBalance, currency)}</strong></div>
              <div><span>Inflows</span><strong>{formatMoney(c.inflows, currency)}</strong></div>
              <div><span>Outflows</span><strong>{formatMoney(c.outflows, currency)}</strong></div>
              <div><span>Ending</span><strong>{formatMoney(c.endingBalance, currency)}</strong></div>
            </div>
            {hasSeriesData(c.series, ["inflows", "outflows"]) ? (
              <BarChart
                series={c.series}
                granularity={c.granularity}
                currency={currency}
                ariaLabel="Bank inflows and outflows by period"
                bars={[
                  { key: "inflows", label: "Inflows", className: "dash-bar-in" },
                  { key: "outflows", label: "Outflows", className: "dash-bar-out" },
                ]}
              />
            ) : (
              <p className="dash-state">No bank transactions recorded in this period.</p>
            )}
          </>
        );
      }}
    </SectionGate>
  );
}

function AccountOverviewWidget({ st, currency, retry, navigate }) {
  return (
    <SectionGate state={st("balance")} onRetry={retry}>
      {(b) => (
        <div className="status-list">
          <div><span>Total assets</span><strong>{formatMoney(b.totalAssets, currency)}</strong></div>
          <div><span>Total liabilities</span><strong>{formatMoney(b.totalLiabilities, currency)}</strong></div>
          <div><span>Total equity</span><strong>{formatMoney(b.totalEquity, currency)}</strong></div>
          <button type="button" className={`dash-link${b.balanced ? "" : " dash-danger-text"}`} onClick={() => navigate("/reports/balance-sheet")}>
            {b.balanced ? `Balanced as of ${formatDate(b.asOf)}` : "Out of balance - open Balance Sheet"}
          </button>
        </div>
      )}
    </SectionGate>
  );
}

function AgingWidget({ st, currency, retry, navigate, sectionKey, kind }) {
  const isAr = kind === "AR";
  return (
    <SectionGate state={st(sectionKey)} onRetry={retry}>
      {(a) =>
        a.documentCount === 0 ? (
          <p className="dash-state">{isAr ? "No open receivables." : "No open payables."}</p>
        ) : (
          <div className="smart-list">
            <div className="smart-summary">
              <h2>{formatMoney(a.total, currency)}</h2>
              <span>{isAr ? "Open receivables" : "Open payables"} · {a.documentCount} document(s) as of {formatDate(a.asOf)}</span>
            </div>

            <div className={`smart-item${a.overdue > 0 ? " warning" : ""}`}>
              <strong>{isAr ? "Overdue" : "Past due"}</strong>
              <span>{formatMoney(a.overdue, currency)} · {a.overdueCount} document(s)</span>
            </div>

            <div className="smart-item">
              <strong>Due within 7 days</strong>
              <span>{formatMoney(a.dueSoon, currency)} · {a.dueSoonCount} document(s)</span>
            </div>

            {a.largestOverdue ? (
              <div className="smart-item">
                <strong>Largest {isAr ? "overdue" : "past due"}</strong>
                <span>{a.largestOverdue.partyName || "-"} · {a.largestOverdue.referenceNo} · {formatMoney(a.largestOverdue.balance, currency)} ({a.largestOverdue.daysOverdue} days)</span>
              </div>
            ) : null}

            <button type="button" className="dash-link" onClick={() => navigate(isAr ? "/reports/ar-aging" : "/reports/ap-aging")}>
              Open {isAr ? "AR" : "AP"} Aging
            </button>
          </div>
        )
      }
    </SectionGate>
  );
}

function BankAccountsWidget({ st, currency, retry }) {
  return (
    <SectionGate state={st("cash")} onRetry={retry}>
      {(c) =>
        c.accounts.length === 0 ? (
          <p className="dash-state">No bank accounts available.</p>
        ) : (
          <div className="bank-list">
            {c.accounts.map((a) => (
              <div className="bank-item" key={a.id}>
                <div>
                  <strong>{a.name}</strong>
                  <span>
                    {" "}{[a.bankName, a.accountNoLast4 ? `••${a.accountNoLast4}` : null, a.accountType ? a.accountType.toLowerCase() : null, `GL ${a.coaCode}`]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
                <div className="bank-right">
                  <strong className={a.balance < 0 ? "dash-negative" : undefined}>{formatMoney(a.balance, currency)}</strong>
                  <span>
                    {a.recon === null
                      ? a.status
                      : a.recon.inProgress
                      ? `${a.recon.inProgress} reconciliation(s) in progress`
                      : a.recon.lastFinalizedThrough
                      ? `Reconciled through ${formatDate(a.recon.lastFinalizedThrough)}`
                      : "Not reconciled yet"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )
      }
    </SectionGate>
  );
}

function TopCustomersWidget({ st, currency, retry }) {
  return (
    <SectionGate state={st("receivables")} onRetry={retry}>
      {(a) =>
        a.topParties.length === 0 ? (
          <p className="dash-state">No customers with open balances.</p>
        ) : (
          <div className="dash-table-wrap">
            <table className="dash-table">
              <thead>
                <tr><th>Customer</th><th className="num">Open balance</th><th className="num">Overdue</th></tr>
              </thead>
              <tbody>
                {a.topParties.map((p) => (
                  <tr key={`${p.partyId}-${p.partyName}`}>
                    <td>{p.partyName || "-"}<small>{p.documents} document(s)</small></td>
                    <td className="num">{formatMoney(p.balance, currency)}</td>
                    <td className="num">{formatMoney(p.overdue, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="dash-footnote">By open receivable balance as of {formatDate(a.asOf)} (AR Aging Summary).</p>
          </div>
        )
      }
    </SectionGate>
  );
}

function IndicatorsWidget({ summary, request, retry }) {
  if (request.status === "error") return <SectionGate state={{ kind: "error" }} onRetry={retry} />;
  if (!summary) return <SectionGate state={{ kind: request.status === "idle" ? "idle" : "loading" }} />;
  const items = financialIndicators(summary.sections);
  if (!items.length) return <p className="dash-state">You do not have permission to view this information.</p>;
  return (
    <div className="health-bars">
      {items.map((i) => (
        <div key={i.id} title={i.hint}>
          <span>{i.label}</span>
          <strong>{i.value === null ? "n/a" : `${i.value.toFixed(2)}${i.unit}`}</strong>
        </div>
      ))}
      <p className="dash-footnote">Calculated from the figures above. n/a = nothing to divide by.</p>
    </div>
  );
}

function AlertsWidget({ summary, request, navigate, retry, access }) {
  if (request.status === "error") return <SectionGate state={{ kind: "error" }} onRetry={retry} />;
  if (!summary) return <SectionGate state={{ kind: request.status === "idle" ? "idle" : "loading" }} />;
  const failed = Object.values(summary.sections).some((s) => s.status === "error");
  return (
    <div className="alert-list">
      {summary.alerts.map((alert, index) =>
        canOpen(access, alert.link) ? (
          <button key={index} type="button" className={`alert-item ${alert.level}`} onClick={() => navigate(alert.link)}>
            {alert.text}
          </button>
        ) : (
          <div key={index} className={`alert-item ${alert.level} dash-alert-static`}>{alert.text}</div>
        )
      )}
      {failed ? <p className="dash-state dash-error">Some data could not be loaded, so alerts may be incomplete.</p> : null}
      {!summary.alerts.length && !failed ? <p className="dash-state">No alerts for this period.</p> : null}
    </div>
  );
}

// Every target is an existing route in App.jsx; each is shown only when the
// user holds the permission that page requires (dashboardModel
// PATH_PERMISSIONS). The page's own server checks stay authoritative.
const QUICK_ACTIONS = [
  { label: "Create Invoice", path: "/transactions/invoice" },
  { label: "Open APV", path: "/transactions/apv" },
  { label: "Request for Payment", path: "/transactions/rfp" },
  { label: "Chart of Accounts", path: "/coa" },
  { label: "General Libraries", path: "/general-libraries" },
  { label: "Trial Balance", path: "/reports/trial-balance" },
  { label: "Income Statement", path: "/reports/income-statement" },
  { label: "Balance Sheet", path: "/reports/balance-sheet" },
];

// Account Analysis carries the company and period of the summary on screen
// (the server-resolved company, as the Income Statement / Balance Sheet
// links do); before a summary loads it carries none and Account Analysis asks.
function QuickActionsWidget({ navigate, summary, access }) {
  if (!access.ready) return <p className="dash-state dash-loading" role="status">Loading...</p>;
  const actions = QUICK_ACTIONS.filter((a) => canOpen(access, a.path));
  const analysis = canOpen(access, "/reports/account-analysis");
  if (!actions.length && !analysis) return <p className="dash-state">No shortcuts available for your role.</p>;
  return (
    <div className="quick-actions">
      {actions.map((a) => (
        <button key={a.path} type="button" onClick={() => navigate(a.path)}>{a.label}</button>
      ))}
      {analysis ? (
        <button type="button" onClick={() => navigate(accountAnalysisLink({ accountCode: "", from: summary?.meta?.from, to: summary?.meta?.to, companyId: summary?.meta?.companyId }))}>
          Account Analysis
        </button>
      ) : null}
    </div>
  );
}

function RecentTransactionsWidget({ st, currency, retry, navigate }) {
  return (
    <SectionGate state={st("transactions")} onRetry={retry}>
      {(t) =>
        t.items.length === 0 ? (
          <p className="dash-state">No transactions recorded.</p>
        ) : (
          <div className="dash-table-wrap">
            <table className="dash-table">
              <thead>
                <tr><th>Document</th><th>Party</th><th>Date</th><th>Status</th><th className="num">Amount</th></tr>
              </thead>
              <tbody>
                {t.items.map((x) => (
                  <tr key={`${x.type}-${x.id}`} className="dash-row-link" onClick={() => navigate(x.link)}>
                    <td><button type="button" className="dash-link" onClick={(e) => { e.stopPropagation(); navigate(x.link); }}>{x.voucherNo || `${x.type} #${x.id}`}</button><small>{x.typeLabel}</small></td>
                    <td>{x.party || "-"}</td>
                    <td>{formatDate(x.transactionDate)}</td>
                    <td><span className={`dash-status dash-status-${String(x.status || "").toLowerCase()}`}>{x.status}</span></td>
                    <td className="num">{formatMoney(x.amount, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="dash-footnote">The latest {t.items.length} record(s) across the modules you can view - not limited to the dashboard period.</p>
          </div>
        )
      }
    </SectionGate>
  );
}

function ActivityWidget({ st, retry }) {
  return (
    <SectionGate state={st("activity")} onRetry={retry}>
      {(a) =>
        a.items.length === 0 ? (
          <p className="dash-state">No recent activity.</p>
        ) : (
          <div className="activity-list">
            {a.items.map((item) => (
              <div className="activity-item" key={item.id}>
                <span className="activity-dot"></span>
                <p>
                  <strong>{item.username || "System"}</strong> {activityVerb(item.action)} {String(item.entityType || item.module || "").toLowerCase()}
                  {item.entityId ? ` #${item.entityId}` : ""}
                  {item.description ? <span className="dash-activity-desc"> - {item.description}</span> : null}
                  <small>{formatDateTime(item.createdAt)}</small>
                </p>
              </div>
            ))}
            <p className="dash-footnote">Latest activity on records you can view - not limited to the dashboard period.</p>
          </div>
        )
      }
    </SectionGate>
  );
}

function SystemStatusWidget({ summary, request, companyState, retry }) {
  const p = summary?.sections?.period;
  const sections = summary ? Object.values(summary.sections) : [];
  const failed = sections.filter((s) => s.status === "error").length;
  const restricted = sections.filter((s) => s.status === "forbidden").length;
  return (
    <div className="status-list">
      <div>
        <span>Dashboard data</span>
        <strong className={request.status === "error" ? "dash-danger-text" : undefined}>
          {request.status === "error" ? "Not loaded" : request.status === "loading" ? "Updating..." : summary ? "Loaded" : "Waiting"}
        </strong>
      </div>
      <div><span>Last updated</span><strong>{summary ? formatDateTime(summary.meta.generatedAt) : "-"}</strong></div>
      <div><span>Companies available</span><strong>{companyState.status === "ready" ? companyState.companies.length : "-"}</strong></div>
      <div><span>Reporting currency</span><strong>{summary?.meta?.currency ? `${summary.meta.currency.code}` : summary ? "Not set" : "-"}</strong></div>
      <div>
        <span>Accounting period ({summary ? formatDate(summary.meta.to) : "period end"})</span>
        <strong>{!p || p.status !== "ok" ? "-" : !p.managed ? "Not managed" : p.periodStatus === "MISSING" ? "Not generated" : String(p.periodStatus).replace(/_/g, " ")}</strong>
      </div>
      {summary && (failed || restricted) ? (
        <div>
          <span>Sections</span>
          <strong>{[failed ? `${failed} failed` : null, restricted ? `${restricted} restricted` : null].filter(Boolean).join(", ")}</strong>
        </div>
      ) : null}
      {request.status === "error" ? <button type="button" className="dash-link" onClick={retry}>Retry</button> : null}
    </div>
  );
}
