// Task 1 - shared master data, branch-isolated reports (real API flows).
//
// ONE shared expense / AP / AR / revenue / cash account and ONE shared supplier
// and customer are used by two branches of the same company (AUDIT and
// OUTSOURCE). Every transaction goes through the real create -> Draft ->
// checker posting path (Maker-Checker Release 1 enforced), one Draft is never
// posted, one posted APV is voided, and one AUDIT APV is reversed across a
// closed period. Every branch-capable report must then show:
//   AUDIT-only = AUDIT, OUTSOURCE-only = OUTSOURCE, consolidated = the sum,
// with no double counting, no Draft / voided amounts, no cross-company access.
// Local test database only. Fixture prefix UAT-BSM-.
process.env.POSTING_SOD_TEST_BYPASS = "0";
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { signSessionToken } = require("../lib/sessionPolicy");
const CurrencyService = require("../services/currencyService");
const AccountingPeriodService = require("../services/accountingPeriodService");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(300000);

const P = "UAT-BSM-";
const D = "2025-06-10"; // a past month - closed later for the reversal case
const FROM = "2025-06-01";
const TO = `${new Date().getFullYear() + 1}-12-31`;
const RANGE = `from=${FROM}&to=${TO}`;
const ids = { companies: [], users: [] };
const co = {};
const br = {};
const tok = {};
const usr = {};
const acc = {};
const party = {};
const v = {}; // voucher numbers / ids
let seq = 0;

const as = (who) => ({ Authorization: `Bearer ${tok[who]}` });
const api = (method, who, url, body) => {
  const r = request(app)[method](url).set(as(who));
  return body === undefined ? r : r.send(body);
};
const report = (who, path, branch, extra = "") =>
  api("get", who, `/api/reports/${path}?companyId=${co.A}${extra}${branch === undefined ? "" : `&branch=${branch}`}`);

async function roleId(code) {
  const [[r]] = await pool.query("SELECT id FROM roles WHERE code = ?", [code]);
  return r.id;
}
async function permissionId(moduleKey, action) {
  const [[p]] = await pool.query("SELECT id FROM permissions WHERE module_key = ? AND action = ?", [moduleKey, action]);
  return p.id;
}
async function mkUser(tag, roleCode, companies, branches = [], noPosting = false) {
  const [u] = await pool.query("INSERT INTO users (username, full_name, password, role_id, status) VALUES (?, ?, 'x', ?, 'ACTIVE')", [`${P}${tag}`, `${P}${tag}`, await roleId(roleCode)]);
  for (const c of companies) await pool.query("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  for (const b of branches) await pool.query("INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)", [u.insertId, b]);
  if (noPosting) {
    // like live ALAS: Accountants have no POSTING.* (user-level override, this file only)
    for (const action of ["POST", "VIEW", "APPROVE"]) {
      await pool.query("INSERT INTO user_permissions (user_id, permission_id, granted, reason) VALUES (?, ?, 0, ?)", [u.insertId, await permissionId("POSTING", action), `${P}fixture`]);
    }
  }
  ids.users.push(u.insertId);
  usr[tag] = { id: u.insertId, username: `${P}${tag}`, role: roleCode, roleCode, token_version: 0 };
  tok[tag] = signSessionToken(usr[tag]);
}
async function mkAccount(key, cls, group) {
  const [r] = await pool.query("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, '2025-01-01', ?, ?)", [`${P}${key}`, `${P}${key}`, cls]);
  await pool.query("INSERT INTO coa_groups (coa_id, group_code, group_description) VALUES (?, ?, ?)", [r.insertId, `${P}${group}`, group]);
  acc[key] = { id: r.insertId, code: `${P}${key}` };
}
async function mkParty(key, type) {
  const [r] = await pool.query("INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, ?, ?, ?, 'ACTIVE')", [co.A, `${P}${key}`, type, `${P}${key}`]);
  party[key] = { id: r.insertId, code: `${P}${key}`, name: `${P}${key}`, type };
}
const L = (key, debit, credit) => ({ accountId: acc[key].id, accountCode: acc[key].code, accountTitle: acc[key].code, particulars: `${P}line`, debit, credit });

