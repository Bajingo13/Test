// Dashboard branch context (GET /api/dashboard/summary?branch=...). The
// dashboard reuses the Reports branch scope (lib/reportBranchContext + the
// Phase A resolver): one branch, ONE consolidated All Branches figure for
// users allowed to consolidate, a branch-restricted user's own branches by
// default, and never another branch's data in any widget.
// Local test database only. Fixture prefix dbr-.
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { signSessionToken } = require("../lib/sessionPolicy");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(180000);

const P = "dbr-";
const COMPANY = `${P}ALAS, OPLAS & CO., CPA'S`;
const RANGE = "from=2096-03-01&to=2096-03-31";
const ids = { companies: [], users: [], banks: [] };
const co = {};
const br = {};
const tok = {};
const acc = {};
const doc = {};

async function roleId(code) {
  return (await pool.query("SELECT id FROM roles WHERE code = ?", [code]))[0][0].id;
}
async function mkUser(tag, roleCode, companies = [], branches = []) {
  const [u] = await pool.query("INSERT INTO users (username, full_name, password, role_id, status) VALUES (?, ?, 'x', ?, 'ACTIVE')", [`${P}${tag}`, `${P}${tag}`, await roleId(roleCode)]);
  for (const c of companies) await pool.query("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  for (const b of branches) await pool.query("INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)", [u.insertId, b]);
  ids.users.push(u.insertId);
  tok[tag] = signSessionToken({ id: u.insertId, username: `${P}${tag}`, role: "user", token_version: 0 });
}
async function mkAccount(key, cls, section, branchId = null) {
  const code = `${P}${key.replace(/@.*/, "")}`;
  const [r] = await pool.query("INSERT INTO chart_of_accounts (code, account_date, title, account_class, branch_id) VALUES (?, '2096-01-01', ?, ?, ?)", [code, `${P}${key}`, cls, branchId]);
  const group = `${P}G-${key.replace(/@.*/, "")}`;
  await pool.query(
    "INSERT IGNORE INTO account_group_codes (group_code, group_description, account_class, report_section, display_order, status) VALUES (?, ?, ?, ?, 10, 'ACTIVE')",
    [group, `${key} group`, cls, section]
  );
  await pool.query("INSERT INTO coa_groups (coa_id, group_code, group_description) VALUES (?, ?, ?)", [r.insertId, group, `${key} group`]);
  acc[key] = { id: r.insertId, code };
}
async function jv(branchId, no, dr, cr, amount, status = "Posted") {
  const [r] = await pool.query(
    "INSERT INTO jv_headers (company_id, branch_id, voucher_no, transaction_date, total_debit, total_credit, status) VALUES (?, ?, ?, '2096-03-10', ?, ?, ?)",
    [co.A, branchId, `${P}${no}`, amount, amount, status]
  );
  await pool.query("INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, debit, credit) VALUES (?, ?, ?, 'x', ?, 0), (?, ?, ?, 'x', 0, ?)",
    [r.insertId, acc[dr].id, acc[dr].code, amount, r.insertId, acc[cr].id, acc[cr].code, amount]);
  doc[no] = r.insertId;
  // an activity event about this document
  await pool.query("INSERT INTO audit_logs (module, entity_type, entity_id, action, description, company_id) VALUES ('TRANSACTIONS.JV', 'JV', ?, 'CREATE', ?, ?)", [r.insertId, `${P}${no} created`, co.A]);
}
async function invoice(branchId, no, amount, status = "Posted") {
  const [r] = await pool.query(
    `INSERT INTO invoice_headers (company_id, branch_id, voucher_no, customer_id, customer_name, transaction_date, due_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, ?, NULL, ?, '2096-03-05', '2096-03-08', ?, ?, 0, ?, 'Unpaid', ?)`,
    [co.A, branchId, `${P}${no}`, `${P}Customer`, amount, amount, amount, status]
  );
  await pool.query("INSERT INTO invoice_lines (invoice_id, account_id, account_code, account_title, debit, credit) VALUES (?, ?, ?, 'AR', ?, 0), (?, ?, ?, 'Sales', 0, ?)",
    [r.insertId, acc.AR.id, acc.AR.code, amount, r.insertId, acc.REV.id, acc.REV.code, amount]);
  doc[no] = r.insertId;
}
async function apv(branchId, no, amount, status = "Posted") {
  const [r] = await pool.query(
    `INSERT INTO apv_headers (company_id, branch_id, voucher_no, supplier_id, supplier_name, transaction_date, due_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, ?, NULL, ?, '2096-03-06', '2096-03-09', ?, ?, 0, ?, 'Unpaid', ?)`,
    [co.A, branchId, `${P}${no}`, `${P}Supplier`, amount, amount, amount, status]
  );
  await pool.query("INSERT INTO apv_lines (apv_id, account_id, account_code, account_title, debit, credit) VALUES (?, ?, ?, 'Exp', ?, 0), (?, ?, ?, 'AP', 0, ?)",
    [r.insertId, acc.EXP.id, acc.EXP.code, amount, r.insertId, acc.AP.id, acc.AP.code, amount]);
  doc[no] = r.insertId;
}
const summary = (who, branch, companyId = co.A) =>
  request(app).get(`/api/dashboard/summary?companyId=${companyId}&${RANGE}${branch === undefined ? "" : `&branch=${branch}`}`).set({ Authorization: `Bearer ${tok[who]}` });
