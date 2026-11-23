const fs = require("fs");
const path = require("path");

// Login identity model - UI (source guards + pure helpers; node-only jest, no
// jsdom - the screens are verified in a real browser separately).
const SRC = path.join(__dirname, "../..");
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), "utf8");
const modal = read("components", "InviteUserModal.jsx");
const accept = read("pages", "ADMIN", "AcceptInvite.jsx");
const pending = read("pages", "ADMIN", "PendingInvitations.jsx");
const userList = read("pages", "ADMIN", "UserList.jsx");
const loginPage = read("pages", "login", "login.jsx");
const dashboard = read("pages", "DASHBOARD", "dashboard.jsx");

let m;
beforeAll(async () => {
  m = await import("../../utils/dashboardModel.mjs");
});

describe("LID-16 Dashboard greeting = USERNAME, never e-mail or full name", () => {
  test("the server's username wins; the session username is only a first guess", () => {
    expect(m.greetingName({ serverUsername: "juan.delacruz", sessionUser: { username: "old.name", email: "juan@gmail.com" } })).toBe("juan.delacruz");
    expect(m.greetingName({ serverUsername: "", sessionUser: { username: "alas.superadmin" } })).toBe("alas.superadmin");
  });
  test("e-mail and full name are never used, even when the username is missing", () => {
    expect(m.greetingName({ serverUsername: "", sessionUser: { email: "juan@gmail.com", name: "Juan Dela Cruz", full_name: "Juan Dela Cruz" } })).toBe("");
    expect(m.greetingName({})).toBe("");
  });
  test("the page greets with greetingName() fed by /api/me/permissions", () => {
    expect(dashboard).toMatch(/setSignedInUsername\(me\?\.user\?\.username \|\| ""\);/);
    expect(dashboard).toMatch(/const name = currentUsername\(signedInUsername\);/);
    expect(dashboard).toMatch(/return greetingName\(\{ serverUsername, sessionUser: sessionUser\(\) \}\);/);
    expect(dashboard).not.toMatch(/user\?\.username \|\| user\?\.name/);
    expect(dashboard).toContain("`Good day, ${name}.`");
  });
});

describe("Invite User: Full Name / Username / Email, all required", () => {
  test("three labelled inputs in that order", () => {
    const full = modal.indexOf('htmlFor="ium-full-name"');
    const user = modal.indexOf('htmlFor="ium-username"');
    const mail = modal.indexOf('htmlFor="ium-email"');
    expect(full).toBeGreaterThan(-1);
    expect(user).toBeGreaterThan(full);
    expect(mail).toBeGreaterThan(user);
    expect(modal).toMatch(/id="ium-username"[\s\S]*?value=\{form\.username\}[\s\S]*?required/);
    expect(modal).toMatch(/id="ium-email"\s+type="email"/);
  });
  test("client-side check mirrors the server (username required, no spaces); the username is sent", () => {
    expect(modal).toContain('if (!form.fullName.trim() || !form.username.trim() || !form.email.trim() || !form.roleId) {');
    // the whitespace check must be \s - a bare /s/ would reject every username containing the letter s
    expect(modal).toContain("if (/\\s/.test(form.username.trim())) {");
    expect(modal).not.toMatch(/if \(\/s\/\.test/);
    expect(modal).toContain('setError("The username cannot contain spaces.");');
    expect(modal).toContain("<form onSubmit={handleSubmit} noValidate>");
    expect(modal).toMatch(/username: "",/);
    expect(modal).toContain("body: JSON.stringify(form)");
  });
});

describe("Accept invitation / lists / login", () => {
  test("the invitee sees Full Name, Username and Email before setting a password", () => {
    expect(accept).toMatch(/<dt>Full Name<\/dt><dd>\{invitation\.fullName\}<\/dd>/);
    expect(accept).toMatch(/<dt>Username<\/dt><dd className="ai-identity-username">\{invitation\.username \|\| invitation\.email\}<\/dd>/);
    expect(accept).toMatch(/<dt>Email<\/dt><dd>\{invitation\.email\}<\/dd>/);
    expect(accept).toContain("sign in with your username or your email");
  });
  test("Pending Invitations shows the username; User List shows e-mail AND username", () => {
    expect(pending).toMatch(/<th>Email<\/th>\s*<th>Username<\/th>\s*<th>Full Name<\/th>/);
    expect(pending).toContain('<td>{inv.username || "-"}</td>');
    expect(userList).toMatch(/<th>Full Name<\/th>\s*<th>Email \/ Username<\/th>\s*<th>Role<\/th>\s*<th>Companies<\/th>\s*<th>Branches<\/th>\s*<th>Status<\/th>/);
    expect(userList).toContain('<span className="ul-identity-email">{u.email || "-"}</span>');
    expect(userList).toContain('<span className="ul-identity-username">{u.username}</span>');
  });
  test("the login field accepts a username or an e-mail (same API field)", () => {
    expect(loginPage).toMatch(/name="username"[\s\S]*?placeholder="Username or email"[\s\S]*?aria-label="Username or email"/);
  });
});
