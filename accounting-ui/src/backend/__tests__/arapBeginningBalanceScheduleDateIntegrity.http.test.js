const fs = require("fs");
const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Phase 10: AR/AP Beginning Balance schedule_date integrity fix. PUT
// /api/arap-beginning-balances previously fell back to NULL for
// arap_payment_schedules.schedule_date (a NOT NULL column) when the
// request supplied neither line.scheduleDate nor line.dueDate, producing
// an uncaught 500 and a full rollback. The fix: when both are omitted, the
// schedule row's own EXISTING schedule_date (read via a LEFT JOIN on the
// route's existing ownership-check query) is preserved instead - never
// NULL, and never silently replaced with balanceDate. CREATE, the Phase 8
// balance_amount computation, the Phase 3 EDIT audit event, and the
// existing transaction/locking boundaries are all unchanged.

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

async function createBB(token, { balanceType, balanceDate, partyId, accountCode, accountId, debit, credit, referenceNo, dueDate }) {
  const res = await request(app).post("/api/arap-beginning-balances").set(auth(token)).send({
    balanceType, balanceDate, currencyCode: "PHP", currencyName: "Philippine Peso", remarks: "x",
    line: { partyId, partyCode: accountCode, partyName: "TestSD Party", accountId, accountCode, accountTitle: accountCode, debit, credit, referenceNo: referenceNo || "", dueDate },
  });
  expect(res.status).toBe(200);
  const [[row]] = await pool.query(
    "SELECT l.id FROM arap_beginning_balance_lines l JOIN arap_beginning_balance_headers h ON h.id = l.header_id WHERE h.balance_type=? AND l.reference_no=? ORDER BY l.id DESC LIMIT 1",
    [balanceType, referenceNo || ""]
  );
  return row.id;
}

async function scheduleRow(lineId) {
  const [[row]] = await pool.query(
    "SELECT DATE_FORMAT(schedule_date, '%Y-%m-%d') AS scheduleDate, amount, balance_amount AS balanceAmount FROM arap_payment_schedules WHERE beginning_balance_line_id = ?",
    [lineId]
  );
  return row;
}
async function lineRow(lineId) {
  const [[row]] = await pool.query(
    "SELECT debit, credit, paid_amount AS paidAmount, balance_amount AS balanceAmount, party_name AS partyName FROM arap_beginning_balance_lines WHERE id = ?",
    [lineId]
  );
  return row;
}

beforeAll(async () => {
  assertNotProductionDatabase();

  companyAId = await makeCompany("TESTSD Company A");
  companyBId = await makeCompany("TESTSD Company B");

  userAId = await makeUser("testsd_a", "TestSdPass!A1", 2, companyAId);
  userBId = await makeUser("testsd_b", "TestSdPass!B1", 2, companyBId);
  await grantAuditLogsView(userAId);
  await grantAuditLogsView(userBId);

  tokenA = await loginAs("testsd_a", "TestSdPass!A1");
  tokenB = await loginAs("testsd_b", "TestSdPass!B1");

  arA = await makeAccount("TESTSD-AR", "TestSD Accounts Receivable", "ASSET");
  apA = await makeAccount("TESTSD-AP", "TestSD Accounts Payable/Cash", "LIABILITY");
  custAId = await makeParty("TESTSD-CUST", "CUSTOMER", "TestSD Customer", companyAId);
  suppAId = await makeParty("TESTSD-SUPP", "SUPPLIER", "TestSD Supplier", companyAId);

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
  await pool.query("DELETE FROM general_libraries WHERE code IN ('TESTSD-CUST','TESTSD-SUPP')");
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'TESTSD-%'");
  await pool.query("DELETE FROM user_permissions WHERE user_id IN (?, ?)", [userAId, userBId]);
  await pool.query("DELETE FROM user_companies WHERE user_id IN (?, ?)", [userAId, userBId]);
  await pool.query("DELETE FROM users WHERE id IN (?, ?)", [userAId, userBId]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [companyAId, companyBId]);
  await pool.end();
});

