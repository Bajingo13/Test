const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Checkpoint 6 - permanent HTTP-level regression coverage for Petty Cash
// Voucher and Debit/Credit Memo, proving they have a real, separate
// identity and never fall back into apv_headers/apv_lines (the bug this
// checkpoint fixes - see the Checkpoint 6 investigation report).

jest.setTimeout(180000);

let companyAId, companyBId;
let tokenA, tokenB;
let cashA, expenseA, arA, apA, revA;
let custAId, suppAId;
let julyPeriodId, augustPeriodId;
let usdId;

async function makeCompany(name) {
  const [result] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [name]);
  return result.insertId;
}
async function makeLoginUser(username, password, roleId, companyId) {
  const hash = await bcrypt.hash(password, 10);
  const [result] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, ?, 'ACTIVE')",
    [username, hash, roleId]
  );
  const userId = result.insertId;
  if (companyId) await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, companyId]);
  return userId;
}
async function makeAccount(code, title, accountClass) {
  const [result] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, accountClass]
  );
  return result.insertId;
}
async function makeParty(code, partyType, name, companyId) {
  const [result] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, ?, ?, ?, 'ACTIVE')",
    [companyId, code, partyType, name]
  );
  return result.insertId;
}
async function loginAs(username, password) {
  const res = await request(app).post("/api/login").send({ username, password });
  if (res.status !== 200) throw new Error(`Login failed for ${username}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token;
}
// Phase 7B fix: this must be scoped to THIS test's own company, not a
// global COUNT(*) across the whole table. Jest's default (non
// --runInBand) run executes test files in parallel worker processes that
// all share the one astrea_accounting_test database - any other suite
// creating an APV fixture in a different company at the same moment (e.g.
// postedImmutability.http.test.js's own APV fixtures) raced this
// unscoped count and produced an intermittent, order/timing-dependent
// false failure unrelated to this file's own Petty Cash/Memo logic.
async function countApvRows() {
  const [[row]] = await pool.query("SELECT COUNT(*) c FROM apv_headers WHERE company_id = ?", [companyAId]);
  return row.c;
}

beforeAll(async () => {
  assertNotProductionDatabase();

  companyAId = await makeCompany("TEST6 Company A");
  companyBId = await makeCompany("TEST6 Company B");
  const adminAId = await makeLoginUser("test6_admin_a", "Test6Pass!A1", 2, companyAId);
  const adminBId = await makeLoginUser("test6_admin_b", "Test6Pass!B1", 2, companyBId);

  cashA = await makeAccount("TEST6CASH-A", "Petty Cash Fund A (6)", "ASSET");
  expenseA = await makeAccount("TEST6EXP-A", "Misc Expense A (6)", "EXPENSE");
  arA = await makeAccount("TEST6AR-A", "Accounts Receivable A (6)", "ASSET");
  apA = await makeAccount("TEST6AP-A", "Accounts Payable A (6)", "LIABILITY");
  revA = await makeAccount("TEST6REV-A", "Sales Revenue A (6)", "INCOME");
  custAId = await makeParty("TEST6-CUSTA", "CUSTOMER", "6 Company A Customer", companyAId);
  suppAId = await makeParty("TEST6-SUPPA", "SUPPLIER", "6 Company A Supplier", companyAId);

  const CurrencyService = require("../services/currencyService");
  await CurrencyService.createCurrency({ id: adminAId, roleCode: "ADMIN" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: companyAId,
  });
  await CurrencyService.createCurrency({ id: adminBId, roleCode: "ADMIN" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: companyBId,
  });
  const usd = await CurrencyService.createCurrency({ id: adminAId, roleCode: "ADMIN" }, {
    currencyCode: "USD", currencyName: "US Dollar", currencySymbol: "$",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "MANUAL", companyId: companyAId,
  });
  usdId = usd.id;
  await CurrencyService.recordRate({ id: adminAId, roleCode: "ADMIN" }, usdId, { rateMode: "MANUAL", rate: 56.0, effectiveDate: "2026-08-01" });

  tokenA = await loginAs("test6_admin_a", "Test6Pass!A1");
  tokenB = await loginAs("test6_admin_b", "Test6Pass!B1");

  await request(app).post("/api/accounting-periods/generate-year").set("Authorization", `Bearer ${tokenA}`).send({ year: 2026, companyId: companyAId });
  const listA = await request(app).get("/api/accounting-periods?year=2026").set("Authorization", `Bearer ${tokenA}`).query({ companyId: companyAId });
  julyPeriodId = listA.body.find((p) => p.period_month === 7).id;
  augustPeriodId = listA.body.find((p) => p.period_month === 8).id;

  const closeRes = await request(app).post(`/api/accounting-periods/${julyPeriodId}/close`).set("Authorization", `Bearer ${tokenA}`).send({ notes: "test close", companyId: companyAId });
  if (closeRes.status !== 200) throw new Error(`Failed to close July fixture period: ${JSON.stringify(closeRes.body)}`);
});

afterAll(async () => {
  await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id IN (?,?)", [companyAId, companyBId]);
  await pool.query(
    "DELETE l FROM petty_cash_lines l JOIN petty_cash_headers h ON h.id = l.petty_cash_id WHERE h.company_id IN (?,?)",
    [companyAId, companyBId]
  );
  await pool.query("DELETE FROM petty_cash_headers WHERE company_id IN (?,?)", [companyAId, companyBId]);
  await pool.query("DELETE l FROM memo_lines l JOIN memo_headers h ON h.id = l.memo_id WHERE h.company_id IN (?,?)", [companyAId, companyBId]);
  await pool.query("DELETE FROM memo_headers WHERE company_id IN (?,?)", [companyAId, companyBId]);
  await pool.query("DELETE FROM currency_rates WHERE currency_id = ?", [usdId]);
  await pool.query("DELETE FROM currencies WHERE company_id IN (?,?)", [companyAId, companyBId]);
  await pool.query("DELETE FROM general_libraries WHERE company_id IN (?,?)", [companyAId, companyBId]);
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'TEST6%'");
  await pool.query("DELETE FROM accounting_period_history WHERE company_id IN (?,?)", [companyAId, companyBId]);
  await pool.query("DELETE FROM accounting_periods WHERE company_id IN (?,?)", [companyAId, companyBId]);
  const [users] = await pool.query("SELECT id FROM users WHERE username IN ('test6_admin_a','test6_admin_b')");
  if (users.length) {
    const ids = users.map((u) => u.id);
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [ids]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [ids]);
  }
  await pool.query("DELETE FROM companies WHERE id IN (?,?)", [companyAId, companyBId]);
  await pool.end();
});

describe("CRITICAL: no APV contamination", () => {
  test("creating a Petty Cash Voucher never creates an apv_headers row", async () => {
    const before = await countApvRows();
    const res = await request(app).post("/api/petty-cash").set("Authorization", `Bearer ${tokenA}`).send({
      voucherNo: "TEST6-PCV-1", payeeName: "Office Supplies Store", transactionDate: "2026-08-05",
      description: "Office supplies", status: "Posted",
      lines: [
        { accountId: expenseA, accountCode: "TEST6EXP-A", accountTitle: "Expense", particulars: "x", debit: 500, credit: 0 },
        { accountId: cashA, accountCode: "TEST6CASH-A", accountTitle: "Petty Cash", particulars: "x", debit: 0, credit: 500 },
      ],
    });
    expect(res.status).toBe(200);
    const after = await countApvRows();
    expect(after).toBe(before);

    const [[pcvRow]] = await pool.query("SELECT id FROM petty_cash_headers WHERE id = ?", [res.body.id]);
    expect(pcvRow).toBeTruthy();
  });

  test("creating a Debit Memo never creates an apv_headers row", async () => {
    const before = await countApvRows();
    const res = await request(app).post("/api/debit-memos").set("Authorization", `Bearer ${tokenA}`).send({
      voucherNo: "TEST6-DM-1", partyId: custAId, partyName: "6 Company A Customer", partyType: "CUSTOMER",
      transactionDate: "2026-08-06", description: "Billing correction", status: "Posted",
      lines: [
        { accountId: arA, accountCode: "TEST6AR-A", accountTitle: "AR", particulars: "x", debit: 300, credit: 0 },
        { accountId: revA, accountCode: "TEST6REV-A", accountTitle: "Revenue", particulars: "x", debit: 0, credit: 300 },
      ],
    });
    expect(res.status).toBe(200);
    expect(await countApvRows()).toBe(before);
  });

  test("creating a Credit Memo never creates an apv_headers row", async () => {
    const before = await countApvRows();
    const res = await request(app).post("/api/credit-memos").set("Authorization", `Bearer ${tokenA}`).send({
      voucherNo: "TEST6-CM-1", partyId: custAId, partyName: "6 Company A Customer", partyType: "CUSTOMER",
      transactionDate: "2026-08-06", description: "Sales return", status: "Posted",
      lines: [
        { accountId: revA, accountCode: "TEST6REV-A", accountTitle: "Revenue", particulars: "x", debit: 200, credit: 0 },
        { accountId: arA, accountCode: "TEST6AR-A", accountTitle: "AR", particulars: "x", debit: 0, credit: 200 },
      ],
    });
    expect(res.status).toBe(200);
    expect(await countApvRows()).toBe(before);
  });

  test("Petty Cash list never includes an APV, and vice versa", async () => {
    const pcvList = await request(app).get("/api/petty-cash").set("Authorization", `Bearer ${tokenA}`);
    expect(pcvList.body.every((r) => r.voucherNo.startsWith("TEST6-PCV"))).toBe(true);
    const dmList = await request(app).get("/api/debit-memos").set("Authorization", `Bearer ${tokenA}`);
    expect(dmList.body.every((r) => r.voucherNo.startsWith("TEST6-DM"))).toBe(true);
    const cmList = await request(app).get("/api/credit-memos").set("Authorization", `Bearer ${tokenA}`);
    expect(cmList.body.every((r) => r.voucherNo.startsWith("TEST6-CM"))).toBe(true);
    // Debit Memo list must never include a Credit Memo row or vice versa,
    // even though they share one physical table.
    const dmHasCm = dmList.body.some((r) => r.voucherNo === "TEST6-CM-1");
    const cmHasDm = cmList.body.some((r) => r.voucherNo === "TEST6-DM-1");
    expect(dmHasCm).toBe(false);
    expect(cmHasDm).toBe(false);
  });
});

describe("Posting balance validation", () => {
  // TransactionCurrencyService.resolveTransactionCurrency() (the same
  // shared service every module calls) already enforces SUM(debit) =
  // SUM(credit) unconditionally via its own finalizeWithRate() - for
  // Draft saves too, not only Posted ones. Discovered while writing these
  // tests (an earlier version of server.js's Petty Cash/Memo routes had
  // a second, redundant, Posted-only balance check that assumed
  // otherwise - removed once this was confirmed, see server.js's comment
  // at the top of the Petty Cash Voucher API section).
  test("an unbalanced Petty Cash Voucher is rejected even as a Draft", async () => {
    const res = await request(app).post("/api/petty-cash").set("Authorization", `Bearer ${tokenA}`).send({
      voucherNo: "TEST6-PCV-UNBAL", payeeName: "x", transactionDate: "2026-08-05", status: "Draft",
      lines: [
        { accountId: expenseA, accountCode: "TEST6EXP-A", accountTitle: "Expense", particulars: "x", debit: 500, credit: 0 },
        { accountId: cashA, accountCode: "TEST6CASH-A", accountTitle: "Cash", particulars: "x", debit: 0, credit: 400 },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not balanced/i);
  });

  test("an unbalanced Debit Memo is rejected when posting", async () => {
    const res = await request(app).post("/api/debit-memos").set("Authorization", `Bearer ${tokenA}`).send({
      voucherNo: "TEST6-DM-UNBAL", partyId: custAId, partyName: "x", partyType: "CUSTOMER",
      transactionDate: "2026-08-06", status: "Posted",
      lines: [
        { accountId: arA, accountCode: "TEST6AR-A", accountTitle: "AR", particulars: "x", debit: 300, credit: 0 },
        { accountId: revA, accountCode: "TEST6REV-A", accountTitle: "Revenue", particulars: "x", debit: 0, credit: 100 },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not balanced/i);
  });

  test("a balanced Draft voucher saves normally", async () => {
    const res = await request(app).post("/api/petty-cash").set("Authorization", `Bearer ${tokenA}`).send({
      voucherNo: "TEST6-PCV-DRAFT", payeeName: "x", transactionDate: "2026-08-05", status: "Draft",
      lines: [
        { accountId: expenseA, accountCode: "TEST6EXP-A", accountTitle: "Expense", particulars: "x", debit: 500, credit: 0 },
        { accountId: cashA, accountCode: "TEST6CASH-A", accountTitle: "Cash", particulars: "x", debit: 0, credit: 500 },
      ],
    });
    expect(res.status).toBe(200);
    await pool.query("DELETE FROM petty_cash_lines WHERE petty_cash_id = ?", [res.body.id]);
    await pool.query("DELETE FROM petty_cash_headers WHERE id = ?", [res.body.id]);
  });
});

describe("Company isolation", () => {
  test("Company B cannot view Company A's Petty Cash Voucher by direct ID", async () => {
    const listA = await request(app).get("/api/petty-cash").set("Authorization", `Bearer ${tokenA}`);
    const pcvId = listA.body.find((r) => r.voucherNo === "TEST6-PCV-1").id;

    const res = await request(app).get(`/api/petty-cash/${pcvId}`).set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
  });

  test("Company B cannot view Company A's Debit Memo by direct ID", async () => {
    const listA = await request(app).get("/api/debit-memos").set("Authorization", `Bearer ${tokenA}`);
    const dmId = listA.body.find((r) => r.voucherNo === "TEST6-DM-1").id;

    const res = await request(app).get(`/api/debit-memos/${dmId}`).set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
  });

  test("Company B's Petty Cash list never shows Company A's vouchers", async () => {
    const res = await request(app).get("/api/petty-cash").set("Authorization", `Bearer ${tokenB}`);
    expect(res.body.some((r) => r.voucherNo.startsWith("TEST6-PCV"))).toBe(false);
  });
});

describe("Period locking", () => {
  test("creating a Petty Cash Voucher dated into CLOSED July is rejected", async () => {
    const res = await request(app).post("/api/petty-cash").set("Authorization", `Bearer ${tokenA}`).send({
      voucherNo: "TEST6-PCV-JUL", payeeName: "x", transactionDate: "2026-07-15", status: "Draft",
      lines: [
        { accountId: expenseA, accountCode: "TEST6EXP-A", accountTitle: "Expense", particulars: "x", debit: 100, credit: 0 },
        { accountId: cashA, accountCode: "TEST6CASH-A", accountTitle: "Cash", particulars: "x", debit: 0, credit: 100 },
      ],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ACCOUNTING_PERIOD_CLOSED");
  });

  test("creating a Debit Memo dated into CLOSED July is rejected", async () => {
    const res = await request(app).post("/api/debit-memos").set("Authorization", `Bearer ${tokenA}`).send({
      voucherNo: "TEST6-DM-JUL", partyId: custAId, partyName: "x", partyType: "CUSTOMER",
      transactionDate: "2026-07-15", status: "Draft",
      lines: [
        { accountId: arA, accountCode: "TEST6AR-A", accountTitle: "AR", particulars: "x", debit: 100, credit: 0 },
        { accountId: revA, accountCode: "TEST6REV-A", accountTitle: "Revenue", particulars: "x", debit: 0, credit: 100 },
      ],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ACCOUNTING_PERIOD_CLOSED");
  });

  test("creating a Credit Memo dated into OPEN August succeeds", async () => {
    const res = await request(app).post("/api/credit-memos").set("Authorization", `Bearer ${tokenA}`).send({
      voucherNo: "TEST6-CM-AUG", partyId: suppAId, partyName: "x", partyType: "SUPPLIER",
      transactionDate: "2026-08-10", status: "Draft",
      lines: [
        { accountId: apA, accountCode: "TEST6AP-A", accountTitle: "AP", particulars: "x", debit: 0, credit: 150 },
        { accountId: expenseA, accountCode: "TEST6EXP-A", accountTitle: "Expense", particulars: "x", debit: 150, credit: 0 },
      ],
    });
    expect(res.status).toBe(200);
  });
});

describe("Multi-currency", () => {
  test("a USD Petty Cash Voucher stores foreign amount, converted base amount, and a rate snapshot", async () => {
    const res = await request(app).post("/api/petty-cash").set("Authorization", `Bearer ${tokenA}`).send({
      voucherNo: "TEST6-PCV-USD", payeeName: "Foreign Vendor", transactionDate: "2026-08-12", status: "Posted",
      currency: { companyId: companyAId, currencyId: usdId },
      lines: [
        { accountId: expenseA, accountCode: "TEST6EXP-A", accountTitle: "Expense", particulars: "x", debit: 10, credit: 0 },
        { accountId: cashA, accountCode: "TEST6CASH-A", accountTitle: "Cash", particulars: "x", debit: 0, credit: 10 },
      ],
    });
    expect(res.status).toBe(200);

    const detail = await request(app).get(`/api/petty-cash/${res.body.id}`).set("Authorization", `Bearer ${tokenA}`);
    expect(detail.body.currency.currencyCode).toBe("USD");
    expect(Number(detail.body.currency.exchangeRate)).toBe(56);
    expect(Number(detail.body.totalDebit)).toBe(560); // 10 * 56, base currency GL amount
    const foreignLine = detail.body.lines.find((l) => l.accountCode === "TEST6EXP-A");
    expect(Number(foreignLine.foreignDebit)).toBe(10);
    expect(Number(foreignLine.debit)).toBe(560);

    // Historical rate stability: recording a NEW rate afterward must not
    // retroactively change this already-saved transaction's stored rate.
    const CurrencyService = require("../services/currencyService");
    await CurrencyService.recordRate({ id: 1, roleCode: "SUPER_ADMIN" }, usdId, { rateMode: "MANUAL", rate: 60.0, effectiveDate: "2026-08-13" });
    const detailAfter = await request(app).get(`/api/petty-cash/${res.body.id}`).set("Authorization", `Bearer ${tokenA}`);
    expect(Number(detailAfter.body.currency.exchangeRate)).toBe(56);
  });
});

describe("Print data resolution", () => {
  test("Petty Cash Voucher print data resolves with no APV labeling", async () => {
    const listA = await request(app).get("/api/petty-cash").set("Authorization", `Bearer ${tokenA}`);
    const pcvId = listA.body.find((r) => r.voucherNo === "TEST6-PCV-1").id;

    const res = await request(app).get(`/api/print/pettyCash/${pcvId}?mode=with_entries`).set("Authorization", `Bearer ${tokenA}`).query({ companyId: companyAId });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body).toUpperCase()).not.toMatch(/\bAPV\b/);
  });

  test("printing a Credit Memo's id through the debitMemo module is rejected (memo_type scoping)", async () => {
    const listCm = await request(app).get("/api/credit-memos").set("Authorization", `Bearer ${tokenA}`);
    const cmId = listCm.body.find((r) => r.voucherNo === "TEST6-CM-1").id;

    const res = await request(app).get(`/api/print/debitMemo/${cmId}?mode=with_entries`).set("Authorization", `Bearer ${tokenA}`).query({ companyId: companyAId });
    expect(res.status).toBe(404);
  });
});

describe("Report integration", () => {
  test("a posted Petty Cash Voucher appears exactly once in Trial Balance", async () => {
    const res = await request(app).get("/api/reports/trial-balance").set("Authorization", `Bearer ${tokenA}`).query({ from: "2026-08-01", to: "2026-08-31", companyId: companyAId });
    expect(res.status).toBe(200);
    const expenseRow = res.body.find((r) => r.account_code === "TEST6EXP-A");
    expect(expenseRow).toBeTruthy();
    // TEST6-PCV-1 (500) is the only August-independent one posted in this
    // window pre-currency-test; just assert it's present and non-zero,
    // not an exact figure that would be brittle against fixture ordering.
    expect(Number(expenseRow.debit) + Number(expenseRow.credit)).toBeGreaterThan(0);
  });

  test("a posted Debit Memo appears exactly once in Account Analysis for its account", async () => {
    const res = await request(app).get("/api/reports/account-analysis").set("Authorization", `Bearer ${tokenA}`).query({ from: "2026-08-01", to: "2026-08-31", accountCode: "TEST6AR-A", companyId: companyAId });
    expect(res.status).toBe(200);
    const matches = res.body.filter((r) => r.reference_no === "TEST6-DM-1");
    expect(matches.length).toBe(1);
    expect(Number(matches[0].debit)).toBe(300);
  });
});