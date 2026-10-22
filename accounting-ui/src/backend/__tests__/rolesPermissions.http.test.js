// Administration -> Roles & Permissions, Phase 1 security/correctness:
//   - invitation permission-template guard (exists, non-empty, within the
//     inviter's own effective permissions, no Administration permission
//     the invited role doesn't already have; Super Admin exempt) - checked
//     at creation and again at acceptance
//   - permission-id validation for role / template / override writes
//   - before/after audit data for role permissions, templates, overrides
//   - data-driven permission matrix (no hidden actions)
//   - Admin / Accountant cannot touch role, template or restriction admin
//
// Role grants are global and shared with other suites, so every role_permissions
// row this file touches is snapshotted first and restored exactly afterwards.
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const EmailService = require("../services/emailService");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(120000);

const P = "rbpt-";
const PASSWORD = "RbptPass!1";
const MAIL = (tag) => `${P}${tag}@example.test`;

const ids = {};
const perm = {};
const tpl = {};
const tokens = {};
let roleSnapshot = [];
let catalogCount = 0;
let buildPermissionMatrix;

async function makeUser(tag, roleId, companyIds = []) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const [u] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status, email, full_name) VALUES (?, ?, ?, 'ACTIVE', ?, ?)",
    [`${P}${tag}`, hash, roleId, MAIL(tag), `RBPT ${tag}`]
  );
  for (const c of companyIds) await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  return u.insertId;
}

async function login(username, password = PASSWORD) {
  const res = await request(app).post("/api/login").send({ username, password });
  if (res.status !== 200) throw new Error(`login ${username}: ${res.status}`);
  return res.body.token;
}

const auth = (who) => ({ Authorization: `Bearer ${tokens[who]}` });

async function makeTemplate(name, permissionIds) {
  const [t] = await pool.execute("INSERT INTO permission_templates (name, description, is_system) VALUES (?, 'rbpt test', 0)", [`${P}${name}`]);
  for (const pid of permissionIds) {
    await pool.execute("INSERT INTO permission_template_items (template_id, permission_id, granted) VALUES (?, ?, 1)", [t.insertId, pid]);
  }
  return t.insertId;
}

function mockEmail() {
  return jest.spyOn(EmailService, "sendInvitationEmail").mockResolvedValue({ delivered: false, reason: "SMTP_NOT_CONFIGURED" });
}

const invite = (who, body) => request(app).post("/api/invitations").set(auth(who)).send(body);

async function invitationRow(email) {
  const [rows] = await pool.execute("SELECT * FROM invitations WHERE email = ?", [email]);
  return rows[0];
}

async function accept(acceptUrl) {
  const token = new URL(acceptUrl).searchParams.get("token");
  return request(app).post("/api/invitations/accept").send({ token, password: "NewUser!123", acceptedTerms: true });
}

async function roleGrant(roleId, permissionId) {
  const [rows] = await pool.execute("SELECT granted FROM role_permissions WHERE role_id = ? AND permission_id = ?", [roleId, permissionId]);
  return rows.length ? !!rows[0].granted : null;
}

async function lastAudit(where, params) {
  const [rows] = await pool.query(`SELECT * FROM audit_logs WHERE ${where} ORDER BY id DESC LIMIT 1`, params);
  const row = rows[0];
  if (!row) return null;
  const parse = (v) => (v == null ? null : typeof v === "string" ? JSON.parse(v) : v);
  return { ...row, before: parse(row.before_data), after: parse(row.after_data) };
}

async function permissionId(moduleKey, action) {
  const [[row]] = await pool.execute("SELECT id FROM permissions WHERE module_key = ? AND action = ?", [moduleKey, action]);
  if (!row) throw new Error(`missing permission ${moduleKey}.${action}`);
  return row.id;
}

