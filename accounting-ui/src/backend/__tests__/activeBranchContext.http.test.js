// System-wide Active Branch (X-Active-Branch) - server side.
// The header is a request CONTEXT: it narrows lists, posting and reports to
// the chosen branch and never widens what the user's company / branch
// assignments allow. Explicit ?branchId / ?branch win; writes never take their
// branch from it; Maker-Checker is untouched.
// Local test database only. Prefix UAT-ABC-.
process.env.POSTING_SOD_TEST_BYPASS = "0";
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { signSessionToken } = require("../lib/sessionPolicy");
const CurrencyService = require("../services/currencyService");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(300000);

const P = "UAT-ABC-";
const D = "2096-05-10";
const RANGE = "from=2096-05-01&to=2096-05-31";
const co = {};
const br = {};
const tok = {};
const usr = {};
const acc = {};
const party = {};
const ids = { users: [] };
const v = {};
let seq = 0;

async function roleId(code) {
  return (await pool.query("SELECT id FROM roles WHERE code = ?", [code]))[0][0].id;
}
async function permissionId(m, a) {
  return (await pool.query("SELECT id FROM permissions WHERE module_key = ? AND action = ?", [m, a]))[0][0].id;
}
async function mkUser(tag, roleCode, companies, branches = [], noPosting = false) {
  const [u] = await pool.query("INSERT INTO users (username, full_name, password, role_id, status) VALUES (?, ?, 'x', ?, 'ACTIVE')", [`${P}${tag}`, `${P}${tag}`, await roleId(roleCode)]);
  for (const c of companies) await pool.query("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  for (const b of branches) await pool.query("INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)", [u.insertId, b]);
  if (noPosting) for (const a of ["POST", "VIEW", "APPROVE"]) await pool.query("INSERT INTO user_permissions (user_id, permission_id, granted, reason) VALUES (?, ?, 0, 'UAT-ABC')", [u.insertId, await permissionId("POSTING", a)]);
  ids.users.push(u.insertId);
  usr[tag] = { id: u.insertId, username: `${P}${tag}`, role: roleCode, roleCode, token_version: 0 };
  tok[tag] = signSessionToken(usr[tag]);
}
// request helper: active = undefined (no header) | "ALL" | branch id | raw string
const call = (method, who, url, { active, body } = {}) => {
  const r = request(app)[method](url).set({ Authorization: `Bearer ${tok[who]}` });
  if (active !== undefined) r.set("X-Active-Branch", String(active));
  return body === undefined ? r : r.send(body);
};
const codes = (res) => (Array.isArray(res.body) ? res.body : []).map((r) => r.code || r.voucherNo).filter((c) => String(c).startsWith(P)).sort();
const L = (key, d, c) => ({ accountId: acc[key].id, accountCode: acc[key].code, accountTitle: acc[key].code, particulars: "x", debit: d, credit: c });
async function apvDraft(maker, branchKey, amount, companyKey = "A") {
  const n = `${P}APV-${branchKey}-${++seq}`;
  const body = { voucherNo: n, transactionDate: D, dueDate: D, referenceNo: n, description: n, status: "Draft",
    supplierId: party.SUP.id, supplierName: party.SUP.code, lines: [L("EXP", amount, 0), L("AP", 0, amount)], totalDebit: amount, totalCredit: amount,
    currency: { companyId: co[companyKey] }, branchId: br[branchKey] };
  const r = await call("post", maker, "/api/apv", { body });
  if (r.status !== 200 && r.status !== 201) throw new Error(`draft ${maker} ${branchKey}: ${r.status} ${JSON.stringify(r.body)}`);
  return { id: r.body.id, body, voucherNo: n };
}
const post = (who, d) => call("put", who, `/api/apv/${d.id}`, { body: { ...d.body, status: "Posted" } });
const expOf = (rows) => (Array.isArray(rows) ? rows : []).filter((r) => (r.account_code || r.accountCode) === acc.EXP.code).reduce((s, r) => s + Number(r.amount ?? 0), 0);

