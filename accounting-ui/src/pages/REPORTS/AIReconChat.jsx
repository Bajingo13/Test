import { useEffect, useRef, useState } from "react";

const API_BASE = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function handleAuthError(status) {
  if (status === 401 || status === 403) {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    if (window.location.pathname !== "/login") {
      window.location.href = "/login";
    }
    return true;
  }
  return false;
}

const SUGGESTIONS = [
  "Generate the bank reconciliation for BDO Account 001 as of July 31, 2026.",
  "Show outstanding checks",
  "Show deposits in transit",
  "Match transactions within 3 days and allow a ₱1.00 variance.",
  "Explain why this is not balanced",
  "Confirm all exact matches",
];

// Requirement #7: visible mode indicator - AI mode / Local rule-based mode /
// Anthropic unavailable. `mode` comes back per-message from the backend
// (services/ai/index.js), so each assistant reply gets its own accurate
// badge instead of one static label for the whole conversation.
function ModePill({ mode }) {
  const labels = {
    anthropic: "AI Mode (Anthropic)",
    mock: "Rule-Based Mode",
    local: "Rule-Based Mode (Local)",
    fallback: "Anthropic Unavailable - Rule-Based Fallback",
  };
  const cls = labels[mode] ? mode : "unknown";
  return <span className={`air-mode-pill ${cls}`}>{labels[mode] || "Unknown Mode"}</span>;
}

function ConfiguredBadge({ status }) {
  if (!status) return null;

  if (status.configuredProvider === "anthropic") {
    return status.anthropicKeyPresent ? (
      <span className="air-mode-pill anthropic">Configured: Anthropic AI</span>
    ) : (
      <span className="air-mode-pill fallback">Configured: Anthropic (no API key set)</span>
    );
  }

  return (
    <span className={`air-mode-pill ${status.configuredProvider === "local" ? "local" : "mock"}`}>
      Configured: Rule-Based Mode
    </span>
  );
}

export default function AIReconChat({ onSessionChange }) {
  const [status, setStatus] = useState(null);
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    loadStatus();
    startConversation();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function loadStatus() {
    try {
      const res = await fetch(`${API_BASE}/api/ai/bank-recon/status`, {
        credentials: "include",
        headers: authHeaders(),
      });
      const data = await res.json();
      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        return;
      }
      setStatus(data);
    } catch (err) {
      console.error("LOAD AI RECON STATUS ERROR:", err);
    }
  }

  async function startConversation() {
    try {
      const res = await fetch(`${API_BASE}/api/ai/bank-recon/conversations`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
      });
      const data = await res.json();
      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        return;
      }
      setConversationId(data.id);
    } catch (err) {
      console.error("START AI RECON CONVERSATION ERROR:", err);
    }
  }

  async function sendMessage(text) {
    const trimmed = (text ?? input).trim();
    if (!trimmed || sending) return;

    let convId = conversationId;
    if (!convId) {
      await startConversation();
      return;
    }

    setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
    setInput("");
    setSending(true);

    try {
      const res = await fetch(
        `${API_BASE}/api/ai/bank-recon/conversations/${convId}/messages`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ message: trimmed }),
        }
      );
      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.message || "Something went wrong.", mode: "unknown" },
        ]);
        return;
      }

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.reply,
          mode: data.mode,
          fallbackReason: data.fallbackReason,
        },
      ]);

      if (data.sessionId) {
        onSessionChange?.(data.sessionId);
      }
    } catch (err) {
      console.error("SEND AI RECON MESSAGE ERROR:", err);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Unable to connect to server.", mode: "unknown" },
      ]);
    } finally {
      setSending(false);
    }
  }

  function handleInputKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
    <div className="air-card air-chat">
      <div className="air-chat-topbar">
        <h2>Ask the Reconciliation Assistant</h2>
        <ConfiguredBadge status={status} />
      </div>

      <div className="air-messages">
        {messages.length === 0 && (
          <div className="air-empty-chat">
            Ask about a bank account and period, e.g. "Generate the bank reconciliation for
            BDO Account 001 as of July 31, 2026." I only read and run the existing
            reconciliation engine - I never post journal entries or finalize a session on
            my own.
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`air-msg ${m.role}`}>
            {m.content}
            {m.role === "assistant" && m.mode && (
              <div className="air-msg-meta">
                <ModePill mode={m.mode} />
                {m.mode === "fallback" && m.fallbackReason && (
                  <span className="air-msg-fallback-reason">({m.fallbackReason})</span>
                )}
              </div>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="air-suggestions">
        {SUGGESTIONS.map((s) => (
          <button key={s} className="air-suggestion-chip" onClick={() => sendMessage(s)}>
            {s}
          </button>
        ))}
      </div>

      <div className="air-chat-inputbar">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleInputKeyDown}
          placeholder="Type a message..."
          disabled={sending}
        />
        <button onClick={() => sendMessage()} disabled={sending || !input.trim()}>
          {sending ? "Sending..." : "Send"}
        </button>
      </div>
    </div>
  );
}
