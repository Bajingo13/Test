// Trial Balance Checker company isolation. A run is created for one
// explicitly chosen (or the user's only) company and stores it in
// trial_balance_checker_runs.company_id; findings belong to it through
// run_id. View, export, mark investigated, recheck and adjustment drafts
// all use the run's stored company - never the caller's first/lowest
// company - and another company's run/finding gets the same 404 as an
// unknown id. Legacy runs (company_id NULL) are Super-Admin-only and can
// never produce an adjustment draft (409).
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(180000);

const P = "tbci-";
const PASSWORD = "TbciPass!1";
const RANGE = { from: "2091-01-01", to: "2091-12-31" };
const UNKNOWN_ID = 2147483000;

const co = {};
const ids = { users: [] };
const tokens = {};
let roles = {};
let legacyRunId;
let legacyFindingId;

async function makeUser(tag, roleId, companyIds = []) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const [u] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, ?, 'ACTIVE')",
    [`${P}${tag}`, hash, roleId]
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

const auth = (who) => ({ Authorization: `Bearer ${tokens[who]}` });
const BASE = "/api/reports/trial-balance-checker";
const runCheck = (who, body = {}) => request(app).post(`${BASE}/check`).set(auth(who)).send({ ...RANGE, ...body });
const getRun = (who, runId) => request(app).get(`${BASE}/runs/${runId}`).set(auth(who));
const exportRun = (who, runId) => request(app).get(`${BASE}/runs/${runId}/export`).set(auth(who));
const recheck = (who, runId, body = {}) => request(app).post(`${BASE}/runs/${runId}/recheck`).set(auth(who)).send(body);
const markInvestigated = (who, findingId) =>
  request(app).patch(`${BASE}/findings/${findingId}`).set(auth(who)).send({ investigated: true, note: "tbci" });
const draft = (who, findingId) =>
  request(app).post(`${BASE}/findings/${findingId}/adjustment-draft`).set(auth(who)).send({
    debitAccountCode: "TBCIDR", creditAccountCode: "TBCICR", amount: "12.34", explanation: "tbci adjustment",
  });

async function runRow(runId) {
  const [[row]] = await pool.execute("SELECT * FROM trial_balance_checker_runs WHERE id = ?", [runId]);
  return row;
}
async function jvCompany(jvId) {
  const [[row]] = await pool.execute("SELECT company_id FROM jv_headers WHERE id = ?", [jvId]);
  return row?.company_id;
}
async function draftAudit(findingId) {
  const [[row]] = await pool.execute(
    "SELECT company_id FROM audit_logs WHERE action = 'CREATE_ADJUSTMENT_DRAFT' AND entity_type = 'CHECKER_FINDING' AND entity_id = ? ORDER BY id DESC LIMIT 1",
    [findingId]
  );
  return row || null;
}
// A finding of a run with no adjustment yet (each run carries several
// static informational findings, so a fresh one is always available).
function freshFinding(runBody, used) {
  const f = runBody.findings.find((x) => !x.adjustment_jv_id && !used.has(x.id));
  used.add(f.id);
  return f.id;
}

