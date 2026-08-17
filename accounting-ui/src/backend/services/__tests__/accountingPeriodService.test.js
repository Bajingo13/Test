const pool = require("../../db");
const PeriodService = require("../accountingPeriodService");

// Checkpoint 5 - central lock service tests. Real DB integration tests
// (same convention as currencyService.test.js) against two throwaway
// companies, cleaned up in afterAll.

jest.setTimeout(30000);

let companyA, companyB;
let adminUserA, adminUserB, unauthorizedAdminA, superAdminUser;
const createdUserIds = [];
const createdPeriodIds = [];

async function makeCompany(name) {
  const [result] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [name]);
  return result.insertId;
}

async function makeUser(username, roleId) {
  const [result] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, 'test-hash-not-used-for-login', ?, 'ACTIVE')",
    [username, roleId]
  );
  createdUserIds.push(result.insertId);
  return result.insertId;
}

async function makePeriod(companyId, year, month, status, extra = {}) {
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const end = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  const [result] = await pool.execute(
    `INSERT INTO accounting_periods (company_id, year, period_month, start_date, end_date, status, closed_by, soft_closed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [companyId, year, month, start, end, status, extra.closedBy || null, extra.softClosedBy || null]
  );
  createdPeriodIds.push(result.insertId);
  return result.insertId;
}

beforeAll(async () => {
  companyA = await makeCompany("TEST CO A - Period Lock");
  companyB = await makeCompany("TEST CO B - Period Lock");

  const adminAId = await makeUser("test_period_admin_a", 2);
  const adminBId = await makeUser("test_period_admin_b", 2);
  const unauthAId = await makeUser("test_period_unauth_a", 2);
  const superId = await makeUser("test_period_super", 1);

  adminUserA = { id: adminAId, username: "test_period_admin_a", roleCode: "ADMIN" };
  adminUserB = { id: adminBId, username: "test_period_admin_b", roleCode: "ADMIN" };
  unauthorizedAdminA = { id: unauthAId, username: "test_period_unauth_a", roleCode: "ADMIN" };
  superAdminUser = { id: superId, username: "test_period_super", roleCode: "SUPER_ADMIN" };

  // Deny POST_SOFT_CLOSED specifically for unauthorizedAdminA, overriding
  // ADMIN's default grant - the same user_permissions override mechanism
  // Access Restrictions uses.
  const [[perm]] = await pool.query(
    "SELECT id FROM permissions WHERE module_key = 'ACCOUNTING_PERIODS' AND action = 'POST_SOFT_CLOSED'"
  );
  await pool.execute(
    "INSERT INTO user_permissions (user_id, permission_id, granted) VALUES (?, ?, 0)",
    [unauthAId, perm.id]
  );
});

afterAll(async () => {
  await pool.query("DELETE FROM accounting_period_history WHERE company_id IN (?,?)", [companyA, companyB]);
  await pool.query("DELETE FROM accounting_periods WHERE company_id IN (?,?)", [companyA, companyB]);
  await pool.query("DELETE FROM user_permissions WHERE user_id IN (?)", [createdUserIds]);
  await pool.query("DELETE FROM users WHERE id IN (?)", [createdUserIds]);
  await pool.query("DELETE FROM companies WHERE id IN (?,?)", [companyA, companyB]);
  await pool.end();
});

describe("assertPeriodOpen", () => {
  test("company with no periods at all is NOT_MANAGED and always passes", async () => {
    const result = await PeriodService.assertPeriodOpen({
      companyId: companyB, transactionDate: "2026-08-15", operation: "CREATE", user: adminUserB,
    });
    expect(result.status).toBe("NOT_MANAGED");
  });

  test("OPEN period passes for CREATE/EDIT/DELETE/POST", async () => {
    await makePeriod(companyA, 2026, 8, "OPEN");
    for (const operation of ["CREATE", "EDIT", "DELETE", "POST"]) {
      const result = await PeriodService.assertPeriodOpen({
        companyId: companyA, transactionDate: "2026-08-15", operation, user: adminUserA,
      });
      expect(result.status).toBe("OPEN");
    }
  });

  test("date boundaries: first and last day of month resolve to that period", async () => {
    const first = await PeriodService.assertPeriodOpen({ companyId: companyA, transactionDate: "2026-08-01", operation: "CREATE", user: adminUserA });
    const last = await PeriodService.assertPeriodOpen({ companyId: companyA, transactionDate: "2026-08-31", operation: "CREATE", user: adminUserA });
    expect(first.status).toBe("OPEN");
    expect(last.status).toBe("OPEN");
  });

  test("CLOSED period rejects every operation, including for SUPER_ADMIN (no silent bypass)", async () => {
    await makePeriod(companyA, 2026, 7, "CLOSED", { closedBy: adminUserA.id });
    for (const operation of ["CREATE", "EDIT", "DELETE", "POST", "BULK_POST", "IMPORT", "GENERATE", "REVERSE"]) {
      await expect(
        PeriodService.assertPeriodOpen({ companyId: companyA, transactionDate: "2026-07-15", operation, user: adminUserA })
      ).rejects.toMatchObject({ statusCode: 409, code: "ACCOUNTING_PERIOD_CLOSED" });

      await expect(
        PeriodService.assertPeriodOpen({ companyId: companyA, transactionDate: "2026-07-15", operation, user: superAdminUser })
      ).rejects.toMatchObject({ statusCode: 409, code: "ACCOUNTING_PERIOD_CLOSED" });
    }
  });

  test("SOFT_CLOSED period: CREATE passes for anyone, other operations require POST_SOFT_CLOSED permission", async () => {
    await makePeriod(companyA, 2026, 6, "SOFT_CLOSED", { softClosedBy: adminUserA.id });

    const createResult = await PeriodService.assertPeriodOpen({
      companyId: companyA, transactionDate: "2026-06-15", operation: "CREATE", user: unauthorizedAdminA,
    });
    expect(createResult.status).toBe("SOFT_CLOSED");

    const authorizedResult = await PeriodService.assertPeriodOpen({
      companyId: companyA, transactionDate: "2026-06-15", operation: "EDIT", user: adminUserA,
    });
    expect(authorizedResult.status).toBe("SOFT_CLOSED_AUTHORIZED");

    await expect(
      PeriodService.assertPeriodOpen({ companyId: companyA, transactionDate: "2026-06-15", operation: "EDIT", user: unauthorizedAdminA })
    ).rejects.toMatchObject({ statusCode: 409, code: "ACCOUNTING_PERIOD_SOFT_CLOSED" });

    await expect(
      PeriodService.assertPeriodOpen({ companyId: companyA, transactionDate: "2026-06-15", operation: "EDIT", user: null })
    ).rejects.toMatchObject({ statusCode: 409, code: "ACCOUNTING_PERIOD_SOFT_CLOSED" });
  });

  test("gap month (company IS period-managed but this month was never generated): CREATE passes, POST is blocked", async () => {
    const createResult = await PeriodService.assertPeriodOpen({
      companyId: companyA, transactionDate: "2026-05-15", operation: "CREATE", user: adminUserA,
    });
    expect(createResult.status).toBe("NOT_CONFIGURED");

    await expect(
      PeriodService.assertPeriodOpen({ companyId: companyA, transactionDate: "2026-05-15", operation: "POST", user: adminUserA })
    ).rejects.toMatchObject({ statusCode: 409, code: "ACCOUNTING_PERIOD_NOT_CONFIGURED" });
  });

  test("company isolation: Company A CLOSED does not affect Company B's same month", async () => {
    await makePeriod(companyB, 2026, 7, "OPEN");
    const resultB = await PeriodService.assertPeriodOpen({
      companyId: companyB, transactionDate: "2026-07-15", operation: "POST", user: adminUserB,
    });
    expect(resultB.status).toBe("OPEN");
  });
});

describe("period lifecycle transitions", () => {
  let periodId;

  test("generateYearPeriods creates 12 periods, idempotent on re-run", async () => {
    const first = await PeriodService.generateYearPeriods({ companyId: companyB, year: 2027, user: adminUserB });
    expect(first.createdCount).toBe(12);
    const second = await PeriodService.generateYearPeriods({ companyId: companyB, year: 2027, user: adminUserB });
    expect(second.createdCount).toBe(0);
    expect(second.skippedCount).toBe(12);
    const periods = await PeriodService.listPeriods({ companyId: companyB, year: 2027 });
    expect(periods.length).toBe(12);
    periodId = periods.find((p) => p.period_month === 3).id;
    createdPeriodIds.push(...periods.map((p) => p.id));
  });

  test("close requires reason-free notes but reopen requires a reason", async () => {
    const closed = await PeriodService.closePeriod({ periodId, companyId: companyB, user: adminUserB, notes: "month-end close" });
    expect(closed.status).toBe("CLOSED");

    await expect(
      PeriodService.reopenPeriod({ periodId, companyId: companyB, user: adminUserB, reason: "" })
    ).rejects.toMatchObject({ statusCode: 400, code: "REOPEN_REASON_REQUIRED" });

    const reopened = await PeriodService.reopenPeriod({ periodId, companyId: companyB, user: adminUserB, reason: "correcting a posting error" });
    expect(reopened.status).toBe("OPEN");

    const history = await PeriodService.getHistory({ companyId: companyB, periodId });
    expect(history.map((h) => h.action)).toEqual(expect.arrayContaining(["GENERATED", "CLOSED", "REOPENED"]));
  });

  test("invalid transition is rejected (cannot re-close an already-CLOSED period via softClose)", async () => {
    await PeriodService.closePeriod({ periodId, companyId: companyB, user: adminUserB, notes: "re-closing" });
    await expect(
      PeriodService.softClosePeriod({ periodId, companyId: companyB, user: adminUserB, notes: "x" })
    ).rejects.toMatchObject({ statusCode: 409, code: "INVALID_PERIOD_TRANSITION" });
    await PeriodService.reopenPeriod({ periodId, companyId: companyB, user: adminUserB, reason: "cleanup" });
  });
});