const MOD = {
  APV: { path: "/api/apv", party: "SUP", lines: (a) => [L("EXP", a, 0), L("AP", 0, a)] },
  INV: { path: "/api/invoices", party: "CUS", lines: (a) => [L("AR", a, 0), L("REV", 0, a)], extra: { invoiceType: "Standard" } },
  JV: { path: "/api/jv", party: null, lines: (a) => [L("CASH", a, 0), L("REV", 0, a)] },
};
function body(mod, branchKey, amount) {
  const m = MOD[mod];
  const p = party[m.party];
  const partyFields = p ? { supplierId: p.id, supplierName: p.name, customerId: p.id, customerName: p.name } : {};
  const n = `${P}${mod}-${branchKey}-${++seq}`;
  return { voucherNo: n, transactionDate: D, dueDate: D, referenceNo: n, description: `${P}${mod}`, status: "Draft",
    ...partyFields, lines: m.lines(amount), totalDebit: amount, totalCredit: amount, currency: { companyId: co.A }, branchId: br[branchKey], ...(m.extra || {}) };
}
async function draft(maker, mod, branchKey, amount) {
  const b = body(mod, branchKey, amount);
  const r = await api("post", maker, MOD[mod].path, b);
  if (r.status !== 200 && r.status !== 201) throw new Error(`${mod} draft by ${maker}: ${r.status} ${JSON.stringify(r.body)}`);
  return { id: r.body.id, body: b, voucherNo: b.voucherNo };
}
async function postedBy(checker, mod, d) {
  const r = await api("put", checker, `${MOD[mod].path}/${d.id}`, { ...d.body, status: "Posted" });
  if (r.status !== 200) throw new Error(`post ${mod} ${d.voucherNo} by ${checker}: ${r.status} ${JSON.stringify(r.body)}`);
  return d;
}

// Report readers (field names differ slightly between reports).
const codeOf = (r) => r.account_code ?? r.accountCode ?? r.code;
const amountOf = (rows, key) => (Array.isArray(rows) ? rows : []).filter((r) => codeOf(r) === acc[key].code).reduce((s, r) => s + Number(r.amount ?? 0), 0);
function tbNet(rows, key) {
  const row = (Array.isArray(rows) ? rows : []).find((r) => codeOf(r) === acc[key].code);
  if (!row) return 0;
  const debit = Number(row.debit ?? row.total_debit ?? row.debit_total ?? 0);
  const credit = Number(row.credit ?? row.total_credit ?? row.credit_total ?? 0);
  return Math.round((debit - credit) * 100) / 100;
}
const text = (res) => JSON.stringify(res.body);
const occurrences = (hay, needle) => hay.split(needle).length - 1;