describe("Schedule-date preservation on omission (1)", () => {
  test("1. existing schedule date is preserved when scheduleDate and dueDate are both omitted", async () => {
    const lineId = await createBB(tokenA, { balanceType: "AR", balanceDate: "2026-09-01", partyId: custAId, accountId: arA, accountCode: "TESTSD-AR", debit: 1000, credit: 0, referenceNo: "SD-1", dueDate: "2026-10-15" });
    const before = await scheduleRow(lineId);
    expect(before.scheduleDate).toBe("2026-10-15");

    const res = await request(app).put("/api/arap-beginning-balances").set(auth(tokenA)).send({
      line: { id: lineId, partyId: custAId, partyName: "TestSD Party Renamed", accountId: arA, accountCode: "TESTSD-AR", accountTitle: "AR", debit: 1000, credit: 0, referenceNo: "SD-1", balanceAmount: 1000 },
      // Deliberately no scheduleDate, no dueDate.
    });
    expect(res.status).toBe(200);

    const after = await scheduleRow(lineId);
    expect(after.scheduleDate).toBe("2026-10-15"); // preserved, not NULL, not balanceDate (2026-09-01)
    expect(after.scheduleDate).not.toBe("2026-09-01");
  });
});

describe("Explicit values are used correctly (2, 3, 4)", () => {
  test("2. scheduleDate supplied -> scheduleDate is used", async () => {
    const lineId = await createBB(tokenA, { balanceType: "AR", balanceDate: "2026-09-01", partyId: custAId, accountId: arA, accountCode: "TESTSD-AR", debit: 1000, credit: 0, referenceNo: "SD-2", dueDate: "2026-10-01" });
    const res = await request(app).put("/api/arap-beginning-balances").set(auth(tokenA)).send({
      line: { id: lineId, partyId: custAId, partyName: "TestSD Party", accountId: arA, accountCode: "TESTSD-AR", accountTitle: "AR", debit: 1000, credit: 0, referenceNo: "SD-2", scheduleDate: "2026-11-20", balanceAmount: 1000 },
    });
    expect(res.status).toBe(200);
    const after = await scheduleRow(lineId);
    expect(after.scheduleDate).toBe("2026-11-20");
  });

  test("3. dueDate supplied without scheduleDate -> dueDate is used", async () => {
    const lineId = await createBB(tokenA, { balanceType: "AR", balanceDate: "2026-09-01", partyId: custAId, accountId: arA, accountCode: "TESTSD-AR", debit: 1000, credit: 0, referenceNo: "SD-3", dueDate: "2026-10-01" });
    const res = await request(app).put("/api/arap-beginning-balances").set(auth(tokenA)).send({
      line: { id: lineId, partyId: custAId, partyName: "TestSD Party", accountId: arA, accountCode: "TESTSD-AR", accountTitle: "AR", debit: 1000, credit: 0, referenceNo: "SD-3", dueDate: "2026-12-05", balanceAmount: 1000 },
    });
    expect(res.status).toBe(200);
    const after = await scheduleRow(lineId);
    expect(after.scheduleDate).toBe("2026-12-05");
  });

  test("4. scheduleDate takes precedence over dueDate when both are supplied", async () => {
    const lineId = await createBB(tokenA, { balanceType: "AR", balanceDate: "2026-09-01", partyId: custAId, accountId: arA, accountCode: "TESTSD-AR", debit: 1000, credit: 0, referenceNo: "SD-4", dueDate: "2026-10-01" });
    const res = await request(app).put("/api/arap-beginning-balances").set(auth(tokenA)).send({
      line: { id: lineId, partyId: custAId, partyName: "TestSD Party", accountId: arA, accountCode: "TESTSD-AR", accountTitle: "AR", debit: 1000, credit: 0, referenceNo: "SD-4", scheduleDate: "2026-11-11", dueDate: "2026-12-31", balanceAmount: 1000 },
    });
    expect(res.status).toBe(200);
    const after = await scheduleRow(lineId);
    expect(after.scheduleDate).toBe("2026-11-11");
  });
});

describe("CREATE behavior remains unchanged (5)", () => {
  test("5. CREATE still falls back to dueDate/balanceDate as before", async () => {
    const lineId = await createBB(tokenA, { balanceType: "AP", balanceDate: "2026-09-07", partyId: suppAId, accountId: apA, accountCode: "TESTSD-AP", debit: 0, credit: 500, referenceNo: "SD-5" }); // no dueDate at all
    const row = await scheduleRow(lineId);
    expect(row.scheduleDate).toBe("2026-09-07"); // falls back to balanceDate, exactly as CREATE always did
  });
});

