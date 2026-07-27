import { useState } from "react";
import { Link } from "react-router-dom";
import AIReconChat from "./AIReconChat.jsx";
import BankReconResults from "./BankReconResults.jsx";
import "./AIRecon.css";

export default function BankReconDashboard() {
  const [activeSessionId, setActiveSessionId] = useState(null);

  return (
    <div className="air-page">
      <div className="air-header-card">
        <div>
          <h1>AI Reconciliation Assistant</h1>
          <p>
            Describe what you need in plain language - the assistant drives the same
            deterministic matching engine as the manual workspace. It never posts journal
            entries, finalizes a session, or reopens one; those stay a human click away.
          </p>
        </div>
        <Link to="/reports/bank-reconciliation" className="air-back-link">
          Manual Workspace List
        </Link>
      </div>

      <div className="air-grid">
        <AIReconChat onSessionChange={setActiveSessionId} />
        <BankReconResults sessionId={activeSessionId} />
      </div>
    </div>
  );
}