beforeAll(async () => {
  assertNotProductionDatabase();
  const mkCo = async (tag, branches) => {
    const [c] = await pool.query("INSERT INTO companies (name, status) VALUES (?, 'Active')", [`${P}${tag}`]);
    co[tag] = c.insertId;
    for (const b of branches) br[`${tag === "A" ? "" : `${tag}.`}${b}`] = (await pool.query("INSERT INTO branches (company_id, name, code, status) VALUES (?, ?, ?, 'ACTIVE')", [c.insertId, `${tag} ${b}`, `${P}${b}`]))[0].insertId;
    await CurrencyService.createCurrency({ id: 0, roleCode: "SUPER_ADMIN" }, { currencyCode: "PHP", currencyName: "Peso", currencySymbol: "P", decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: c.insertId });
  };
  await mkCo("A", ["AUDIT", "OUTSOURCE", "TAX"]);
  await mkCo("B", ["AUDIT"]); // overlapping branch code, another company
  await mkCo("C", []); // zero branches
  await mkCo("S", ["ONLY"]); // one branch
  await mkUser("acctAud", "ACCOUNTANT", [co.A], [br.AUDIT], true);
  await mkUser("acctOT", "ACCOUNTANT", [co.A], [br.OUTSOURCE, br.TAX], true);
  await mkUser("acctAll", "ACCOUNTANT", [co.A], [br.AUDIT, br.OUTSOURCE, br.TAX], true);
  await mkUser("adminA", "ADMIN", [co.A]);
  await mkUser("adminA2", "ADMIN", [co.A]);
  await mkUser("adminB", "ADMIN", [co.B]);
  await mkUser("adminS", "ADMIN", [co.S]);
  await mkUser("super", "SUPER_ADMIN", []);
  // consolidation permission (REPORTS.ALL_BRANCHES / VIEW) per user, for the
  // report matrix: granted to two accountants, revoked from one ADMIN
  await mkUser("acctOTc", "ACCOUNTANT", [co.A], [br.OUTSOURCE, br.TAX], true);
  await mkUser("acctAllc", "ACCOUNTANT", [co.A], [br.AUDIT, br.OUTSOURCE, br.TAX], true);
  await mkUser("adminNoCon", "ADMIN", [co.A]);
  const consolidate = await permissionId("REPORTS.ALL_BRANCHES", "VIEW");
  for (const [tag, granted] of [["acctOTc", 1], ["acctAllc", 1], ["adminNoCon", 0]]) {
    await pool.query("INSERT INTO user_permissions (user_id, permission_id, granted, reason) VALUES (?, ?, ?, 'UAT-ABC')", [usr[tag].id, consolidate, granted]);
  }
  await pool.query("INSERT INTO account_group_codes (group_code, group_description, account_class, status) VALUES (?, 'EXP', 'EXPENSE', 'ACTIVE'), (?, 'LIA', 'LIABILITY', 'ACTIVE')", [`${P}EXPG`, `${P}LIAG`]);
  const mkAcc = async (key, cls, group, branchId = null) => {
    const [r] = await pool.query("INSERT INTO chart_of_accounts (code, account_date, title, account_class, branch_id) VALUES (?, '2096-01-01', ?, ?, ?)", [`${P}${key}`, `${P}${key}`, cls, branchId]);
    if (group) await pool.query("INSERT INTO coa_groups (coa_id, group_code, group_description) VALUES (?, ?, ?)", [r.insertId, `${P}${group}`, group]);
    acc[key] = { id: r.insertId, code: `${P}${key}` };
  };
  await mkAcc("EXP", "EXPENSE", "EXPG"); // shared
  await mkAcc("AP", "LIABILITY", "LIAG"); // shared
  await mkAcc("AUD-ONLY", "ASSET", null, br.AUDIT);
  await mkAcc("OUT-ONLY", "ASSET", null, br.OUTSOURCE);
  await mkAcc("TAX-ONLY", "ASSET", null, br.TAX);
  await mkAcc("B-ONLY", "ASSET", null, br["B.AUDIT"]);
  const mkParty = async (key, type, branchId = null, companyKey = "A") => {
    const [r] = await pool.query("INSERT INTO general_libraries (company_id, code, party_type, name, status, branch_id) VALUES (?, ?, ?, ?, 'ACTIVE', ?)", [co[companyKey], `${P}${key}`, type, `${P}${key}`, branchId]);
    party[key] = { id: r.insertId, code: `${P}${key}` };
  };
  await mkParty("SUP", "SUPPLIER"); // shared
  await mkParty("SUP-AUD", "SUPPLIER", br.AUDIT);
  await mkParty("SUP-OUT", "SUPPLIER", br.OUTSOURCE);
  await mkParty("CUS", "CUSTOMER"); // shared
  await mkParty("CUS-OUT", "CUSTOMER", br.OUTSOURCE);
  // AUDIT 15,000 and OUTSOURCE 10,000 - the same shared supplier and accounts
  v.aud = await apvDraft("acctAud", "AUDIT", 15000);
  v.out = await apvDraft("acctOT", "OUTSOURCE", 10000);
  for (const d of [v.aud, v.out]) {
    const r = await post("adminA", d);
    if (r.status !== 200) throw new Error(`post: ${r.status} ${JSON.stringify(r.body)}`);
  }
  v.taxDraft = await apvDraft("acctOT", "TAX", 700);
  v.audDraft = await apvDraft("acctAll", "AUDIT", 300);
});