beforeAll(async () => {
  assertNotProductionDatabase();
  for (const [tag, branches] of [["A", ["AUDIT", "OUTSOURCE"]], ["B", ["B1"]]]) {
    const [c] = await pool.query("INSERT INTO companies (name, status) VALUES (?, 'Active')", [`${P}${tag}`]);
    co[tag] = c.insertId;
    ids.companies.push(c.insertId);
    for (const b of branches) {
      const [r] = await pool.query("INSERT INTO branches (company_id, name, code, status) VALUES (?, ?, ?, 'ACTIVE')", [c.insertId, `${P}${b}`, `${P}${b}`]);
      br[b] = r.insertId;
    }
    await CurrencyService.createCurrency({ id: 0, roleCode: "SUPER_ADMIN" }, {
      currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "P", decimalPlaces: 2,
      symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: c.insertId,
    });
  }
  await mkUser("makerAudit", "ACCOUNTANT", [co.A], [br.AUDIT], true);
  await mkUser("makerOut", "ACCOUNTANT", [co.A], [br.OUTSOURCE], true);
  await mkUser("checker", "ADMIN", [co.A]);
  await mkUser("checker2", "ADMIN", [co.A]);
  await mkUser("adminB", "ADMIN", [co.B]);
  await pool.query(
    "INSERT INTO account_group_codes (group_code, group_description, account_class, status) VALUES (?, 'AST', 'ASSET', 'ACTIVE'), (?, 'LIA', 'LIABILITY', 'ACTIVE'), (?, 'REV', 'INCOME', 'ACTIVE'), (?, 'EXP', 'EXPENSE', 'ACTIVE')",
    [`${P}AST`, `${P}LIA`, `${P}REV`, `${P}EXP`]
  );
  // shared accounts (branch_id NULL) - used by BOTH branches
  await mkAccount("CASH", "ASSET", "AST");
  await mkAccount("AR", "ASSET", "AST");
  await mkAccount("AP", "LIABILITY", "LIA");
  await mkAccount("REV", "INCOME", "REV");
  await mkAccount("EXP", "EXPENSE", "EXP");
  await pool.query("INSERT INTO bank_codes (bank_code, bank_name, coa_account_id, coa_code, status) VALUES (?, ?, ?, ?, 'ACTIVE')", [`${P}BANK`, `${P}BANK`, acc.CASH.id, acc.CASH.code]);
  // shared parties (company A, branch_id NULL) - used by BOTH branches
  await mkParty("SUP", "SUPPLIER");
  await mkParty("CUS", "CUSTOMER");

  // AUDIT: APV 15,000; invoice 7,000; cash JV 1,500. OUTSOURCE: 10,000 / 3,000 / 500.
  v.apvAudit = await postedBy("checker", "APV", await draft("makerAudit", "APV", "AUDIT", 15000));
  v.apvOut = await postedBy("checker", "APV", await draft("makerOut", "APV", "OUTSOURCE", 10000));
  v.invAudit = await postedBy("checker", "INV", await draft("makerAudit", "INV", "AUDIT", 7000));
  v.invOut = await postedBy("checker", "INV", await draft("makerOut", "INV", "OUTSOURCE", 3000));
  v.jvAudit = await postedBy("checker", "JV", await draft("makerAudit", "JV", "AUDIT", 1500));
  v.jvOut = await postedBy("checker", "JV", await draft("makerOut", "JV", "OUTSOURCE", 500));
  // never posted
  v.draftAudit = await draft("makerAudit", "APV", "AUDIT", 999);
  // posted, then voided by a second checker (not the maker)
  v.voidOut = await postedBy("checker", "APV", await draft("makerOut", "APV", "OUTSOURCE", 444));
  const voided = await api("post", "checker2", `/api/apv/${v.voidOut.id}/void`, { reason: `${P}duplicate`, companyId: co.A });
  if (voided.status !== 200) throw new Error(`void: ${voided.status} ${JSON.stringify(voided.body)}`);
});

afterAll(async () => {
  try {
    const cos = ids.companies.concat(0);
    const users = ids.users.concat(0);
    for (const [lines, fk, head] of [["jv_lines", "jv_id", "jv_headers"], ["invoice_lines", "invoice_id", "invoice_headers"], ["apv_lines", "apv_id", "apv_headers"]]) {
      await pool.query(`DELETE l FROM ${lines} l JOIN ${head} h ON h.id = l.${fk} WHERE h.company_id IN (?)`, [cos]);
      await pool.query(`DELETE FROM ${head} WHERE company_id IN (?)`, [cos]);
    }
    await pool.query("DELETE FROM transaction_tax_entries WHERE company_id IN (?)", [cos]).catch(() => {});
    await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM accounting_period_history WHERE company_id IN (?)", [cos]).catch(() => {});
    await pool.query("DELETE FROM accounting_periods WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM audit_logs WHERE company_id IN (?) OR user_id IN (?)", [cos, users]);
    await pool.query("DELETE FROM general_libraries WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM bank_codes WHERE bank_code LIKE ?", [`${P}%`]);
    await pool.query("DELETE FROM coa_groups WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE ?)", [`${P}%`]);
    await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE ?", [`${P}%`]);
    await pool.query("DELETE FROM account_group_codes WHERE group_code LIKE ?", [`${P}%`]);
    await pool.query("DELETE FROM currency_rates WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM currencies WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM user_permissions WHERE user_id IN (?)", [users]);
    await pool.query("DELETE FROM user_branches WHERE user_id IN (?)", [users]);
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [users]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [users]);
    await pool.query("DELETE FROM branches WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM companies WHERE id IN (?)", [cos]);
  } finally {
    await pool.end();
  }
});

