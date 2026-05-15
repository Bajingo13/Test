import { useEffect, useMemo, useState } from "react";
import "./Auth.css";
import { getSessionUser, loginUser, logout, registerUser } from "../../auth/auth";

const ROLES = ["Admin", "Accountant", "Auditor"];

export default function Auth({ onAuthed }) {
  const [mode, setMode] = useState("login"); // login | register
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [name, setName] = useState("");
  const [role, setRole] = useState("Accountant");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [remember, setRemember] = useState(true);
  const [showPw, setShowPw] = useState(false);

  useEffect(() => {
    const u = getSessionUser();
    if (u) onAuthed?.(u);
  }, [onAuthed]);

  const canSubmit = useMemo(() => {
    if (!email.trim() || password.length < 4) return false;
    if (mode === "register" && name.trim().length < 2) return false;
    return !loading;
  }, [email, password, name, mode, loading]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      await new Promise((r) => setTimeout(r, 250));

      if (mode === "register") {
        registerUser({
          email: email.trim(),
          password,
          name: name.trim(),
          role,
        });
      }

      const user = loginUser({ email: email.trim(), password, remember });
      onAuthed?.(user);
    } catch (err) {
      setError(err?.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  function switchMode(next) {
    setError("");
    setMode(next);
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-header">
          <div className="badge">Accounting System</div>
          <h1>{mode === "login" ? "Sign in" : "Create account"}</h1>
          <p>
            {mode === "login"
              ? "Enter your credentials to access the accounting dashboard."
              : "Register locally for now (no backend yet)."}
          </p>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          {mode === "register" && (
            <>
              <label className="field">
                <span>Name</span>
                <input
                  type="text"
                  value={name}
                  placeholder="Juan Dela Cruz"
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                />
              </label>

              <label className="field">
                <span>Role</span>
                <select value={role} onChange={(e) => setRole(e.target.value)}>
                  {ROLES.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </label>
            </>
          )}

          <label className="field">
            <span>Email</span>
            <input
              type="email"
              value={email}
              placeholder="you@company.com"
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
            />
          </label>

          <label className="field">
            <span>Password</span>
            <div className="pw-wrap">
              <input
                type={showPw ? "text" : "password"}
                value={password}
                placeholder="••••••••"
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
              />
              <button
                type="button"
                className="pw-toggle"
                onClick={() => setShowPw((v) => !v)}
              >
                {showPw ? "Hide" : "Show"}
              </button>
            </div>
          </label>

          <div className="row">
            <label className="remember">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              Remember me
            </label>

            <button
              type="button"
              className="link"
              onClick={() => {
                logout();
                alert("Session cleared.");
              }}
            >
              Clear session
            </button>
          </div>

          {error && <div className="error">{error}</div>}

          <button className="primary" type="submit" disabled={!canSubmit}>
            {loading
              ? mode === "login"
                ? "Signing in..."
                : "Creating..."
              : mode === "login"
              ? "Sign in"
              : "Create account"}
          </button>

          <div className="switch">
            {mode === "login" ? (
              <>
                No account?{" "}
                <button type="button" className="link" onClick={() => switchMode("register")}>
                  Register
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button type="button" className="link" onClick={() => switchMode("login")}>
                  Sign in
                </button>
              </>
            )}
          </div>
        </form>

        <div className="note">
          <strong>Note:</strong> Frontend-only demo. Credentials are stored in{" "}
          <code>localStorage</code>.
        </div>
      </div>
    </div>
  );
}