afterAll(async () => {
  try {
    const cos = Object.values(co);
    await pool.query("DELETE l FROM apv_lines l JOIN apv_headers h ON h.id = l.apv_id WHERE h.company_id IN (?)", [cos]);
    await pool.query("DELETE FROM apv_headers WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM transaction_tax_entries WHERE company_id IN (?)", [cos]).catch(() => {});
    await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM audit_logs WHERE company_id IN (?) OR user_id IN (?)", [cos, ids.users]);
    await pool.query("DELETE FROM general_libraries WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM coa_groups WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE ?)", [`${P}%`]);
    await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE ?", [`${P}%`]);
    await pool.query("DELETE FROM account_group_codes WHERE group_code LIKE ?", [`${P}%`]);
    await pool.query("DELETE FROM currency_rates WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM currencies WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM user_permissions WHERE user_id IN (?)", [ids.users]);
    await pool.query("DELETE FROM user_branches WHERE user_id IN (?)", [ids.users]);
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [ids.users]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [ids.users]);
    await pool.query("DELETE FROM branches WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM companies WHERE id IN (?)", [cos]);
  } finally {
    await pool.end();
  }
});

describe("Chart of Accounts / General Libraries: shared + active branch's own", () => {
  const coa = (who, active, qs = "") => call("get", who, `/api/coa${qs}`, { active });
  test("OUTSOURCE active -> shared + OUTSOURCE-owned only; AUDIT active -> shared + AUDIT-owned only", async () => {
    expect(codes(await coa("acctAll", br.OUTSOURCE))).toEqual([acc.AP.code, acc.EXP.code, acc["OUT-ONLY"].code].sort());
    expect(codes(await coa("acctAll", br.AUDIT))).toEqual([acc.AP.code, acc["AUD-ONLY"].code, acc.EXP.code].sort());
  });
  test("All Assigned Branches (ALL or no header) -> shared + every assigned branch's own, never another company's", async () => {
    const expected = [acc.AP.code, acc.EXP.code, acc["OUT-ONLY"].code, acc["TAX-ONLY"].code].sort();
    expect(codes(await coa("acctOT", "ALL"))).toEqual(expected);
    expect(codes(await coa("acctOT", undefined))).toEqual(expected);
    expect(codes(await coa("acctOT", "ALL"))).not.toContain(acc["B-ONLY"].code);
  });
  test("an unassigned active branch never widens: AUDIT-only accountant with OUTSOURCE active sees shared only", async () => {
    expect(codes(await coa("acctAud", br.OUTSOURCE))).toEqual([acc.AP.code, acc.EXP.code].sort());
  });
  test("another company's branch id (overlapping code) gives nothing of that company", async () => {
    expect(codes(await coa("acctAud", br["B.AUDIT"]))).toEqual([acc.AP.code, acc.EXP.code].sort());
  });
  test("an explicit ?branchId wins over the active branch; a malformed header is refused (400)", async () => {
    expect(codes(await coa("acctAll", br.AUDIT, `?branchId=${br.TAX}`))).toEqual([acc.AP.code, acc.EXP.code, acc["TAX-ONLY"].code].sort());
    const bad = await coa("acctAll", "abc");
    expect([bad.status, bad.body.code]).toEqual([400, "ACTIVE_BRANCH_INVALID"]);
  });
  test("General Libraries: suppliers / customers follow the same ownership rule", async () => {
    const gl = async (who, active) => codes(await call("get", who, `/api/genlib?companyId=${co.A}`, { active }));
    expect(await gl("acctAll", br.OUTSOURCE)).toEqual([party.CUS.code, party["CUS-OUT"].code, party.SUP.code, party["SUP-OUT"].code].sort());
    expect(await gl("acctAll", br.AUDIT)).toEqual([party.CUS.code, party.SUP.code, party["SUP-AUD"].code].sort());
    expect(await gl("acctAud", br.OUTSOURCE)).toEqual([party.CUS.code, party.SUP.code].sort());
  });
  test("changing the active branch never changes a record's owning branch", async () => {
    const [[row]] = await pool.query("SELECT branch_id FROM chart_of_accounts WHERE id = ?", [acc["AUD-ONLY"].id]);
    expect(row.branch_id).toBe(br.AUDIT);
  });
});

