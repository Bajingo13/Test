const fs = require("fs");
const path = require("path");

// Authentication security - browser side (source guards; node-only jest - the screens
// are verified in a real browser separately). TC-SEC-005 (UI), mitigation A wiring.

const SRC = path.join(__dirname, "../..");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8").replace(/\r\n/g, "\n");

describe("inactivity sign-out in the browser", () => {
  const session = read("utils/authSession.js");
  const keep = read("components/SessionKeepAlive.jsx");

  test("a 401 signs out to Login with the inactivity message - no alert(), no auto-submit", () => {
    expect(session).toContain('"Your session has expired due to inactivity. Please log in again."');
    expect(session).toContain("AUTH_NOTICE_KEY");
    expect(session.replace(/^\s*\/\/.*$/gm, "")).not.toMatch(/\balert\(/); // comments still mention the old alert()
    expect(read("utils/installAuthFetchGuard.js")).toMatch(/handleAuthError\(401, code\)/);
    expect(read("api.js")).toMatch(/handleAuthError\(401, data\?\.code\)/);
  });

  test("SessionKeepAlive is mounted on app pages only, refreshes on real activity, expires idle tabs", () => {
    expect(read("App.jsx")).toContain("{!isLoginPage && !isPrintPage && !isVerifyPage && <SessionKeepAlive />}");
    expect(keep).toContain("/api/auth/keepalive");
    expect(keep).toMatch(/ACTIVITY_EVENTS = \["mousedown", "mousemove", "keydown", "touchstart", "wheel", "scroll"\]/);
    expect(keep).toContain('handleAuthError(401, "SESSION_EXPIRED")');
    expect(keep).not.toMatch(/\.submit\(|requestSubmit|method: "PUT"|method: "PATCH"/);
  });

  test("Login shows the one-shot notice and errors in-page (no alert())", () => {
    const login = read("pages/login/login.jsx");
    expect(login).toMatch(/sessionStorage\.removeItem\(AUTH_NOTICE_KEY\)/);
    expect(login).toContain('className="login-notice" role="status"');
    expect(login).toContain('className="login-error" role="alert"');
    expect(login).not.toMatch(/\balert\(/);
    const css = read("pages/login/login.css");
    expect(css).toContain(".login-notice");
    expect(css).toContain(".login-error");
  });
});
