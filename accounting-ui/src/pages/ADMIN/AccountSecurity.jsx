import { useState } from "react";
import { authHeaders, handleAuthError, AUTH_NOTICE_KEY, TOKEN_KEY, USER_KEY } from "../../utils/authSession";
import "./AccountSecurity.css";

const API_URL = import.meta.env.VITE_API_URL || "";
const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_CHANGED_MESSAGE = "Password changed successfully. Please log in again.";

// SUPER_ADMIN-only "Account Security" (User Settings tab). Rendered by
// UserSettings.jsx only for roleCode SUPER_ADMIN; the server enforces the same
// rule independently (routes/account.routes.js -> requireSuperAdmin).
// Changes the signed-in account only - no user id is ever sent.

async function postJson(path, body) {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function messageFor(res, data) {
  if (res.status === 403) return "Only a Super Admin can change account credentials.";
  if (res.status === 429) return data.message || "Too many attempts. Please try again later.";
  if (res.status >= 500) return "The change could not be completed. Please try again.";
  return data.message || "The change could not be completed.";
}

function Banner({ state }) {
  if (!state) return null;
  return (
    <div className={`acs-banner acs-banner-${state.tone}`} role={state.tone === "error" ? "alert" : "status"}>
      {state.text}
    </div>
  );
}

function ChangePasswordForm() {
  const [form, setForm] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    if (!form.currentPassword) return setState({ tone: "error", text: "Enter your current password." });
    if (form.newPassword.length < PASSWORD_MIN_LENGTH) return setState({ tone: "error", text: `The new password must be at least ${PASSWORD_MIN_LENGTH} characters.` });
    if (form.newPassword !== form.confirmPassword) return setState({ tone: "error", text: "The new password and its confirmation do not match." });
    setBusy(true);
    setState(null);
    try {
      const { res, data } = await postJson("/api/account/change-password", form);
      if (res.status === 401) return handleAuthError(res.status, data.code);
      if (!res.ok) {
        setForm({ ...form, currentPassword: "" });
        return setState({ tone: "error", text: messageFor(res, data) });
      }
      // Every session (this one included) was revoked server-side: sign out and
      // show the one-shot notice on the Login page.
      try { sessionStorage.setItem(AUTH_NOTICE_KEY, PASSWORD_CHANGED_MESSAGE); } catch { /* storage unavailable */ }
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      window.location.href = "/login";
    } catch {
      setState({ tone: "error", text: "Unable to connect to the server." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="acs-section" onSubmit={submit} noValidate>
      <h3>Change Password</h3>
      <p className="acs-muted">At least {PASSWORD_MIN_LENGTH} characters. You will be signed out of every session and asked to log in again.</p>
      <div className="acs-field">
        <label htmlFor="acs-pw-current">Current Password</label>
        <input id="acs-pw-current" type="password" autoComplete="current-password" value={form.currentPassword} onChange={set("currentPassword")} />
      </div>
      <div className="acs-field">
        <label htmlFor="acs-pw-new">New Password</label>
        <input id="acs-pw-new" type="password" autoComplete="new-password" value={form.newPassword} onChange={set("newPassword")} />
      </div>
      <div className="acs-field">
        <label htmlFor="acs-pw-confirm">Confirm New Password</label>
        <input id="acs-pw-confirm" type="password" autoComplete="new-password" value={form.confirmPassword} onChange={set("confirmPassword")} />
      </div>
      <Banner state={state} />
      <div className="acs-actions">
        <button type="submit" className="acs-btn-primary" disabled={busy}>{busy ? "Saving..." : "Change Password"}</button>
      </div>
    </form>
  );
}

function ChangeUsernameForm({ currentUsername, onChanged }) {
  const [form, setForm] = useState({ currentPassword: "", newUsername: "" });
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    if (!form.currentPassword) return setState({ tone: "error", text: "Enter your current password." });
    if (!form.newUsername.trim()) return setState({ tone: "error", text: "Enter a new username." });
    setBusy(true);
    setState(null);
    try {
      const { res, data } = await postJson("/api/account/change-username", form);
      if (res.status === 401) return handleAuthError(res.status, data.code);
      if (!res.ok) {
        setForm({ ...form, currentPassword: "" });
        return setState({ tone: "error", text: messageFor(res, data) });
      }
      try {
        const stored = JSON.parse(localStorage.getItem(USER_KEY) || "null");
        if (stored) localStorage.setItem(USER_KEY, JSON.stringify({ ...stored, username: data.username }));
      } catch { /* storage unavailable */ }
      setForm({ currentPassword: "", newUsername: "" });
      setState({ tone: "success", text: `Username changed to ${data.username}. Use it the next time you log in.` });
      onChanged?.(data.username);
    } catch {
      setState({ tone: "error", text: "Unable to connect to the server." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="acs-section" onSubmit={submit} noValidate>
      <h3>Change Username</h3>
      <p className="acs-muted">
        Current username: <strong className="acs-current">{currentUsername || "-"}</strong>. 3-100 characters: letters, digits and . _ @ + - only, no spaces.
      </p>
      <div className="acs-field">
        <label htmlFor="acs-un-current">Current Password</label>
        <input id="acs-un-current" type="password" autoComplete="current-password" value={form.currentPassword} onChange={set("currentPassword")} />
      </div>
      <div className="acs-field">
        <label htmlFor="acs-un-new">New Username</label>
        <input id="acs-un-new" type="text" autoComplete="username" value={form.newUsername} onChange={set("newUsername")} />
      </div>
      <Banner state={state} />
      <div className="acs-actions">
        <button type="submit" className="acs-btn-primary" disabled={busy}>{busy ? "Saving..." : "Change Username"}</button>
      </div>
    </form>
  );
}

export default function AccountSecurity({ currentUsername, onUsernameChanged }) {
  return (
    <div className="acs-root">
      <h2 className="acs-title">Account Security</h2>
      <div className="acs-grid">
        <ChangePasswordForm />
        <ChangeUsernameForm currentUsername={currentUsername} onChanged={onUsernameChanged} />
      </div>
    </div>
  );
}