describe("the fixture really shares master data and keeps the originating branch", () => {
  test("accounts and parties are shared (branch_id NULL); each posted header and its lines carry the originating branch", async () => {
    const [coa] = await pool.query("SELECT branch_id FROM chart_of_accounts WHERE code LIKE ?", [`${P}%`]);
    expect(coa.every((r) => r.branch_id === null)).toBe(true);
    const [parties] = await pool.query("SELECT branch_id FROM general_libraries WHERE company_id = ?", [co.A]);
    expect(parties.every((r) => r.branch_id === null)).toBe(true);
    const [apvs] = await pool.query("SELECT id, branch_id, supplier_id, status, created_by, posted_by FROM apv_headers WHERE id IN (?)", [[v.apvAudit.id, v.apvOut.id]]);
    const byId = Object.fromEntries(apvs.map((r) => [r.id, r]));
    expect(byId[v.apvAudit.id].branch_id).toBe(br.AUDIT);
    expect(byId[v.apvOut.id].branch_id).toBe(br.OUTSOURCE);
    expect(byId[v.apvAudit.id].supplier_id).toBe(party.SUP.id);
    expect(byId[v.apvOut.id].supplier_id).toBe(party.SUP.id);
    // Maker-Checker: made by the accountant, posted by the checker
    expect(byId[v.apvAudit.id].created_by).toBe(usr.makerAudit.id);
    expect(byId[v.apvAudit.id].posted_by).toBe(usr.checker.id);
    expect(byId[v.apvAudit.id].status).toBe("Posted");
    const [[draftRow]] = await pool.query("SELECT status, branch_id FROM apv_headers WHERE id = ?", [v.draftAudit.id]);
    expect([draftRow.status.toUpperCase(), draftRow.branch_id]).toEqual(["DRAFT", br.AUDIT]);
    const [[voidRow]] = await pool.query("SELECT status FROM apv_headers WHERE id = ?", [v.voidOut.id]);
    expect(voidRow.status.toUpperCase()).not.toBe("POSTED");
  });
});

describe("financial statements: AUDIT-only, OUTSOURCE-only, consolidated", () => {
  // Income Statement amounts are credit - debit (expenses negative).
  test("Income Statement - expense 15,000 / 10,000 / 25,000; revenue 8,500 / 3,500 / 12,000; consolidated line not duplicated", async () => {
    const is = (b) => report("checker", "income-statement", b, `&${RANGE}`);
    const [a, o, all, none] = await Promise.all([is(br.AUDIT), is(br.OUTSOURCE), is("ALL"), is(undefined)]);
    for (const r of [a, o, all, none]) expect(r.status).toBe(200);
    expect([amountOf(a.body, "EXP"), amountOf(o.body, "EXP"), amountOf(all.body, "EXP"), amountOf(none.body, "EXP")]).toEqual([-15000, -10000, -25000, -25000]);
    expect([amountOf(a.body, "REV"), amountOf(o.body, "REV"), amountOf(all.body, "REV")]).toEqual([8500, 3500, 12000]);
    expect(all.body.filter((r) => codeOf(r) === acc.EXP.code)).toHaveLength(1);
  });
  test("Balance Sheet - AP 15,000 / 10,000 / 25,000; AR 7,000 / 3,000 / 10,000; cash 1,500 / 500 / 2,000", async () => {
    const bs = (b) => report("checker", "balance-sheet", b, `&to=${TO}`);
    const [a, o, all] = await Promise.all([bs(br.AUDIT), bs(br.OUTSOURCE), bs("ALL")]);
    expect([amountOf(a.body, "AP"), amountOf(o.body, "AP"), amountOf(all.body, "AP")]).toEqual([15000, 10000, 25000]);
    expect([amountOf(a.body, "AR"), amountOf(o.body, "AR"), amountOf(all.body, "AR")]).toEqual([7000, 3000, 10000]);
    expect([amountOf(a.body, "CASH"), amountOf(o.body, "CASH"), amountOf(all.body, "CASH")]).toEqual([1500, 500, 2000]);
  });
  test("Trial Balance - debits equal credits per branch and consolidated; expense nets 15,000 / 10,000 / 25,000", async () => {
    const tb = (b) => report("checker", "trial-balance", b, `&${RANGE}`);
    const [a, o, all] = await Promise.all([tb(br.AUDIT), tb(br.OUTSOURCE), tb("ALL")]);
    expect([tbNet(a.body, "EXP"), tbNet(o.body, "EXP"), tbNet(all.body, "EXP")]).toEqual([15000, 10000, 25000]);
    expect([tbNet(a.body, "AP"), tbNet(o.body, "AP"), tbNet(all.body, "AP")]).toEqual([-15000, -10000, -25000]);
    for (const r of [a, o, all]) {
      const mine = r.body.filter((x) => String(codeOf(x)).startsWith(P));
      const net = mine.reduce((s, x) => s + tbNet([x], Object.keys(acc).find((k) => acc[k].code === codeOf(x))), 0);
      expect(Math.round(net * 100) / 100).toBe(0);
    }
  });
});

