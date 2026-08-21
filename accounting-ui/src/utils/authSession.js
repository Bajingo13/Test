// System-wide authentication audit: the app had no single shared helper for
// attaching the JWT to a request or reacting to an auth failure - ~48 pages
// each carried their own copy-pasted `authHeaders()`, and a smaller subset
// also carried their own `handleAuthError()`. Two real bugs came out of
// that duplication:
//
// 1. A handful of File Setup pages (Group Code among them) never got the
//    `authHeaders()` copy-paste at all, so every request they make is
//    missing the Authorization header entirely and always fails with the
//    backend's literal "Access token required" (401) message - not a token
//    expiry issue, not a JWT_SECRET issue, just a missing header.
// 2. Every existing `handleAuthError(status)` copy (and src/api.js's own
//    inline equivalent) treated 401 and 403 identically - clearing the
//    session and redirecting to /login on BOTH. A 403 means "you're
//    authenticated but not allowed to do this" (see
//    middleware/authorizePermission.js on the backend) and must never log
//    the user out.
//
// This module is the single place both bugs are fixed, and every page that
// used to duplicate this logic now imports it instead - consolidating
// through one shared layer rather than patching each copy individually.
export const TOKEN_KEY = "token";
export const USER_KEY = "user";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Module-level guard: several requests on one page can fail with 401
// concurrently (e.g. a dashboard firing 5 GETs at once against an expired
// token) - without this, each would independently clear localStorage and
// call `window.location.href`, and every caller's own catch block would
// still show its own alert() first, stacking up several identical
// "Access token required" / "Session expired" alerts before the redirect
// takes effect. This guard makes only the first 401 actually act; every
// concurrent one after it is a no-op.
let sessionExpiredHandled = false;

// Returns true only when this WAS a 401 it just handled (session cleared,
// redirect issued) - callers keep their existing `if (handleAuthError(res.status)) return;`
// pattern working unchanged. A 403 (or any other status) returns false, so
// the caller falls through to its normal error display instead of being
// logged out - the fix for bug #2 above.
export function handleAuthError(status) {
  if (status !== 401) return false;

  if (sessionExpiredHandled) return true;
  sessionExpiredHandled = true;

  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);

  if (window.location.pathname !== "/login") {
    alert("Your session has expired. Please sign in again.");
    window.location.href = "/login";
  }

  return true;
}
