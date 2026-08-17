const pool = require("../../db");
const CurrencyService = require("../currencyService");
const TemplateService = require("../recurringTemplateService");
const GenerationService = require("../recurringGenerationService");

// Checkpoint 3F: scheduler wiring, idempotency hardening (concurrent
// races, FAILED-occurrence retry, resume catch-up policy), and
// processDueSchedules (the batch entry point the scheduler/run-due
// endpoint call). Reuses Checkpoint 3D's proven currency-policy behavior
// unchanged (see recurringInvoiceCurrency.test.js) - this file covers the
// NEW 3F behaviors only, per "ONE SCHEDULED OCCURRENCE = EXACTLY ONE
// GENERATED TRANSACTION" being the most important requirement.

jest.setTimeout(60000);

let companyId, adminUser;
let arAccountId, revenueAccountId, testPartyId;
const createdUserIds = [];
const createdInvoiceIds = [];

async function makeCompany(name) {
  const [result] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [name]);
  return result.insertId;
}

async function makeUser(username, roleId) {
  const [result] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, 'test-hash-not-used-for-login', ?, 'ACTIVE')",
    [username, roleId]
  );
  const userId = result.insertId;
  createdUserIds.push(userId);
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, companyId]);
  return { id: userId, roleCode: "NON_SUPER" };
}

async function makeAccount(code, title, accountClass) {
  const [result] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, accountClass]
  );
  return result.insertId;
}

function templateLines() {
  return [
    { accountId: arAccountId, accountCode: "TEST3FRAR", accountTitle: "Accounts Receivable (Test)", particularsTemplate: "Recurring charge {{month_name}}", debit: 100, credit: 0 },
    { accountId: revenueAccountId, accountCode: "TEST3FRREV", accountTitle: "Service Revenue (Test)", particularsTemplate: "Recurring charge {{month_name}}", debit: 0, credit: 100 },
  ];
}

