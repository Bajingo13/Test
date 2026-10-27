// Audit event company attribution (Phase 4). New audit rows carry the
// company that actually owns the event's entity; events whose ownership
// is not one single company (multi-company users/invitations, global
// configuration, login) stay company_id = NULL (SYSTEM - Super Admin only).
// Never the actor's or the target's "first" company.
//
// Covers: user management, invitations, per-user permission overrides and
// template application, recurring templates + generation, accounting
// periods, FX revaluation, trial balance checker runs, print templates and
// document printing - then the unchanged Audit Logs visibility model on
// top of the new rows (A admin / B admin / Super Admin / system).
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const { soleCompanyId, soleCompanyForAccess, soleCompanyOfUser } = require("../lib/auditCompany");
const CurrencyService = require("../services/currencyService");
const RecurringTemplateService = require("../services/recurringTemplateService");
const GenerationService = require("../services/recurringGenerationService");
const FxRevaluationService = require("../services/fxRevaluationService");

jest.setTimeout(180000);

const P = "acat-";
const PASSWORD = "AcatPass!1";
const RECUR_PREFIX = "ACAT Recurring ";

const ids = { users: [], invitations: [], invoices: [], fxSessions: [], checkerRuns: [], printTemplates: [] };
const tokens = {};
let co = {};
let br = {};
let roles = {};

async function makeUser(tag, roleId, companyIds = []) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const [u] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status, email, full_name) VALUES (?, ?, ?, 'ACTIVE', ?, ?)",
    [`${P}${tag}`, hash, roleId, `${P}${tag}@example.test`, `ACAT ${tag}`]
  );
  for (const c of companyIds) await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  ids.users.push(u.insertId);
  return u.insertId;
}

