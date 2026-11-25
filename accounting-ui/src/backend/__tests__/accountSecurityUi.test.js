const fs = require("fs");
const path = require("path");

// Account Security UI (source guards; node-only jest, no jsdom - the screens are
// verified in a real browser separately). The server enforces SUPER_ADMIN on
// /api/account/* independently (accountCredentials.http.test.js).
const ADMIN = path.join(__dirname, "../../pages/ADMIN");
const read = (f) => fs.readFileSync(path.join(ADMIN, f), "utf8");
const settings = read("UserSettings.jsx");
const security = read("AccountSecurity.jsx");
const css = read("AccountSecurity.css");

describe("Account Security tab follows the server's credential policy", () => {
  test("the tab is added only when the server reports changeOwnCredentials (default: SUPER_ADMIN only)", () => {
    expect(settings).toMatch(/const NO_CREDENTIALS = \{ changeOwnCredentials: false, manageUserCredentials: false, notificationEmail: false \};/);
    expect(settings).toMatch(/setCredentials\(\{ \.\.\.NO_CREDENTIALS, \.\.\.\(data\.credentialManagement \|\| \{\}\) \}\);/);
    expect(settings).toMatch(/const canChangeOwnCredentials = credentials\.changeOwnCredentials === true;/);
    expect(settings).toMatch(/\[\.\.\.TABS, \.\.\.\(canChangeOwnCredentials \? SECURITY_TABS : \[\]\)\]/);
    expect(settings).toMatch(/activeTab === "security" && canChangeOwnCredentials && \(/);
    // the client never decides by role name
    expect(settings).not.toMatch(/roleCode === "SUPER_ADMIN"/);
    // the base tab list for everyone else is unchanged
    expect(settings).toMatch(/const TABS = \[\n  \{ id: "users", label: "User List" \},\n  \{ id: "invitations", label: "Pending Invitations" \},\n\];/);
  });
  test("the Notification Email form is shown only when the server says so (SUPER_ADMIN)", () => {
    expect(settings).toMatch(/showNotificationEmail=\{credentials\.notificationEmail === true\}/);
    expect(security).toMatch(/showNotificationEmail = false \}\)/);
    expect(security).toMatch(/\{showNotificationEmail && <NotificationEmailForm \/>\}/);
  });
  test("User List credential actions are passed only the server capability", () => {
    expect(settings).toMatch(/canManageCredentials=\{credentials\.manageUserCredentials === true\}/);
    const list = read("UserList.jsx");
    expect(list).toMatch(/canManageCredentials = false \}/);
    expect(list).toMatch(/\{canManageCredentials && \(/);
  });
});