async function createRecurringTemplate({ startDate, endDate }) {
  return TemplateService.createTemplate(
    {
      moduleType: "invoice",
      templateName: `Test Recurring 3F ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      partyId: testPartyId,
      partyName: "Test Recurring Customer 3F",
      descriptionTemplate: "Recurring charge for {{month_name}} {{year}}",
      currency: "PHP",
      currencyId: null,
      amountMode: "FIXED",
      amountConfig: {},
      dueDateRule: { mode: "SAME_AS_TRANSACTION_DATE" },
      lines: templateLines(),
      schedule: { frequency: "MONTHLY", startDate, endDate: endDate || null, dateAdjustmentRule: "KEEP_ORIGINAL" },
    },
    adminUser.id,
    companyId
  );
}

async function setNextRunDate(scheduleId, date) {
  await pool.execute("UPDATE recurring_transaction_schedules SET next_run_date = ? WHERE id = ?", [date, scheduleId]);
}

async function forceAccountMissing(lineAccountId) {
  // Simulates a guaranteed generation failure (revalidateForGeneration
  // rejects a missing account) without touching currency/rate logic -
  // isolates the FAILED-occurrence retry test from rate-resolution
  // behavior already covered elsewhere.
  await pool.execute("DELETE FROM chart_of_accounts WHERE id = ?", [lineAccountId]);
}

beforeAll(async () => {
  const [orphanedUsers] = await pool.execute("SELECT id FROM users WHERE username = 'test_admin_3f_sched'");
  if (orphanedUsers.length) {
    const orphanedUserId = orphanedUsers[0].id;
    const [orphanedCompanies] = await pool.execute("SELECT company_id FROM user_companies WHERE user_id = ?", [orphanedUserId]);
    for (const { company_id: orphanedCompanyId } of orphanedCompanies) {
      await pool.execute(
        `DELETE o FROM recurring_transaction_occurrences o
         JOIN recurring_transaction_schedules s ON s.id = o.schedule_id
         JOIN recurring_transaction_templates t ON t.id = s.template_id
         WHERE t.company_id = ?`, [orphanedCompanyId]
      );
      await pool.execute(
        `DELETE s FROM recurring_transaction_schedules s
         JOIN recurring_transaction_templates t ON t.id = s.template_id
         WHERE t.company_id = ?`, [orphanedCompanyId]
      );
      await pool.execute(
        `DELETE l FROM recurring_transaction_template_lines l
         JOIN recurring_transaction_templates t ON t.id = l.template_id
         WHERE t.company_id = ?`, [orphanedCompanyId]
      );
      await pool.execute("DELETE FROM recurring_transaction_templates WHERE company_id = ?", [orphanedCompanyId]);
      await pool.execute("DELETE FROM transaction_currency_snapshots WHERE company_id = ?", [orphanedCompanyId]);
      await pool.execute("DELETE FROM currency_rates WHERE company_id = ?", [orphanedCompanyId]);
      await pool.execute("DELETE FROM currencies WHERE company_id = ?", [orphanedCompanyId]);
      await pool.execute("DELETE FROM user_companies WHERE company_id = ?", [orphanedCompanyId]);
      await pool.execute("DELETE FROM companies WHERE id = ?", [orphanedCompanyId]);
    }
    await pool.execute("DELETE FROM users WHERE id = ?", [orphanedUserId]);
  }
  await pool.execute("DELETE FROM chart_of_accounts WHERE code LIKE 'TEST3FR%'");
  await pool.execute("DELETE FROM general_libraries WHERE code = 'TEST3FRCUST'");

  companyId = await makeCompany("TEST CO - Checkpoint 3F Scheduler");
  adminUser = await makeUser("test_admin_3f_sched", 2);

  await CurrencyService.createCurrency(adminUser, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId,
  });

  arAccountId = await makeAccount("TEST3FRAR", "Accounts Receivable (Test)", "ASSET");
  revenueAccountId = await makeAccount("TEST3FRREV", "Service Revenue (Test)", "INCOME");

  const [partyResult] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, 'TEST3FRCUST', 'CUSTOMER', 'Test Recurring Customer 3F', 'ACTIVE')",
    [companyId]
  );
  testPartyId = partyResult.insertId;
});

afterAll(async () => {
  const [allTestInvoices] = await pool.execute("SELECT id FROM invoice_headers WHERE customer_id = ?", [testPartyId]);
  const allInvoiceIds = Array.from(new Set([...createdInvoiceIds, ...allTestInvoices.map((r) => r.id)]));
  if (allInvoiceIds.length) {
    await pool.query(`DELETE FROM invoice_lines WHERE invoice_id IN (?)`, [allInvoiceIds]);
    await pool.query(`DELETE FROM transaction_currency_snapshots WHERE transaction_type = 'INV' AND transaction_id IN (?)`, [allInvoiceIds]);
    await pool.query(`DELETE FROM invoice_headers WHERE id IN (?)`, [allInvoiceIds]);
  }
  await pool.execute(
    `DELETE o FROM recurring_transaction_occurrences o
     JOIN recurring_transaction_schedules s ON s.id = o.schedule_id
     JOIN recurring_transaction_templates t ON t.id = s.template_id
     WHERE t.template_name LIKE 'Test Recurring 3F %'`
  );
  await pool.execute(
    `DELETE s FROM recurring_transaction_schedules s
     JOIN recurring_transaction_templates t ON t.id = s.template_id
     WHERE t.template_name LIKE 'Test Recurring 3F %'`
  );
  await pool.execute(
    `DELETE l FROM recurring_transaction_template_lines l
     JOIN recurring_transaction_templates t ON t.id = l.template_id
     WHERE t.template_name LIKE 'Test Recurring 3F %'`
  );
  await pool.execute(`DELETE FROM recurring_transaction_templates WHERE template_name LIKE 'Test Recurring 3F %'`);
  await pool.execute("DELETE FROM chart_of_accounts WHERE code LIKE 'TEST3FR%'");
  if (testPartyId) await pool.execute("DELETE FROM general_libraries WHERE id = ?", [testPartyId]);
  await pool.execute("DELETE FROM transaction_currency_snapshots WHERE company_id = ?", [companyId]);
  await pool.execute("DELETE FROM currency_rates WHERE company_id = ?", [companyId]);
  await pool.execute("DELETE FROM currencies WHERE company_id = ?", [companyId]);
  if (createdUserIds.length) {
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [createdUserIds]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [createdUserIds]);
  }
  await pool.execute("DELETE FROM companies WHERE id = ?", [companyId]);
  await pool.end();
});

describe("Idempotency: concurrent workers cannot duplicate an occurrence", () => {
  test("Two simultaneous processSchedule calls for the SAME schedule never duplicate a single occurrence date", async () => {
    const { scheduleId } = await createRecurringTemplate({ startDate: "2026-02-01" });

    // Simulates Generate Now racing the scheduler, or two Railway
    // instances both picking up the same due schedule at once. Correct
    // behavior under FOR UPDATE row locking: the second call blocks until
    // the first commits, then re-reads the ALREADY-ADVANCED next_run_date
    // and generates the FOLLOWING occurrence - not a collision, but also
    // never a duplicate of the same date. What matters (and is asserted
    // below) is that EVERY occurrence_date that got generated has exactly
    // one occurrence row and exactly one invoice - never two.
    const [resultA, resultB] = await Promise.all([
      GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: adminUser.id }),
      GenerationService.processSchedule(scheduleId, { triggerType: "SCHEDULED" }),
    ]);

    expect(resultA.status).toBe("SUCCESS");
    expect(resultB.status).toBe("SUCCESS");
    expect(resultA.occurrenceDate).not.toBe(resultB.occurrenceDate); // sequential, not colliding
    expect(resultA.generatedId).not.toBe(resultB.generatedId);
    createdInvoiceIds.push(resultA.generatedId, resultB.generatedId);

    for (const date of [resultA.occurrenceDate, resultB.occurrenceDate]) {
      const [occCount] = await pool.execute(
        "SELECT COUNT(*) AS c FROM recurring_transaction_occurrences WHERE schedule_id = ? AND occurrence_date = ?",
        [scheduleId, date]
      );
      expect(occCount[0].c).toBe(1);
    }
  });

  test("The DB-level UNIQUE(schedule_id, occurrence_date) constraint itself rejects a raw duplicate insert", async () => {
    // Direct test of the backstop hardened in 3F (the ER_DUP_ENTRY catch
    // around the occurrence insert in processSchedule) - proves the
    // safety net exists at the database level independent of whether
    // FOR UPDATE locking manages to prevent the race further upstream.
    const { scheduleId } = await createRecurringTemplate({ startDate: "2026-02-15" });
    await pool.execute(
      `INSERT INTO recurring_transaction_occurrences (schedule_id, occurrence_date, generated_module_type, trigger_type, status, generated_by)
       VALUES (?, '2026-02-15', 'invoice', 'MANUAL', 'SUCCESS', ?)`,
      [scheduleId, adminUser.id]
    );
    await expect(
      pool.execute(
        `INSERT INTO recurring_transaction_occurrences (schedule_id, occurrence_date, generated_module_type, trigger_type, status, generated_by)
         VALUES (?, '2026-02-15', 'invoice', 'MANUAL', 'SUCCESS', ?)`,
        [scheduleId, adminUser.id]
      )
    ).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
  });

  test("Retry after a genuine failure reuses the SAME occurrence, never creates a second", async () => {
    const { scheduleId } = await createRecurringTemplate({ startDate: "2026-03-01" });

    // Force a real failure: delete the AR account the template's first
    // line references, so revalidateForGeneration rejects it.
    const acct = await makeAccount("TEST3FRTMP", "Temp Account (deleted below)", "ASSET");
    await pool.execute(
      "UPDATE recurring_transaction_template_lines SET account_id = ? WHERE template_id = (SELECT template_id FROM recurring_transaction_schedules WHERE id = ?) LIMIT 1",
      [acct, scheduleId]
    );
    await forceAccountMissing(acct);

    await expect(
      GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: adminUser.id })
    ).rejects.toMatchObject({ statusCode: 422 });

    const [failedRows] = await pool.execute(
      "SELECT id, status FROM recurring_transaction_occurrences WHERE schedule_id = ? AND occurrence_date = '2026-03-01'",
      [scheduleId]
    );
    expect(failedRows.length).toBe(1);
    expect(failedRows[0].status).toBe("FAILED");
    const failedOccurrenceId = failedRows[0].id;

    // Fix the root cause, then retry the SAME due occurrence.
    const goodAcct = await makeAccount("TEST3FRFIX", "Fixed Account (Test)", "ASSET");
    await pool.execute(
      "UPDATE recurring_transaction_template_lines SET account_id = ?, account_code = 'TEST3FRFIX' WHERE template_id = (SELECT template_id FROM recurring_transaction_schedules WHERE id = ?) LIMIT 1",
      [goodAcct, scheduleId]
    );

    const retried = await GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: adminUser.id });
    expect(retried.status).toBe("SUCCESS");
    createdInvoiceIds.push(retried.generatedId);

    // Exactly one occurrence row for that date - the FAILED placeholder
    // was replaced (deleted+reinserted), never left as a second row.
    const [finalRows] = await pool.execute(
      "SELECT id, status FROM recurring_transaction_occurrences WHERE schedule_id = ? AND occurrence_date = '2026-03-01'",
      [scheduleId]
    );
    expect(finalRows.length).toBe(1);
    expect(finalRows[0].status).toBe("SUCCESS");
    expect(finalRows[0].id).not.toBe(failedOccurrenceId); // replaced, not reused-in-place
  });

  test("Retry after a SUCCESS is rejected (ALREADY_GENERATED), never creates a second transaction", async () => {
    const { scheduleId } = await createRecurringTemplate({ startDate: "2026-04-01" });
    const first = await GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: adminUser.id });
    expect(first.status).toBe("SUCCESS");
    createdInvoiceIds.push(first.generatedId);

    await setNextRunDate(scheduleId, "2026-04-01"); // simulate a retry attempt at the same date
    const retry = await GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: adminUser.id });
    expect(retry.status).toBe("ALREADY_GENERATED");

    const [invCount] = await pool.execute("SELECT COUNT(*) AS c FROM invoice_headers WHERE customer_id = ? AND transaction_date = '2026-04-01'", [testPartyId]);
    expect(invCount[0].c).toBe(1);
  });
});

describe("processDueSchedules - the scheduler/run-due batch entry point", () => {
  test("Generates only due, active, unpaused schedules", async () => {
    const due = await createRecurringTemplate({ startDate: "2020-01-01" }); // clearly in the past = due now
    await setNextRunDate(due.scheduleId, "2020-01-01");

    const notDueYet = await createRecurringTemplate({ startDate: "2099-01-01" }); // far future = never due

    const pausedButDue = await createRecurringTemplate({ startDate: "2020-01-01" });
    await setNextRunDate(pausedButDue.scheduleId, "2020-01-01");
    await pool.execute("UPDATE recurring_transaction_schedules SET is_paused = 1 WHERE id = ?", [pausedButDue.scheduleId]);

    const result = await GenerationService.processDueSchedules({ triggerType: "SCHEDULED", limit: 100 });
    const dueResult = result.results.find((r) => r.scheduleId === due.scheduleId);
    expect(dueResult.status).toBe("SUCCESS");
    if (dueResult.generatedId) createdInvoiceIds.push(dueResult.generatedId);

    expect(result.results.find((r) => r.scheduleId === notDueYet.scheduleId)).toBeUndefined();
    expect(result.results.find((r) => r.scheduleId === pausedButDue.scheduleId)).toBeUndefined();
  });

  test("A paused schedule cannot be generated even via direct processSchedule (Generate Now)", async () => {
    const { scheduleId } = await createRecurringTemplate({ startDate: "2026-05-01" });
    await pool.execute("UPDATE recurring_transaction_schedules SET is_paused = 1 WHERE id = ?", [scheduleId]);

    await expect(
      GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: adminUser.id })
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("Resume catch-up policy (section 31)", () => {
  test("Resuming an overdue schedule with no policy chosen returns a decision request, does not resume", async () => {
    const { scheduleId } = await createRecurringTemplate({ startDate: "2020-01-01" });
    await setNextRunDate(scheduleId, "2020-01-01");
    await pool.execute("UPDATE recurring_transaction_schedules SET is_paused = 1 WHERE id = ?", [scheduleId]);

    const result = await TemplateService.resumeSchedule(scheduleId, { userId: adminUser.id });
    expect(result.requiresCatchUpDecision).toBe(true);
    expect(result.missedCount).toBeGreaterThan(0);

    const [row] = await pool.execute("SELECT is_paused FROM recurring_transaction_schedules WHERE id = ?", [scheduleId]);
    expect(!!row[0].is_paused).toBe(true); // still paused - no silent resume
  });

  test("SKIP_TO_NEXT records missed occurrences as SKIPPED and fast-forwards without generating anything", async () => {
    const { scheduleId } = await createRecurringTemplate({ startDate: "2020-01-01" });
    await setNextRunDate(scheduleId, "2020-01-01");
    await pool.execute("UPDATE recurring_transaction_schedules SET is_paused = 1 WHERE id = ?", [scheduleId]);

    const result = await TemplateService.resumeSchedule(scheduleId, { catchUpPolicy: "SKIP_TO_NEXT", userId: adminUser.id });
    expect(result.resumed).toBe(true);
    expect(result.catchUpPolicy).toBe("SKIP_TO_NEXT");

    const [skipped] = await pool.execute(
      "SELECT COUNT(*) AS c FROM recurring_transaction_occurrences WHERE schedule_id = ? AND status = 'SKIPPED'",
      [scheduleId]
    );
    expect(skipped[0].c).toBeGreaterThan(0);

    // Scoped to THIS schedule's own occurrences (not a blanket date-range
    // scan on invoice_headers, which would also catch other tests' own
    // deliberately-generated past-dated invoices in this same file).
    const [generatedForThisSchedule] = await pool.execute(
      "SELECT COUNT(*) AS c FROM recurring_transaction_occurrences WHERE schedule_id = ? AND status = 'SUCCESS'",
      [scheduleId]
    );
    expect(generatedForThisSchedule[0].c).toBe(0); // nothing was generated for the missed period

    const [row] = await pool.execute("SELECT is_paused, next_run_date FROM recurring_transaction_schedules WHERE id = ?", [scheduleId]);
    expect(!!row[0].is_paused).toBe(false);
  });

  test("GENERATE_MISSED resumes without altering next_run_date, letting normal generation catch up", async () => {
    const { scheduleId } = await createRecurringTemplate({ startDate: "2020-01-01" });
    await setNextRunDate(scheduleId, "2020-01-01");
    await pool.execute("UPDATE recurring_transaction_schedules SET is_paused = 1 WHERE id = ?", [scheduleId]);

    const result = await TemplateService.resumeSchedule(scheduleId, { catchUpPolicy: "GENERATE_MISSED", userId: adminUser.id });
    expect(result.resumed).toBe(true);
    expect(result.catchUpPolicy).toBe("GENERATE_MISSED");

    const [row] = await pool.execute("SELECT is_paused, DATE_FORMAT(next_run_date, '%Y-%m-%d') AS nextRunDate FROM recurring_transaction_schedules WHERE id = ?", [scheduleId]);
    expect(!!row[0].is_paused).toBe(false);
    expect(row[0].nextRunDate).toBe("2020-01-01"); // unchanged - next call generates it for real

    const gen = await GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: adminUser.id });
    expect(gen.status).toBe("SUCCESS");
    createdInvoiceIds.push(gen.generatedId);
  });

  test("Resuming a schedule that is NOT overdue resumes immediately, no decision needed", async () => {
    const { scheduleId } = await createRecurringTemplate({ startDate: "2099-01-01" });
    await pool.execute("UPDATE recurring_transaction_schedules SET is_paused = 1 WHERE id = ?", [scheduleId]);

    const result = await TemplateService.resumeSchedule(scheduleId, { userId: adminUser.id });
    expect(result.resumed).toBe(true);
    expect(result.requiresCatchUpDecision).toBeUndefined();
  });
});

describe("End date / numbering", () => {
  test("A schedule reaching its end date completes after the final occurrence", async () => {
    const { scheduleId } = await createRecurringTemplate({ startDate: "2026-06-01", endDate: "2026-06-01" });
    const result = await GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: adminUser.id });
    expect(result.status).toBe("SUCCESS");
    createdInvoiceIds.push(result.generatedId);

    const [row] = await pool.execute("SELECT is_active, completed_at FROM recurring_transaction_schedules WHERE id = ?", [scheduleId]);
    expect(!!row[0].is_active).toBe(false);
    expect(row[0].completed_at).not.toBeNull();
  });

  test("Two occurrences from different templates in the same month get distinct, non-colliding voucher numbers", async () => {
    const t1 = await createRecurringTemplate({ startDate: "2026-07-01" });
    const t2 = await createRecurringTemplate({ startDate: "2026-07-01" });

    const r1 = await GenerationService.processSchedule(t1.scheduleId, { triggerType: "MANUAL", userId: adminUser.id });
    const r2 = await GenerationService.processSchedule(t2.scheduleId, { triggerType: "MANUAL", userId: adminUser.id });
    createdInvoiceIds.push(r1.generatedId, r2.generatedId);

    expect(r1.voucherNo).not.toBe(r2.voucherNo);
    expect(r1.voucherNo).toMatch(/^INV-REC-\d{6}-\d{4}$/);
    expect(r2.voucherNo).toMatch(/^INV-REC-\d{6}-\d{4}$/);
  });

  test("Generated invoice traces back to its recurring template via the occurrence record", async () => {
    const { scheduleId, templateId } = await createRecurringTemplate({ startDate: "2026-08-01" });
    const result = await GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: adminUser.id });
    createdInvoiceIds.push(result.generatedId);

    const [occ] = await pool.execute(
      "SELECT generated_transaction_id AS generatedId FROM recurring_transaction_occurrences WHERE id = ?",
      [result.occurrenceId]
    );
    expect(occ[0].generatedId).toBe(result.generatedId);

    const [inv] = await pool.execute("SELECT remarks FROM invoice_headers WHERE id = ?", [result.generatedId]);
    expect(inv[0].remarks).toContain(`recurring template #${templateId}`);
  });
});

