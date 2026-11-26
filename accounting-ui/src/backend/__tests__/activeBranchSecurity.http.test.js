// System-wide Active Branch - release security verification (ALAS Release 1).
// The X-Active-Branch header is a request CONTEXT only. These tests attack it:
// unassigned branches, another company's branches, header / URL conflicts,
// record-level reads / writes / deletes outside the user's authority,
// Maker-Checker, and consolidated reporting without REPORTS.ALL_BRANCHES.
// Local test database only. Prefix UAT-ABS-.
process.env.POSTING_SOD_TEST_BYPASS = "0";
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { signSessionToken } = require("../lib/sessionPolicy");
const CurrencyService = require("../services/currencyService");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(300000);

const P = "UAT-ABS-";
const D = "2097-03-10";
const co = {};
const br = {};
const tok = {};
const usr = {};
const acc = {};
const party = {};
const ids = { users: [] };
let seq = 0;

async function roleId(code) {
  return (await pool.query("SELECT id FROM roles WHERE code = ?", [code]))[0][0].id;
}
async function permissionId(m, a) {
  return (await pool.query("SELECT id FROM permissions WHERE module_key = ? AND action = ?", [m, a]))[0][0].id;
}
async function mkUser(tag, roleCode, companies, branches = [], grants = []) {
  const [u] = await pool.query("INSERT INTO users (username, full_name, password, role_id, status) VALUES (?, ?, 'x', ?, 'ACTIVE')", [`${P}${tag}`, `${P}${tag}`, await roleId(roleCode)]);
  for (const c of companies) await pool.query("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  for (const b of branches) await pool.query("INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)", [u.insertId, b]);
  for (const [m, a, granted] of grants) await pool.query("INSERT INTO user_permissions (user_id, permission_id, granted, reason) VALUES (?, ?, ?, 'UAT-ABS')", [u.insertId, await permissionId(m, a), granted]);
  ids.users.push(u.insertId);
  usr[tag] = { id: u.insertId, username: `${P}${tag}`, role: roleCode, roleCode, token_version: 0 };
  tok[tag] = signSessionToken(usr[tag]);
}
const call = (method, who, url, { active, body } = {}) => {
  const r = request(app)[method](url).set({ Authorization: `Bearer ${tok[who]}` });
  if (active !== undefined) r.set("X-Active-Branch", String(active));
  return body === undefined ? r : r.send(body);
};
const listCodes = (res) => (Array.isArray(res.body) ? res.body : []).map((r) => r.code || r.voucherNo).filter((c) => String(c || "").startsWith(P)).sort();
const exists = async (table, id) => (await pool.query(`SELECT COUNT(*) n FROM ${table} WHERE id = ?`, [id]))[0][0].n === 1;
const L = (key, d, c) => ({ accountId: acc[key].id, accountCode: acc[key].code, accountTitle: acc[key].code, particulars: "x", debit: d, credit: c });
async function apvDraft(maker, branchKey, amount) {
  const n = `${P}APV-${branchKey}-${++seq}`;
  const body = { voucherNo: n, transactionDate: D, dueDate: D, referenceNo: n, description: n, status: "Draft",
    supplierId: party.SUP.id, supplierName: party.SUP.code, lines: [L("EXP", amount, 0), L("AP", 0, amount)], totalDebit: amount, totalCredit: amount,
    currency: { companyId: co.A }, branchId: br[branchKey] };
  const r = await call("post", maker, "/api/apv", { body });
  if (r.status !== 200 && r.status !== 201) throw new Error(`draft ${maker} ${branchKey}: ${r.status} ${JSON.stringify(r.body)}`);
  return { id: r.body.id, body, voucherNo: n };
}
const expOf = (rows) => (Array.isArray(rows) ? rows : []).filter((r) => (r.account_code || r.accountCode) === acc.EXP.code).reduce((s, r) => s + Number(r.amount ?? 0), 0);
const v = {};