describe("ledgers and analysis list only the selected branch, each entry once", () => {
  test("General Ledger - AUDIT vouchers only / OUTSOURCE only / both, each line exactly once", async () => {
    const gl = (b) => report("checker", "general-ledger", b, `&${RANGE}`);
    const [a, o, all] = (await Promise.all([gl(br.AUDIT), gl(br.OUTSOURCE), gl("ALL")])).map(text);
    for (const [hay, yes, no] of [[a, [v.apvAudit, v.invAudit, v.jvAudit], [v.apvOut, v.invOut, v.jvOut]], [o, [v.apvOut, v.invOut, v.jvOut], [v.apvAudit, v.invAudit, v.jvAudit]]]) {
      for (const d of yes) expect(hay).toContain(d.voucherNo);
      for (const d of no) expect(hay).not.toContain(d.voucherNo);
    }
    for (const d of [v.apvAudit, v.apvOut, v.invAudit, v.invOut, v.jvAudit, v.jvOut]) {
      const branchHay = [v.apvAudit, v.invAudit, v.jvAudit].includes(d) ? a : o;
      expect(occurrences(all, `"${d.voucherNo}"`)).toBe(occurrences(branchHay, `"${d.voucherNo}"`));
    }
    // Draft and voided vouchers never appear
    for (const hay of [a, o, all]) {
      expect(hay).not.toContain(v.draftAudit.voucherNo);
      expect(hay).not.toContain(v.voidOut.voucherNo);
    }
  });
  test("Account Analysis - shared expense account split by branch", async () => {
    const aa = (b) => report("checker", "account-analysis", b, `&${RANGE}&accountCode=${encodeURIComponent(acc.EXP.code)}`);
    const [a, o, all] = (await Promise.all([aa(br.AUDIT), aa(br.OUTSOURCE), aa("ALL")])).map(text);
    expect(a).toContain(v.apvAudit.voucherNo);
    expect(a).not.toContain(v.apvOut.voucherNo);
    expect(o).toContain(v.apvOut.voucherNo);
    expect(o).not.toContain(v.apvAudit.voucherNo);
    expect(all).toContain(v.apvAudit.voucherNo);
    expect(all).toContain(v.apvOut.voucherNo);
  });
  test("Cash Flow and Daily Cash Position - cash JVs by branch", async () => {
    const cf = (b) => report("checker", "cash-flow-statement", b, `&${RANGE}`);
    const [a, o] = (await Promise.all([cf(br.AUDIT), cf(br.OUTSOURCE)])).map(text);
    expect(a).toContain(v.jvAudit.voucherNo);
    expect(a).not.toContain(v.jvOut.voucherNo);
    expect(o).toContain(v.jvOut.voucherNo);
    expect(o).not.toContain(v.jvAudit.voucherNo);
    const dcp = (b) => report("checker", "daily-cash-position", b, `&date=${D}&from=${D}&to=${D}`);
    const [da, dO] = (await Promise.all([dcp(br.AUDIT), dcp(br.OUTSOURCE)])).map(text);
    expect(da).not.toContain(v.jvOut.voucherNo);
    expect(dO).not.toContain(v.jvAudit.voucherNo);
  });
});

