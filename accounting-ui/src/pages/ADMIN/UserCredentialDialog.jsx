import { useEffect, useRef, useState } from "react";
import { authHeaders, handleAuthError } from "../../utils/authSession";

const API_URL = import.meta.env.VITE_API_URL || "";
const PASSWORD_MIN_LENGTH = 8;

// User List -> Reset Password / Change Username for ANOTHER user. Offered only
// when the server reports credentialManagement.manageUserCredentials (ALAS) and
// the row is a user the actor manages; the server re-checks every rule
// (POST /api/users/:id/reset-password | /change-username).
// The typed password lives only in this dialog's state and is cleared on close.
export default function UserCredentialDialog({ dialog, onClose, onDone }) {
  const [form, setForm] = useState({ newPassword: "", confirmPassword: "", newUsername: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const firstRef = useRef(null);

  useEffect(() => {
    setForm({ newPassword: "", confirmPassword: "", newUsername: "" });
    setError("");
    if (!dialog) return undefined;
    firstRef.current?.focus();
    const onKey = (e) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog]);

  if (!dialog) return null;
  const isPassword = dialog.kind === "PASSWORD";
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    if (isPassword) {
      if (form.newPassword.length < PASSWORD_MIN_LENGTH) return setError(`The new password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
      if (form.newPassword !== form.confirmPassword) return setError("The new password and its confirmation do not match.");
    } else if (!form.newUsername.trim()) {
      return setError("Enter a new username.");
    }
    setBusy(true);
    setError("");
    try {
      const path = dialog.kind === "USERNAME" ? "change-username" : "reset-password";
      const body = isPassword
        ? { newPassword: form.newPassword, confirmPassword: form.confirmPassword }
        : { newUsername: form.newUsername };
      const res = await fetch(`${API_URL}/api/users/${dialog.user.id}/${path}`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) return handleAuthError(res.status, data.code);
      if (!res.ok) {
        setForm({ ...form, newPassword: "", confirmPassword: "" });
        return setError(res.status >= 500 ? "The change could not be completed. Please try again." : data.message || "The change could not be completed.");
      }
      setForm({ newPassword: "", confirmPassword: "", newUsername: "" });
      onDone(data.message);
    } catch {
      setError("Unable to connect to the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ul-confirm-overlay" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className="ul-confirm ul-cred" role="dialog" aria-modal="true" aria-labelledby="ul-cred-title" onSubmit={submit} noValidate>
        <h3 id="ul-cred-title">{isPassword ? "Reset password" : "Change username"}</h3>
        <p>
          {isPassword
            ? `Set a new password for ${dialog.name}. They will be signed out of every device and must use the new password. Share it with them securely.`
            : `Current username: ${dialog.user.username}. 3-100 characters: letters, digits and . _ @ + - only, no spaces.`}
        </p>
        {isPassword ? (
          <>
            <label className="ul-cred-field" htmlFor="ul-cred-new">
              New Password
              <input id="ul-cred-new" ref={firstRef} type="password" autoComplete="new-password" value={form.newPassword} onChange={set("newPassword")} />
            </label>
            <label className="ul-cred-field" htmlFor="ul-cred-confirm">
              Confirm New Password
              <input id="ul-cred-confirm" type="password" autoComplete="new-password" value={form.confirmPassword} onChange={set("confirmPassword")} />
            </label>
          </>
        ) : (
          <label className="ul-cred-field" htmlFor="ul-cred-username">
            New Username
            <input id="ul-cred-username" ref={firstRef} type="text" autoComplete="off" value={form.newUsername} onChange={set("newUsername")} />
          </label>
        )}
        {error && <div className="ul-error-banner" role="alert">{error}</div>}
        <div className="ul-confirm-actions">
          <button type="button" className="ul-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="ul-btn ul-btn-primary-solid" disabled={busy}>
            {busy ? "Saving..." : isPassword ? "Reset Password" : "Change Username"}
          </button>
        </div>
      </form>
    </div>
  );
}
