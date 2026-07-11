import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiPost } from "../../api";
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
  const [loginSuccessAnim, setLoginSuccessAnim] = useState(false);

  const [bubbleStates, setBubbleStates]= useState({
    APV: false,
    COA: false,
    Reports: false,
  });

  const canLogin = form.username.trim() && form.password.trim();

  function handleChange(e) {
    const { name, value, type, checked } = e.target;

    setForm((prev) => ({
      ...prev,
      [name]: type === "checkbox" ? checked : value,
    }));
  }

  function handleBubbleClick(name) {
    setBubbleStates((prev) => ({
      ...prev,
      [name]: true,
    }));

    setTimeout(() => {
      setBubbleStates((prev) => ({
        ...prev,
        [name]: false,
      }));
    }, 5000);
  }

  function getBubbleClass(name) {
    return bubbleStates[name] ? "bubble-pop-three" : "";
  }

  async function handleSubmit(e) {
    e.preventDefault();

    if (!form.username.trim() || !form.password.trim()) {
      alert("Please enter your username and password.");
      return;
    }

    try {
      setLoading(true);

      const data = await apiPost("/api/login", {
        username: form.username,
        password: form.password,
      });

      localStorage.setItem("token", data.token);
      localStorage.setItem("user", JSON.stringify(data.user));

      setLoginSuccessAnim(true);

      setTimeout(() => {
        navigate("/dashboard");
      }, 900);
    } catch (error) {
      console.error("LOGIN ERROR:", error);
      alert(
        error instanceof TypeError
          ? "Unable to connect to the server."
          : error.message || "Login failed"
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={`login-page ${loginSuccessAnim ? "login-success" : ""}`}>
      <div className="login-bg-glow glow-one"></div>
      <div className="login-bg-glow glow-two"></div>

      <div className="login-shell">
        <div className="login-left">
          <form className="login-card" onSubmit={handleSubmit}>
            <div className="login-logo-wrap">
              <img
                src="/all_image/astrea-logo.png"
                alt="AstreaBlue"
                className="login-logo"
              />
            </div>

            <h1>Sign in</h1>
            <p className="login-subtitle">Access your accounting system</p>

            <div className="login-field">
              <span className="field-icon">👤</span>
              <input
                type="text"
                name="username"
                value={form.username}
                onChange={handleChange}
                placeholder="Username"
                autoComplete="username"
                required
              />
            </div>

            <div className="login-field">
              <span className="field-icon">🔒</span>
              <input
                type={showPassword ? "text" : "password"}
                name="password"
                value={form.password}
                onChange={handleChange}
                placeholder="Password"
                autoComplete="current-password"
                required
              />

              <button
                type="button"
                className="password-eye"
                onClick={() => setShowPassword((prev) => !prev)}
              >
                {showPassword ? "🙈" : "👁"}
              </button>
            </div>

            <div className="login-options">
              <label>
                <input
                  type="checkbox"
                  name="remember"
                  checked={form.remember}
                  onChange={handleChange}
                />
                <span>Remember me</span>
              </label>

              <button type="button">Forgot password?</button>
            </div>

            {canLogin ? (
              <button
                type="submit"
                className={`login-submit ${loading ? "is-loading" : ""}`}
                disabled={loading}
              >
                <span>{loading ? "Signing in..." : "Sign In"}</span>
                <i></i>
              </button>
            ) : (
              <div className="login-placeholder">
                Enter username and password to continue
              </div>
            )}

            <div className="login-divider">
              <span></span>
              <p>Authorized users only</p>
              <span></span>
            </div>
          </form>
        </div>

        <div className="login-right">
          <button
            type="button"
            data-label="APV"
            className={`floating-card card-one ${getBubbleClass("APV")}`}
            onClick={() => handleBubbleClick("APV")}
          >
            APV
          </button>

          <button
            type="button"
            data-label="COA"
            className={`floating-card card-two ${getBubbleClass("COA")}`}
            onClick={() => handleBubbleClick("COA")}
          >
            COA
          </button>

          <button
            type="button"
            data-label="Reports"
            className={`floating-card card-three ${getBubbleClass("Reports")}`}
            onClick={() => handleBubbleClick("Reports")}
          >
            Reports
          </button>

          <div className="dashboard-graphic">
            <div className="chart-card mini-card"></div>

            <div className="main-graphic-card">
              <div className="pie-chart">
                <span></span>
              </div>

              <div className="line-list">
                <span></span>
                <span></span>
                <span></span>
              </div>

              <div className="bar-chart">
                <span></span>
                <span></span>
                <span></span>
                <span></span>
              </div>
            </div>
          </div>

          <div className="right-content">
            <h2>Accounting System</h2>
            <p>Where Finance Meets Efficiency.</p>
          </div>

          <div className="feature-row">
            <div>
              <span>▣</span>
              <p>Transactions</p>
            </div>
            <div>
              <span>□</span>
              <p>Vouchers</p>
            </div>
            <div>
              <span>▤</span>
              <p>Reports</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}