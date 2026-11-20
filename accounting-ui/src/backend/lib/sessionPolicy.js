// Session policy - inactivity timeout (security mitigation A).
//
// Uses the EXISTING authentication design (a signed JWT, re-checked against the
// users row on every request by middleware/authenticate.js) - no second session
// mechanism. A session token is valid for SESSION_IDLE_SECONDS (15 minutes) from
// the moment it is issued; the server's signature/expiry check enforces it, so no
// client-side code can extend a token that has already expired.
//
// Activity extends the session: while the user is active the browser calls
// POST /api/auth/keepalive (only after real user interaction - mouse, keyboard,
// touch - never from background requests), which re-issues a fresh 15-minute
// token. A tab left untouched therefore stops extending and expires on the server.
// Revocation is unchanged (users.token_version, status).
const jwt = require("jsonwebtoken");

// Overridable for LOCAL testing only (e.g. a 60-second idle window in a browser UAT).
const SESSION_IDLE_SECONDS = Number(process.env.SESSION_IDLE_SECONDS) > 0 ? Number(process.env.SESSION_IDLE_SECONDS) : 15 * 60;
const SESSION_EXPIRED_MESSAGE = "Your session has expired due to inactivity. Please log in again.";

function signSessionToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, tv: user.token_version ?? user.tv ?? 0 },
    process.env.JWT_SECRET,
    { expiresIn: SESSION_IDLE_SECONDS }
  );
}

module.exports = { SESSION_IDLE_SECONDS, SESSION_EXPIRED_MESSAGE, signSessionToken };