describe("transactions: lists follow the active branch; access never widens", () => {
  const apvs = (who, active) => call("get", who, `/api/apv?companyId=${co.A}`, { active });
  test("AUDIT active -> AUDIT APV only; OUTSOURCE active -> OUTSOURCE APV only; ALL -> both", async () => {
    expect(codes(await apvs("acctAll", br.AUDIT))).toEqual([v.aud.voucherNo, v.audDraft.voucherNo].sort());
    expect(codes(await apvs("acctAll", br.OUTSOURCE))).toEqual([v.out.voucherNo]);
    expect(codes(await apvs("acctAll", "ALL"))).toEqual([v.aud.voucherNo, v.audDraft.voucherNo, v.out.voucherNo, v.taxDraft.voucherNo].sort());
  });
  test("an AUDIT-only accountant asking for OUTSOURCE gets nothing (never the other branch's data)", async () => {
    expect(codes(await apvs("acctAud", br.OUTSOURCE))).toEqual([]);
    // their own branch: the posted AUDIT APV and the AUDIT draft another accountant prepared
    expect(codes(await apvs("acctAud", undefined))).toEqual([v.aud.voucherNo, v.audDraft.voucherNo].sort());
  });
  test("a record of an authorized branch stays readable by id whatever branch is active; an unauthorized one stays 404", async () => {
    expect((await call("get", "acctAll", `/api/apv/${v.out.id}?companyId=${co.A}`, { active: br.AUDIT })).status).toBe(200);
    expect((await call("get", "acctAud", `/api/apv/${v.out.id}?companyId=${co.A}`, { active: br.OUTSOURCE })).status).toBe(404);
  });
  test("an explicit ?branchId lookup (open items of the document's own branch) is not emptied by the active branch", async () => {
    const r = await call("get", "acctAll", `/api/apv/unpaid?companyId=${co.A}&supplierId=${party.SUP.id}&branchId=${br.OUTSOURCE}`, { active: br.AUDIT });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).toContain(v.out.voucherNo);
  });
  test("writes never take their branch from the header: no branchId -> BRANCH_REQUIRED; an explicit branchId is used", async () => {
    const n = `${P}APV-W-${++seq}`;
    const base = { voucherNo: n, transactionDate: D, dueDate: D, referenceNo: n, description: n, status: "Draft", supplierId: party.SUP.id, supplierName: party.SUP.code,
      lines: [L("EXP", 5, 0), L("AP", 0, 5)], totalDebit: 5, totalCredit: 5, currency: { companyId: co.A } };
    const missing = await call("post", "acctAll", "/api/apv", { active: br.AUDIT, body: base });
    expect([missing.status, missing.body.code]).toEqual([400, "BRANCH_REQUIRED"]);
    const ok = await call("post", "acctAll", "/api/apv", { active: br.AUDIT, body: { ...base, branchId: br.TAX } });
    expect([200, 201]).toContain(ok.status);
    const [[row]] = await pool.query("SELECT branch_id FROM apv_headers WHERE id = ?", [ok.body.id]);
    expect(row.branch_id).toBe(br.TAX);
    const tamper = await call("post", "acctAud", "/api/apv", { active: br.AUDIT, body: { ...base, voucherNo: `${n}-X`, referenceNo: `${n}-X`, branchId: br.OUTSOURCE } });
    expect(tamper.status).toBe(403);
  });
});

