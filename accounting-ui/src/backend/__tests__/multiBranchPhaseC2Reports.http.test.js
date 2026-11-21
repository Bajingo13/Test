// Multi-Branch Phase C-2A - branch scope of the Reports module (backend side of
// the report Branch selector). One branch, ALL (one consolidated report) and
// the default scope, across the financial statements, trial balance, ledgers,
// aging and statements. Local test database only. Fixture prefix UAT-MBR-.
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { signSessionToken } = require("../lib/sessionPolicy");
const CurrencyService = require("../services/currencyService");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(180000);

const P = "UAT-MBR-";
const D = "2097-06-05";
const ids = { companies: [], users: [] };
const co = {};
const br = {};
const tok = {};
const usr = {};
const acc = {};
let customer, supplier;

const get = (who, url) => request(app).get(url).set({ Authorization: `Bearer ${tok[who]}` });
const range = `from=2097-06-01&to=2097-06-30`;

async function roleId(code) {
  const [[r]] = await pool.query("SELECT id FROM roles WHERE code = ?", [code]);
  return r.id;
}
async function mkUser(tag, roleCode, companies, branches = []) {
  const [u] = await pool.query("INSERT INTO users (username, full_name, password, role_id, status) VALUES (?, ?, 'x', ?, 'ACTIVE')", [`${P}${tag}`, `${P}${tag}`, await roleId(roleCode)]);
  for (const c of companies) await pool.query("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  for (const b of branches) await pool.query("INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)", [u.insertId, b]);
  ids.users.push(u.insertId);
  usr[tag] = { id: u.insertId, username: `${P}${tag}`, role: roleCode, roleCode, token_version: 0 };
  tok[tag] = signSessionToken(usr[tag]);
}
async function mkAccount(key, cls, group) {
  const [r] = await pool.query("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, '2097-01-01', ?, ?)", [`${P}${key}`, `${P}${key}`, cls]);
  await pool.query("INSERT INTO coa_groups (coa_id, group_code, group_description) VALUES (?, ?, ?)", [r.insertId, `${P}${group.code}`, group.desc]);
  acc[key] = { id: r.insertId, code: `${P}${key}` };
}
async function postedJv(companyId, branchId, no, amount) {
  const [r] = await pool.query("INSERT INTO jv_headers (company_id, branch_id, voucher_no, transaction_date, total_debit, total_credit, status) VALUES (?, ?, ?, ?, ?, ?, 'Posted')", [companyId, branchId, `${P}${no}`, D, amount, amount]);
  await pool.query("INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, debit, credit) VALUES (?, ?, ?, 'Cash', ?, 0), (?, ?, ?, 'Sales', 0, ?)",
    [r.insertId, acc.CASH.id, acc.CASH.code, amount, r.insertId, acc.SALES.id, acc.SALES.code, amount]);
}
async function postedInvoice(companyId, branchId, no, amount) {
  const [r] = await pool.query(
    `INSERT INTO invoice_headers (company_id, branch_id, voucher_no, customer_id, customer_name, transaction_date, due_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'Unpaid', 'Posted')`,
    [companyId, branchId, `${P}${no}`, customer.id, customer.name, D, D, amount, amount, amount]
  );
  await pool.query("INSERT INTO invoice_lines (invoice_id, account_id, account_code, account_title, debit, credit) VALUES (?, ?, ?, 'AR', ?, 0), (?, ?, ?, 'Sales', 0, ?)",
    [r.insertId, acc.AR.id, acc.AR.code, amount, r.insertId, acc.SALES.id, acc.SALES.code, amount]);
}
async function postedApv(companyId, branchId, no, amount) {
  const [r] = await pool.query(
    `INSERT INTO apv_headers (company_id, branch_id, voucher_no, supplier_id, supplier_name, transaction_date, due_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'Unpaid', 'Posted')`,
    [companyId, branchId, `${P}${no}`, supplier.id, supplier.name, D, D, amount, amount, amount]
  );
  await pool.query("INSERT INTO apv_lines (apv_id, account_id, account_code, account_title, debit, credit) VALUES (?, ?, ?, 'Exp', ?, 0), (?, ?, ?, 'AP', 0, ?)",
    [r.insertId, acc.EXP.id, acc.EXP.code, amount, r.insertId, acc.AP.id, acc.AP.code, amount]);
}
const salesOf = (rows) => rows.filter((r) => (r.account_code || r.accountCode) === acc.SALES.code).reduce((s, r) => s + Number(r.amount), 0);
const cashOf = (rows) => rows.filter((r) => (r.account_code || r.accountCode) === acc.CASH.code).reduce((s, r) => s + Number(r.amount), 0);