beforeAll(async () => {
  assertNotProductionDatabase();
  ({ buildPermissionMatrix } = await import("../../utils/permissionMatrix.mjs"));

  const [roles] = await pool.execute("SELECT id, code FROM roles");
  for (const r of roles) ids[r.code] = r.id;
  const [[{ c }]] = await pool.execute("SELECT COUNT(*) AS c FROM permissions");
  catalogCount = c;

  perm.reportsView = await permissionId("REPORTS.FINANCIAL", "VIEW");
  perm.dashboard = await permissionId("DASHBOARD", "VIEW");
  perm.apExport = await permissionId("REPORTS.AP", "EXPORT");
  perm.auditLogs = await permissionId("ADMIN.AUDIT_LOGS", "VIEW");
  perm.userEdit = await permissionId("ADMIN.USER_SETTINGS", "EDIT");
  perm.coaView = await permissionId("FILESETUP.COA", "VIEW");

  // Snapshot the ACCOUNTANT role rows this suite edits, to restore exactly.
  const [snap] = await pool.query(
    "SELECT permission_id, granted FROM role_permissions WHERE role_id = ? AND permission_id IN (?)",
    [ids.ACCOUNTANT, [perm.coaView, perm.dashboard]]
  );
  roleSnapshot = snap;

  const [ca] = await pool.execute("INSERT INTO companies (name, status) VALUES ('RBPT Co A', 'Active')");
  const [cb] = await pool.execute("INSERT INTO companies (name, status) VALUES ('RBPT Co B', 'Active')");
  ids.coA = ca.insertId;
  ids.coB = cb.insertId;

  ids.sa = await makeUser("sa", ids.SUPER_ADMIN);
  ids.admin = await makeUser("admin", ids.ADMIN, [ids.coA]);
  ids.adminRestricted = await makeUser("admin_restricted", ids.ADMIN, [ids.coA]);
  ids.acct = await makeUser("acct", ids.ACCOUNTANT, [ids.coA]);
  ids.acctB = await makeUser("acct_b", ids.ACCOUNTANT, [ids.coB]);
  ids.acctTarget = await makeUser("acct_target", ids.ACCOUNTANT, [ids.coA]);
  // adminRestricted has an explicit deny override on REPORTS.AP.EXPORT - its
  // *effective* permissions are narrower than the Admin role's.
  await pool.execute("INSERT INTO user_permissions (user_id, permission_id, granted, reason) VALUES (?, ?, 0, 'rbpt test')", [ids.adminRestricted, perm.apExport]);

  for (const who of ["sa", "admin", "adminRestricted", "acct"]) {
    const tag = { sa: "sa", admin: "admin", adminRestricted: "admin_restricted", acct: "acct" }[who];
    tokens[who] = await login(`${P}${tag}`);
  }

  tpl.allowed = await makeTemplate("allowed", [perm.reportsView, perm.dashboard]);
  tpl.audit = await makeTemplate("audit", [perm.auditLogs]);
  tpl.adminOnly = await makeTemplate("admin-only", [perm.userEdit]);
  tpl.apExport = await makeTemplate("ap-export", [perm.apExport]);
  tpl.empty = await makeTemplate("empty", []);
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
  // Restore the ACCOUNTANT role rows exactly as they were.
  await pool.query("DELETE FROM role_permissions WHERE role_id = ? AND permission_id IN (?)", [ids.ACCOUNTANT, [perm.coaView, perm.dashboard]]);
  for (const r of roleSnapshot) {
    await pool.execute("INSERT INTO role_permissions (role_id, permission_id, granted) VALUES (?, ?, ?)", [ids.ACCOUNTANT, r.permission_id, r.granted]);
  }

  const [users] = await pool.query("SELECT id FROM users WHERE username LIKE ? OR email LIKE ?", [`${P}%`, `${P}%`]);
  const userIds = users.map((u) => u.id);
  await pool.query("DELETE FROM invitations WHERE email LIKE ?", [`${P}%`]);
  const [tpls] = await pool.query("SELECT id FROM permission_templates WHERE name LIKE ?", [`${P}%`]);
  const tplIds = tpls.map((t) => t.id);
  if (userIds.length) {
    await pool.query("DELETE FROM invitations WHERE invited_by IN (?)", [userIds]);
    for (const t of ["user_companies", "user_branches", "user_permissions"]) {
      await pool.query(`DELETE FROM ${t} WHERE user_id IN (?)`, [userIds]);
    }
    await pool.query("DELETE FROM audit_logs WHERE user_id IN (?)", [userIds]);
    await pool.query("DELETE FROM audit_logs WHERE entity_type IN ('USER', 'USER_PERMISSION') AND entity_id IN (?)", [userIds]);
    await pool.query("UPDATE permission_templates SET created_by = NULL WHERE created_by IN (?)", [userIds]);
  }
  if (tplIds.length) {
    await pool.query("DELETE FROM audit_logs WHERE entity_type = 'PERMISSION_TEMPLATE' AND entity_id IN (?)", [tplIds]);
    await pool.query("DELETE FROM permission_templates WHERE id IN (?)", [tplIds]);
  }
  if (userIds.length) await pool.query("DELETE FROM users WHERE id IN (?)", [userIds]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [ids.coA, ids.coB]);
  await pool.end();
});