describe("Phase 8 balance_amount computation remains correct (6)", () => {
  test("6. balance_amount is still server-computed, unaffected by this fix", async () => {
    const lineId = await createBB(tokenA, { balanceType: "AR", balanceDate: "2026-09-01", partyId: custAId, accountId: arA, accountCode: "TESTSD-AR", debit: 800, credit: 0, referenceNo: "SD-6", dueDate: "2026-10-01" });
    const res = await request(app).put("/api/arap-beginning-balances").set(auth(tokenA)).send({
      line: { id: lineId, partyId: custAId, partyName: "TestSD Party", accountId: arA, accountCode: "TESTSD-AR", accountTitle: "AR", debit: 800, credit: 0, referenceNo: "SD-6", balanceAmount: 1 }, // deliberately wrong
    });
    expect(res.status).toBe(200);
    const row = await lineRow(lineId);
    expect(Number(row.balanceAmount)).toBe(800); // server-computed, ignores client value
    expect(Number(row.balanceAmount)).not.toBe(1);
  });
});

describe("Phase 3 EDIT audit event remains correct (7)", () => {
  test("7. EDIT audit event still records the authoritative post-update debit/credit", async () => {
    const lineId = await createBB(tokenA, { balanceType: "AR", balanceDate: "2026-09-01", partyId: custAId, accountId: arA, accountCode: "TESTSD-AR", debit: 1200, credit: 0, referenceNo: "SD-7", dueDate: "2026-10-01" });
    const res = await request(app).put("/api/arap-beginning-balances").set(auth(tokenA)).send({
      line: { id: lineId, partyId: custAId, partyName: "TestSD Audit Party", accountId: arA, accountCode: "TESTSD-AR", accountTitle: "AR", debit: 1500, credit: 0, referenceNo: "SD-7", balanceAmount: 1500 },
    });
    expect(res.status).toBe(200);
    const [rows] = await pool.query(
      "SELECT after_data AS afterData FROM audit_logs WHERE module='AR_BEGINNING' AND entity_id=? AND action='EDIT'",
      [lineId]
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].afterData.debit)).toBe(1500);
    expect(rows[0].afterData.partyName).toBe("TestSD Audit Party");
  });
});

describe("Company isolation remains intact (8)", () => {
  test("8. Company B cannot edit Company A's beginning balance line, or its schedule date", async () => {
    const lineId = await createBB(tokenA, { balanceType: "AR", balanceDate: "2026-09-01", partyId: custAId, accountId: arA, accountCode: "TESTSD-AR", debit: 200, credit: 0, referenceNo: "SD-8", dueDate: "2026-10-01" });
    const res = await request(app).put("/api/arap-beginning-balances").set(auth(tokenB)).send({
      line: { id: lineId, partyId: custAId, partyName: "Hacked", accountId: arA, accountCode: "TESTSD-AR", accountTitle: "AR", debit: 200, credit: 0, referenceNo: "SD-8", scheduleDate: "2099-01-01" },
    });
    expect(res.status).toBe(404);
    const row = await scheduleRow(lineId);
    expect(row.scheduleDate).toBe("2026-10-01"); // untouched
  });
});

describe("Nonexistent line still returns the existing error (9)", () => {
  test("9. editing a nonexistent beginning balance line returns 404, same as before", async () => {
    const res = await request(app).put("/api/arap-beginning-balances").set(auth(tokenA)).send({
      line: { id: 999999999, partyId: custAId, partyName: "Ghost", accountId: arA, accountCode: "TESTSD-AR", accountTitle: "AR", debit: 1, credit: 0 },
    });
    expect(res.status).toBe(404);
    expect(res.body.message).toBe("Beginning balance line not found");
  });
});