describe("Posting and Maker-Checker", () => {
  const pending = async (who, active) => (await call("get", who, `/api/posting/pending?companyId=${co.A}`, { active })).body.map((r) => r.voucherNo).filter((n) => String(n).startsWith(P)).sort();
  test("pending drafts follow the active branch (TAX -> TAX drafts only; AUDIT -> AUDIT drafts only)", async () => {
    const tax = await pending("adminA", br.TAX);
    expect(tax).toContain(v.taxDraft.voucherNo);
    expect(tax).not.toContain(v.audDraft.voucherNo);
    expect(tax.every((n) => !n.includes("-AUDIT-") && !n.includes("-OUTSOURCE-"))).toBe(true);
    expect(await pending("adminA", br.AUDIT)).toContain(v.audDraft.voucherNo);
    expect(await pending("adminA", br.AUDIT)).not.toContain(v.taxDraft.voucherNo);
    expect(await pending("adminA", "ALL")).toEqual(expect.arrayContaining([v.taxDraft.voucherNo, v.audDraft.voucherNo]));
  });
  test("an accountant without POSTING still cannot see or post anything, whatever branch is active", async () => {
    expect((await call("get", "acctOT", `/api/posting/pending?companyId=${co.A}`, { active: br.TAX })).status).toBe(403);
    expect((await call("post", "acctOT", "/api/posting/post", { active: br.TAX, body: { companyId: co.A, scope: "ap" } })).status).toBe(403);
    expect((await post("acctAll", v.audDraft)).status).toBe(403);
  });
  test("bulk posting with TAX active posts only TAX drafts; the AUDIT draft stays a Draft", async () => {
    const r = await call("post", "adminA", "/api/posting/post", { active: br.TAX, body: { companyId: co.A, scope: "ap" } });
    expect(r.status).toBe(200);
    const [rows] = await pool.query("SELECT id, status, posted_by FROM apv_headers WHERE id IN (?)", [[v.taxDraft.id, v.audDraft.id]]);
    const byId = Object.fromEntries(rows.map((x) => [x.id, x]));
    expect(byId[v.taxDraft.id].status).toBe("Posted");
    expect(byId[v.taxDraft.id].posted_by).toBe(usr.adminA.id);
    expect(byId[v.audDraft.id].status).toBe("Draft");
  });
  test("the creator still cannot post their own draft (separation of duties unchanged)", async () => {
    const own = await apvDraft("adminA", "AUDIT", 40);
    const r = await post("adminA", own);
    expect([r.status, r.body.code]).toEqual([403, "SELF_POSTING_NOT_ALLOWED"]);
  });
});

describe("reports: the active branch is the report branch when none is given", () => {
  const is = (who, active, extra = "") => call("get", who, `/api/reports/income-statement?companyId=${co.A}&${RANGE}${extra}`, { active });
  // TAX now holds the two TAX drafts bulk-posted above (700 + 5).
  test("AUDIT 15,000 / OUTSOURCE 10,000 / TAX 705; no branch or ALL (ADMIN) = the sum, nothing double-counted", async () => {
    const aud = expOf((await is("adminA", br.AUDIT)).body);
    const out = expOf((await is("adminA", br.OUTSOURCE)).body);
    const tax = expOf((await is("adminA", br.TAX)).body);
    expect([aud, out, tax]).toEqual([-15000, -10000, -705]);
    expect(expOf((await is("adminA", undefined)).body)).toBe(aud + out + tax);
    expect(expOf((await is("adminA", "ALL")).body)).toBe(aud + out + tax);
  });
  test("an explicit ?branch wins over the active branch", async () => {
    expect(expOf((await is("adminA", br.AUDIT, "&branch=ALL")).body)).toBe(-25705);
  });
  test("an accountant cannot reach another branch's report through the header (403)", async () => {
    const r = await is("acctAud", br.OUTSOURCE);
    expect([r.status, r.body.code]).toEqual([403, "BRANCH_ACCESS_DENIED"]);
    expect(expOf((await is("acctAud", br.AUDIT)).body)).toBe(-15000);
  });
  test("another company's branch (overlapping code) does not apply to company A's report", async () => {
    expect(expOf((await is("adminA", br["B.AUDIT"])).body)).toBe(-25705);
    expect((await call("get", "adminB", `/api/reports/income-statement?companyId=${co.A}&${RANGE}`, { active: br.AUDIT })).status).toBe(403);
  });
});

