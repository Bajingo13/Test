import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import "./AcceptInvite.css";

const API_URL = import.meta.env.VITE_API_URL || "";

export default function AcceptInvite() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") || "";

  const [invitation, setInvitation] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  useEffect(() => {
    if (!token) {
      setLoadError("This invitation link is missing its token.");
      setLoading(false);
      return;
    }

    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/invitations/validate/${token}`);
        const data = await res.json();
        if (!res.ok) {
          setLoadError(data.message || "This invitation link is invalid.");
          return;
        }
        setInvitation(data);
      } catch (err) {
        console.error("VALIDATE INVITATION ERROR:", err);
        setLoadError("Unable to connect to the server.");
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitError("");

    if (password.length < 8) {
      setSubmitError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setSubmitError("Passwords do not match.");
      return;
    }
    if (!acceptedTerms) {
      setSubmitError("You must accept the terms to continue.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`${API_URL}/api/invitations/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password, acceptedTerms }),
      });
      const data = await res.json();

      if (!res.ok) {
        setSubmitError(data.message || "Failed to activate your account.");
        return;
      }

      localStorage.setItem("token", data.token);
      localStorage.setItem("user", JSON.stringify(data.user));
      navigate("/dashboard");
    } catch (err) {
      console.error("ACCEPT INVITATION ERROR:", err);
      setSubmitError("Unable to connect to the server.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="ai-page">
      <div className="ai-card">
        <h1>Set Up Your Account</h1>

        {loading && <p className="ai-muted">Checking your invitation...</p>}

        {!loading && loadError && (
          <div className="ai-error-banner">{loadError}</div>
        )}

        {!loading && invitation && (
          <>
            <p className="ai-muted">
              You've been invited as <strong>{invitation.fullName}</strong> ({invitation.email}) with the role{" "}
              <strong>{invitation.roleName}</strong>
              {invitation.companyNames?.length > 0 && (
                <> at <strong>{invitation.companyNames.join(", ")}</strong></>
              )}
              . Set a password to activate your account.
            </p>

            <form onSubmit={handleSubmit}>
              <div className="ai-field">
                <label>Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  autoComplete="new-password"
                  required
                />
              </div>

              <div className="ai-field">
                <label>Confirm Password</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                />
              </div>

              <label className="ai-checkbox">
                <input
                  type="checkbox"
                  checked={acceptedTerms}
                  onChange={(e) => setAcceptedTerms(e.target.checked)}
                />
                <span>I accept the applicable terms and policies.</span>
              </label>

              {submitError && <div className="ai-error-banner">{submitError}</div>}

              <button type="submit" className="ai-submit" disabled={submitting}>
                {submitting ? "Activating..." : "Activate Account"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
