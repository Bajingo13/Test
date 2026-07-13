import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import "./Dashboard.css";

const STORAGE_KEY = "astrea_ai_dashboard_widgets";

const WIDGET_LIBRARY = [
  { id: "aiAssistant", title: "AstreaBlue AI Assistant", category: "AI Copilot", size: "hero" },
  { id: "revenue", title: "Revenue Pulse", category: "Finance", size: "small" },
  { id: "profit", title: "Profit Intelligence", category: "Finance", size: "small" },
  { id: "cashForecast", title: "Cash Forecast", category: "Prediction", size: "small" },
  { id: "receivables", title: "Smart Collections", category: "Receivables", size: "medium" },
  { id: "payables", title: "Payables Monitor", category: "Payables", size: "medium" },
  { id: "bankAccounts", title: "Bank Accounts", category: "Banking", size: "medium" },
  { id: "financialHealth", title: "Financial Health Score", category: "Risk", size: "medium" },
  { id: "aiAlerts", title: "Accounting Alerts", category: "Warnings", size: "medium" },
  { id: "quickActions", title: "Suggested Actions", category: "Automation", size: "medium" },
  { id: "recentActivity", title: "Activity Timeline", category: "Activity", size: "large" },
  { id: "systemStatus", title: "System Intelligence", category: "System", size: "medium" },
];

const DEFAULT_WIDGETS = [
  "aiAssistant",
  "revenue",
  "profit",
  "cashForecast",
  "receivables",
  "payables",
  "bankAccounts",
  "financialHealth",
  "aiAlerts",
  "quickActions",
];

function getInitialWidgets() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : DEFAULT_WIDGETS;
  } catch {
    return DEFAULT_WIDGETS;
  }
}