describe("AP / AR reports - same supplier and customer, split by branch", () => {
  // Per-party summaries (no voucher numbers): the party's total must be the
  // branch's own amount, the sum when consolidated.
  test.each([
    ["ap-aging-summary", () => `&asOf=${TO}`, (b) => b.parties?.[0]?.baseBalance, [15000, 10000, 25000]],
    ["ap-payables-and-payments", () => `&partyId=${party.SUP.id}&${RANGE}`, (b) => b.grandTotalEndingPayable, [15000, 10000, 25000]],
    ["ar-aging-summary", () => `&asOf=${TO}`, (b) => b.parties?.[0]?.baseBalance, [7000, 3000, 10000]],
    ["ar-billings-and-collections", () => `&partyId=${party.CUS.id}&${RANGE}`, (b) => b.grandTotalEndingBalance, [7000, 3000, 10000]],
  ])("%s: AUDIT / OUTSOURCE / consolidated totals (Draft and voided excluded)", async (path, extra, pick, expected) => {
    const get = (b) => report("checker", path, b, extra());
    const [a, o, all] = await Promise.all([get(br.AUDIT), get(br.OUTSOURCE), get("ALL")]);
    for (const r of [a, o, all]) expect([path, r.status]).toEqual([path, 200]);
    expect([a, o, all].map((r) => Number(pick(r.body)))).toEqual(expected);
  });

  test.each([
    ["ap-aging", () => `&asOf=${TO}`, "apv"],
    ["ap-overdue-accounts", () => `&asOf=${TO}`, "apv"],
    ["ap-statement-of-accounts", () => `&partyId=${party.SUP.id}&${RANGE}`, "apv"],
    ["subsidiary-ledger", () => `&type=AP&partyId=${party.SUP.id}&${RANGE}`, "apv"],
    ["ar-aging", () => `&asOf=${TO}`, "inv"],
    ["ar-overdue-accounts", () => `&asOf=${TO}`, "inv"],
    ["ar-statement-of-accounts", () => `&partyId=${party.CUS.id}&${RANGE}`, "inv"],
    ["subsidiary-ledger", () => `&type=AR&partyId=${party.CUS.id}&${RANGE}`, "inv"],
  ])("%s: branch-only, other branch excluded, consolidated has both, Draft/voided never", async (path, extra, kind) => {
    const [own, other] = kind === "apv" ? [v.apvAudit, v.apvOut] : [v.invAudit, v.invOut];
    const get = (b) => report("checker", path, b, extra());
    const [a, o, all] = await Promise.all([get(br.AUDIT), get(br.OUTSOURCE), get("ALL")]);
    for (const r of [a, o, all]) expect([path, r.status]).toEqual([path, 200]);
    const [ta, to, tall] = [a, o, all].map(text);
    expect(ta).toContain(own.voucherNo);
    expect(ta).not.toContain(other.voucherNo);
    expect(to).toContain(other.voucherNo);
    expect(to).not.toContain(own.voucherNo);
    expect(tall).toContain(own.voucherNo);
    expect(tall).toContain(other.voucherNo);
    for (const hay of [ta, to, tall]) {
      expect(hay).not.toContain(v.draftAudit.voucherNo);
      expect(hay).not.toContain(v.voidOut.voucherNo);
    }
  });
});