async function tokenFor(tag) {
  const res = await request(app).post("/api/login").send({ username: `${P}${tag}`, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login ${tag}: ${res.status}`);
  return res.body.token;
}

async function grant(userId, moduleKey, action) {
  const [[perm]] = await pool.query("SELECT id FROM permissions WHERE module_key = ? AND action = ?", [moduleKey, action]);
  await pool.execute("INSERT INTO user_permissions (user_id, permission_id, granted) VALUES (?, ?, 1)", [userId, perm.id]);
}

const auth = (who) => ({ Authorization: `Bearer ${tokens[who]}` });

// Newest audit row for an entity/action (or null).
async function audit(entityType, entityId, action) {
  const [rows] = await pool.execute(
    "SELECT * FROM audit_logs WHERE entity_type = ? AND entity_id = ? AND action = ? ORDER BY id DESC LIMIT 1",
    [entityType, entityId, action]
  );
  return rows[0] || null;
}

async function auditCount(where, params) {
  const [[r]] = await pool.execute(`SELECT COUNT(*) AS c FROM audit_logs WHERE ${where}`, params);
  return r.c;
}

let accountIds = [];
let partyB;

function recurringBody(name) {
  return {
    moduleType: "invoice",
    templateName: `${RECUR_PREFIX}${name}`,
    partyId: partyB,
    partyName: "ACAT Customer B",
    descriptionTemplate: "ACAT recurring {{month_name}}",
    currency: "PHP",
    currencyId: null,
    amountMode: "FIXED",
    amountConfig: {},
    dueDateRule: { mode: "SAME_AS_TRANSACTION_DATE" },
    lines: [
      { accountId: accountIds[0], accountCode: "ACATAR", accountTitle: "AR (ACAT)", particularsTemplate: "x", debit: 100, credit: 0 },
      { accountId: accountIds[1], accountCode: "ACATREV", accountTitle: "Revenue (ACAT)", particularsTemplate: "x", debit: 0, credit: 100 },
    ],
    schedule: { frequency: "MONTHLY", startDate: "2092-02-01", endDate: null, dateAdjustmentRule: "KEEP_ORIGINAL" },
  };
}

beforeAll(async () => {
  assertNotProductionDatabase();

  const [roleRows] = await pool.execute("SELECT id, code FROM roles");
  for (const r of roleRows) roles[r.code] = r.id;

  const [ca] = await pool.execute("INSERT INTO companies (name, status) VALUES ('ACAT Co A', 'Active')");
  const [cb] = await pool.execute("INSERT INTO companies (name, status) VALUES ('ACAT Co B', 'Active')");
  co = { A: ca.insertId, B: cb.insertId };
  const [ba] = await pool.execute("INSERT INTO branches (company_id, name, status) VALUES (?, 'ACAT Branch A', 'ACTIVE')", [co.A]);
  const [bb] = await pool.execute("INSERT INTO branches (company_id, name, status) VALUES (?, 'ACAT Branch B', 'ACTIVE')", [co.B]);
  br = { A: ba.insertId, B: bb.insertId };

  ids.super = await makeUser("super", roles.SUPER_ADMIN);
  ids.adminA = await makeUser("admin-a", roles.ADMIN, [co.A]);
  ids.adminB = await makeUser("admin-b", roles.ADMIN, [co.B]);
  ids.tA = await makeUser("t-a", roles.ACCOUNTANT, [co.A]);
  ids.tAB = await makeUser("t-ab", roles.ACCOUNTANT, [co.A, co.B]);
  ids.tMove = await makeUser("t-move", roles.ACCOUNTANT, [co.A]);
  await grant(ids.adminA, "ADMIN.AUDIT_LOGS", "VIEW");
  await grant(ids.adminB, "ADMIN.AUDIT_LOGS", "VIEW");

  tokens.super = await tokenFor("super");
  tokens.adminA = await tokenFor("admin-a");
  tokens.adminB = await tokenFor("admin-b");

  // Company B: base currency, accounts and a customer for recurring / FX.
  await CurrencyService.createCurrency({ id: ids.super, roleCode: "SUPER_ADMIN" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "P",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: co.B,
  });
  await pool.execute("DELETE FROM chart_of_accounts WHERE code IN ('ACATAR', 'ACATREV')");
  for (const [code, title, cls] of [["ACATAR", "AR (ACAT)", "ASSET"], ["ACATREV", "Revenue (ACAT)", "INCOME"]]) {
    const [r] = await pool.execute(
      "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
      [code, title, cls]
    );
    accountIds.push(r.insertId);
  }
  const [party] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, 'ACATCUSTB', 'CUSTOMER', 'ACAT Customer B', 'ACTIVE')",
    [co.B]
  );
  partyB = party.insertId;
});

afterAll(async () => {
  const companies = [co.A, co.B].filter(Boolean);
  try {
    // Recurring
    const [tpl] = await pool.query("SELECT id FROM recurring_transaction_templates WHERE template_name LIKE ?", [`${RECUR_PREFIX}%`]);
    const tplIds = tpl.map((r) => r.id);
    if (tplIds.length) {
      await pool.query(
        "DELETE o FROM recurring_transaction_occurrences o JOIN recurring_transaction_schedules s ON s.id = o.schedule_id WHERE s.template_id IN (?)",
        [tplIds]
      );
      await pool.query("DELETE FROM recurring_transaction_schedules WHERE template_id IN (?)", [tplIds]);
      await pool.query("DELETE FROM recurring_transaction_template_lines WHERE template_id IN (?)", [tplIds]);
      await pool.query("DELETE FROM recurring_transaction_template_versions WHERE template_id IN (?)", [tplIds]);
      await pool.query("DELETE FROM recurring_transaction_templates WHERE id IN (?)", [tplIds]);
    }
    if (companies.length) {
      const [inv] = await pool.query("SELECT id FROM invoice_headers WHERE company_id IN (?)", [companies]);
      const invIds = inv.map((r) => r.id);
      if (invIds.length) {
        await pool.query("DELETE FROM invoice_lines WHERE invoice_id IN (?)", [invIds]);
        await pool.query("DELETE FROM invoice_headers WHERE id IN (?)", [invIds]);
      }
      await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id IN (?)", [companies]);
      // FX revaluation
      const [fx] = await pool.query("SELECT id FROM fx_revaluation_sessions WHERE company_id IN (?)", [companies]);
      if (fx.length) {
        await pool.query("DELETE FROM fx_revaluation_items WHERE session_id IN (?)", [fx.map((r) => r.id)]);
        await pool.query("DELETE FROM fx_revaluation_sessions WHERE id IN (?)", [fx.map((r) => r.id)]);
      }
      // Periods, print templates
      await pool.query("DELETE FROM accounting_period_history WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM accounting_periods WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM document_print_templates WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM currency_rates WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM currencies WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM general_libraries WHERE company_id IN (?)", [companies]);
    }
    if (ids.checkerRuns.length) {
      await pool.query("DELETE FROM trial_balance_checker_findings WHERE run_id IN (?)", [ids.checkerRuns]);
      await pool.query("DELETE FROM trial_balance_checker_runs WHERE id IN (?)", [ids.checkerRuns]);
    }
    await pool.execute("DELETE FROM chart_of_accounts WHERE code IN ('ACATAR', 'ACATREV')");
    // Recurring numbering counter for the suite's far-future month only.
    await pool.execute("DELETE FROM recurring_number_counters WHERE period_key LIKE '2092%'");
    // Permission templates / invitations
    await pool.query("DELETE i FROM permission_template_items i JOIN permission_templates t ON t.id = i.template_id WHERE t.name LIKE 'ACAT %'");
    await pool.query("DELETE FROM permission_templates WHERE name LIKE 'ACAT %'");
    const [acceptedUsers] = await pool.query("SELECT accepted_user_id AS id FROM invitations WHERE email LIKE ? AND accepted_user_id IS NOT NULL", [`${P}%`]);
    ids.users.push(...acceptedUsers.map((r) => r.id));
    await pool.query("DELETE FROM invitations WHERE email LIKE ?", [`${P}%`]);
    // Audit rows written by this suite's users or for its companies only.
    if (ids.users.length) await pool.query("DELETE FROM audit_logs WHERE user_id IN (?)", [ids.users]);
    if (companies.length) await pool.query("DELETE FROM audit_logs WHERE company_id IN (?)", [companies]);
    if (ids.users.length) {
      await pool.query("DELETE FROM user_permissions WHERE user_id IN (?)", [ids.users]);
      await pool.query("DELETE FROM user_branches WHERE user_id IN (?)", [ids.users]);
      await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [ids.users]);
      await pool.query("DELETE FROM users WHERE id IN (?)", [ids.users]);
    }
    if (companies.length) {
      await pool.query("DELETE FROM branches WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM companies WHERE id IN (?)", [companies]);
    }
  } finally {
    await pool.end();
  }
});

describe("attribution helper", () => {
  test("exactly one distinct company -> that company; none or several -> null", () => {
    expect(soleCompanyId([7])).toBe(7);
    expect(soleCompanyId([7, "7"])).toBe(7);
    expect(soleCompanyId("[7]")).toBe(7);
    expect(soleCompanyId([3, 7])).toBeNull();
    expect(soleCompanyId([])).toBeNull();
    expect(soleCompanyId(null)).toBeNull();
    expect(soleCompanyId("not json")).toBeNull();
  });

  test("a branch counts as its company", async () => {
    expect(await soleCompanyForAccess(pool, { companyIds: [co.A], branchIds: [br.A] })).toBe(co.A);
    expect(await soleCompanyForAccess(pool, { companyIds: [co.A], branchIds: [br.B] })).toBeNull();
    expect(await soleCompanyForAccess(pool, { companyIds: [], branchIds: [br.B] })).toBe(co.B);
  });

  test("a user's membership: one company -> it; two -> null (not the lowest id)", async () => {
    expect(await soleCompanyOfUser(pool, ids.tA)).toBe(co.A);
    expect(await soleCompanyOfUser(pool, ids.tAB)).toBeNull();
    expect(await soleCompanyOfUser(pool, ids.super)).toBeNull();
  });
});

describe("authentication stays system-level", () => {
  test("a single-company user's login is not attributed to that company", async () => {
    await tokenFor("t-a");
    const [[row]] = await pool.execute(
      "SELECT company_id FROM audit_logs WHERE action = 'LOGIN_SUCCESS' AND user_id = ? ORDER BY id DESC LIMIT 1",
      [ids.tA]
    );
    expect(row.company_id).toBeNull();
  });
});

describe("user management", () => {
  test("status change on a single-company user -> that company", async () => {
    const res = await request(app).patch(`/api/users/${ids.tA}/status`).set(auth("adminA")).send({ status: "INACTIVE" });
    expect(res.status).toBe(200);
    expect((await audit("USER", ids.tA, "USER_DEACTIVATED")).company_id).toBe(co.A);
    await request(app).patch(`/api/users/${ids.tA}/status`).set(auth("adminA")).send({ status: "ACTIVE" });
    expect((await audit("USER", ids.tA, "USER_ACTIVATED")).company_id).toBe(co.A);
  });

  test("multi-company user stays NULL even when the actor is a Company A admin", async () => {
    const res = await request(app).patch(`/api/users/${ids.tAB}/status`).set(auth("adminA")).send({ status: "SUSPENDED" });
    expect(res.status).toBe(200);
    expect((await audit("USER", ids.tAB, "USER_SUSPENDED")).company_id).toBeNull();
    await request(app).patch(`/api/users/${ids.tAB}/status`).set(auth("adminA")).send({ status: "ACTIVE" });
  });

  test("unlock and revoke sessions follow the target's single company", async () => {
    expect((await request(app).post(`/api/users/${ids.tA}/unlock`).set(auth("adminA"))).status).toBe(200);
    expect((await audit("USER", ids.tA, "USER_UNLOCKED")).company_id).toBe(co.A);
    expect((await request(app).post(`/api/users/${ids.tA}/revoke-sessions`).set(auth("adminA"))).status).toBe(200);
    expect((await audit("USER", ids.tA, "SESSION_REVOKED")).company_id).toBe(co.A);
    expect((await request(app).post(`/api/users/${ids.tAB}/revoke-sessions`).set(auth("adminA"))).status).toBe(200);
    expect((await audit("USER", ids.tAB, "SESSION_REVOKED")).company_id).toBeNull();
  });

  test("access update within one company -> that company; a move A -> B -> NULL", async () => {
    let res = await request(app).patch(`/api/users/${ids.tA}`).set(auth("super")).send({ fullName: "ACAT t-a renamed" });
    expect(res.status).toBe(200);
    expect((await audit("USER", ids.tA, "ACCESS_UPDATED")).company_id).toBe(co.A);

    res = await request(app).patch(`/api/users/${ids.tMove}`).set(auth("super")).send({ companyIds: [co.B] });
    expect(res.status).toBe(200);
    const row = await audit("USER", ids.tMove, "ACCESS_UPDATED");
    expect(row.company_id).toBeNull();
    expect(row.company_id).not.toBe(co.A);
  });
});

describe("invitations", () => {
  let singleId;

  test("single-company invitation: invited / resent / accepted -> that company", async () => {
    const res = await request(app).post("/api/invitations").set(auth("super")).send({
      email: `${P}inv-single@example.test`, fullName: "ACAT Invitee", roleId: roles.ACCOUNTANT, companyIds: [co.B],
    });
    expect(res.status).toBe(201);
    singleId = res.body.id;
    expect((await audit("INVITATION", singleId, "USER_INVITED")).company_id).toBe(co.B);

    expect((await request(app).post(`/api/invitations/${singleId}/resend`).set(auth("super"))).status).toBe(200);
    expect((await audit("INVITATION", singleId, "INVITATION_RESENT")).company_id).toBe(co.B);
  });

  test("acceptance attributes both the invitation and the new user to that company", async () => {
    // Each resend replaces the token; take the current one from a resend.
    const resend = await request(app).post(`/api/invitations/${singleId}/resend`).set(auth("super"));
    const token = /token=([0-9a-f]{64})/.exec(resend.body.acceptUrl || "")?.[1];
    expect(token).toBeTruthy();
    const res = await request(app).post("/api/invitations/accept").send({ token, password: "AcatNew!123", acceptedTerms: true });
    expect(res.status).toBe(201);
    const newUserId = res.body.user.id;
    ids.users.push(newUserId);
    expect((await audit("INVITATION", singleId, "INVITATION_ACCEPTED")).company_id).toBe(co.B);
    expect((await audit("USER", newUserId, "USER_ACTIVATED")).company_id).toBe(co.B);
  });

  test("multi-company invitation stays NULL (invited / revoked)", async () => {
    const res = await request(app).post("/api/invitations").set(auth("super")).send({
      email: `${P}inv-multi@example.test`, fullName: "ACAT Multi", roleId: roles.ACCOUNTANT, companyIds: [co.A, co.B],
    });
    expect(res.status).toBe(201);
    expect((await audit("INVITATION", res.body.id, "USER_INVITED")).company_id).toBeNull();
    expect((await request(app).post(`/api/invitations/${res.body.id}/revoke`).set(auth("super"))).status).toBe(200);
    expect((await audit("INVITATION", res.body.id, "INVITATION_REVOKED")).company_id).toBeNull();
  });

  test("a company plus a branch of another company stays NULL", async () => {
    const res = await request(app).post("/api/invitations").set(auth("super")).send({
      email: `${P}inv-branch@example.test`, fullName: "ACAT Branch", roleId: roles.ACCOUNTANT, companyIds: [co.A], branchIds: [br.B],
    });
    expect(res.status).toBe(201);
    expect((await audit("INVITATION", res.body.id, "USER_INVITED")).company_id).toBeNull();
  });
});

describe("permission overrides and template application", () => {
  let permId;
  let templateId;

  beforeAll(async () => {
    const [[perm]] = await pool.query("SELECT id FROM permissions WHERE module_key = 'ADMIN.USER_SETTINGS' AND action = 'VIEW'");
    permId = perm.id;
    const [t] = await pool.execute("INSERT INTO permission_templates (name, description) VALUES ('ACAT Template', 'phase 4 test')");
    templateId = t.insertId;
    await pool.execute("INSERT INTO permission_template_items (template_id, permission_id, granted) VALUES (?, ?, 1)", [templateId, permId]);
  });

  test("restriction on a single-company user -> that company; removal too", async () => {
    const res = await request(app).post("/api/access-restrictions").set(auth("super")).send({ userId: ids.tA, permissionId: permId, granted: false });
    expect(res.status).toBe(201);
    expect((await audit("USER_PERMISSION", ids.tA, "RESTRICTION_ADDED")).company_id).toBe(co.A);
    expect((await request(app).delete(`/api/access-restrictions/${res.body.id}`).set(auth("super"))).status).toBe(200);
    expect((await audit("USER_PERMISSION", ids.tA, "RESTRICTION_REMOVED")).company_id).toBe(co.A);
  });

  test("restriction on a multi-company user stays NULL", async () => {
    const res = await request(app).post("/api/access-restrictions").set(auth("super")).send({ userId: ids.tAB, permissionId: permId, granted: false });
    expect(res.status).toBe(201);
    expect((await audit("USER_PERMISSION", ids.tAB, "RESTRICTION_ADDED")).company_id).toBeNull();
  });

  test("full override replace follows the target user", async () => {
    expect((await request(app).put(`/api/users/${ids.tA}/access`).set(auth("super")).send({ grants: [] })).status).toBe(200);
    expect((await audit("USER_PERMISSION", ids.tA, "RESTRICTION_ADDED")).company_id).toBe(co.A);
  });

  test("template applied: single-company user -> company, multi-company -> NULL; the global template itself stays unattributed", async () => {
    expect((await request(app).post(`/api/permission-templates/${templateId}/apply`).set(auth("super")).send({ userId: ids.tA })).status).toBe(200);
    expect((await audit("PERMISSION_TEMPLATE", templateId, "TEMPLATE_APPLIED")).company_id).toBe(co.A);
    expect((await request(app).post(`/api/permission-templates/${templateId}/apply`).set(auth("super")).send({ userId: ids.tAB })).status).toBe(200);
    expect((await audit("PERMISSION_TEMPLATE", templateId, "TEMPLATE_APPLIED")).company_id).toBeNull();
  });
});

describe("recurring transactions", () => {
  let templateId;
  let scheduleId;

  beforeAll(async () => {
    const res = await request(app).post("/api/recurring-transactions").set(auth("super")).send({ ...recurringBody("B main"), companyId: co.B });
    expect(res.status).toBe(201);
    templateId = res.body.templateId;
    scheduleId = res.body.scheduleId;
  });

  test("template created / paused / resumed with Company B -> B", async () => {
    expect((await audit("RECURRING_TEMPLATE", templateId, "TEMPLATE_CREATED")).company_id).toBe(co.B);
    expect((await request(app).post(`/api/recurring-transactions/${templateId}/pause`).set(auth("super")).send({ companyId: co.B })).status).toBe(200);
    expect((await audit("RECURRING_TEMPLATE", templateId, "TEMPLATE_PAUSED")).company_id).toBe(co.B);
    const resumed = await request(app).post(`/api/recurring-transactions/${templateId}/resume`).set(auth("super")).send({ companyId: co.B, catchUpPolicy: "SKIP_TO_NEXT" });
    expect(resumed.status).toBe(200);
    expect((await audit("RECURRING_TEMPLATE", templateId, "TEMPLATE_RESUMED")).company_id).toBe(co.B);
  });

  test("another company cannot be substituted: A context on B's template -> 404, no audit row", async () => {
    const before = await auditCount("entity_type = 'RECURRING_TEMPLATE' AND entity_id = ?", [templateId]);
    const res = await request(app).post(`/api/recurring-transactions/${templateId}/stop`).set(auth("super")).send({ companyId: co.A });
    expect(res.status).toBe(404);
    expect(await auditCount("entity_type = 'RECURRING_TEMPLATE' AND entity_id = ?", [templateId])).toBe(before);
    const edit = await request(app).put(`/api/recurring-transactions/${templateId}`).set(auth("super")).send({ companyId: co.A, templateName: `${RECUR_PREFIX}hijack` });
    expect(edit.status).toBe(404);
    expect(await auditCount("entity_type = 'RECURRING_TEMPLATE' AND entity_id = ? AND company_id = ?", [templateId, co.A])).toBe(0);
  });

  test("generation: generated occurrence -> the template's company", async () => {
    const result = await GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: ids.super });
    expect(result.status).toBe("SUCCESS");
    ids.invoices.push(result.generatedId);
    expect((await audit("INVOICE", result.generatedId, "OCCURRENCE_GENERATED")).company_id).toBe(co.B);
  });

  test("generation failure -> the template's company", async () => {
    const created = await RecurringTemplateService.createTemplate(recurringBody("B failing"), ids.super, co.B);
    await pool.execute("DELETE FROM recurring_transaction_template_lines WHERE template_id = ?", [created.templateId]);
    await expect(GenerationService.processSchedule(created.scheduleId, { userId: ids.super })).rejects.toThrow();
    expect((await audit("RECURRING_SCHEDULE", created.scheduleId, "OCCURRENCE_FAILED")).company_id).toBe(co.B);
  });

  test("legacy template with no company -> NULL, never the first-company fallback", async () => {
    const created = await RecurringTemplateService.createTemplate(recurringBody("legacy"), ids.super, co.B);
    await pool.execute("UPDATE recurring_transaction_templates SET company_id = NULL WHERE id = ?", [created.templateId]);
    await pool.execute("DELETE FROM recurring_transaction_template_lines WHERE template_id = ?", [created.templateId]);
    await expect(GenerationService.processSchedule(created.scheduleId, { userId: ids.super })).rejects.toThrow();
    expect((await audit("RECURRING_SCHEDULE", created.scheduleId, "OCCURRENCE_FAILED")).company_id).toBeNull();
  });
});

describe("document printing", () => {
  test("transaction and invoice print events -> the printed document's company; wrong company -> 404, no row", async () => {
    const invoiceId = ids.invoices[0];
    expect(invoiceId).toBeTruthy();

    let res = await request(app).get(`/api/print/invoice/${invoiceId}?companyId=${co.B}&intent=preview`).set(auth("super"));
    expect(res.status).toBe(200);
    expect((await audit("INVOICE", invoiceId, "PRINT_PREVIEW")).company_id).toBe(co.B);

    res = await request(app).get(`/api/invoice-print/${invoiceId}?companyId=${co.B}&intent=print`).set(auth("super"));
    expect(res.status).toBe(200);
    expect((await audit("INVOICE", invoiceId, "PRINT_DOCUMENT")).company_id).toBe(co.B);

    const before = await auditCount("entity_type = 'INVOICE' AND entity_id = ?", [invoiceId]);
    res = await request(app).get(`/api/print/invoice/${invoiceId}?companyId=${co.A}`).set(auth("super"));
    expect(res.status).toBe(404);
    expect(await auditCount("entity_type = 'INVOICE' AND entity_id = ?", [invoiceId])).toBe(before);
  });

  test("list print -> the listed company", async () => {
    const res = await request(app).post("/api/print/invoice/list").set(auth("super")).send({ companyId: co.B, grouping: "number", intent: "preview" });
    expect(res.status).toBe(200);
    const [[row]] = await pool.execute(
      "SELECT company_id FROM audit_logs WHERE entity_type = 'INVOICE_LIST' AND action = 'PRINT_LIST_PREVIEW' AND user_id = ? ORDER BY id DESC LIMIT 1",
      [ids.super]
    );
    expect(row.company_id).toBe(co.B);
  });
});

describe("print templates", () => {
  test("template events -> the template row's company; wrong company -> 404, no row", async () => {
    const res = await request(app).post("/api/print-templates").set(auth("super")).send({
      companyId: co.B, moduleType: "invoice", templateCode: "acat-inv-b", templateName: "ACAT Invoice B",
      documentVariant: "sales_invoice", config: { header: { documentTitle: "ACAT" } },
    });
    expect(res.status).toBe(201);
    const id = res.body.id;
    expect((await audit("PRINT_TEMPLATE", id, "CREATE")).company_id).toBe(co.B);

    expect((await request(app).post(`/api/print-templates/${id}/set-default`).set(auth("super")).send({ companyId: co.B })).status).toBe(200);
    expect((await audit("PRINT_TEMPLATE", id, "SET_DEFAULT")).company_id).toBe(co.B);

    expect((await request(app).post(`/api/print-templates/${id}/deactivate`).set(auth("super")).send({ companyId: co.A })).status).toBe(404);
    expect(await audit("PRINT_TEMPLATE", id, "DEACTIVATE")).toBeNull();
  });
});

describe("accounting periods", () => {
  test("generate / soft-close -> the period's company; wrong company -> 404, no row", async () => {
    let res = await request(app).post("/api/accounting-periods/generate-year").set(auth("super")).send({ companyId: co.B, year: 2093 });
    expect(res.status).toBe(200);
    const [[gen]] = await pool.execute(
      "SELECT company_id FROM audit_logs WHERE action = 'ACCOUNTING_PERIOD_GENERATED' AND user_id = ? ORDER BY id DESC LIMIT 1",
      [ids.super]
    );
    expect(gen.company_id).toBe(co.B);

    const [[period]] = await pool.execute("SELECT id FROM accounting_periods WHERE company_id = ? AND year = 2093 AND period_month = 1", [co.B]);
    res = await request(app).post(`/api/accounting-periods/${period.id}/soft-close`).set(auth("super")).send({ companyId: co.A });
    expect(res.status).toBe(404);
    expect(await audit("ACCOUNTING_PERIOD", period.id, "ACCOUNTING_PERIOD_SOFT_CLOSED")).toBeNull();

    res = await request(app).post(`/api/accounting-periods/${period.id}/soft-close`).set(auth("super")).send({ companyId: co.B });
    expect(res.status).toBe(200);
    expect((await audit("ACCOUNTING_PERIOD", period.id, "ACCOUNTING_PERIOD_SOFT_CLOSED")).company_id).toBe(co.B);
  });
});

describe("FX revaluation", () => {
  test("calculate / post -> the session's company; wrong company -> 404, no row", async () => {
    // Company B has configured periods (above), so posting needs 2092 too.
    expect((await request(app).post("/api/accounting-periods/generate-year").set(auth("super")).send({ companyId: co.B, year: 2092 })).status).toBe(200);
    const session = await FxRevaluationService.calculate({ companyId: co.B, revaluationDate: "2092-06-30", userId: ids.super });
    const sessionId = session.session.id;
    expect(sessionId).toBeTruthy();
    expect((await audit("FX_REVALUATION_SESSION", sessionId, "FX_REVALUATION_CALCULATED")).company_id).toBe(co.B);

    await expect(FxRevaluationService.post({ sessionId, userId: ids.super, companyId: co.A })).rejects.toMatchObject({ statusCode: 404 });
    expect(await audit("FX_REVALUATION_SESSION", sessionId, "FX_REVALUATION_POSTED")).toBeNull();

    await FxRevaluationService.post({ sessionId, userId: ids.super, companyId: co.B });
    expect((await audit("FX_REVALUATION_SESSION", sessionId, "FX_REVALUATION_POSTED")).company_id).toBe(co.B);
  });
});

describe("trial balance checker", () => {
  test("a run -> the company it checked", async () => {
    const res = await request(app).post("/api/reports/trial-balance-checker/check").set(auth("super")).send({ companyId: co.B, from: "2092-01-01", to: "2092-12-31" });
    expect(res.status).toBe(200);
    const runId = res.body.runId;
    expect(runId).toBeTruthy();
    ids.checkerRuns.push(runId);
    expect((await audit("CHECKER_RUN", runId, "RUN")).company_id).toBe(co.B);
  });
});

describe("Audit Logs visibility on top of the new attribution (model unchanged)", () => {
  const list = (who, qs) => request(app).get(`/api/audit-logs?limit=200&${qs}`).set(auth(who));

  test("Company A admin sees A-scoped user events, not system (multi-company) ones", async () => {
    const own = await list("adminA", `entityType=USER&entityId=${ids.tA}`);
    expect(own.status).toBe(200);
    expect(own.body.some((r) => r.action === "USER_DEACTIVATED")).toBe(true);
    expect(own.body.every((r) => r.companyId === co.A)).toBe(true);

    const multi = await list("adminA", `entityType=USER&entityId=${ids.tAB}`);
    expect(multi.status).toBe(200);
    expect(multi.body).toEqual([]);
    expect((await list("adminA", "scope=system")).status).toBe(403);
  });

  test("Company A admin does not see B-scoped events; Company B admin does", async () => {
    const a = await list("adminA", "module=ACCOUNTING_PERIODS");
    expect(a.body.some((r) => r.companyId === co.B)).toBe(false);
    expect((await list("adminA", `companyId=${co.B}`)).status).toBe(403);

    const b = await list("adminB", "module=ACCOUNTING_PERIODS");
    expect(b.status).toBe(200);
    expect(b.body.some((r) => r.action === "ACCOUNTING_PERIOD_GENERATED" && r.companyId === co.B)).toBe(true);
    expect(b.body.every((r) => r.companyId === co.B)).toBe(true);
  });

  test("Super Admin sees A, B and SYSTEM events", async () => {
    expect((await list("super", `companyId=${co.A}&entityType=USER&entityId=${ids.tA}`)).body.length).toBeGreaterThan(0);
    expect((await list("super", `companyId=${co.B}&module=ACCOUNTING_PERIODS`)).body.length).toBeGreaterThan(0);
    const sys = await list("super", `scope=system&entityType=USER&entityId=${ids.tAB}`);
    expect(sys.status).toBe(200);
    expect(sys.body.some((r) => r.action === "USER_SUSPENDED")).toBe(true);
    expect(sys.body.every((r) => r.companyId === null)).toBe(true);
  });
});