function WidgetFrame({ widget, children, onRemove, onMoveUp, onMoveDown }) {
  return (
    <section className={`dashboard-widget ${widget.size}`}>
      <div className="widget-toolbar">
        <div>
          <h3>{widget.title}</h3>
          <span>{widget.category}</span>
        </div>

        <div className="widget-controls">
          <button onClick={onMoveUp} title="Move up">↑</button>
          <button onClick={onMoveDown} title="Move down">↓</button>
          <button onClick={onRemove} title="Remove">×</button>
        </div>
      </div>

      <div className="widget-body">{children}</div>
    </section>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [showLibrary, setShowLibrary] = useState(false);
  const [showDeveloperModal, setShowDeveloperModal] = useState(false);
  const [activeWidgetIds, setActiveWidgetIds] = useState(getInitialWidgets);

  const activeWidgets = useMemo(
    () =>
      activeWidgetIds
        .map((id) => WIDGET_LIBRARY.find((w) => w.id === id))
        .filter(Boolean),
    [activeWidgetIds]
  );

  function saveLayout(next) {
    setActiveWidgetIds(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }

  function addWidget(id) {
    if (activeWidgetIds.includes(id)) return;
    saveLayout([...activeWidgetIds, id]);
  }

  function removeWidget(id) {
    saveLayout(activeWidgetIds.filter((widgetId) => widgetId !== id));
  }

  function moveWidget(id, direction) {
    const index = activeWidgetIds.indexOf(id);
    const nextIndex = direction === "up" ? index - 1 : index + 1;
    if (nextIndex < 0 || nextIndex >= activeWidgetIds.length) return;

    const next = [...activeWidgetIds];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    saveLayout(next);
  }

  function resetDashboard() {
    saveLayout(DEFAULT_WIDGETS);
  }

  function renderWidget(id) {
    switch (id) {
      case "aiAssistant":
        return <AIAssistantWidget navigate={navigate} />;

      case "revenue":
        return (
          <KPIWidget
            label="Projected Revenue"
            amount="₱1.42M"
            trend="+18.4%"
            status="AI forecast: strong"
            type="positive"
          />
        );

      case "profit":
        return (
          <KPIWidget
            label="Estimated Net Profit"
            amount="₱384,500"
            trend="+11.2%"
            status="Margin improving"
            type="positive"
          />
        );

      case "cashForecast":
        return <CashForecastWidget />;

      case "receivables":
        return <ReceivablesWidget />;

      case "payables":
        return <PayablesWidget />;

      case "bankAccounts":
        return <SmartBankAccountsWidget />;

      case "financialHealth":
        return <FinancialHealthWidget />;

      case "aiAlerts":
        return <AIAlertsWidget navigate={navigate} />;

      case "quickActions":
        return <AIQuickActionsWidget navigate={navigate} />;

      case "recentActivity":
        return <AIActivityWidget />;

      case "systemStatus":
        return <SystemIntelligenceWidget />;

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
            AI-powered financial insights, automation, and predictive monitoring
            <span
              className="secret-period"
              onClick={() => setShowDeveloperModal(true)}
              title="Developer Info"
            >
              .
            </span>
          </p>

          <div className="ai-status-row">
            <span className="ai-pulse"></span>
            <span>AI Automation Active</span>
            <span>Last scan: Just now</span>
          </div>
        </div>

        <div className="dashboard-header-actions">
          <button onClick={() => setShowLibrary((prev) => !prev)}>
            + Add Widget
          </button>
          <button onClick={resetDashboard}>Reset Layout</button>
        </div>
      </header>

      {showLibrary && (
        <section className="widget-library">
          <div className="library-header">
            <div>
              <h2>Widget Library</h2>
              <p>Select intelligent widgets to monitor your accounting system.</p>
            </div>
          </div>

          <div className="library-grid">
            {WIDGET_LIBRARY.map((widget) => {
              const added = activeWidgetIds.includes(widget.id);

              return (
                <button
                  key={widget.id}
                  className={added ? "library-item added" : "library-item"}
                  onClick={() => addWidget(widget.id)}
                  disabled={added}
                >
                  <strong>{widget.title}</strong>
                  <span>{widget.category}</span>
                  <small>{added ? "Already added" : "Add widget"}</small>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <main className="dashboard-widget-grid">
        {activeWidgets.map((widget) => (
          <WidgetFrame
            key={widget.id}
            widget={widget}
            onRemove={() => removeWidget(widget.id)}
            onMoveUp={() => moveWidget(widget.id, "up")}
            onMoveDown={() => moveWidget(widget.id, "down")}
          >
            {renderWidget(widget.id)}
          </WidgetFrame>
        ))}
      </main>

      {showDeveloperModal && (
        <div
          className="simple-dev-modal"
          onClick={() => setShowDeveloperModal(false)}
        >
          <div className="simple-dev-box" onClick={(e) => e.stopPropagation()}>
            <button
              className="simple-dev-close"
              onClick={() => setShowDeveloperModal(false)}
            >
              ×
            </button>

            <p>Developed by JJ and DJ with JR </p>
          </div>
        </div>
      )}
    </div>
  );
}

function AIAssistantWidget({ navigate }) {
  return (
    <div className="ai-assistant">
      <div className="ai-orb">JJ</div>

      <div className="ai-assistant-content">
        <h2>Good day, Admin.</h2>
        <p>
          I scanned your current financial activity and found key actions that
          need attention.
        </p>

        <div className="ai-insight-grid">
          <div>
            <strong>Cash Outlook</strong>
            <span>Healthy for the next 7 days</span>
          </div>

          <div>
            <strong>Collections</strong>
            <span>₱38,500 overdue needs follow-up</span>
          </div>

          <div>
            <strong>Payables</strong>
            <span>5 APVs awaiting approval</span>
          </div>
        </div>

        <div className="ai-command-row">
          <button onClick={() => navigate("/reports/trial-balance")}>
            Generate Trial Balance
          </button>
          <button onClick={() => navigate("/reports/income-statement")}>
            View Income Statement
          </button>
          <button onClick={() => navigate("/transactions/apv")}>
            Review APV
          </button>
        </div>
      </div>
    </div>
  );
}

function KPIWidget({ label, amount, trend, status, type }) {
  return (
    <div className="kpi-widget">
      <div className="kpi-top">
        <span>{label}</span>
        <strong className={type}>{trend}</strong>
      </div>

      <h2>{amount}</h2>
      <p>{status}</p>

      <div className="mini-chart">
        <span></span>
        <span></span>
        <span></span>
        <span></span>
        <span></span>
      </div>
    </div>
  );
}

function CashForecastWidget() {
  return (
    <div className="forecast-widget">
      <h2>₱1,031,630</h2>
      <p>Current available cash</p>

      <div className="forecast-list">
        <div>
          <span>Tomorrow</span>
          <strong>₱1,008,500</strong>
        </div>
        <div>
          <span>7 Days</span>
          <strong>₱965,200</strong>
        </div>
        <div>
          <span>30 Days</span>
          <strong>₱1,245,100</strong>
        </div>
      </div>

      <div className="confidence">
        <span>AI confidence</span>
        <strong>96%</strong>
      </div>
    </div>
  );
}

function ReceivablesWidget() {
  return (
    <div className="smart-list">
      <div className="smart-summary">
        <h2>₱245,000</h2>
        <span>Total receivables</span>
      </div>

      <div className="smart-item warning">
        <strong>Priority Collection</strong>
        <span>ABC Trading — ₱38,500 overdue</span>
      </div>

      <div className="smart-item">
        <strong>Expected this week</strong>
        <span>₱172,000 forecasted collection</span>
      </div>
    </div>
  );
}

function PayablesWidget() {
  return (
    <div className="smart-list">
      <div className="smart-summary">
        <h2>₱96,800</h2>
        <span>Bills / APV to pay</span>
      </div>

      <div className="smart-item">
        <strong>Due Today</strong>
        <span>₱18,000 scheduled payments</span>
      </div>

      <div className="smart-item warning">
        <strong>Recommendation</strong>
        <span>Review 5 APVs before posting</span>
      </div>
    </div>
  );
}

function SmartBankAccountsWidget() {
  return (
    <div className="bank-list">
      <div className="bank-item">
        <div>
          <strong>Operating Account</strong>
          <span> BDO · status: stable</span>
        </div>
        <div className="bank-right">
          <strong>₱845,230.00</strong>
          <span>12 unreconciled</span>
        </div>
      </div>

      <div className="bank-item">
        <div>
          <strong>Payroll Account</strong>
          <span>BPI · status: reconciled</span>
        </div>
        <div className="bank-right">
          <strong>₱186,400.00</strong>
          <span>Reconciled</span>
        </div>
      </div>

      <div className="ai-bank-note">
        No unusual withdrawals detected in the last 24 hours.
      </div>
    </div>
  );
}

function FinancialHealthWidget() {
  return (
    <div className="health-widget">
      <div className="health-score">
        <span>86</span>
        <small>/100</small>
      </div>

      <div className="health-bars">
        <div>
          <span>Liquidity</span>
          <strong>Healthy</strong>
        </div>
        <div>
          <span>Receivables Risk</span>
          <strong>Medium</strong>
        </div>
        <div>
          <span>Expense Control</span>
          <strong>Normal</strong>
        </div>
      </div>
    </div>
  );
}

function AIAlertsWidget({ navigate }) {
  const alerts = [
    {
      level: "warning",
      text: "Trial Balance difference detected in last generation.",
      action: () => navigate("/reports/trial-balance"),
    },
    {
      level: "info",
      text: "Income Statement is ready for month-end review.",
      action: () => navigate("/reports/income-statement"),
    },
    {
      level: "danger",
      text: "VAT filing review recommended before deadline.",
      action: () => navigate("/reports"),
    },
  ];

  return (
    <div className="alert-list">
      {alerts.map((alert, index) => (
        <button
          key={index}
          className={`alert-item ${alert.level}`}
          onClick={alert.action}
        >
          {alert.text}
        </button>
      ))}
    </div>
  );
}

function AIQuickActionsWidget({ navigate }) {
  return (
    <div className="quick-actions">
      <button onClick={() => navigate("/transactions/invoice")}>Create Invoice</button>
      <button onClick={() => navigate("/transactions/apv")}>Create APV</button>
      <button onClick={() => navigate("/reports/trial-balance")}>Generate TB</button>
      <button onClick={() => navigate("/reports/account-analysis")}>Account Analysis</button>
      <button onClick={() => navigate("/reports/income-statement")}>Income Statement</button>
      <button onClick={() => navigate("/reports/balance-sheet")}>Balance Sheet</button>
    </div>
  );
}

function AIActivityWidget() {
  const activities = [
    "detected ₱38,500 overdue receivables.",
    "APV-0008 is pending approval.",
    "Cash forecast updated for the next 30 days.",
    "Chart of Accounts grouping verified.",
    "Bank reconciliation needs review.",
  ];

  return (
    <div className="activity-list">
      {activities.map((item, index) => (
        <div className="activity-item" key={index}>
          <span className="activity-dot"></span>
          <p>{item}</p>
        </div>
      ))}
    </div>
  );
}

function SystemIntelligenceWidget() {
  return (
    <div className="status-list">
      <div><span>Accounting Engine</span><strong>Online</strong></div>
      <div><span>Insights</span><strong>Active</strong></div>
      <div><span>Database Sync</span><strong>Ready</strong></div>
      <div><span>Report Builder</span><strong>Available</strong></div>
    </div>
  );
}