beforeAll(async () => {
  assertNotProductionDatabase();
  for (const [tag, branches] of [["A", ["A1", "A2"]], ["B", ["B1"]]]) {
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
  await mkUser("adminA", "ADMIN", [co.A]);
  await mkUser("acctA1", "ACCOUNTANT", [co.A], [br.A1]);
  await mkUser("acctBoth", "ACCOUNTANT", [co.A], [br.A1, br.A2]);
  await mkUser("adminB", "ADMIN", [co.B]);
  await pool.query("INSERT INTO account_group_codes (group_code, group_description, account_class, status) VALUES (?, 'REVENUE', 'INCOME', 'ACTIVE'), (?, 'ASSETS', 'ASSET', 'ACTIVE'), (?, 'LIABILITIES', 'LIABILITY', 'ACTIVE'), (?, 'EXPENSES', 'EXPENSE', 'ACTIVE')",
    [`${P}REV`, `${P}AST`, `${P}LIA`, `${P}EXPG`]);
  await mkAccount("CASH", "ASSET", { code: "AST", desc: "ASSETS" });
  await mkAccount("AR", "ASSET", { code: "AST", desc: "ASSETS" });
  await mkAccount("SALES", "INCOME", { code: "REV", desc: "REVENUE" });
  await mkAccount("EXP", "EXPENSE", { code: "EXPG", desc: "EXPENSES" });
  await mkAccount("AP", "LIABILITY", { code: "LIA", desc: "LIABILITIES" });
  const [cu] = await pool.query("INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, ?, 'CUSTOMER', ?, 'ACTIVE')", [co.A, `${P}CUS`, `${P}CUS`]);
  customer = { id: cu.insertId, name: `${P}CUS` };
  const [su] = await pool.query("INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, ?, 'SUPPLIER', ?, 'ACTIVE')", [co.A, `${P}SUP`, `${P}SUP`]);
  supplier = { id: su.insertId, name: `${P}SUP` };
  await postedJv(co.A, br.A1, "JV-A1", 100000);
  await postedJv(co.A, br.A2, "JV-A2", 150000);
  await postedJv(co.B, br.B1, "JV-B1", 70000);
  await postedInvoice(co.A, br.A1, "INV-A1", 1200);
  await postedInvoice(co.A, br.A2, "INV-A2", 3400);
  await postedApv(co.A, br.A1, "APV-A1", 500);
  await postedApv(co.A, br.A2, "APV-A2", 800);
});

afterAll(async () => {
  try {
    const cos = ids.companies.concat(0);
    for (const [lines, fk, head] of [["jv_lines", "jv_id", "jv_headers"], ["invoice_lines", "invoice_id", "invoice_headers"], ["apv_lines", "apv_id", "apv_headers"]]) {
      await pool.query(`DELETE l FROM ${lines} l JOIN ${head} h ON h.id = l.${fk} WHERE h.company_id IN (?)`, [cos]);
      await pool.query(`DELETE FROM ${head} WHERE company_id IN (?)`, [cos]);
    }
    await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM audit_logs WHERE company_id IN (?) OR user_id IN (?)", [cos, ids.users.concat(0)]);
    await pool.query("DELETE FROM general_libraries WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM coa_groups WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE ?)", [`${P}%`]);
    await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE ?", [`${P}%`]);
    await pool.query("DELETE FROM account_group_codes WHERE group_code LIKE ?", [`${P}%`]);
    await pool.query("DELETE FROM currency_rates WHERE company_id IN (?)", [cos]);
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

describe("Income Statement / Balance Sheet: one branch, All Branches (one report), default scope", () => {
  const is = (who, branch) => get(who, `/api/reports/income-statement?companyId=${co.A}&${range}${branch === undefined ? "" : `&branch=${branch}`}`);
  const bs = (who, branch) => get(who, `/api/reports/balance-sheet?companyId=${co.A}&to=2097-06-30${branch === undefined ? "" : `&branch=${branch}`}`);

  // Sales per branch = its JV (100,000 / 150,000) + its invoice (1,200 / 3,400).
  test("ADMIN: Branch A1, Branch A2, All Branches = one combined line; no branch = the company report as before", async () => {
    expect(salesOf((await is("adminA", br.A1)).body)).toBe(101200);
    expect(salesOf((await is("adminA", br.A2)).body)).toBe(153400);
    const all = await is("adminA", "ALL");
    expect(all.status).toBe(200);
    expect(salesOf(all.body)).toBe(254600);
    expect(all.body.filter((r) => r.account_code === acc.SALES.code)).toHaveLength(1);
    expect(salesOf((await is("adminA")).body)).toBe(254600);
  });

  test("Balance Sheet follows the same scope (cash per branch / consolidated)", async () => {
    expect(cashOf((await bs("adminA", br.A1)).body)).toBe(100000);
    expect(cashOf((await bs("adminA", "ALL")).body)).toBe(250000);
    expect(cashOf((await bs("acctA1")).body)).toBe(100000);
  });

  test("ACCOUNTANT: own branch only; another branch and All Branches are refused by the server", async () => {
    expect(salesOf((await is("acctA1", br.A1)).body)).toBe(101200);
    expect(salesOf((await is("acctA1")).body)).toBe(101200); // no branch sent: never more than their branches
    const other = await is("acctA1", br.A2);
    expect([other.status, other.body.code]).toEqual([403, "BRANCH_ACCESS_DENIED"]);
    const all = await is("acctA1", "ALL");
    expect([all.status, all.body.code]).toEqual([403, "CONSOLIDATED_NOT_ALLOWED"]);
    expect((await is("acctA1", br.B1)).body.code).toBe("BRANCH_COMPANY_MISMATCH");
  });

  test("a multi-branch ACCOUNTANT selects either assigned branch but still not All Branches", async () => {
    expect(salesOf((await is("acctBoth", br.A2)).body)).toBe(153400);
    expect(salesOf((await is("acctBoth", br.A1)).body)).toBe(101200);
    expect((await is("acctBoth", "ALL")).body.code).toBe("CONSOLIDATED_NOT_ALLOWED");
  });

  test("another company's ADMIN cannot reach Company A's report or branches", async () => {
    expect((await is("adminB", br.A1)).status).toBe(403);
    const own = await get("adminB", `/api/reports/income-statement?companyId=${co.B}&${range}`);
    expect(salesOf(own.body)).toBe(70000);
  });
});

describe("other reports honour the same branch scope", () => {
  test("Trial Balance", async () => {
    const tb = async (who, branch) => {
      const r = await get(who, `/api/reports/trial-balance?companyId=${co.A}&${range}${branch ? `&branch=${branch}` : ""}`);
      expect(r.status).toBe(200);
      const row = r.body.find((x) => (x.account_code || x.accountCode) === acc.SALES.code);
      return row ? Math.abs(Number(row.credit ?? row.total_credit ?? row.credit_total ?? 0) - Number(row.debit ?? row.total_debit ?? row.debit_total ?? 0)) : 0;
    };
    expect(await tb("adminA", br.A1)).toBe(101200);
    expect(await tb("adminA", "ALL")).toBe(254600);
    expect(await tb("acctA1")).toBe(101200);
  });

  test("General Ledger lists only the selected branch's entries", async () => {
    const gl = async (who, branch) => JSON.stringify((await get(who, `/api/reports/general-ledger?companyId=${co.A}&${range}${branch ? `&branch=${branch}` : ""}`)).body);
    const a1 = await gl("adminA", br.A1);
    expect(a1).toContain(`${P}JV-A1`);
    expect(a1).not.toContain(`${P}JV-A2`);
    const all = await gl("adminA", "ALL");
    expect(all).toContain(`${P}JV-A1`);
    expect(all).toContain(`${P}JV-A2`);
    expect(await gl("acctA1")).not.toContain(`${P}JV-A2`);
  });

  test("AR aging and AP aging", async () => {
    const ar = JSON.stringify((await get("acctA1", `/api/reports/ar-aging?companyId=${co.A}&asOf=2097-06-30`)).body);
    expect(ar).toContain(`${P}INV-A1`);
    expect(ar).not.toContain(`${P}INV-A2`);
    const ap = JSON.stringify((await get("adminA", `/api/reports/ap-aging?companyId=${co.A}&asOf=2097-06-30&branch=${br.A2}`)).body);
    expect(ap).toContain(`${P}APV-A2`);
    expect(ap).not.toContain(`${P}APV-A1`);
    const apAll = JSON.stringify((await get("adminA", `/api/reports/ap-aging?companyId=${co.A}&asOf=2097-06-30&branch=ALL`)).body);
    expect(apAll).toContain(`${P}APV-A1`);
    expect(apAll).toContain(`${P}APV-A2`);
  });

  test("AP Statement of Accounts and Subsidiary Ledger", async () => {
    const soa = JSON.stringify((await get("adminA", `/api/reports/ap-statement-of-accounts?companyId=${co.A}&partyId=${supplier.id}&${range}&branch=${br.A1}`)).body);
    expect(soa).toContain(`${P}APV-A1`);
    expect(soa).not.toContain(`${P}APV-A2`);
    const sl = await get("acctA1", `/api/reports/subsidiary-ledger?companyId=${co.A}&type=AR&partyId=${customer.id}&${range}`);
    expect(sl.status).toBe(200);
    const slText = JSON.stringify(sl.body);
    expect(slText).not.toContain(`${P}INV-A2`);
  });
});