beforeAll(async () => {
  assertNotProductionDatabase();
  const [roleRows] = await pool.execute("SELECT id, code FROM roles");
  for (const r of roleRows) roles[r.code] = r.id;

  // Decoy first: the lowest company id of this suite. Nothing may ever
  // fall back to it.
  for (const tag of ["Decoy", "A", "B"]) {
    const [c] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [`TBCI Co ${tag}`]);
    co[tag] = c.insertId;
  }

  await makeUser("super", roles.SUPER_ADMIN);
  ids.adminA = await makeUser("admin-a", roles.ADMIN, [co.A]);
  ids.adminB = await makeUser("admin-b", roles.ADMIN, [co.B]);
  ids.multi = await makeUser("multi", roles.ADMIN, [co.A, co.B]);
  const [[auditPerm]] = await pool.query("SELECT id FROM permissions WHERE module_key = 'ADMIN.AUDIT_LOGS' AND action = 'VIEW'");
  for (const u of [ids.adminA, ids.adminB]) {
    await pool.execute("INSERT INTO user_permissions (user_id, permission_id, granted) VALUES (?, ?, 1)", [u, auditPerm.id]);
  }

  await pool.execute("DELETE FROM chart_of_accounts WHERE code IN ('TBCIDR', 'TBCICR')");
  await pool.execute("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES ('TBCIDR', CURDATE(), 'TBCI Debit', 'EXPENSE')");
  await pool.execute("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES ('TBCICR', CURDATE(), 'TBCI Credit', 'LIABILITY')");

  // A legacy run (pre-migration shape: no company).
  const [legacy] = await pool.execute(
    `INSERT INTO trial_balance_checker_runs (company_id, run_by, from_date, to_date, tolerance, balance_status, run_state)
     VALUES (NULL, NULL, '2090-01-01', '2090-12-31', 0, 'BALANCED', 'COMPLETED')`
  );
  legacyRunId = legacy.insertId;
  const [lf] = await pool.execute(
    "INSERT INTO trial_balance_checker_findings (run_id, category, severity, source_module, reason, recommended_action) VALUES (?, 'OTHER_SUSPICIOUS', 'LOW', 'SYSTEM', 'tbci legacy', 'Create Adjustment Draft')",
    [legacyRunId]
  );
  legacyFindingId = lf.insertId;

  tokens.super = await tokenFor("super");
  tokens.adminA = await tokenFor("admin-a");
  tokens.adminB = await tokenFor("admin-b");
  tokens.multi = await tokenFor("multi");
});

afterAll(async () => {
  const companies = [co.Decoy, co.A, co.B].filter(Boolean);
  try {
    if (companies.length) {
      const [jvs] = await pool.query("SELECT id FROM jv_headers WHERE company_id IN (?)", [companies]);
      if (jvs.length) {
        await pool.query("DELETE FROM jv_lines WHERE jv_id IN (?)", [jvs.map((r) => r.id)]);
        await pool.query("DELETE FROM jv_headers WHERE id IN (?)", [jvs.map((r) => r.id)]);
      }
      await pool.query(
        "DELETE f FROM trial_balance_checker_findings f JOIN trial_balance_checker_runs r ON r.id = f.run_id WHERE r.company_id IN (?)",
        [companies]
      );
      await pool.query("DELETE FROM trial_balance_checker_runs WHERE company_id IN (?)", [companies]);
    }
    if (legacyRunId) {
      await pool.query("DELETE FROM trial_balance_checker_findings WHERE run_id = ?", [legacyRunId]);
      await pool.query("DELETE FROM trial_balance_checker_runs WHERE id = ?", [legacyRunId]);
    }
    await pool.execute("DELETE FROM chart_of_accounts WHERE code IN ('TBCIDR', 'TBCICR')");
    if (ids.users.length) await pool.query("DELETE FROM audit_logs WHERE user_id IN (?)", [ids.users]);
    if (companies.length) await pool.query("DELETE FROM audit_logs WHERE company_id IN (?)", [companies]);
    if (ids.users.length) {
      await pool.query("DELETE FROM user_permissions WHERE user_id IN (?)", [ids.users]);
      await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [ids.users]);
      await pool.query("DELETE FROM users WHERE id IN (?)", [ids.users]);
    }
    if (companies.length) await pool.query("DELETE FROM companies WHERE id IN (?)", [companies]);
  } finally {
    await pool.end();
  }
});

const runs = {};
const used = new Set();

