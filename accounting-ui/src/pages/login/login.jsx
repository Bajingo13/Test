import { useState } from "react";
import { useNavigate } from "react-router-dom";
import "./login.css";

export default function Login() {
  const navigate = useNavigate();

  const [form, setForm] = useState({
    username: "",
    password: "",
    remember: false,
  });

  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  function handleChange(e) {
    const { name, value, type, checked } = e.target;
    setForm((prev) => ({
      ...prev,
      [name]: type === "checkbox" ? checked : value,
    }));
  }

  async function handleSubmit(e) {
    e.preventDefault();

    if (!form.username.trim() || !form.password.trim()) {
      alert("Please enter your username and password.");
      return;
    }

    try {
      setLoading(true);

      const response = await fetch("http://localhost:8080/api/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          username: form.username,
          password: form.password,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        alert(data.message || "Login failed");
        return;
      }

      alert(data.message || "Login successful");
      navigate("/dashboard");
    } catch (error) {
      console.error("LOGIN ERROR:", error);
      alert("Unable to connect to the server.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-overlay" />

      <div className="login-container">
        <div className="login-left">
          <div className="login-brand">AstreaBlue</div>
          <h1 className="login-heading">Welcome back</h1>
          <p className="login-subtext">
            Sign in to continue managing your accounting transactions,
            vouchers, and reports.
          </p>

          <div className="login-feature-box">
            <div className="login-feature-title">Accounting System</div>
            <div className="login-feature-text">
              Secure access to vouchers, journal entries, ledgers, and reports.
            </div>
          </div>
        </div>

        <div className="login-right">
          <form className="login-card" onSubmit={handleSubmit}>
            <h2 className="login-card-title">Sign In</h2>
            <p className="login-card-subtitle">
              Enter your account credentials below
            </p>

            <div className="login-field">
              <label className="login-label">Username</label>
              <input
                type="text"
                name="username"
                value={form.username}
                onChange={handleChange}
                placeholder="Enter your username"
                className="login-input"
                required
              />
            </div>

            <div className="login-field">
              <label className="login-label">Password</label>
              <div className="login-password-wrap">
                <input
                  type={showPassword ? "text" : "password"}
                  name="password"
                  value={form.password}
                  onChange={handleChange}
                  placeholder="Enter your password"
                  className="login-input"
                  required
                />
                <button
                  type="button"
                  className="login-show-btn"
                  onClick={() => setShowPassword((prev) => !prev)}
                >
                  {showPassword ? "Hide" : "Show"}
                </button>
              </div>
            </div>

            <div className="login-options">
              <label className="login-checkbox-wrap">
                <input
                  type="checkbox"
                  name="remember"
                  checked={form.remember}
                  onChange={handleChange}
                />
                <span>Remember me</span>
              </label>

              <button type="button" className="login-link-btn">
                Forgot password?
              </button>
            </div>

            <button type="submit" className="login-submit-btn" disabled={loading}>
              {loading ? "Logging in..." : "Login"}
            </button>

            <div className="login-footer-text">
              Protected system access for authorized users only
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}