describe("Failed EDIT leaves schedule date untouched (10)", () => {
  test("10. a failed EDIT (closed period) does not modify the schedule date", async () => {
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
       VALUES (?, ?, 'TESTSD-AR', 'Original Name', ?, 'TESTSD-AR', 'AR', 700, 0, 700, 0, 0, 'Unpaid')`,
      [headerId, custAId, arA]
    );
    const lineId = lineResult.insertId;
    await pool.execute(
      `INSERT INTO arap_payment_schedules (beginning_balance_line_id, schedule_date, amount, paid_amount, balance_amount, status)
       VALUES (?, '2026-07-20', 700, 0, 700, 'Unpaid')`,
      [lineId]
    );

    const res = await request(app).put("/api/arap-beginning-balances").set(auth(tokenA)).send({
      line: { id: lineId, partyId: custAId, partyName: "Should Not Apply", accountId: arA, accountCode: "TESTSD-AR", accountTitle: "AR", debit: 999, credit: 0, scheduleDate: "2099-01-01" },
    });
    expect(res.status).toBe(409);

    const row = await scheduleRow(lineId);
    expect(row.scheduleDate).toBe("2026-07-20"); // untouched by the rolled-back transaction

    await pool.query("DELETE FROM arap_payment_schedules WHERE beginning_balance_line_id = ?", [lineId]);
    await pool.query("DELETE FROM arap_beginning_balance_lines WHERE id = ?", [lineId]);
    await pool.query("DELETE FROM arap_beginning_balance_headers WHERE id = ?", [headerId]);
    await pool.query("DELETE FROM accounting_periods WHERE id = ?", [periodResult.insertId]);
  });
});

describe("Existing payment/application behavior remains unchanged (11)", () => {
  test("11. an OR payment applied to an AR Beginning Balance line still works, and a subsequent field-only edit preserves both the payment and the schedule date", async () => {
    const lineId = await createBB(tokenA, { balanceType: "AR", balanceDate: "2026-09-01", partyId: custAId, accountId: arA, accountCode: "TESTSD-AR", debit: 1000, credit: 0, referenceNo: "SD-11", dueDate: "2026-10-01" });

    const orRes = await request(app).post("/api/or").set(auth(tokenA)).send({
      voucherNo: "TESTSD-OR-11", customerId: custAId, customerName: "TestSD Party",
      transactionDate: "2026-09-12", totalDebit: 400, totalCredit: 400, status: "Draft",
      lines: [
        { accountId: apA, accountCode: "TESTSD-CASH", accountTitle: "Cash", particulars: "x", debit: 400, credit: 0 },
        { accountId: arA, accountCode: "TESTSD-AR", accountTitle: "AR", particulars: "x", debit: 0, credit: 400 },
      ],
      invoiceApplications: [{ sourceType: "AR_BEGINNING", sourceId: lineId, amount: 400, applicationDate: "2026-09-12" }],
    });
    expect(orRes.status).toBe(200);

    const paidRow = await lineRow(lineId);
    expect(Number(paidRow.paidAmount)).toBe(400);
    expect(Number(paidRow.balanceAmount)).toBe(600);

    const editRes = await request(app).put("/api/arap-beginning-balances").set(auth(tokenA)).send({
      line: { id: lineId, partyId: custAId, partyName: "TestSD Party Renamed Again", accountId: arA, accountCode: "TESTSD-AR", accountTitle: "AR", debit: 1000, credit: 0, referenceNo: "SD-11", balanceAmount: 999999 },
    });
    expect(editRes.status).toBe(200);

    const afterLine = await lineRow(lineId);
    expect(Number(afterLine.paidAmount)).toBe(400); // payment untouched
    expect(Number(afterLine.balanceAmount)).toBe(600); // correctly re-derived

    const afterSchedule = await scheduleRow(lineId);
    expect(afterSchedule.scheduleDate).toBe("2026-10-01"); // preserved, not reset
  });
});

describe("Source guards - collaborator files untouched (12)", () => {
  test("paymentApplicationService.js / voidCancelService.js / JournalSuggestionService.js / BankReconController.js are unchanged", () => {
    const paymentSrc = fs.readFileSync(require.resolve("../services/paymentApplicationService.js"), "utf8");
    expect(paymentSrc).not.toContain("arap_payment_schedules");
    expect(paymentSrc).not.toContain("existingScheduleDate");

    const voidSrc = fs.readFileSync(require.resolve("../services/voidCancelService.js"), "utf8");
    expect(voidSrc).not.toContain("arap_payment_schedules");

    const journalSrc = fs.readFileSync(require.resolve("../services/JournalSuggestionService.js"), "utf8");
    expect(journalSrc).not.toContain("arap_payment_schedules");
    expect(journalSrc).toContain("async function postAdjustmentAsJV(conn, adjustmentId, user) {");

    const bankReconPath = require.resolve("../controllers/BankReconController.js");
    const bankReconSrc = fs.readFileSync(bankReconPath, "utf8");
    expect(bankReconSrc).not.toContain("existingScheduleDate");
  });
});