describe("run creation: an explicit, validated company", () => {
  test("single-company user gets their only company automatically", async () => {
    const res = await runCheck("adminA");
    expect(res.status).toBe(200);
    expect(res.body.companyId).toBe(co.A);
    expect((await runRow(res.body.runId)).company_id).toBe(co.A);
    runs.adminA = res.body;
  });

  test("Company B admin's run is Company B", async () => {
    const res = await runCheck("adminB");
    expect(res.status).toBe(200);
    expect((await runRow(res.body.runId)).company_id).toBe(co.B);
    runs.adminB = res.body;
  });

  test("multi-company user must select a company; with one selected the run is that company", async () => {
    const res = await runCheck("multi");
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Select a company/);
    const picked = await runCheck("multi", { companyId: co.B });
    expect(picked.status).toBe(200);
    expect((await runRow(picked.body.runId)).company_id).toBe(co.B);
  });

  test("Super Admin must select a company - never the lowest", async () => {
    const res = await runCheck("super");
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Select a company/);
    const a = await runCheck("super", { companyId: co.A });
    const b = await runCheck("super", { companyId: co.B });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((await runRow(a.body.runId)).company_id).toBe(co.A);
    expect((await runRow(b.body.runId)).company_id).toBe(co.B);
    runs.superA = a.body;
    runs.superB = b.body;
  });

  test("the client cannot pick a company it has no access to, nor an invalid / unknown one", async () => {
    expect((await runCheck("adminA", { companyId: co.B })).status).toBe(403);
    expect((await runCheck("adminA", { companyId: "abc" })).status).toBe(400);
    expect((await runCheck("super", { companyId: UNKNOWN_ID })).status).toBe(400);
  });
});

describe("run and finding access", () => {
  test("own company run is visible; another company's run looks exactly like an unknown one", async () => {
    expect((await getRun("adminA", runs.adminA.runId)).status).toBe(200);
    const cross = await getRun("adminB", runs.adminA.runId);
    const unknown = await getRun("adminB", UNKNOWN_ID);
    expect(cross.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(cross.body).toEqual(unknown.body);
  });

  test("Super Admin can read both companies' runs", async () => {
    expect((await getRun("super", runs.adminA.runId)).body.companyId).toBe(co.A);
    expect((await getRun("super", runs.adminB.runId)).body.companyId).toBe(co.B);
  });

  test("cross-company mark investigated is rejected before any update", async () => {
    const findingId = runs.adminA.findings[0].id;
    const res = await markInvestigated("adminB", findingId);
    expect(res.status).toBe(404);
    const [[f]] = await pool.execute("SELECT investigated FROM trial_balance_checker_findings WHERE id = ?", [findingId]);
    expect(f.investigated).toBe(0);

    const own = await markInvestigated("adminA", findingId);
    expect(own.status).toBe(200);
    const [[a]] = await pool.execute(
      "SELECT company_id FROM audit_logs WHERE action = 'MARK_INVESTIGATED' AND entity_id = ? ORDER BY id DESC LIMIT 1",
      [findingId]
    );
    expect(a.company_id).toBe(co.A);
  });

  test("cross-company export is rejected; own export works", async () => {
    expect((await exportRun("adminB", runs.adminA.runId)).status).toBe(404);
    const own = await exportRun("adminA", runs.adminA.runId);
    expect(own.status).toBe(200);
    expect(own.headers["content-type"]).toMatch(/text\/csv/);
  });

  test("recheck keeps the run's company, ignores a body company, and is rejected cross-company", async () => {
    expect((await recheck("adminB", runs.adminA.runId)).status).toBe(404);
    const res = await recheck("super", runs.adminA.runId, { companyId: co.B });
    expect(res.status).toBe(200);
    expect((await runRow(res.body.runId)).company_id).toBe(co.A);
  });
});

describe("adjustment drafts use the run's company", () => {
  const cases = [
    ["Company A admin, Company A run", "adminA", "adminA", "A"],
    ["Company B admin, Company B run", "adminB", "adminB", "B"],
    ["Super Admin, Company A run", "super", "superA", "A"],
    ["Super Admin, Company B run", "super", "superB", "B"],
  ];
  test.each(cases)("%s -> JV and audit in that company", async (_label, who, runKey, company) => {
    const findingId = freshFinding(runs[runKey], used);
    const res = await draft(who, findingId);
    expect(res.status).toBe(200);
    expect(await jvCompany(res.body.jvId)).toBe(co[company]);
    expect((await draftAudit(findingId)).company_id).toBe(co[company]);
  });

  test("no lowest-company fallback: a Super Admin draft never lands in the lowest company", async () => {
    expect(co.Decoy).toBeLessThan(co.A);
    const findingId = freshFinding(runs.superB, used);
    const res = await draft("super", findingId);
    expect(res.status).toBe(200);
    const jvCo = await jvCompany(res.body.jvId);
    expect(jvCo).toBe(co.B);
    expect(jvCo).not.toBe(co.Decoy);
  });

  test("cross-company draft is rejected and creates nothing", async () => {
    const findingId = freshFinding(runs.adminA, used);
    const [[before]] = await pool.query("SELECT COUNT(*) AS c FROM jv_headers WHERE company_id IN (?)", [[co.A, co.B]]);
    const res = await draft("adminB", findingId);
    expect(res.status).toBe(404);
    const [[after]] = await pool.query("SELECT COUNT(*) AS c FROM jv_headers WHERE company_id IN (?)", [[co.A, co.B]]);
    expect(after.c).toBe(before.c);
    expect(await draftAudit(findingId)).toBeNull();
  });

  test("unknown finding is rejected with the same 404", async () => {
    const res = await draft("super", UNKNOWN_ID);
    expect(res.status).toBe(404);
    expect(res.body.message).toBe("Finding not found");
  });
});

describe("legacy runs without a company", () => {
  test("Super-Admin-only: invisible to company users, visible to Super Admin", async () => {
    expect((await getRun("adminA", legacyRunId)).status).toBe(404);
    expect((await markInvestigated("adminA", legacyFindingId)).status).toBe(404);
    const res = await getRun("super", legacyRunId);
    expect(res.status).toBe(200);
    expect(res.body.companyId).toBeNull();
  });

  test("cannot create an adjustment draft (409) or be re-run (409); no company is assigned", async () => {
    const res = await draft("super", legacyFindingId);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/no company assigned/);
    expect((await recheck("super", legacyRunId)).status).toBe(409);
    expect((await runRow(legacyRunId)).company_id).toBeNull();
    expect(await draftAudit(legacyFindingId)).toBeNull();
  });
});