describe("User credential dialog (Reset Password / Change Username)", () => {
  const dialog = read("UserCredentialDialog.jsx");
  test("posts to the per-user administrative endpoints with only the new value", () => {
    expect(dialog).toMatch(/`\$\{API_URL\}\/api\/users\/\$\{dialog\.user\.id\}\/\$\{path\}`/);
    expect(dialog).toMatch(/dialog\.kind === "USERNAME" \? "change-username" : "reset-password"/);
    expect(dialog).toMatch(/\{ newPassword: form\.newPassword, confirmPassword: form\.confirmPassword \}/);
    expect(dialog).toMatch(/\{ newUsername: form\.newUsername \}/);
    expect(dialog).toMatch(/method: "POST"/);
  });
  test("passwords are never logged, kept after an error, or put in the URL", () => {
    expect(dialog).not.toMatch(/console\.(log|error|warn|info)/);
    expect(dialog).toMatch(/setForm\(\{ \.\.\.form, newPassword: "", confirmPassword: "" \}\)/);
    expect(dialog).not.toMatch(/\?newPassword|\?password/);
    expect(dialog).toMatch(/autoComplete="new-password"/);
    expect(dialog).not.toMatch(/\balert\(|\bconfirm\(|\bprompt\(/);
  });
  test("expired / revoked session goes through the shared auth-error handler", () => {
    expect(dialog).toMatch(/if \(res\.status === 401\) return handleAuthError\(res\.status, data\.code\);/);
  });
});

describe("Account Security forms", () => {
  test("Change Password: current / new / confirm, posts to the self-service endpoint only", () => {
    for (const id of ["acs-pw-current", "acs-pw-new", "acs-pw-confirm"]) expect(security).toContain(`id="${id}"`);
    expect(security).toContain('postJson("/api/account/change-password", form)');
    expect(security).toMatch(/autoComplete="current-password"/);
    expect(security).toMatch(/autoComplete="new-password"/);
  });
  test("Change Username: current password + new username", () => {
    for (const id of ["acs-un-current", "acs-un-new"]) expect(security).toContain(`id="${id}"`);
    expect(security).toContain('postJson("/api/account/change-username", form)');
  });
  test("no target user id is ever sent; nothing goes into the URL", () => {
    expect(security).not.toMatch(/userId|user_id|targetUser/);
    expect(security).not.toMatch(/change-(password|username)\?/);
    expect(security).toMatch(/method: "POST"/);
  });
  test("password change signs out and shows the one-shot Login notice", () => {
    expect(security).toContain('export const PASSWORD_CHANGED_MESSAGE = "Password changed successfully. Please log in again.";');
    expect(security).toMatch(/sessionStorage\.setItem\(AUTH_NOTICE_KEY, PASSWORD_CHANGED_MESSAGE\)/);
    expect(security).toMatch(/localStorage\.removeItem\(TOKEN_KEY\);\s*localStorage\.removeItem\(USER_KEY\);\s*window\.location\.href = "\/login";/);
  });
  test("an expired / revoked session goes through the shared auth-error handler", () => {
    // password form, username form, notification-email form (load + submit)
    expect(security.match(/if \(res\.status === 401\) return handleAuthError\(res\.status, data\.code\);/g)).toHaveLength(4);
  });
  test("in-page messages only (no native dialogs), errors announced as alerts", () => {
    expect(security).not.toMatch(/\balert\(|\bconfirm\(|\bprompt\(/);
    expect(security).toMatch(/role=\{state\.tone === "error" \? "alert" : "status"\}/);
  });
  test("passwords are never logged or kept after an error", () => {
    expect(security).not.toMatch(/console\.(log|error|warn|info)/);
    // one per form that takes the current password (password, username, notification email)
    expect(security.match(/setForm\(\{ \.\.\.form, currentPassword: "" \}\)/g)).toHaveLength(3);
  });
});

describe("Account Security layout", () => {
  test("theme tokens only (light + dark follow User Settings)", () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(/);
    expect(css).toMatch(/var\(--bg-surface\)/);
    expect(css).toMatch(/var\(--danger-bg\)/);
    expect(css).toMatch(/var\(--success-bg\)/);
  });
  test("responsive: shrinkable grid, one column <= 900px, full-width button <= 600px", () => {
    expect(css).toMatch(/grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
    expect(css).toMatch(/@media \(max-width: 900px\) \{\s*\.acs-grid \{\s*grid-template-columns: minmax\(0, 1fr\);/);
    expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*?\.acs-actions \.acs-btn-primary \{\s*width: 100%;/);
  });
});

describe("Notification Email form and confirmation page", () => {
  const verifyPage = fs.readFileSync(path.join(__dirname, "..", "..", "pages", "ADMIN", "VerifyEmail.jsx"), "utf8");
  const appSrc = fs.readFileSync(path.join(__dirname, "..", "..", "App.jsx"), "utf8");
  test("Account Security has the Notification Email form (current password + new address)", () => {
    expect(security).toMatch(/<NotificationEmailForm \/>/);
    expect(security).toMatch(/"\/api\/account\/email\/request"/);
    expect(security).toMatch(/id="acs-em-current" type="password"/);
    expect(security).toMatch(/None registered/);
  });
  test("the confirmation page never consumes the token on load - only on the button", () => {
    expect(verifyPage).not.toMatch(/useEffect/);
    expect(verifyPage).toMatch(/onClick=\{confirm\}/);
    expect(verifyPage).toMatch(/\/api\/account\/email\/verify/);
    expect(verifyPage).not.toMatch(/console\./);
  });
  test("the confirmation page's login link uses the theme colour (readable in dark mode)", () => {
    const veCss = fs.readFileSync(path.join(__dirname, "..", "..", "pages", "ADMIN", "VerifyEmail.css"), "utf8");
    expect(verifyPage).toMatch(/import "\.\/VerifyEmail\.css";/);
    expect(verifyPage).toMatch(/<Link className="ve-link" to="\/login">/);
    expect(veCss).toMatch(/\.ve-link \{\s*color: var\(--accent-blue\);/);
  });
  test("/verify-email is a public, chrome-less route", () => {
    expect(appSrc).toMatch(/<Route path="\/verify-email" element=\{<VerifyEmail \/>\} \/>/);
    expect(appSrc).toMatch(/location\.pathname === "\/verify-email"/);
  });
});