const scope = (who, companyId = co.A) => request(app).get(`/api/branch-scope/branches?companyId=${companyId}`).set({ Authorization: `Bearer ${tok[who]}` });
const vouchers = (body) => body.sections.transactions.items.map((t) => t.voucherNo).sort();
const activityDocs = (body) => body.sections.activity.items.map((a) => a.entityId).sort((x, y) => x - y);

beforeAll(async () => {
  assertNotProductionDatabase();
  for (const [tag, name, branches] of [["A", COMPANY, ["B1", "B2", "B3"]], ["O", `${P}Other Co`, ["OB"]]]) {
    const [c] = await pool.query("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [name]);
    co[tag] = c.insertId;
    ids.companies.push(c.insertId);
    await pool.query("INSERT INTO currencies (company_id, currency_code, currency_name, currency_symbol, is_base_currency, is_active) VALUES (?, 'PHP', 'Philippine Peso', 'P', 1, 1)", [c.insertId]);
    for (const b of branches) br[b] = (await pool.query("INSERT INTO branches (company_id, name, code, status) VALUES (?, ?, ?, 'ACTIVE')", [c.insertId, `${P}${b}`, `${P}${b}`]))[0].insertId;
  }
  await mkUser("super", "SUPER_ADMIN");
  await mkUser("admin", "ADMIN", [co.A]);
  await mkUser("acct1", "ACCOUNTANT", [co.A], [br.B1]);
  await mkUser("acct12", "ACCOUNTANT", [co.A], [br.B1, br.B2]);

  await mkAccount("BANK", "ASSET", "CURRENT_ASSET");
  await mkAccount("AR", "ASSET", "CURRENT_ASSET");
  await mkAccount("AP", "LIABILITY", "CURRENT_LIABILITY");
  await mkAccount("EQ", "EQUITY", "EQUITY");
  await mkAccount("REV", "INCOME", "REVENUE");
  await mkAccount("EXP", "EXPENSE", "OPERATING_EXPENSE");
  // Phase B: the SAME account code owned separately by Branch 1 and Branch 2
  await mkAccount("REUSED@B1", "INCOME", "REVENUE", br.B1);
  await mkAccount("REUSED@B2", "INCOME", "REVENUE", br.B2);
  const [b] = await pool.query(
    "INSERT INTO bank_codes (bank_code, bank_name, account_no, account_name, coa_account_id, coa_code, status) VALUES (?, 'Dbr Bank', '000777888999', 'Dbr Operating', ?, ?, 'ACTIVE')",
    [`${P}BANK`, acc.BANK.id, acc.BANK.code]
  );
  ids.banks.push(b.insertId);

  // revenue / expenses / cash per branch (distinct amounts)
  await jv(br.B1, "JV-B1-SALE", "BANK", "REV", 1000);
  await jv(br.B1, "JV-B1-REUSED", "BANK", "REUSED@B1", 50);
  await jv(br.B1, "JV-B1-EXP", "EXP", "BANK", 100);
  await jv(br.B2, "JV-B2-SALE", "BANK", "REV", 2500);
  await jv(br.B2, "JV-B2-REUSED", "BANK", "REUSED@B2", 70);
  await jv(br.B2, "JV-B2-EXP", "EXP", "BANK", 300);
  await jv(br.B3, "JV-B3-SALE", "BANK", "REV", 400);
  await jv(br.B3, "JV-B3-DRAFT", "BANK", "REV", 99999, "Draft");
  // receivables / payables / drafts per branch
  await invoice(br.B1, "INV-B1", 600);
  await invoice(br.B2, "INV-B2", 900);
  await invoice(br.B2, "INV-B2-DRAFT", 45, "Draft");
  await apv(br.B1, "APV-B1", 200);
  await apv(br.B2, "APV-B2", 350);
  await apv(br.B1, "APV-B1-DRAFT", 11, "Draft");
  await apv(br.B2, "APV-B2-DRAFT1", 22, "Draft");
  await apv(br.B2, "APV-B2-DRAFT2", 33, "Draft");
});

afterAll(async () => {
  try {
    const cos = ids.companies.concat(0);
    for (const [lines, fk, head] of [["jv_lines", "jv_id", "jv_headers"], ["invoice_lines", "invoice_id", "invoice_headers"], ["apv_lines", "apv_id", "apv_headers"]]) {
      await pool.query(`DELETE l FROM ${lines} l JOIN ${head} h ON h.id = l.${fk} WHERE h.company_id IN (?)`, [cos]);
      await pool.query(`DELETE FROM ${head} WHERE company_id IN (?)`, [cos]);
    }
    await pool.query("DELETE FROM audit_logs WHERE company_id IN (?) OR user_id IN (?) OR description LIKE ?", [cos, ids.users.concat(0), `${P}%`]);
    await pool.query("DELETE FROM bank_codes WHERE id IN (?)", [ids.banks.concat(0)]);
    await pool.query("DELETE FROM coa_groups WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE ?)", [`${P}%`]);
    await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE ?", [`${P}%`]);
    await pool.query("DELETE FROM account_group_codes WHERE group_code LIKE ?", [`${P}%`]);
    await pool.query("DELETE FROM currencies WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM user_branches WHERE user_id IN (?)", [ids.users.concat(0)]);
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [ids.users.concat(0)]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [ids.users.concat(0)]);
    await pool.query("DELETE FROM branches WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM companies WHERE id IN (?)", [cos]);
  } finally {
    await pool.end();
  }
});