describe("running-run deduplication is per company", () => {
  test("a running Company A check is reused for A but never handed to B", async () => {
    const [[superUser]] = await pool.execute("SELECT id FROM users WHERE username = ?", [`${P}super`]);
    const range = { from: "2089-01-01", to: "2089-12-31" };
    const [running] = await pool.execute(
      `INSERT INTO trial_balance_checker_runs (company_id, run_by, from_date, to_date, tolerance, balance_status, run_state)
       VALUES (?, ?, ?, ?, 0, 'BALANCED', 'RUNNING')`,
      [co.A, superUser.id, range.from, range.to]
    );
    const b = await runCheck("super", { ...range, companyId: co.B });
    expect(b.status).toBe(200);
    expect(b.body.runId).not.toBe(running.insertId);
    expect(b.body.companyId).toBe(co.B);

    const a = await runCheck("super", { ...range, companyId: co.A });
    expect(a.status).toBe(200);
    expect(a.body.runId).toBe(running.insertId);
  });
});

describe("Audit Logs: each company sees only its own checker events", () => {
  const list = (who) => request(app).get("/api/audit-logs?module=TRIAL_BALANCE_CHECKER&limit=200").set(auth(who));

  test("Company A admin: A runs and A adjustment audits only", async () => {
    const res = await list("adminA");
    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.action === "CREATE_ADJUSTMENT_DRAFT")).toBe(true);
    expect(res.body.every((r) => r.companyId === co.A)).toBe(true);
  });

  test("Company B admin: B only", async () => {
    const res = await list("adminB");
    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.action === "CREATE_ADJUSTMENT_DRAFT")).toBe(true);
    expect(res.body.every((r) => r.companyId === co.B)).toBe(true);
  });

  test("Super Admin: both", async () => {
    const res = await list("super");
    const companies = new Set(res.body.map((r) => r.companyId));
    expect(companies.has(co.A)).toBe(true);
    expect(companies.has(co.B)).toBe(true);
  });
});