describe("report consolidation needs REPORTS.ALL_BRANCHES; an aggregate selection never bypasses it", () => {
  const is = (who, active, extra = "") => call("get", who, `/api/reports/income-statement?companyId=${co.A}&${RANGE}${extra}`, { active });
  const MSG = "Select a specific branch to generate this report. Consolidated reporting is not available for your account.";
  const refused = (r) => [r.status, r.body.code, r.body.message];

  test("without the permission: ONE assigned branch -> that branch; several or all -> 400 REPORT_BRANCH_REQUIRED (nothing substituted)", async () => {
    expect(expOf((await is("acctAud", undefined)).body)).toBe(-15000);
    for (const who of ["acctOT", "acctAll", "adminNoCon"]) {
      expect(refused(await is(who, undefined))).toEqual([400, "REPORT_BRANCH_REQUIRED", MSG]);
      expect(refused(await is(who, "ALL"))).toEqual([400, "REPORT_BRANCH_REQUIRED", MSG]); // aggregate header = no branch
    }
  });
  test("without the permission: an explicit ?branch=ALL is still 403", async () => {
    for (const who of ["acctOT", "acctAll", "adminNoCon"]) {
      const r = await is(who, undefined, "&branch=ALL");
      expect([r.status, r.body.code]).toEqual([403, "CONSOLIDATED_NOT_ALLOWED"]);
    }
  });
  test("without the permission: a specific authorized branch always works (header or ?branch)", async () => {
    expect(expOf((await is("acctOT", br.OUTSOURCE)).body)).toBe(-10000);
    expect(expOf((await is("acctOT", undefined, `&branch=${br.TAX}`)).body)).toBe(-705);
    expect(expOf((await is("acctAll", br.AUDIT)).body)).toBe(-15000);
    expect(expOf((await is("adminNoCon", br.TAX)).body)).toBe(-705);
  });
  test("with the permission: consolidated across the user's AUTHORIZED branches only", async () => {
    expect(expOf((await is("acctOTc", undefined)).body)).toBe(-10705); // OUTSOURCE + TAX, never AUDIT
    expect(expOf((await is("acctOTc", undefined, "&branch=ALL")).body)).toBe(-10705);
    expect(expOf((await is("acctAllc", undefined, "&branch=ALL")).body)).toBe(-25705);
    expect(expOf((await is("adminA", undefined, "&branch=ALL")).body)).toBe(-25705);
    expect(expOf((await is("super", undefined, "&branch=ALL")).body)).toBe(-25705);
    expect(expOf((await is("super", undefined)).body)).toBe(-25705);
  });
  test("the Dashboard summary follows the same rule", async () => {
    const dash = (who, active) => call("get", who, `/api/dashboard/summary?companyId=${co.A}&from=2096-05-01&to=2096-05-31`, { active });
    expect(refused(await dash("acctOT", undefined))).toEqual([400, "REPORT_BRANCH_REQUIRED", MSG]);
    expect((await dash("acctOT", br.OUTSOURCE)).status).toBe(200);
    expect((await dash("acctOTc", undefined)).status).toBe(200);
    expect((await dash("acctAud", undefined)).status).toBe(200);
  });
  test("no permission is granted by the selection: the branch list reports canConsolidate unchanged", async () => {
    const flag = async (who) => (await call("get", who, `/api/branch-scope/branches?companyId=${co.A}`)).body.canConsolidate;
    expect([await flag("acctOT"), await flag("acctAll"), await flag("acctOTc"), await flag("adminNoCon"), await flag("adminA")]).toEqual([false, false, true, false, true]);
  });
  test("the Trial Balance checker workflow keeps its existing scope (not refused for a missing branch)", async () => {
    const r = await call("get", "acctOT", `/api/reports/trial-balance-checker/status?companyId=${co.A}`);
    expect(r.body?.code).not.toBe("REPORT_BRANCH_REQUIRED");
  });
});

describe("zero-branch and one-branch companies", () => {
  test("a company with no branches: lists work, a stray header does not break them", async () => {
    const r = await call("get", "super", `/api/apv?companyId=${co.C}`, { active: br.AUDIT });
    expect(r.status).toBe(200);
  });
  test("a one-branch company: its branch active still shows company-level (no-branch) history", async () => {
    const [h] = await pool.query("INSERT INTO apv_headers (company_id, branch_id, voucher_no, supplier_id, supplier_name, transaction_date, total_debit, total_credit, status) VALUES (?, NULL, ?, NULL, 'x', ?, 1, 1, 'Draft')", [co.S, `${P}APV-S-LEGACY`, D]);
    const r = await call("get", "adminS", `/api/apv?companyId=${co.S}`, { active: br["S.ONLY"] });
    expect(codes(r)).toContain(`${P}APV-S-LEGACY`);
    await pool.query("DELETE FROM apv_headers WHERE id = ?", [h.insertId]);
  });
});

describe("branch list for the selector", () => {
  test("GET /api/branch-scope/branches returns the user's branches and the company total", async () => {
    const ot = await call("get", "acctOT", `/api/branch-scope/branches?companyId=${co.A}`);
    expect(ot.body.branches.map((b) => b.id).sort()).toEqual([br.OUTSOURCE, br.TAX].sort());
    expect([ot.body.totalBranches, ot.body.canConsolidate]).toEqual([3, false]);
    const admin = await call("get", "adminA", `/api/branch-scope/branches?companyId=${co.A}`);
    expect([admin.body.branches.length, admin.body.totalBranches]).toEqual([3, 3]);
  });
});
