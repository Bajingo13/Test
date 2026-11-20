import { useEffect } from "react";
import { getToken, TOKEN_KEY, handleAuthError, tokenExpiry } from "../utils/authSession";

// Inactivity timeout - browser side (security mitigation A).
//
// The SERVER enforces the 15-minute timeout: a session token expires 15 minutes
// after it was issued (backend lib/sessionPolicy.js) and every API call with an
// expired token is refused with 401 SESSION_EXPIRED. This component only:
//   1. extends the session while the user is genuinely active - after real input
//      (mouse, keyboard, touch, scroll) it calls POST /api/auth/keepalive, which
//      re-issues a fresh token; background requests never extend it, so an
//      untouched tab expires; and
//   2. signs an idle tab out as soon as its token has expired (even without a
//      request), showing the inactivity message on the Login page.
// Nothing is ever saved or submitted automatically.
const API_BASE = import.meta.env.VITE_API_URL || "";
const ACTIVITY_EVENTS = ["mousedown", "mousemove", "keydown", "touchstart", "wheel", "scroll"];
const CHECK_EVERY_MS = 15000;

export default function SessionKeepAlive() {
  useEffect(() => {
    if (!getToken()) return undefined;
    let lastActivity = Date.now();
    let lastRefresh = Date.now();
    let refreshing = false;

    const idleWindowMs = () => {
      try {
        const payload = JSON.parse(atob(getToken().split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        return Math.max(30000, (Number(payload.exp) - Number(payload.iat)) * 1000);
      } catch {
        return 15 * 60 * 1000;
      }
    };
    const refreshEveryMs = () => Math.min(60000, idleWindowMs() / 3);

    function expireIfDue() {
      const exp = tokenExpiry();
      if (exp && Date.now() >= exp * 1000) {
        handleAuthError(401, "SESSION_EXPIRED");
        return true;
      }
      return false;
    }

    async function refresh() {
      if (refreshing || !getToken() || expireIfDue()) return;
      refreshing = true;
      try {
        const res = await fetch(`${API_BASE}/api/auth/keepalive`, { method: "POST", headers: { Authorization: `Bearer ${getToken()}` } });
        if (res.ok) {
          const data = await res.json();
          if (data?.token) localStorage.setItem(TOKEN_KEY, data.token);
          lastRefresh = Date.now();
        }
        // a 401 is handled by the global fetch guard (sign-out + Login message)
      } catch {
        // network trouble: try again on the next activity / check
      } finally {
        refreshing = false;
      }
    }

    function onActivity() {
      lastActivity = Date.now();
      if (Date.now() - lastRefresh >= refreshEveryMs()) refresh();
    }

    function tick() {
      if (expireIfDue()) return;
      if (lastActivity > lastRefresh && Date.now() - lastRefresh >= refreshEveryMs()) refresh();
    }

    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    const onVisible = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(tick, CHECK_EVERY_MS);
    tick();
    return () => {
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, onActivity));
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, []);

  return null;
}