describe("authorization - server-side, direct API", () => {
  test("an AUDIT accountant: default scope = AUDIT only; OUTSOURCE and All Branches refused", async () => {
    const is = (b) => report("makerAudit", "income-statement", b, `&${RANGE}`);
    expect(amountOf((await is(undefined)).body, "EXP")).toBe(-15000);
    expect(amountOf((await is(br.AUDIT)).body, "EXP")).toBe(-15000);
    const other = await is(br.OUTSOURCE);
    expect([other.status, other.body.code]).toEqual([403, "BRANCH_ACCESS_DENIED"]);
    const all = await is("ALL");
    expect([all.status, all.body.code]).toEqual([403, "CONSOLIDATED_NOT_ALLOWED"]);
    const gl = text(await report("makerAudit", "general-ledger", undefined, `&${RANGE}`));
    expect(gl).toContain(v.apvAudit.voucherNo);
    expect(gl).not.toContain(v.apvOut.voucherNo);
  });
  test("an OUTSOURCE accountant cannot open or list an AUDIT transaction by direct API", async () => {
    const one = await api("get", "makerOut", `/api/apv/${v.apvAudit.id}?companyId=${co.A}`);
    expect([403, 404]).toContain(one.status);
    expect(text(one)).not.toContain(`${P}APV-AUDIT`);
    const list = await api("get", "makerOut", `/api/apv?companyId=${co.A}`);
    expect(text(list)).not.toContain(v.apvAudit.voucherNo);
  });
  test("another company's ADMIN cannot read Company A's reports or branches", async () => {
    const r = await report("adminB", "income-statement", br.AUDIT, `&${RANGE}`);
    expect(r.status).toBe(403);
    const r2 = await api("get", "adminB", `/api/reports/trial-balance?companyId=${co.A}&${RANGE}`);
    expect(r2.status).toBe(403);
    const own = await api("get", "adminB", `/api/reports/income-statement?companyId=${co.B}&${RANGE}`);
    expect(amountOf(own.body, "EXP")).toBe(0);
  });
});

describe("closed-period reversal stays in the originating branch", () => {
  test("reversing the AUDIT APV zeroes AUDIT, leaves OUTSOURCE at 10,000, consolidated 10,000", async () => {
    const today = AccountingPeriodService.toDateOnly(new Date());
    const [ry, rm] = today.split("-").map(Number);
    const openStart = `${ry}-${String(rm).padStart(2, "0")}-01`;
    const openEnd = AccountingPeriodService.toDateOnly(new Date(ry, rm, 0));
    await pool.query(
      "INSERT INTO accounting_periods (company_id, year, period_month, start_date, end_date, status) VALUES (?, 2025, 6, '2025-06-01', '2025-06-30', 'CLOSED'), (?, ?, ?, ?, ?, 'OPEN')",
      [co.A, co.A, ry, rm, openStart, openEnd]
    );
    const voidTry = await api("post", "checker2", `/api/apv/${v.apvAudit.id}/void`, { reason: "x", companyId: co.A });
    expect([voidTry.status, voidTry.body.code]).toEqual([409, "REVERSAL_REQUIRED"]);
    // the maker cannot reverse their own work; a second checker can
    const own = await api("post", "makerAudit", `/api/apv/${v.apvAudit.id}/reverse`, { reason: `${P}reverse`, companyId: co.A });
    expect(own.status).toBe(403);
    const rev = await api("post", "checker2", `/api/apv/${v.apvAudit.id}/reverse`, { reason: `${P}reverse`, companyId: co.A });
    expect(rev.status).toBe(200);
    const [[jv]] = await pool.query("SELECT branch_id, status, transaction_date FROM jv_headers WHERE id = ?", [rev.body.reversalJvId]);
    expect(jv.branch_id).toBe(br.AUDIT);
    expect(jv.status).toBe("Posted");

    const is = (b) => report("checker", "income-statement", b, `&${RANGE}`);
    const [a, o, all] = await Promise.all([is(br.AUDIT), is(br.OUTSOURCE), is("ALL")]);
    expect([amountOf(a.body, "EXP"), amountOf(o.body, "EXP"), amountOf(all.body, "EXP")]).toEqual([0, -10000, -10000]);
    const tb = (b) => report("checker", "trial-balance", b, `&${RANGE}`);
    const [ta, to] = await Promise.all([tb(br.AUDIT), tb(br.OUTSOURCE)]);
    expect([tbNet(ta.body, "AP"), tbNet(to.body, "AP")]).toEqual([0, -10000]);
  });
});