// Expected per branch (Posted only; the posted invoice credits Sales and the
// posted APV debits Expense):
//   revenue  B1 1000+50+600 = 1650 | B2 2500+70+900 = 3470 | B3 400   (ALL = 5520, the reused code counted once per branch)
//   net      B1 1650-100-200 = 1350 | B2 3470-300-350 = 2820 | B3 400 (ALL = 4570)
//   cash     B1 950            | B2 2270            | B3 400   (ALL = 3620)
//   AR       B1 600 | B2 900       AP  B1 200 | B2 350
//   drafts   APV B1 1 (11) | B2 2 (55); invoice B2 1
const EXPECT = {
  B1: { revenue: 1650, net: 1350, cash: 950, ar: 600, ap: 200, draftApv: { count: 1, amount: 11 }, draftInv: 0 },
  B2: { revenue: 3470, net: 2820, cash: 2270, ar: 900, ap: 350, draftApv: { count: 2, amount: 55 }, draftInv: 1 },
  B3: { revenue: 400, net: 400, cash: 400, ar: 0, ap: 0, draftApv: { count: 0, amount: 0 }, draftInv: 0 },
};
const figures = (body) => ({
  revenue: body.sections.income.revenue,
  net: body.sections.income.netIncome,
  cash: body.sections.cash.endingBalance,
  ar: body.sections.receivables.total,
  ap: body.sections.payables.total,
  draftApv: body.sections.workflow.draftApv,
  draftInv: body.sections.workflow.draftInvoices.count,
});

describe("company context", () => {
  test("DBR-01/02 the company resolves and is named in the summary (single-company scope)", async () => {
    const res = await summary("admin", br.B1);
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ companyId: co.A, companyName: COMPANY });
    const noCompany = await request(app).get(`/api/dashboard/summary?${RANGE}`).set({ Authorization: `Bearer ${tok.admin}` });
    expect(noCompany.status).toBe(200); // one company -> resolved without companyId
    expect(noCompany.body.meta.companyName).toBe(COMPANY);
  });
});

describe("ADMIN / SUPER_ADMIN", () => {
  test("DBR-03/10 ADMIN switches Branch 1 -> Branch 2 -> Branch 3 and every widget follows", async () => {
    for (const b of ["B1", "B2", "B3"]) {
      const res = await summary("admin", br[b]);
      expect([b, res.status]).toEqual([b, 200]);
      expect(res.body.meta.branch).toMatchObject({ scope: "BRANCH", consolidated: false, branches: [{ id: br[b], code: `${P}${b}` }] });
      expect([b, figures(res.body)]).toEqual([b, EXPECT[b]]);
    }
  });
  test("DBR-03 ADMIN All Branches = ONE consolidated figure (B1+B2+B3), reused code counted once per branch", async () => {
    const res = await summary("admin", "ALL");
    expect(res.status).toBe(200);
    expect(res.body.meta.branch).toMatchObject({ scope: "ALL", consolidated: true });
    expect(res.body.meta.branch.branches.map((b) => b.id).sort((x, y) => x - y)).toEqual([br.B1, br.B2, br.B3].sort((x, y) => x - y));
    expect(figures(res.body)).toEqual({ revenue: 5520, net: 4570, cash: 3620, ar: 1500, ap: 550, draftApv: { count: 3, amount: 66 }, draftInv: 1 });
    // no ?branch for a full-authority user: the company dashboard exactly as before
    const company = await summary("admin");
    expect(company.body.meta.branch).toEqual({ scope: "COMPANY", consolidated: null, branches: [] });
    expect(figures(company.body)).toEqual(figures(res.body));
  });
  test("DBR-04 SUPER_ADMIN reaches every branch and All Branches", async () => {
    const s = await scope("super");
    expect(s.body.branches.map((b) => b.id).sort((x, y) => x - y)).toEqual([br.B1, br.B2, br.B3].sort((x, y) => x - y));
    expect(s.body.canConsolidate).toBe(true);
    expect(figures((await summary("super", br.B2)).body)).toEqual(EXPECT.B2);
    expect((await summary("super", "ALL")).body.sections.income.revenue).toBe(5520);
  });
});

