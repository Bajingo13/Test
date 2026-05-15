import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import "./Dashboard.css";

const STORAGE_KEY = "astrea_modular_dashboard_widgets";

const WIDGET_LIBRARY = [
  { id: "invoices", title: "Invoices owed to you", category: "Finance", size: "small" },
  { id: "apv", title: "Bills / APV to pay", category: "Finance", size: "small" },
  { id: "bankCash", title: "Cash in bank", category: "Banking", size: "small" },
  { id: "bankAccounts", title: "Bank Accounts", category: "Banking", size: "large" },
  { id: "quickActions", title: "Quick Actions", category: "Tools", size: "medium" },
  { id: "recentActivity", title: "Recent Activity", category: "Activity", size: "large" },
  { id: "cashFlow", title: "Cash Flow Snapshot", category: "Reports", size: "medium" },
  { id: "notes", title: "Notes", category: "Tools", size: "medium" },
  { id: "systemStatus", title: "System Status", category: "System", size: "medium" },
];

const DEFAULT_WIDGETS = [
  "invoices",
  "apv",
  "bankCash",
  "bankAccounts",
  "quickActions",
  "recentActivity",
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
  const [activeWidgetIds, setActiveWidgetIds] = useState(getInitialWidgets);

  const activeWidgets = useMemo(
    () => activeWidgetIds
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
      case "invoices":
        return <MoneyWidget amount="₱245,000" detail="₱38,500 overdue" />;
      case "apv":
        return <MoneyWidget amount="₱96,800" detail="5 awaiting approval" />;
      case "bankCash":
        return <MoneyWidget amount="₱1,031,630" detail="Across 2 accounts" />;
      case "bankAccounts":
        return <BankAccountsWidget />;
      case "quickActions":
        return <QuickActionsWidget navigate={navigate} />;
      case "recentActivity":
        return <RecentActivityWidget />;
      case "cashFlow":
        return <CashFlowWidget />;
      case "notes":
        return <NotesWidget />;
      case "systemStatus":
        return <SystemStatusWidget />;
      default:
        return null;
    }
  }

  return (
    <div className="dashboard-page">
      <header className="dashboard-hero">
        <div>
          <p className="dashboard-mini-label">AstreaBlue Accounting</p>
          <h1>Business Dashboard</h1>
          <p className="dashboard-subtext">
            Add, remove, and rearrange widgets based on what you want to monitor.
          </p>
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
              <p>Select widgets to show on your dashboard.</p>
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
    </div>
  );
}

function MoneyWidget({ amount, detail }) {
  return (
    <div className="money-widget">
      <h2>{amount}</h2>
      <p>{detail}</p>
    </div>
  );
}

function BankAccountsWidget() {
  return (
    <div className="bank-list">
      <div className="bank-item">
        <div>
          <strong>Operating Account</strong>
          <span>BDO</span>
        </div>
        <div className="bank-right">
          <strong>₱845,230.00</strong>
          <span>12 unreconciled</span>
        </div>
      </div>

      <div className="bank-item">
        <div>
          <strong>Payroll Account</strong>
          <span>BPI</span>
        </div>
        <div className="bank-right">
          <strong>₱186,400.00</strong>
          <span>Reconciled</span>
        </div>
      </div>
    </div>
  );
}

function QuickActionsWidget({ navigate }) {
  return (
    <div className="quick-actions">
      <button onClick={() => navigate("/transactions/invoice")}>Create Invoice</button>
      <button onClick={() => navigate("/transactions/apv")}>Create APV</button>
      <button onClick={() => navigate("/coa")}>Chart of Accounts</button>
      <button onClick={() => navigate("/general-libraries")}>General Libraries</button>
    </div>
  );
}

function RecentActivityWidget() {
  const activities = [
    "Invoice INV-2026-001 was created.",
    "APV-0008 is pending approval.",
    "ABC Trading record was updated.",
    "COA entry 101001 was edited.",
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

function CashFlowWidget() {
  return (
    <div className="cashflow-bars">
      <div>
        <span>Cash In</span>
        <div className="bar-track">
          <div className="bar-fill cash-in"></div>
        </div>
        <strong>₱245,000</strong>
      </div>

      <div>
        <span>Cash Out</span>
        <div className="bar-track">
          <div className="bar-fill cash-out"></div>
        </div>
        <strong>₱96,800</strong>
      </div>
    </div>
  );
}

function NotesWidget() {
  return (
    <textarea
      className="dashboard-notes"
      placeholder="Write reminders or notes here..."
    />
  );
}

function SystemStatusWidget() {
  return (
    <div className="status-list">
      <div><span>Invoice Module</span><strong>Active</strong></div>
      <div><span>APV Module</span><strong>Active</strong></div>
      <div><span>Database Sync</span><strong>Ready</strong></div>
    </div>
  );
}