// ---------------------------------------------------------------------------
describe("invitation template security", () => {
  test("1. Admin can invite an Accountant without a template", async () => {
    mockEmail();
    const res = await invite("admin", { email: MAIL("inv-none"), fullName: "No Template", roleId: ids.ACCOUNTANT, companyIds: [ids.coA] });
    expect(res.status).toBe(201);
    expect((await invitationRow(MAIL("inv-none"))).permission_template_id).toBeNull();
    // The UI's "Use role defaults" option sends an empty string.
    const res2 = await invite("admin", { email: MAIL("inv-blank"), fullName: "Blank Template", roleId: ids.ACCOUNTANT, companyIds: [ids.coA], permissionTemplateId: "" });
    expect(res2.status).toBe(201);
    expect((await invitationRow(MAIL("inv-blank"))).permission_template_id).toBeNull();
  });

  test("2. Admin can invite an Accountant with an allowed template; accepted user gets exactly it", async () => {
    mockEmail();
    const res = await invite("admin", { email: MAIL("inv-allowed"), fullName: "Allowed", roleId: ids.ACCOUNTANT, companyIds: [ids.coA], permissionTemplateId: tpl.allowed });
    expect(res.status).toBe(201);
    expect((await invitationRow(MAIL("inv-allowed"))).permission_template_id).toBe(tpl.allowed);
    expect((await accept(res.body.acceptUrl)).status).toBe(201);
    const [[u]] = await pool.execute("SELECT id FROM users WHERE email = ?", [MAIL("inv-allowed")]);
    const [granted] = await pool.execute("SELECT permission_id FROM user_permissions WHERE user_id = ? AND granted = 1 ORDER BY permission_id", [u.id]);
    expect(granted.map((r) => r.permission_id).sort((a, b) => a - b)).toEqual([perm.reportsView, perm.dashboard].sort((a, b) => a - b));
  });

  test("3. a template granting a permission the inviter doesn't have is rejected (effective permissions)", async () => {
    const email = mockEmail();
    // The Admin role has REPORTS.AP.EXPORT, but this Admin is denied it by override.
    const res = await invite("adminRestricted", { email: MAIL("inv-ap"), fullName: "AP", roleId: ids.ACCOUNTANT, companyIds: [ids.coA], permissionTemplateId: tpl.apExport });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/REPORTS\.AP\.EXPORT/);
    expect(await invitationRow(MAIL("inv-ap"))).toBeUndefined();
    expect(email).not.toHaveBeenCalled();
    // The same template is fine for an Admin who does hold it.
    const ok = await invite("admin", { email: MAIL("inv-ap-ok"), fullName: "AP ok", roleId: ids.ACCOUNTANT, companyIds: [ids.coA], permissionTemplateId: tpl.apExport });
    expect(ok.status).toBe(201);
  });

  test("4. a template granting an Administration permission the Accountant role can't receive is rejected", async () => {
    const email = mockEmail();
    const res = await invite("admin", { email: MAIL("inv-adminonly"), fullName: "Admin Only", roleId: ids.ACCOUNTANT, companyIds: [ids.coA], permissionTemplateId: tpl.adminOnly });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/ADMIN\.USER_SETTINGS\.EDIT/);
    expect(await invitationRow(MAIL("inv-adminonly"))).toBeUndefined();
    expect(email).not.toHaveBeenCalled();
  });

  test("5. Admin cannot hand out Audit Logs through a template", async () => {
    const email = mockEmail();
    expect((await request(app).get("/api/audit-logs").set(auth("admin"))).status).toBe(403);
    const res = await invite("admin", { email: MAIL("inv-audit"), fullName: "Audit", roleId: ids.ACCOUNTANT, companyIds: [ids.coA], permissionTemplateId: tpl.audit });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/ADMIN\.AUDIT_LOGS\.VIEW/);
    expect(await invitationRow(MAIL("inv-audit"))).toBeUndefined();
    expect(email).not.toHaveBeenCalled();
  });

  test("6. Super Admin can use a valid template (exempt from the inviter ceiling)", async () => {
    mockEmail();
    const res = await invite("sa", { email: MAIL("inv-sa"), fullName: "SA Invite", roleId: ids.ACCOUNTANT, companyIds: [ids.coA], permissionTemplateId: tpl.audit });
    expect(res.status).toBe(201);
    expect((await accept(res.body.acceptUrl)).status).toBe(201);
    const token = await login(MAIL("inv-sa"), "NewUser!123");
    expect((await request(app).get("/api/audit-logs").set({ Authorization: `Bearer ${token}` })).status).toBe(200);
  });

  test("7. a nonexistent or malformed template id returns 400", async () => {
    const email = mockEmail();
    for (const permissionTemplateId of [999999, "abc", -1]) {
      const res = await invite("admin", { email: MAIL("inv-missing"), fullName: "Missing", roleId: ids.ACCOUNTANT, companyIds: [ids.coA], permissionTemplateId });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Selected permission template does not exist.");
    }
    const sa = await invite("sa", { email: MAIL("inv-missing"), fullName: "Missing", roleId: ids.ACCOUNTANT, companyIds: [ids.coA], permissionTemplateId: 999999 });
    expect(sa.status).toBe(400);
    expect(await invitationRow(MAIL("inv-missing"))).toBeUndefined();
    expect(email).not.toHaveBeenCalled();
  });

  test("8. an empty template is refused - no deny-all user can be created", async () => {
    const email = mockEmail();
    for (const who of ["admin", "sa"]) {
      const res = await invite(who, { email: MAIL("inv-empty"), fullName: "Empty", roleId: ids.ACCOUNTANT, companyIds: [ids.coA], permissionTemplateId: tpl.empty });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/no permissions configured/);
    }
    expect(await invitationRow(MAIL("inv-empty"))).toBeUndefined();
    expect(email).not.toHaveBeenCalled();
    // Applying an empty template to an existing user is refused too.
    const apply = await request(app).post(`/api/permission-templates/${tpl.empty}/apply`).set(auth("sa")).send({ userId: ids.acctTarget });
    expect(apply.status).toBe(400);
    const [[{ c }]] = await pool.execute("SELECT COUNT(*) AS c FROM user_permissions WHERE user_id = ?", [ids.acctTarget]);
    expect(c).toBe(0);
  });

  test("8b. a template emptied or deleted after the invite is re-checked at acceptance (no user created)", async () => {
    mockEmail();
    const tmp = await makeTemplate("later-emptied", [perm.reportsView]);
    const res = await invite("admin", { email: MAIL("inv-later"), fullName: "Later", roleId: ids.ACCOUNTANT, companyIds: [ids.coA], permissionTemplateId: tmp });
    expect(res.status).toBe(201);
    await pool.execute("DELETE FROM permission_template_items WHERE template_id = ?", [tmp]);
    const acc = await accept(res.body.acceptUrl);
    expect(acc.status).toBe(409);
    const [users] = await pool.execute("SELECT id FROM users WHERE email = ?", [MAIL("inv-later")]);
    expect(users).toHaveLength(0);
    expect((await invitationRow(MAIL("inv-later"))).status).toBe("PENDING");

    // Template grows past the inviter's rights after the invite -> also refused.
    const tmp2 = await makeTemplate("later-grown", [perm.reportsView]);
    const res2 = await invite("admin", { email: MAIL("inv-grown"), fullName: "Grown", roleId: ids.ACCOUNTANT, companyIds: [ids.coA], permissionTemplateId: tmp2 });
    expect(res2.status).toBe(201);
    await pool.execute("INSERT INTO permission_template_items (template_id, permission_id, granted) VALUES (?, ?, 1)", [tmp2, perm.auditLogs]);
    expect((await accept(res2.body.acceptUrl)).status).toBe(409);
    const [users2] = await pool.execute("SELECT id FROM users WHERE email = ?", [MAIL("inv-grown")]);
    expect(users2).toHaveLength(0);
  });

  test("9-10. every rejected template invitation leaves no invitation, token or email", async () => {
    const email = mockEmail();
    const [[{ c: before }]] = await pool.execute("SELECT COUNT(*) AS c FROM invitations WHERE invited_by = ?", [ids.admin]);
    for (const permissionTemplateId of [tpl.audit, tpl.adminOnly, tpl.empty, 999999]) {
      const res = await invite("admin", { email: MAIL("inv-reject"), fullName: "Reject", roleId: ids.ACCOUNTANT, companyIds: [ids.coA], permissionTemplateId });
      expect([400, 403]).toContain(res.status);
      expect(res.body.acceptUrl).toBeUndefined();
    }
    const [[{ c: after }]] = await pool.execute("SELECT COUNT(*) AS c FROM invitations WHERE invited_by = ?", [ids.admin]);
    expect(after).toBe(before);
    expect(email).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("permission id validation (role permissions)", () => {
  const put = (who, roleId, grants) => request(app).put(`/api/roles/${roleId}/permissions`).set(auth(who)).send({ grants });

  test("11 / 17. valid ids save successfully", async () => {
    const res = await put("sa", ids.ACCOUNTANT, [{ permissionId: perm.coaView, granted: true }]);
    expect(res.status).toBe(200);
    expect(await roleGrant(ids.ACCOUNTANT, perm.coaView)).toBe(true);
    const back = await put("sa", ids.ACCOUNTANT, [{ permissionId: perm.coaView, granted: false }]);
    expect(back.status).toBe(200);
    expect(await roleGrant(ids.ACCOUNTANT, perm.coaView)).toBe(false);
  });

  test("12 / 13. an invalid id returns 400 and nothing is written", async () => {
    const before = await roleGrant(ids.ACCOUNTANT, perm.coaView);
    for (const bad of [999999999, "abc", 0, null]) {
      const res = await put("sa", ids.ACCOUNTANT, [{ permissionId: perm.coaView, granted: !before }, { permissionId: bad, granted: true }]);
      expect(res.status).toBe(400);
    }
    expect(await roleGrant(ids.ACCOUNTANT, perm.coaView)).toBe(before);
    expect((await put("sa", ids.ACCOUNTANT, "not-a-list")).status).toBe(400);
  });

  test("14. duplicate ids: identical duplicates collapse, conflicting duplicates are rejected", async () => {
    let res = await put("sa", ids.ACCOUNTANT, [
      { permissionId: perm.coaView, granted: true },
      { permissionId: perm.coaView, granted: true },
    ]);
    expect(res.status).toBe(200);
    const [rows] = await pool.execute("SELECT COUNT(*) AS c FROM role_permissions WHERE role_id = ? AND permission_id = ?", [ids.ACCOUNTANT, perm.coaView]);
    expect(rows[0].c).toBe(1);
    expect(await roleGrant(ids.ACCOUNTANT, perm.coaView)).toBe(true);

    res = await put("sa", ids.ACCOUNTANT, [
      { permissionId: perm.coaView, granted: false },
      { permissionId: perm.coaView, granted: true },
    ]);
    expect(res.status).toBe(400);
    expect(await roleGrant(ids.ACCOUNTANT, perm.coaView)).toBe(true);
    await put("sa", ids.ACCOUNTANT, [{ permissionId: perm.coaView, granted: false }]);
  });
});

// ---------------------------------------------------------------------------
describe("role security", () => {
  test("15 / 16. Admin and Accountant cannot modify role permissions", async () => {
    const before = await roleGrant(ids.ACCOUNTANT, perm.coaView);
    for (const who of ["admin", "acct"]) {
      for (const roleId of [ids.ADMIN, ids.ACCOUNTANT, ids.SUPER_ADMIN]) {
        const res = await request(app).put(`/api/roles/${roleId}/permissions`).set(auth(who)).send({ grants: [{ permissionId: perm.coaView, granted: true }] });
        expect(res.status).toBe(403);
      }
    }
    expect(await roleGrant(ids.ACCOUNTANT, perm.coaView)).toBe(before);
  });

  test("18. the Super Admin role stays protected", async () => {
    const res = await request(app).put(`/api/roles/${ids.SUPER_ADMIN}/permissions`).set(auth("sa")).send({ grants: [{ permissionId: perm.coaView, granted: false }] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Super Admin always has full access/);
  });
});

// ---------------------------------------------------------------------------
describe("audit data", () => {
  test("19-21. PERMISSION_CHANGED records before/after states with added and removed lists", async () => {
    const dashboardBefore = await roleGrant(ids.ACCOUNTANT, perm.dashboard);
    expect(dashboardBefore).toBe(true);
    const res = await request(app).put(`/api/roles/${ids.ACCOUNTANT}/permissions`).set(auth("sa")).send({
      grants: [
        { permissionId: perm.coaView, granted: true },
        { permissionId: perm.dashboard, granted: false },
        { permissionId: perm.reportsView, granted: true }, // unchanged - not in the diff
      ],
    });
    expect(res.status).toBe(200);
    const audit = await lastAudit("action = 'PERMISSION_CHANGED' AND entity_type = 'ROLE' AND entity_id = ? AND user_id = ?", [ids.ACCOUNTANT, ids.sa]);
    expect(audit.before.role).toBe("ACCOUNTANT");
    const beforeCoa = audit.before.permissions.find((p) => p.permission === "FILESETUP.COA.VIEW");
    const afterCoa = audit.after.permissions.find((p) => p.permission === "FILESETUP.COA.VIEW");
    expect(beforeCoa).toMatchObject({ permissionId: perm.coaView, moduleKey: "FILESETUP.COA", action: "VIEW", granted: false });
    expect(beforeCoa.label).toBeTruthy();
    expect(afterCoa).toMatchObject({ permissionId: perm.coaView, granted: true });
    expect(audit.after.added).toEqual(["FILESETUP.COA.VIEW"]);
    expect(audit.after.removed).toEqual(["DASHBOARD.VIEW"]);
    expect(audit.after.permissions.some((p) => p.permission === "REPORTS.FINANCIAL.VIEW")).toBe(false);

    // restore
    await request(app).put(`/api/roles/${ids.ACCOUNTANT}/permissions`).set(auth("sa")).send({
      grants: [{ permissionId: perm.coaView, granted: false }, { permissionId: perm.dashboard, granted: true }],
    });
    expect(await roleGrant(ids.ACCOUNTANT, perm.dashboard)).toBe(true);
  });

  test("22-24. template create / update / delete audits carry the permission state", async () => {
    const created = await request(app).post("/api/permission-templates").set(auth("sa")).send({
      name: `${P}audited`,
      description: "first",
      grants: [{ permissionId: perm.reportsView, granted: true }, { permissionId: perm.dashboard, granted: false }],
    });
    expect(created.status).toBe(201);
    const id = created.body.template.id;
    let audit = await lastAudit("action = 'TEMPLATE_CREATED' AND entity_id = ?", [id]);
    expect(audit.after).toMatchObject({ name: `${P}audited`, description: "first", permissions: ["REPORTS.FINANCIAL.VIEW"] });

    const updated = await request(app).put(`/api/permission-templates/${id}`).set(auth("sa")).send({
      name: `${P}audited-2`,
      description: "second",
      grants: [{ permissionId: perm.dashboard, granted: true }],
    });
    expect(updated.status).toBe(200);
    audit = await lastAudit("action = 'TEMPLATE_UPDATED' AND entity_id = ?", [id]);
    expect(audit.before).toMatchObject({ name: `${P}audited`, description: "first", permissions: ["REPORTS.FINANCIAL.VIEW"] });
    expect(audit.after).toMatchObject({ name: `${P}audited-2`, description: "second", permissions: ["DASHBOARD.VIEW"] });
    expect(audit.after.added).toEqual(["DASHBOARD.VIEW"]);
    expect(audit.after.removed).toEqual(["REPORTS.FINANCIAL.VIEW"]);

    // Invalid permission ids are rejected before anything changes.
    const bad = await request(app).put(`/api/permission-templates/${id}`).set(auth("sa")).send({ name: "x", grants: [{ permissionId: 999999999, granted: true }] });
    expect(bad.status).toBe(400);
    const badCreate = await request(app).post("/api/permission-templates").set(auth("sa")).send({ name: `${P}bad`, grants: [{ permissionId: 999999999, granted: true }] });
    expect(badCreate.status).toBe(400);
    const [[still]] = await pool.execute("SELECT name FROM permission_templates WHERE id = ?", [id]);
    expect(still.name).toBe(`${P}audited-2`);

    const del = await request(app).delete(`/api/permission-templates/${id}`).set(auth("sa"));
    expect(del.status).toBe(200);
    audit = await lastAudit("action = 'TEMPLATE_DELETED' AND entity_id = ?", [id]);
    expect(audit.before).toMatchObject({ name: `${P}audited-2`, description: "second", isSystem: false, permissions: ["DASHBOARD.VIEW"] });
  });

  test("25. template apply audit names the template, the target user and what was applied", async () => {
    const res = await request(app).post(`/api/permission-templates/${tpl.allowed}/apply`).set(auth("sa")).send({ userId: ids.acctTarget });
    expect(res.status).toBe(200);
    const audit = await lastAudit("action = 'TEMPLATE_APPLIED' AND entity_id = ?", [tpl.allowed]);
    expect(audit.after).toMatchObject({ templateId: tpl.allowed, templateName: `${P}allowed`, targetUserId: ids.acctTarget, targetUsername: `${P}acct_target` });
    expect(audit.after.granted.sort()).toEqual(["DASHBOARD.VIEW", "REPORTS.FINANCIAL.VIEW"]);
    expect(audit.after.deniedCount).toBe(catalogCount - 2);
    expect(audit.before).toEqual({ targetUserId: ids.acctTarget, overrides: [] });
    await request(app).put(`/api/users/${ids.acctTarget}/access`).set(auth("sa")).send({ grants: [] });
  });

  test("26. restriction add / remove audits carry the restriction", async () => {
    const add = await request(app).post("/api/access-restrictions").set(auth("sa")).send({ userId: ids.acct, permissionId: perm.reportsView, granted: false, reason: "rbpt review" });
    expect(add.status).toBe(201);
    let audit = await lastAudit("action = 'RESTRICTION_ADDED' AND entity_type = 'USER_PERMISSION' AND entity_id = ?", [ids.acct]);
    expect(audit.before).toBeNull();
    expect(audit.after).toMatchObject({ userId: ids.acct, permission: "REPORTS.FINANCIAL.VIEW", granted: false, reason: "rbpt review" });

    // Changing an existing override records what it was before.
    await request(app).post("/api/access-restrictions").set(auth("sa")).send({ userId: ids.acct, permissionId: perm.reportsView, granted: true, reason: "rbpt changed" });
    audit = await lastAudit("action = 'RESTRICTION_ADDED' AND entity_type = 'USER_PERMISSION' AND entity_id = ?", [ids.acct]);
    expect(audit.before).toMatchObject({ permission: "REPORTS.FINANCIAL.VIEW", granted: false, reason: "rbpt review" });
    expect(audit.after).toMatchObject({ granted: true, reason: "rbpt changed" });

    const del = await request(app).delete(`/api/access-restrictions/${add.body.id}`).set(auth("sa"));
    expect(del.status).toBe(200);
    audit = await lastAudit("action = 'RESTRICTION_REMOVED' AND entity_id = ?", [ids.acct]);
    expect(audit.before).toMatchObject({
      restrictionId: add.body.id,
      userId: ids.acct,
      username: `${P}acct`,
      permissionId: perm.reportsView,
      permission: "REPORTS.FINANCIAL.VIEW",
      granted: true,
      reason: "rbpt changed",
    });
  });

  test("27. bulk override replacement records before and after lists; invalid ids are rejected", async () => {
    await pool.execute("INSERT INTO user_permissions (user_id, permission_id, granted, reason) VALUES (?, ?, 0, 'old')", [ids.acctTarget, perm.dashboard]);
    const res = await request(app).put(`/api/users/${ids.acctTarget}/access`).set(auth("sa")).send({
      grants: [{ permissionId: perm.reportsView, granted: false, reason: "new" }],
    });
    expect(res.status).toBe(200);
    const audit = await lastAudit("action = 'RESTRICTION_ADDED' AND entity_type = 'USER_PERMISSION' AND entity_id = ? AND user_id = ?", [ids.acctTarget, ids.sa]);
    expect(audit.before.overrides).toEqual([{ permissionId: perm.dashboard, permission: "DASHBOARD.VIEW", granted: false, reason: "old" }]);
    expect(audit.after.overrides).toEqual([{ permissionId: perm.reportsView, permission: "REPORTS.FINANCIAL.VIEW", granted: false, reason: "new" }]);

    const bad = await request(app).put(`/api/users/${ids.acctTarget}/access`).set(auth("sa")).send({ grants: [{ permissionId: 999999999, granted: true }] });
    expect(bad.status).toBe(400);
    const [rows] = await pool.execute("SELECT permission_id FROM user_permissions WHERE user_id = ?", [ids.acctTarget]);
    expect(rows.map((r) => r.permission_id)).toEqual([perm.reportsView]);
    await request(app).put(`/api/users/${ids.acctTarget}/access`).set(auth("sa")).send({ grants: [] });
  });
});

// ---------------------------------------------------------------------------
describe("permission matrix", () => {
  test("28 / 29. every catalog permission gets a cell, including actions outside the old nine", async () => {
    const res = await request(app).get(`/api/roles/${ids.ACCOUNTANT}/permissions`).set(auth("sa"));
    expect(res.status).toBe(200);
    const matrix = buildPermissionMatrix(res.body.permissions);
    expect(matrix.permissionCount).toBe(catalogCount);
    const placed = matrix.modules.flatMap((m) => Object.values(m.cells).map((p) => p.permission_id));
    expect(new Set(placed).size).toBe(catalogCount);
    const OLD_NINE = ["VIEW", "CREATE", "EDIT", "DELETE", "SUBMIT", "APPROVE", "POST", "EXPORT", "CONFIGURE"];
    const outside = res.body.permissions.filter((p) => !OLD_NINE.includes(p.action));
    expect(outside.length).toBeGreaterThan(0);
    for (const p of outside) expect(matrix.actions).toContain(p.action);
    for (const a of ["VOID", "PRINT", "CLOSE", "REOPEN"]) expect(matrix.actions).toContain(a);
  });

  test("a permission added later appears without a code change", () => {
    const matrix = buildPermissionMatrix([
      { permission_id: 1, module_key: "X", action: "VIEW" },
      { permission_id: 2, module_key: "X", action: "BRAND_NEW_ACTION" },
      { permission_id: 3, module_key: "Y", action: "VIEW" },
    ]);
    expect(matrix.actions).toEqual(["VIEW", "BRAND_NEW_ACTION"]);
    expect(matrix.modules.map((m) => m.moduleKey)).toEqual(["X", "Y"]);
    expect(matrix.modules[0].cells.BRAND_NEW_ACTION.permission_id).toBe(2);
  });

  test("matrix pages derive columns from data, not a hardcoded action list", () => {
    for (const file of ["RolePermissionMatrix.jsx", "PermissionTemplateManager.jsx"]) {
      const src = fs.readFileSync(path.join(__dirname, "..", "..", "pages", "ADMIN", file), "utf8");
      expect(src).not.toMatch(/const ACTIONS = \[/);
      expect(src).toMatch(/buildPermissionMatrix\(/);
      expect(src).toMatch(/matrix\.actions\.map/);
    }
  });
});

// ---------------------------------------------------------------------------
describe("isolation: Admin / Accountant cannot reach role, template or restriction admin", () => {
  test("30 / 31. every write is refused, including against another company's user, and nothing changes", async () => {
    const [[{ c: tplBefore }]] = await pool.execute("SELECT COUNT(*) AS c FROM permission_templates");
    const [[{ c: upBefore }]] = await pool.query("SELECT COUNT(*) AS c FROM user_permissions WHERE user_id IN (?)", [[ids.acctB, ids.acct]]);
    const roleBefore = await roleGrant(ids.ACCOUNTANT, perm.coaView);
    for (const who of ["admin", "acct"]) {
      const calls = [
        request(app).put(`/api/roles/${ids.ACCOUNTANT}/permissions`).set(auth(who)).send({ grants: [{ permissionId: perm.coaView, granted: true }] }),
        request(app).post("/api/permission-templates").set(auth(who)).send({ name: `${P}hijack`, grants: [] }),
        request(app).put(`/api/permission-templates/${tpl.allowed}`).set(auth(who)).send({ name: "hijacked" }),
        request(app).delete(`/api/permission-templates/${tpl.allowed}`).set(auth(who)),
        request(app).post(`/api/permission-templates/${tpl.allowed}/apply`).set(auth(who)).send({ userId: ids.acctB }),
        request(app).post("/api/access-restrictions").set(auth(who)).send({ userId: ids.acctB, permissionId: perm.auditLogs, granted: true }),
        request(app).post("/api/access-restrictions").set(auth(who)).send({ userId: ids[who], permissionId: perm.auditLogs, granted: true }),
        request(app).get("/api/access-restrictions").set(auth(who)),
        request(app).put(`/api/users/${ids.acctB}/access`).set(auth(who)).send({ grants: [] }),
        request(app).put(`/api/users/${ids[who]}/access`).set(auth(who)).send({ grants: [{ permissionId: perm.auditLogs, granted: true }] }),
      ];
      for (const res of await Promise.all(calls)) expect(res.status).toBe(403);
    }
    const [[{ c: tplAfter }]] = await pool.execute("SELECT COUNT(*) AS c FROM permission_templates");
    const [[{ c: upAfter }]] = await pool.query("SELECT COUNT(*) AS c FROM user_permissions WHERE user_id IN (?)", [[ids.acctB, ids.acct]]);
    expect(tplAfter).toBe(tplBefore);
    expect(upAfter).toBe(upBefore);
    expect(await roleGrant(ids.ACCOUNTANT, perm.coaView)).toBe(roleBefore);
    const [[t]] = await pool.execute("SELECT name FROM permission_templates WHERE id = ?", [tpl.allowed]);
    expect(t.name).toBe(`${P}allowed`);
  });
});