describe("ACCOUNTANT", () => {
  test("DBR-05 Branch-1 accountant: scope is Branch 1 only, no consolidation; the dashboard shows Branch 1", async () => {
    const s = await scope("acct1");
    expect(s.body.branches.map((b) => b.id)).toEqual([br.B1]);
    expect(s.body.canConsolidate).toBe(false);
    const res = await summary("acct1", br.B1);
    expect(res.status).toBe(200);
    expect(figures(res.body)).toEqual(EXPECT.B1);
    // without ?branch the server still limits them to their own branch
    const dflt = await summary("acct1");
    expect(dflt.body.meta.branch).toMatchObject({ scope: "BRANCH", branches: [{ id: br.B1 }] });
    expect(figures(dflt.body)).toEqual(EXPECT.B1);
  });
  test("DBR-06/10 Branch-1+2 accountant switches Branch 1 <-> Branch 2 (same company), figures change", async () => {
    const s = await scope("acct12");
    expect(s.body.branches.map((b) => b.id).sort((x, y) => x - y)).toEqual([br.B1, br.B2].sort((x, y) => x - y));
    expect(s.body.canConsolidate).toBe(false);
    const one = await summary("acct12", br.B1);
    const two = await summary("acct12", br.B2);
    expect(one.body.meta.companyName).toBe(COMPANY);
    expect(two.body.meta.companyName).toBe(COMPANY);
    expect(figures(one.body)).toEqual(EXPECT.B1);
    expect(figures(two.body)).toEqual(EXPECT.B2);
  });
  test("DBR-07/08 a forged Branch 3 / other-company branch / malformed branch is refused", async () => {
    for (const [who, b] of [["acct12", br.B3], ["acct1", br.B2], ["acct1", br.B3], ["acct12", br.OB], ["admin", br.OB]]) {
      const res = await summary(who, b);
      expect([who, b, res.status >= 400 && res.status < 500]).toEqual([who, b, true]);
      expect(res.body.sections).toBeUndefined();
    }
    for (const bad of ["abc", "-1", "1;DROP"]) expect((await summary("acct1", encodeURIComponent(bad))).status).toBe(400);
  });
  test("DBR-09 All Branches is refused for accountants (also for one with two branches)", async () => {
    for (const who of ["acct1", "acct12"]) {
      const res = await summary(who, "ALL");
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("CONSOLIDATED_NOT_ALLOWED");
      expect(res.body.sections).toBeUndefined();
    }
  });
  test("DBR-11 no other branch's data in any widget (transactions, activity, drafts)", async () => {
    const b1 = (await summary("acct12", br.B1)).body;
    const b2 = (await summary("acct12", br.B2)).body;
    expect(vouchers(b1)).toEqual([`${P}APV-B1`, `${P}APV-B1-DRAFT`, `${P}INV-B1`, `${P}JV-B1-EXP`, `${P}JV-B1-REUSED`, `${P}JV-B1-SALE`].sort());
    expect(vouchers(b2).every((v) => /-B2/.test(v))).toBe(true);
    expect(vouchers(b2)).not.toContain(`${P}JV-B3-SALE`);
    expect(activityDocs(b1)).toEqual([doc["JV-B1-SALE"], doc["JV-B1-REUSED"], doc["JV-B1-EXP"]].sort((x, y) => x - y));
    expect(activityDocs(b2)).toEqual([doc["JV-B2-SALE"], doc["JV-B2-REUSED"], doc["JV-B2-EXP"]].sort((x, y) => x - y));
    const text = JSON.stringify(b1);
    for (const other of ["-B2", "-B3"]) expect(text).not.toContain(other);
    // the Branch-1-only accountant's default dashboard carries no Branch 2/3 document either
    expect(JSON.stringify((await summary("acct1")).body)).not.toMatch(/-B2|-B3/);
  });
});