describe("Make Recurring bootstrap - source transaction currency (bug found during 3F live verification)", () => {
  // "Make Recurring" bootstraps template line amounts from an EXISTING
  // saved transaction. Template lines are defined to hold TRANSACTION-
  // CURRENCY amounts (generation later multiplies by the resolved rate to
  // get base) - bootstrapping from a foreign-denominated source must use
  // that source's own foreign_debit/foreign_credit, NOT its base
  // debit/credit, or generation would double-apply the exchange rate.
  const createdSourceInvoiceIds = [];
  let usdId;

  beforeAll(async () => {
    const usd = await CurrencyService.createCurrency(adminUser, {
      currencyCode: "GBP", currencyName: "British Pound (bootstrap test)", currencySymbol: "£",
      decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "MANUAL", companyId,
    });
    usdId = usd.id;
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 70.0, effectiveDate: "2026-09-01" });
  });

  afterAll(async () => {
    if (createdSourceInvoiceIds.length) {
      await pool.query("DELETE FROM invoice_lines WHERE invoice_id IN (?)", [createdSourceInvoiceIds]);
      await pool.query("DELETE FROM transaction_currency_snapshots WHERE transaction_type = 'INV' AND transaction_id IN (?)", [createdSourceInvoiceIds]);
      await pool.query("DELETE FROM invoice_headers WHERE id IN (?)", [createdSourceInvoiceIds]);
    }
    // Delete everything that could still hold a currency_id FK to this
    // test currency FIRST - both the template (cascades to its own
    // schedule/lines) and any transaction_currency_snapshots (the
    // GENERATED invoice's snapshot, tracked in the outer createdInvoiceIds
    // array and only cleaned up by the OUTER afterAll, which runs AFTER
    // this nested one - so it must be handled here too, not there).
    await pool.execute("DELETE FROM recurring_transaction_templates WHERE currency_id = ?", [usdId]);
    await pool.execute("DELETE FROM transaction_currency_snapshots WHERE currency_id = ?", [usdId]);
    await pool.execute("DELETE FROM currency_rates WHERE currency_id = ?", [usdId]);
    await pool.execute("DELETE FROM currencies WHERE id = ?", [usdId]);
  });

  test("Bootstrapping from a PHP (base-currency) source uses its base debit/credit unchanged", async () => {
    const [inv] = await pool.execute(
      `INSERT INTO invoice_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, due_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
       VALUES (?, 'TEST3F-BOOT-PHP', ?, 'Test Recurring Customer 3F', '2026-09-01', '2026-09-30', 500, 0, 0, 500, 'Unpaid', 'Posted')`,
      [companyId, testPartyId]
    );
    createdSourceInvoiceIds.push(inv.insertId);
    await pool.execute(
      `INSERT INTO invoice_lines (invoice_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'TEST3FRAR', 'AR', 'x', 500, 0)`,
      [inv.insertId, arAccountId]
    );

    const bootstrap = await TemplateService.createTemplateFromTransaction("invoice", inv.insertId, adminUser.id, companyId);
    expect(bootstrap.sourceCurrencyId).toBeNull();
    expect(bootstrap.lines[0].debit).toBe(500);
  });

  test("Bootstrapping from a foreign-currency source uses its FOREIGN amount, not its base amount", async () => {
    const [inv] = await pool.execute(
      `INSERT INTO invoice_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, due_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status, currency_id)
       VALUES (?, 'TEST3F-BOOT-GBP', ?, 'Test Recurring Customer 3F', '2026-09-01', '2026-09-30', 7000, 0, 0, 7000, 'Unpaid', 'Posted', ?)`,
      [companyId, testPartyId, usdId]
    );
    createdSourceInvoiceIds.push(inv.insertId);
    // Base debit is 7000 (100 GBP * 70.00) - the bug this test guards
    // against would bootstrap the template with 7000 as its "foreign"
    // line amount, then generation would multiply by 70 AGAIN (490,000).
    await pool.execute(
      `INSERT INTO invoice_lines (invoice_id, account_id, account_code, account_title, particulars, debit, credit, foreign_debit, foreign_credit)
       VALUES (?, ?, 'TEST3FRAR', 'AR', 'x', 7000, 0, 100, 0)`,
      [inv.insertId, arAccountId]
    );

    const bootstrap = await TemplateService.createTemplateFromTransaction("invoice", inv.insertId, adminUser.id, companyId);
    expect(bootstrap.sourceCurrencyId).toBe(usdId);
    expect(bootstrap.lines[0].debit).toBe(100); // the FOREIGN amount, not 7000

    // End-to-end: saving this bootstrap as a template and generating it
    // must reproduce the source's own base amount (100 * 70 = 7000), not
    // a double-applied rate (100 * 70 * 70 = 490000).
    const created = await TemplateService.createTemplate(
      {
        moduleType: "invoice", templateName: `Test Recurring 3F Bootstrap ${Date.now()}`,
        partyId: testPartyId, partyName: "Test Recurring Customer 3F", descriptionTemplate: "x",
        currencyId: usdId, ratePolicy: "RESOLVE_ON_GENERATION", amountMode: "FIXED", amountConfig: {},
        dueDateRule: { mode: "SAME_AS_TRANSACTION_DATE" },
        lines: [{ accountId: arAccountId, accountCode: "TEST3FRAR", accountTitle: "AR", debit: bootstrap.lines[0].debit, credit: 0 }, { accountId: revenueAccountId, accountCode: "TEST3FRREV", accountTitle: "Revenue", debit: 0, credit: bootstrap.lines[0].debit }],
        schedule: { frequency: "MONTHLY", startDate: "2026-09-01", dateAdjustmentRule: "KEEP_ORIGINAL" },
      },
      adminUser.id, companyId
    );
    const result = await GenerationService.processSchedule(created.scheduleId, { triggerType: "MANUAL", userId: adminUser.id });
    expect(result.status).toBe("SUCCESS");
    createdInvoiceIds.push(result.generatedId);

    const [genInv] = await pool.execute("SELECT total_debit AS totalDebit FROM invoice_headers WHERE id = ?", [result.generatedId]);
    expect(Number(genInv[0].totalDebit)).toBeCloseTo(7000, 2); // NOT 490000
  });
});