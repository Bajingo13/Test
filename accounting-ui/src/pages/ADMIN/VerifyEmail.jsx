import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import "./AcceptInvite.css";

const API_URL = import.meta.env.VITE_API_URL || "";

// Public page for the one-time notification-email confirmation link
// (POST /api/account/email/verify). Nothing is submitted on page load: mail
// scanners and link previews open links automatically, and a GET must never
// consume the single-use token - the owner confirms with the button.
export default function VerifyEmail() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") || "";
  const [state, setState] = useState(token ? "ready" : "missing");
  const [message, setMessage] = useState("");

  async function confirm() {
    setState("working");
    try {
      const res = await fetch(`${API_URL}/api/account/email/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setState("error");
        setMessage(res.status === 429 ? "Too many attempts. Please try again later." : data.message || "This verification link is invalid or has already been used.");
        return;
      }
      setState("done");
      setMessage(data.message || "Your notification email has been confirmed.");
    } catch {
      setState("error");
      setMessage("Unable to connect to the server.");
    }
  }

  return (
    <div className="ai-page">
      <div className="ai-card">
        <h1>Confirm Notification Email</h1>
        {state === "missing" && <div className="ai-error-banner" role="alert">This confirmation link is missing its token.</div>}
        {(state === "ready" || state === "working") && (
          <>
            <p className="ai-muted">Confirm that this address should receive security notices for your accounting system account.</p>
            <button type="button" className="ai-submit" onClick={confirm} disabled={state === "working"}>
              {state === "working" ? "Confirming..." : "Confirm email"}
            </button>
          </>
        )}
        {state === "done" && <p role="status">{message}</p>}
        {state === "error" && <div className="ai-error-banner" role="alert">{message}</div>}
        <p className="ai-muted"><Link to="/login">Go to Login</Link></p>
      </div>
    </div>
  );
}