beforeAll(async () => {
  assertNotProductionDatabase();
  const mkCo = async (tag, branches) => {
    const [c] = await pool.query("INSERT INTO companies (name, status) VALUES (?, 'Active')", [`${P}${tag}`]);
    co[tag] = c.insertId;
    for (const b of branches) br[`${tag === "A" ? "" : `${tag}.`}${b}`] = (await pool.query("INSERT INTO branches (company_id, name, code, status) VALUES (?, ?, ?, 'ACTIVE')", [c.insertId, `${tag} ${b}`, `${P}${b}`]))[0].insertId;
    await CurrencyService.createCurrency({ id: 0, roleCode: "SUPER_ADMIN" }, { currencyCode: "PHP", currencyName: "Peso", currencySymbol: "P", decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: c.insertId });
  };
  await mkCo("A", ["AUDIT", "OUTSOURCE", "TAX"]);
  await mkCo("B", ["AUDIT"]); // overlapping branch code in another company
  const del = [["FILESETUP.COA", "DELETE", 1], ["FILESETUP.GENLIB", "DELETE", 1], ["FILESETUP.GENLIB", "EDIT", 1], ["FILESETUP.COA", "EDIT", 1]];
  const noPost = [["POSTING", "POST", 0], ["POSTING", "VIEW", 0], ["POSTING", "APPROVE", 0]];
  await mkUser("acctAud", "ACCOUNTANT", [co.A], [br.AUDIT], [...del, ...noPost]); // may delete, AUDIT only
  await mkUser("acctOT", "ACCOUNTANT", [co.A], [br.OUTSOURCE, br.TAX], noPost);
  await mkUser("acctAll", "ACCOUNTANT", [co.A], [br.AUDIT, br.OUTSOURCE, br.TAX], noPost);
  await mkUser("adminA", "ADMIN", [co.A]);
  await mkUser("adminA2", "ADMIN", [co.A]);
  await mkUser("adminB", "ADMIN", [co.B]);
  await pool.query("INSERT INTO account_group_codes (group_code, group_description, account_class, status) VALUES (?, 'EXP', 'EXPENSE', 'ACTIVE'), (?, 'LIA', 'LIABILITY', 'ACTIVE')", [`${P}EXPG`, `${P}LIAG`]);
  const mkAcc = async (key, cls, group, branchId = null) => {
    const [r] = await pool.query("INSERT INTO chart_of_accounts (code, account_date, title, account_class, branch_id) VALUES (?, '2097-01-01', ?, ?, ?)", [`${P}${key}`, `${P}${key}`, cls, branchId]);
    if (group) await pool.query("INSERT INTO coa_groups (coa_id, group_code, group_description) VALUES (?, ?, ?)", [r.insertId, `${P}${group}`, group]);
    acc[key] = { id: r.insertId, code: `${P}${key}` };
  };
  await mkAcc("EXP", "EXPENSE", "EXPG");
  await mkAcc("AP", "LIABILITY", "LIAG");
  for (const [k, b] of [["AUD-1", br.AUDIT], ["AUD-2", br.AUDIT], ["OUT-1", br.OUTSOURCE], ["TAX-1", br.TAX], ["B-1", br["B.AUDIT"]]]) await mkAcc(k, "ASSET", null, b);
  const mkParty = async (key, type, branchId, companyKey = "A") => {
    const [r] = await pool.query("INSERT INTO general_libraries (company_id, code, party_type, name, status, branch_id) VALUES (?, ?, ?, ?, 'ACTIVE', ?)", [co[companyKey], `${P}${key}`, type, `${P}${key}`, branchId]);
    party[key] = { id: r.insertId, code: `${P}${key}` };
  };
  await mkParty("SUP", "SUPPLIER", null); // company A shared
  await mkParty("SUP-AUD", "SUPPLIER", br.AUDIT);
  await mkParty("SUP-OUT", "SUPPLIER", br.OUTSOURCE);
  await mkParty("B-SHARED", "SUPPLIER", null, "B");
  await mkParty("B-AUD", "SUPPLIER", br["B.AUDIT"], "B");
  v.aud = await apvDraft("acctAud", "AUDIT", 15000);
  v.out = await apvDraft("acctOT", "OUTSOURCE", 10000);
  for (const d of [v.aud, v.out]) {
    const r = await call("put", "adminA", `/api/apv/${d.id}`, { body: { ...d.body, status: "Posted" } });
    if (r.status !== 200) throw new Error(`post: ${r.status} ${JSON.stringify(r.body)}`);
  }
  v.adminDraft = await apvDraft("adminA", "AUDIT", 300);
  v.taxDraft = await apvDraft("acctOT", "TAX", 700);
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

describe("S1 the header never grants additional branch access", () => {
  test("AUDIT-only accountant with OUTSOURCE active: no OUTSOURCE account, supplier or voucher anywhere", async () => {
    const coa = listCodes(await call("get", "acctAud", "/api/coa", { active: br.OUTSOURCE }));
    expect(coa).toEqual([acc.AP.code, acc.EXP.code].sort()); // shared only
    const gl = listCodes(await call("get", "acctAud", `/api/genlib?companyId=${co.A}`, { active: br.OUTSOURCE }));
    expect(gl).toEqual([party.SUP.code]);
    expect(listCodes(await call("get", "acctAud", `/api/apv?companyId=${co.A}`, { active: br.OUTSOURCE }))).toEqual([]);
    expect((await call("get", "acctAud", `/api/apv/${v.out.id}?companyId=${co.A}`, { active: br.OUTSOURCE })).status).toBe(404);
  });
  test("ALL / no header for a restricted user = their own branches only (never the company)", async () => {
    for (const active of [undefined, "ALL"]) {
      const coa = listCodes(await call("get", "acctOT", "/api/coa", { active }));
      expect(coa).toEqual([acc.AP.code, acc.EXP.code, acc["OUT-1"].code, acc["TAX-1"].code].sort());
    }
  });
});

describe("S2 another company's records are unreachable through X-Active-Branch", () => {
  test("company B's ADMIN with a company A branch active sees only company B", async () => {
    const gl = listCodes(await call("get", "adminB", `/api/genlib?companyId=${co.B}`, { active: br.AUDIT }));
    expect(gl).toEqual([party["B-AUD"].code, party["B-SHARED"].code].sort());
    expect(listCodes(await call("get", "adminB", "/api/coa", { active: br.AUDIT }))).not.toContain(acc["AUD-1"].code);
    for (const url of [`/api/genlib?companyId=${co.A}`, `/api/apv?companyId=${co.A}`, `/api/reports/income-statement?companyId=${co.A}&from=2097-03-01&to=2097-03-31`]) {
      const r = await call("get", "adminB", url, { active: br.AUDIT });
      // refused, never data. (/api/apv answers this company refusal as 500 -
      // pre-existing since 93d2fc6 with or without the header; no data either way)
      expect(r.status === 403 || r.status === 500).toBe(true);
      expect(Array.isArray(r.body)).toBe(false);
      expect(JSON.stringify(r.body)).not.toContain(P);
    }
  });
  test("company A's ADMIN with company B's overlapping AUDIT active gets company A's data, never B's", async () => {
    const coa = listCodes(await call("get", "adminA", "/api/coa", { active: br["B.AUDIT"] }));
    expect(coa).not.toContain(acc["B-1"].code);
    const gl = listCodes(await call("get", "adminA", `/api/genlib?companyId=${co.A}`, { active: br["B.AUDIT"] }));
    expect(gl).not.toContain(party["B-AUD"].code);
    expect(gl).not.toContain(party["B-SHARED"].code);
  });
});

describe("S3 explicit URL branch parameters are validated against assignments", () => {
  test("?branchId / ?branch / body branchId of an unassigned branch are refused", async () => {
    const coa = await call("get", "acctAud", `/api/coa?branchId=${br.OUTSOURCE}`);
    expect([403, 404]).toContain(coa.status);
    expect(listCodes(coa)).toEqual([]);
    const rpt = await call("get", "acctAud", `/api/reports/income-statement?companyId=${co.A}&from=2097-03-01&to=2097-03-31&branch=${br.OUTSOURCE}`);
    expect([rpt.status, rpt.body.code]).toEqual([403, "BRANCH_ACCESS_DENIED"]);
    const other = await call("get", "adminA", `/api/reports/income-statement?companyId=${co.A}&from=2097-03-01&to=2097-03-31&branch=${br["B.AUDIT"]}`);
    expect([403, 404]).toContain(other.status);
    const write = await call("post", "acctAud", "/api/apv", { body: { ...v.aud.body, voucherNo: `${P}APV-X`, referenceNo: `${P}APV-X`, branchId: br.OUTSOURCE } });
    expect(write.status).toBe(403);
  });
});

describe("S4 a header / URL conflict never exposes unauthorized data", () => {
  test("authorized header + unauthorized ?branchId -> refused (no data)", async () => {
    const r = await call("get", "acctAud", `/api/coa?branchId=${br.OUTSOURCE}`, { active: br.AUDIT });
    expect([403, 404]).toContain(r.status);
    expect(listCodes(r)).toEqual([]);
    const rpt = await call("get", "acctAud", `/api/reports/income-statement?companyId=${co.A}&from=2097-03-01&to=2097-03-31&branch=${br.OUTSOURCE}`, { active: br.AUDIT });
    expect(rpt.status).toBe(403);
  });
  test("unauthorized header + authorized ?branchId -> exactly the authorized branch", async () => {
    const coa = listCodes(await call("get", "acctAud", `/api/coa?branchId=${br.AUDIT}`, { active: br.OUTSOURCE }));
    expect(coa).not.toContain(acc["OUT-1"].code);
    expect(coa).toEqual(expect.arrayContaining([acc["AUD-1"].code]));
    const rpt = await call("get", "acctAud", `/api/reports/income-statement?companyId=${co.A}&from=2097-03-01&to=2097-03-31&branch=${br.AUDIT}`, { active: br.OUTSOURCE });
    expect(expOf(rpt.body)).toBe(-15000);
  });
  test("both authorized but different -> the explicit URL wins (one scope, never a union)", async () => {
    const rpt = await call("get", "acctOT", `/api/reports/income-statement?companyId=${co.A}&from=2097-03-01&to=2097-03-31&branch=${br.OUTSOURCE}`, { active: br.TAX });
    expect(expOf(rpt.body)).toBe(-10000);
  });
  test("a malformed or injected header is refused, not interpreted", async () => {
    for (const bad of ["1 OR 1=1", "-1", "abc", "1,2"]) {
      expect((await call("get", "acctAud", "/api/coa", { active: bad })).status).toBe(400);
    }
  });
});

describe("S5 shared master records stay company-scoped", () => {
  test("company A's shared supplier is invisible and undeletable from company B", async () => {
    expect(listCodes(await call("get", "adminB", `/api/genlib?companyId=${co.B}`))).not.toContain(party.SUP.code);
    const r = await call("post", "adminB", "/api/genlib/bulk-delete", { body: { ids: [party.SUP.id], companyId: co.B } });
    expect(r.status).toBe(200);
    expect(await exists("general_libraries", party.SUP.id)).toBe(true);
    const forced = await call("post", "adminB", "/api/genlib/bulk-delete", { body: { ids: [party.SUP.id], companyId: co.A } });
    expect(forced.status).toBe(403);
    expect(await exists("general_libraries", party.SUP.id)).toBe(true);
  });
});

describe("S6 branch-owned COA / General Library records only within authorized scope", () => {
  test("edit / delete of another branch's record by id -> 404, record unchanged", async () => {
    expect((await call("delete", "acctAud", `/api/coa/${acc["OUT-1"].id}`, { active: br.AUDIT })).status).toBe(404);
    expect(await exists("chart_of_accounts", acc["OUT-1"].id)).toBe(true);
    expect((await call("delete", "acctAud", `/api/genlib/${party["SUP-OUT"].id}?companyId=${co.A}`, { active: br.OUTSOURCE })).status).toBe(404);
    expect(await exists("general_libraries", party["SUP-OUT"].id)).toBe(true);
    const put = await call("put", "acctAud", `/api/genlib/${party["SUP-OUT"].id}?companyId=${co.A}`, { active: br.OUTSOURCE, body: { code: party["SUP-OUT"].code, name: "hijack", type: "SUPPLIER", status: "ACTIVE" } });
    expect([403, 404]).toContain(put.status);
    const [[row]] = await pool.query("SELECT name FROM general_libraries WHERE id = ?", [party["SUP-OUT"].id]);
    expect(row.name).toBe(party["SUP-OUT"].code);
  });
});

describe("S7 bulk delete rechecks every selected record", () => {
  test("a mixed selection deletes only the user's own unused records; the header changes nothing", async () => {
    const pick = [acc["AUD-2"].id, acc["OUT-1"].id, acc["TAX-1"].id, acc["B-1"].id, acc.EXP.id];
    const r = await call("post", "acctAud", "/api/coa/bulk-delete", { active: br.OUTSOURCE, body: { ids: pick } });
    expect(r.status).toBe(200);
    expect(await exists("chart_of_accounts", acc["AUD-2"].id)).toBe(false); // own branch, unused
    for (const k of ["OUT-1", "TAX-1", "B-1"]) expect(await exists("chart_of_accounts", acc[k].id)).toBe(true); // not visible -> skipped
    expect(await exists("chart_of_accounts", acc.EXP.id)).toBe(true); // shared but used -> blocked
    const statusOf = (id) => (r.body.results || []).find((x) => Number(x.id) === Number(id))?.status;
    expect(statusOf(acc["OUT-1"].id)).toBe("skipped");
    expect(statusOf(acc.EXP.id)).toBe("blocked");
    const g = await call("post", "acctAud", "/api/genlib/bulk-delete", { active: br.OUTSOURCE, body: { ids: [party["SUP-OUT"].id, party["B-AUD"].id], companyId: co.A } });
    expect(g.status).toBe(200);
    expect(await exists("general_libraries", party["SUP-OUT"].id)).toBe(true);
    expect(await exists("general_libraries", party["B-AUD"].id)).toBe(true);
  });
  test("without the DELETE permission the header cannot enable bulk delete", async () => {
    const r = await call("post", "acctOT", "/api/coa/bulk-delete", { active: br.OUTSOURCE, body: { ids: [acc["OUT-1"].id] } });
    expect(r.status).toBe(403);
    expect(await exists("chart_of_accounts", acc["OUT-1"].id)).toBe(true);
  });
});

describe("S9 Maker-Checker is unchanged by the active branch", () => {
  test("the maker cannot post their own draft, whatever branch is active", async () => {
    for (const active of [undefined, "ALL", br.AUDIT, br.OUTSOURCE]) {
      const r = await call("put", "adminA", `/api/apv/${v.adminDraft.id}`, { active, body: { ...v.adminDraft.body, status: "Posted" } });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("SELF_POSTING_NOT_ALLOWED");
    }
    const [[h]] = await pool.query("SELECT status FROM apv_headers WHERE id = ?", [v.adminDraft.id]);
    expect(h.status).toBe("Draft");
  });
  test("accountants without POSTING cannot reach the queue or post, whatever branch is active", async () => {
    for (const active of [undefined, br.TAX]) {
      expect((await call("get", "acctOT", `/api/posting/pending?companyId=${co.A}`, { active })).status).toBe(403);
      expect((await call("put", "acctOT", `/api/apv/${v.taxDraft.id}`, { active, body: { ...v.taxDraft.body, status: "Posted" } })).status).toBe(403);
    }
  });
  test("bulk posting with OUTSOURCE active never posts drafts of another branch", async () => {
    const r = await call("post", "adminA2", "/api/posting/post", { active: br.OUTSOURCE, body: { companyId: co.A, items: [{ module: "APV", id: v.taxDraft.id }, { module: "APV", id: v.adminDraft.id }] } });
    expect([200, 207, 400, 403, 409]).toContain(r.status);
    const [rows] = await pool.query("SELECT status FROM apv_headers WHERE id IN (?)", [[v.taxDraft.id, v.adminDraft.id]]);
    expect(rows.map((x) => x.status)).toEqual(["Draft", "Draft"]);
  });
});

describe("S10 no consolidated financial results without REPORTS.ALL_BRANCHES", () => {
  const ROUTES = ["2307", "account-analysis", "aging", "alphalist", "ap-aging", "ap-aging-summary", "ap-overdue-accounts", "ap-payables-and-payments",
    "ap-statement-of-accounts", "ar-aging", "ar-aging-summary", "ar-billings-and-collections", "ar-overdue-accounts", "ar-statement-of-accounts",
    "balance-sheet", "books/accounts-payable", "books/cash-disbursement", "books/cash-receipt", "books/debit-credit-memo", "books/income", "books/journal",
    "books/net-summary", "books/petty-cash", "books/summary-totals", "cash-flow-statement", "daily-cash-position", "ewt-audit", "fixed-asset-lapsing",
    "fixed-asset-register", "general-ledger", "income-statement", "lapsed-prepayments", "output-vat", "prepaid-list", "prepaid-subsidiary",
    "prepayment-lapsing", "subsidiary-ledger", "trial-balance"];
  test.each(ROUTES)("/api/reports/%s: aggregate -> 400, ?branch=ALL -> 403 (multi-branch and all-branch accountants)", async (route) => {
    for (const who of ["acctOT", "acctAll"]) {
      for (const active of [undefined, "ALL"]) {
        const r = await call("get", who, `/api/reports/${route}?companyId=${co.A}&from=2097-03-01&to=2097-03-31`, { active });
        expect([r.status, r.body?.code]).toEqual([400, "REPORT_BRANCH_REQUIRED"]);
      }
      const all = await call("get", who, `/api/reports/${route}?companyId=${co.A}&from=2097-03-01&to=2097-03-31&branch=ALL`);
      expect([all.status, all.body?.code]).toEqual([403, "CONSOLIDATED_NOT_ALLOWED"]);
    }
  });
  test("the Dashboard summary is refused the same way; a single branch still works", async () => {
    const q = `companyId=${co.A}&from=2097-03-01&to=2097-03-31`;
    const r = await call("get", "acctAll", `/api/dashboard/summary?${q}`);
    expect([r.status, r.body.code]).toEqual([400, "REPORT_BRANCH_REQUIRED"]);
    expect((await call("get", "acctAll", `/api/dashboard/summary?${q}`, { active: br.AUDIT })).status).toBe(200);
    expect(expOf((await call("get", "acctAll", `/api/reports/income-statement?${q}`, { active: br.OUTSOURCE })).body)).toBe(-10000);
  });
});
