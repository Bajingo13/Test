const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Phase 8: AR/AP Beginning Balance EDIT integrity fix. PUT
// /api/arap-beginning-balances previously trusted the client-supplied
// line.balanceAmount verbatim when writing arap_beginning_balance_lines.
// balance_amount, and read the line's existing paid_amount/foreign_paid_
// amount via a plain (non-locking) SELECT before the transaction even
// began - the same class of gap Phase 6 fixed for Invoice/APV DELETE, but
// here for a value the client could simply lie about, plus a real
// concurrency race against applyInvoicePayment()/applyApvPayment() (which
// already take FOR UPDATE on this exact row). The fix: balance_amount is
// now always recomputed server-side as
// GREATEST(<debit for AR | credit for AP> - paid_amount, 0) - the exact
// formula this route's own CREATE and the payment-application UPDATE
// already use - with paid_amount/foreign_paid_amount read fresh under a
// FOR UPDATE lock taken inside the existing (unmoved) transaction, before
// those values are used. No other behavior, transaction boundary, or
// audit shape was changed.

jest.setTimeout(180000);

let companyAId, companyBId;
let userAId, userBId;
let tokenA, tokenB;
let arA, apA;
let custAId, suppAId;

async function makeCompany(name) {
  const [r] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [name]);
  return r.insertId;
}
async function makeUser(username, password, roleId, companyId) {
  const hash = await bcrypt.hash(password, 10);
  const [r] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, ?, 'ACTIVE')",
    [username, hash, roleId]
  );
  if (companyId) await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [r.insertId, companyId]);
  return r.insertId;
}
async function makeAccount(code, title, accountClass) {
  const [r] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, accountClass]
  );
  return r.insertId;
}
async function makeParty(code, partyType, name, companyId) {
  const [r] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, ?, ?, ?, 'ACTIVE')",
    [companyId, code, partyType, name]
  );
  return r.insertId;
}
async function loginAs(username, password) {
  const res = await request(app).post("/api/login").send({ username, password });
  if (res.status !== 200) throw new Error(`Login failed for ${username}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token;
}
async function grantAuditLogsView(userId) {
  const [[perm]] = await pool.query("SELECT id FROM permissions WHERE module_key = 'ADMIN.AUDIT_LOGS' AND action = 'VIEW'");
  await pool.execute("INSERT INTO user_permissions (user_id, permission_id, granted) VALUES (?, ?, 1)", [userId, perm.id]);
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function createBB(token, { balanceType, balanceDate, partyId, accountCode, accountId, debit, credit, referenceNo }) {
  const res = await request(app).post("/api/arap-beginning-balances").set(auth(token)).send({
    balanceType, balanceDate, currencyCode: "PHP", currencyName: "Philippine Peso", remarks: "x",
    line: { partyId, partyCode: accountCode, partyName: "TestBI Party", accountId, accountCode, accountTitle: accountCode, debit, credit, referenceNo: referenceNo || "" },
  });
  expect(res.status).toBe(200);
  const [[row]] = await pool.query(
    "SELECT l.id FROM arap_beginning_balance_lines l JOIN arap_beginning_balance_headers h ON h.id = l.header_id WHERE h.balance_type=? AND l.reference_no=? ORDER BY l.id DESC LIMIT 1",
    [balanceType, referenceNo || ""]
  );
  return row.id;
}

async function applyOrToArBeginning(token, { lineId, amount, companyId }) {
  const res = await request(app).post("/api/or").set(auth(token)).send({
    voucherNo: `TESTBI-OR-${lineId}-${amount}`, customerId: custAId, customerName: "TestBI Party",
    transactionDate: "2026-09-12", totalDebit: amount, totalCredit: amount, status: "Draft",
    lines: [
      { accountId: apA, accountCode: "TESTBI-CASH", accountTitle: "Cash", particulars: "x", debit: amount, credit: 0 },
      { accountId: arA, accountCode: "TESTBI-AR", accountTitle: "AR", particulars: "x", debit: 0, credit: amount },
    ],
    invoiceApplications: [{ sourceType: "AR_BEGINNING", sourceId: lineId, amount, applicationDate: "2026-09-12" }],
  });
  expect(res.status).toBe(200);
  return res.body.id;
}

async function applyCvToApBeginning(token, { lineId, amount }) {
  const res = await request(app).post("/api/cv").set(auth(token)).send({
    voucherNo: `TESTBI-CV-${lineId}-${amount}`, payeeId: suppAId, payeeName: "TestBI Party",
    transactionDate: "2026-09-12", totalDebit: amount, totalCredit: amount, status: "Draft",
    lines: [
      { accountId: apA, accountCode: "TESTBI-AP", accountTitle: "AP", particulars: "x", debit: amount, credit: 0 },
      { accountId: arA, accountCode: "TESTBI-CASH2", accountTitle: "Cash", particulars: "x", debit: 0, credit: amount },
    ],
    apvApplications: [{ sourceType: "AP_BEGINNING", sourceId: lineId, amount, applicationDate: "2026-09-12" }],
  });
  expect(res.status).toBe(200);
  return res.body.id;
}

async function lineRow(lineId) {
  const [[row]] = await pool.query(
    "SELECT debit, credit, paid_amount AS paidAmount, balance_amount AS balanceAmount, foreign_paid_amount AS foreignPaidAmount, foreign_balance_amount AS foreignBalanceAmount FROM arap_beginning_balance_lines WHERE id = ?",
    [lineId]
  );
  return row;
}

beforeAll(async () => {
  assertNotProductionDatabase();

  companyAId = await makeCompany("TESTBI Company A");
  companyBId = await makeCompany("TESTBI Company B");

  userAId = await makeUser("testbi_a", "TestBiPass!A1", 2, companyAId);
  userBId = await makeUser("testbi_b", "TestBiPass!B1", 2, companyBId);
  await grantAuditLogsView(userAId);
  await grantAuditLogsView(userBId);

  tokenA = await loginAs("testbi_a", "TestBiPass!A1");
  tokenB = await loginAs("testbi_b", "TestBiPass!B1");

  arA = await makeAccount("TESTBI-AR", "TestBI Accounts Receivable", "ASSET");
  apA = await makeAccount("TESTBI-AP", "TestBI Accounts Payable/Cash", "LIABILITY");
  custAId = await makeParty("TESTBI-CUST", "CUSTOMER", "TestBI Customer", companyAId);
  suppAId = await makeParty("TESTBI-SUPP", "SUPPLIER", "TestBI Supplier", companyAId);

  const CurrencyService = require("../services/currencyService");
  await CurrencyService.createCurrency({ id: userAId, roleCode: "ADMIN" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: companyAId,
  });
  await CurrencyService.createCurrency({ id: userBId, roleCode: "ADMIN" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: companyBId,
  });
});

afterAll(async () => {
  for (const co of [companyAId, companyBId]) {
    await pool.query("DELETE FROM audit_logs WHERE company_id = ?", [co]);
    await pool.query(
      "DELETE ta FROM transaction_applications ta JOIN arap_beginning_balance_lines l ON l.id = ta.source_id AND ta.source_type IN ('AR_BEGINNING','AP_BEGINNING') JOIN arap_beginning_balance_headers h ON h.id = l.header_id WHERE h.company_id = ?",
      [co]
    );
    await pool.query("DELETE l FROM or_lines l JOIN or_headers h ON h.id = l.or_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM or_headers WHERE company_id = ?", [co]);
    await pool.query("DELETE l FROM cv_lines l JOIN cv_headers h ON h.id = l.cv_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM cv_headers WHERE company_id = ?", [co]);
    await pool.query(
      "DELETE ps FROM arap_payment_schedules ps JOIN arap_beginning_balance_lines l ON l.id = ps.beginning_balance_line_id JOIN arap_beginning_balance_headers h ON h.id = l.header_id WHERE h.company_id = ?",
      [co]
    );
    await pool.query("DELETE l FROM arap_beginning_balance_lines l JOIN arap_beginning_balance_headers h ON h.id = l.header_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM arap_beginning_balance_headers WHERE company_id = ?", [co]);
    await pool.query("DELETE FROM accounting_period_history WHERE company_id = ?", [co]);
    await pool.query("DELETE FROM accounting_periods WHERE company_id = ?", [co]);
    await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id = ?", [co]);
    await pool.query("DELETE FROM currencies WHERE company_id = ?", [co]);
  }
  await pool.query("DELETE FROM general_libraries WHERE code IN ('TESTBI-CUST','TESTBI-SUPP')");
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'TESTBI-%'");
  await pool.query("DELETE FROM user_permissions WHERE user_id IN (?, ?)", [userAId, userBId]);
  await pool.query("DELETE FROM user_companies WHERE user_id IN (?, ?)", [userAId, userBId]);
  await pool.query("DELETE FROM users WHERE id IN (?, ?)", [userAId, userBId]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [companyAId, companyBId]);
  await pool.end();
});

describe("Normal EDIT still succeeds (1, 2)", () => {
  test("1. AR Beginning Balance normal EDIT still succeeds", async () => {
    const lineId = await createBB(tokenA, { balanceType: "AR", balanceDate: "2026-09-01", partyId: custAId, accountId: arA, accountCode: "TESTBI-AR", debit: 1000, credit: 0, referenceNo: "BI-AR-1" });
    const res = await request(app).put("/api/arap-beginning-balances").set(auth(tokenA)).send({
      line: { id: lineId, partyId: custAId, partyName: "TestBI Party Updated", accountId: arA, accountCode: "TESTBI-AR", accountTitle: "AR", debit: 1000, credit: 0, referenceNo: "BI-AR-1", dueDate: "2026-09-01", balanceAmount: 1000 },
    });
    expect(res.status).toBe(200);
    const row = await lineRow(lineId);
    expect(Number(row.balanceAmount)).toBe(1000);
  });

  test("2. AP Beginning Balance normal EDIT still succeeds", async () => {
    const lineId = await createBB(tokenA, { balanceType: "AP", balanceDate: "2026-09-01", partyId: suppAId, accountId: apA, accountCode: "TESTBI-AP", debit: 0, credit: 800, referenceNo: "BI-AP-1" });
    const res = await request(app).put("/api/arap-beginning-balances").set(auth(tokenA)).send({
      line: { id: lineId, partyId: suppAId, partyName: "TestBI Party Updated", accountId: apA, accountCode: "TESTBI-AP", accountTitle: "AP", debit: 0, credit: 800, referenceNo: "BI-AP-1", dueDate: "2026-09-01", balanceAmount: 800 },
    });
    expect(res.status).toBe(200);
    const row = await lineRow(lineId);
    expect(Number(row.balanceAmount)).toBe(800);
  });
});

describe("Client cannot manipulate the derived balance (3, 4, 12)", () => {
  test("3/12. an intentionally incorrect balanceAmount is ignored; stored balance is the server-computed value", async () => {
    const lineId = await createBB(tokenA, { balanceType: "AR", balanceDate: "2026-09-01", partyId: custAId, accountId: arA, accountCode: "TESTBI-AR", debit: 1000, credit: 0, referenceNo: "BI-AR-3" });
    const res = await request(app).put("/api/arap-beginning-balances").set(auth(tokenA)).send({
      // No payment applied yet, so the authoritative balance is 1000 -
      // deliberately lie and submit 1 instead.
      line: { id: lineId, partyId: custAId, partyName: "TestBI Party", accountId: arA, accountCode: "TESTBI-AR", accountTitle: "AR", debit: 1000, credit: 0, referenceNo: "BI-AR-3", dueDate: "2026-09-01", balanceAmount: 1 },
    });
    expect(res.status).toBe(200);
    const row = await lineRow(lineId);
    expect(Number(row.balanceAmount)).not.toBe(1);
    expect(Number(row.balanceAmount)).toBe(1000);

    // A wildly large/negative arbitrary value is equally ignored.
    const res2 = await request(app).put("/api/arap-beginning-balances").set(auth(tokenA)).send({
      line: { id: lineId, partyId: custAId, partyName: "TestBI Party", accountId: arA, accountCode: "TESTBI-AR", accountTitle: "AR", debit: 1000, credit: 0, referenceNo: "BI-AR-3", dueDate: "2026-09-01", balanceAmount: -999999 },
    });
    expect(res2.status).toBe(200);
    const row2 = await lineRow(lineId);
    expect(Number(row2.balanceAmount)).toBe(1000);
  });

  test("4. an intentionally incorrect foreignBalanceAmount has no effect - it was never read from the client, before or after this fix", async () => {
    const lineId = await createBB(tokenA, { balanceType: "AR", balanceDate: "2026-09-01", partyId: custAId, accountId: arA, accountCode: "TESTBI-AR", debit: 500, credit: 0, referenceNo: "BI-AR-4" });
    const before = await lineRow(lineId);
    const res = await request(app).put("/api/arap-beginning-balances").set(auth(tokenA)).send({
      line: { id: lineId, partyId: custAId, partyName: "TestBI Party", accountId: arA, accountCode: "TESTBI-AR", accountTitle: "AR", debit: 500, credit: 0, referenceNo: "BI-AR-4", dueDate: "2026-09-01", foreignBalanceAmount: 777777 },
    });
    expect(res.status).toBe(200);
    const row = await lineRow(lineId);
    expect(Number(row.foreignBalanceAmount)).not.toBe(777777);
    // Base-currency line: foreign_balance_amount tracks the same
    // server-computed value as balance_amount (rate 1), exactly as before
    // this fix - unaffected by the submitted foreignBalanceAmount either way.
    expect(Number(row.foreignBalanceAmount)).toBe(Number(row.balanceAmount));
    void before;
  });
});

describe("EDIT preserves an existing payment's effect (5, 6)", () => {
  test("5. AR Beginning Balance with an existing OR application - EDIT preserves the correct paid/balance", async () => {
    const lineId = await createBB(tokenA, { balanceType: "AR", balanceDate: "2026-09-01", partyId: custAId, accountId: arA, accountCode: "TESTBI-AR", debit: 1000, credit: 0, referenceNo: "BI-AR-5" });
    await applyOrToArBeginning(tokenA, { lineId, amount: 400, companyId: companyAId });

    const paidRow = await lineRow(lineId);
    expect(Number(paidRow.paidAmount)).toBe(400);
    expect(Number(paidRow.balanceAmount)).toBe(600);

    // Edit the line (unrelated field change) while submitting a stale
    // balanceAmount that ignores the payment entirely.
    const res = await request(app).put("/api/arap-beginning-balances").set(auth(tokenA)).send({
      line: { id: lineId, partyId: custAId, partyName: "TestBI Party Renamed", accountId: arA, accountCode: "TESTBI-AR", accountTitle: "AR", debit: 1000, credit: 0, referenceNo: "BI-AR-5", dueDate: "2026-09-01", balanceAmount: 1000 },
    });
    expect(res.status).toBe(200);

    const after = await lineRow(lineId);
    expect(Number(after.paidAmount)).toBe(400); // payment effect not erased
    expect(Number(after.balanceAmount)).toBe(600); // correctly re-derived, not reset to 1000
  });

  test("6. AP Beginning Balance with an existing CV application - EDIT preserves the correct paid/balance", async () => {
    const lineId = await createBB(tokenA, { balanceType: "AP", balanceDate: "2026-09-01", partyId: suppAId, accountId: apA, accountCode: "TESTBI-AP", debit: 0, credit: 900, referenceNo: "BI-AP-6" });
    await applyCvToApBeginning(tokenA, { lineId, amount: 300 });

    const paidRow = await lineRow(lineId);
    expect(Number(paidRow.paidAmount)).toBe(300);
    expect(Number(paidRow.balanceAmount)).toBe(600);

    const res = await request(app).put("/api/arap-beginning-balances").set(auth(tokenA)).send({
      line: { id: lineId, partyId: suppAId, partyName: "TestBI Supplier Renamed", accountId: apA, accountCode: "TESTBI-AP", accountTitle: "AP", debit: 0, credit: 900, referenceNo: "BI-AP-6", dueDate: "2026-09-01", balanceAmount: 900 },
    });
    expect(res.status).toBe(200);

    const after = await lineRow(lineId);
    expect(Number(after.paidAmount)).toBe(300);
    expect(Number(after.balanceAmount)).toBe(600);
  });
});

describe("Company isolation still works (7)", () => {
  test("7. Company B cannot edit Company A's beginning balance line", async () => {
    const lineId = await createBB(tokenA, { balanceType: "AR", balanceDate: "2026-09-01", partyId: custAId, accountId: arA, accountCode: "TESTBI-AR", debit: 200, credit: 0, referenceNo: "BI-AR-7" });
    const res = await request(app).put("/api/arap-beginning-balances").set(auth(tokenB)).send({
      line: { id: lineId, partyId: custAId, partyName: "Hacked", accountId: arA, accountCode: "TESTBI-AR", accountTitle: "AR", debit: 200, credit: 0, referenceNo: "BI-AR-7", dueDate: "2026-09-01", balanceAmount: 1 },
    });
    expect(res.status).toBe(404);
    const row = await lineRow(lineId);
    expect(Number(row.debit)).toBe(200); // untouched
  });
});

describe("Period-lock behavior still works (8)", () => {
  test("8. a beginning balance line dated in a CLOSED period cannot be edited", async () => {
    const [periodResult] = await pool.execute(
      `INSERT INTO accounting_periods (company_id, year, period_month, start_date, end_date, status)
       VALUES (?, 2026, 7, '2026-07-01', '2026-07-31', 'CLOSED')`,
      [companyAId]
    );
    const [headerResult] = await pool.execute(
      `INSERT INTO arap_beginning_balance_headers (company_id, balance_type, balance_date, currency_code, currency_name, remarks, status)
       VALUES (?, 'AR', '2026-07-15', 'PHP', 'Philippine Peso', 'x', 'Posted')`,
      [companyAId]
    );
    const headerId = headerResult.insertId;
    const [lineResult] = await pool.execute(
      `INSERT INTO arap_beginning_balance_lines (header_id, party_id, party_code, party_name, account_id, account_code, account_title, debit, credit, balance_amount, paid_amount, status)
       VALUES (?, ?, 'TESTBI-AR', 'x', ?, 'TESTBI-AR', 'AR', 500, 0, 500, 0, 'Unpaid')`,
      [headerId, custAId, arA]
    );
    const lineId = lineResult.insertId;

    const res = await request(app).put("/api/arap-beginning-balances").set(auth(tokenA)).send({
      line: { id: lineId, partyId: custAId, accountId: arA, accountCode: "TESTBI-AR", accountTitle: "AR", debit: 750, credit: 0, dueDate: "2026-09-01", balanceAmount: 750 },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ACCOUNTING_PERIOD_CLOSED");

    const row = await lineRow(lineId);
    expect(Number(row.debit)).toBe(500); // untouched

    await pool.query("DELETE FROM arap_beginning_balance_lines WHERE id = ?", [lineId]);
    await pool.query("DELETE FROM arap_beginning_balance_headers WHERE id = ?", [headerId]);
    await pool.query("DELETE FROM accounting_periods WHERE id = ?", [periodResult.insertId]);
  });
});

describe("Existing EDIT audit event still works (9)", () => {
  test("9. EDIT audit event records the authoritative post-update debit/credit", async () => {
    const lineId = await createBB(tokenA, { balanceType: "AR", balanceDate: "2026-09-01", partyId: custAId, accountId: arA, accountCode: "TESTBI-AR", debit: 1200, credit: 0, referenceNo: "BI-AR-9" });
    const res = await request(app).put("/api/arap-beginning-balances").set(auth(tokenA)).send({
      line: { id: lineId, partyId: custAId, partyName: "TestBI Audit Party", accountId: arA, accountCode: "TESTBI-AR", accountTitle: "AR", debit: 1500, credit: 0, referenceNo: "BI-AR-9", dueDate: "2026-09-01", balanceAmount: 1 },
    });
    expect(res.status).toBe(200);

    const [rows] = await pool.query(
      "SELECT after_data AS afterData FROM audit_logs WHERE module='AR_BEGINNING' AND entity_id=? AND action='EDIT'",
      [lineId]
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].afterData.debit)).toBe(1500);
    expect(rows[0].afterData.partyName).toBe("TestBI Audit Party");
  });
});

describe("Rollback on failure leaves no partial changes (10)", () => {
  test("10. a failed EDIT (closed period) leaves the line completely untouched", async () => {
    const [periodResult] = await pool.execute(
      `INSERT INTO accounting_periods (company_id, year, period_month, start_date, end_date, status)
       VALUES (?, 2026, 6, '2026-06-01', '2026-06-30', 'CLOSED')`,
      [companyAId]
    );
    const [headerResult] = await pool.execute(
      `INSERT INTO arap_beginning_balance_headers (company_id, balance_type, balance_date, currency_code, currency_name, remarks, status)
       VALUES (?, 'AR', '2026-06-10', 'PHP', 'Philippine Peso', 'x', 'Posted')`,
      [companyAId]
    );
    const headerId = headerResult.insertId;
    const [lineResult] = await pool.execute(
      `INSERT INTO arap_beginning_balance_lines (header_id, party_id, party_code, party_name, account_id, account_code, account_title, debit, credit, balance_amount, paid_amount, foreign_paid_amount, status)
       VALUES (?, ?, 'TESTBI-AR', 'Original Name', ?, 'TESTBI-AR', 'AR', 700, 0, 700, 0, 0, 'Unpaid')`,
      [headerId, custAId, arA]
    );
    const lineId = lineResult.insertId;

    const before = await lineRow(lineId);
    const res = await request(app).put("/api/arap-beginning-balances").set(auth(tokenA)).send({
      line: { id: lineId, partyId: custAId, partyName: "Should Not Apply", accountId: arA, accountCode: "TESTBI-AR", accountTitle: "AR", debit: 999, credit: 0, dueDate: "2026-09-01", balanceAmount: 999 },
    });
    expect(res.status).toBe(409);

    const [[nameRow]] = await pool.query("SELECT party_name AS partyName FROM arap_beginning_balance_lines WHERE id = ?", [lineId]);
    expect(nameRow.partyName).toBe("Original Name");
    const after = await lineRow(lineId);
    expect(Number(after.debit)).toBe(Number(before.debit));
    expect(Number(after.balanceAmount)).toBe(Number(before.balanceAmount));

    await pool.query("DELETE FROM arap_beginning_balance_lines WHERE id = ?", [lineId]);
    await pool.query("DELETE FROM arap_beginning_balance_headers WHERE id = ?", [headerId]);
    await pool.query("DELETE FROM accounting_periods WHERE id = ?", [periodResult.insertId]);
  });
});

describe("Concurrency: EDIT locks the same row applyInvoicePayment()/applyApvPayment() lock (11)", () => {
  test("a manually held FOR UPDATE lock on the beginning-balance line genuinely blocks a concurrent EDIT until released", async () => {
    const lineId = await createBB(tokenA, { balanceType: "AR", balanceDate: "2026-09-01", partyId: custAId, accountId: arA, accountCode: "TESTBI-AR", debit: 1000, credit: 0, referenceNo: "BI-AR-11" });

    const lockConn = await pool.getConnection();
    try {
      await lockConn.beginTransaction();
      // The exact same lock applyInvoicePayment() takes on an AR_BEGINNING
      // line, and the exact same lock this route's EDIT now takes.
      await lockConn.execute(
        "SELECT paid_amount FROM arap_beginning_balance_lines WHERE id = ? FOR UPDATE",
        [lineId]
      );

      const editPromise = request(app).put("/api/arap-beginning-balances").set(auth(tokenA)).send({
        line: { id: lineId, partyId: custAId, partyName: "TestBI Party", accountId: arA, accountCode: "TESTBI-AR", accountTitle: "AR", debit: 1000, credit: 0, referenceNo: "BI-AR-11", dueDate: "2026-09-01", balanceAmount: 1 },
      });

      const raceCheck = await Promise.race([
        editPromise.then((r) => ({ settled: true, status: r.status })),
        new Promise((resolve) => setTimeout(() => resolve({ settled: false }), 700)),
      ]);
      expect(raceCheck.settled).toBe(false); // genuinely blocked, not just slow

      await lockConn.commit();

      const finalRes = await editPromise;
      expect(finalRes.status).toBe(200);
      const row = await lineRow(lineId);
      expect(Number(row.balanceAmount)).toBe(1000); // still correctly server-computed once unblocked
    } finally {
      lockConn.release();
    }
  });

  test("a real concurrent payment application and EDIT never leave an inconsistent balance", async () => {
    const ITERATIONS = 5;
    for (let i = 0; i < ITERATIONS; i++) {
      const lineId = await createBB(tokenA, { balanceType: "AR", balanceDate: "2026-09-01", partyId: custAId, accountId: arA, accountCode: "TESTBI-AR", debit: 1000, credit: 0, referenceNo: `BI-AR-RACE-${i}` });

      const [editRes, orRes] = await Promise.all([
        request(app).put("/api/arap-beginning-balances").set(auth(tokenA)).send({
          line: { id: lineId, partyId: custAId, partyName: `TestBI Race ${i}`, accountId: arA, accountCode: "TESTBI-AR", accountTitle: "AR", debit: 1000, credit: 0, referenceNo: `BI-AR-RACE-${i}`, dueDate: "2026-09-01", balanceAmount: 1 },
        }),
        request(app).post("/api/or").set(auth(tokenA)).send({
          voucherNo: `TESTBI-OR-RACE-${i}`, customerId: custAId, customerName: "TestBI Party",
          transactionDate: "2026-09-12", totalDebit: 400, totalCredit: 400, status: "Draft",
          lines: [
            { accountId: apA, accountCode: "TESTBI-CASH", accountTitle: "Cash", particulars: "x", debit: 400, credit: 0 },
            { accountId: arA, accountCode: "TESTBI-AR", accountTitle: "AR", particulars: "x", debit: 0, credit: 400 },
          ],
          invoiceApplications: [{ sourceType: "AR_BEGINNING", sourceId: lineId, amount: 400, applicationDate: "2026-09-12" }],
        }),
      ]);

      expect(editRes.status).toBe(200);

      const row = await lineRow(lineId);
      if (orRes.status === 200) {
        // The payment landed - self-consistency requires balance to
        // reflect it, in either possible ordering.
        expect(Number(row.paidAmount)).toBe(400);
        expect(Number(row.balanceAmount)).toBe(600);
      } else {
        expect(Number(row.paidAmount)).toBe(0);
        expect(Number(row.balanceAmount)).toBe(1000);
      }
      // The client's bogus balanceAmount: 1 must never win, regardless of ordering.
      expect(Number(row.balanceAmount)).not.toBe(1);
    }
  });
});
