const pool = require("../../db");
const CurrencyService = require("../currencyService");
const TransactionCurrencyService = require("../transactionCurrencyService");
const TemplateService = require("../recurringTemplateService");
const GenerationService = require("../recurringGenerationService");

// Checkpoint 3D Part B: Recurring Invoice multi-currency. The core
// acceptance test (per the spec's own framing) is #3/#4: two occurrences
// generated at two different available rates must each keep their OWN
// rate forever - generating occurrence #2 must never rewrite occurrence #1.

jest.setTimeout(60000);

let companyId, adminUser;
let phpId, usdId;
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
    { accountId: arAccountId, accountCode: "TEST3DRAR", accountTitle: "Accounts Receivable (Test)", particularsTemplate: "Recurring charge {{month_name}}", debit: 100, credit: 0 },
    { accountId: revenueAccountId, accountCode: "TEST3DRREV", accountTitle: "Service Revenue (Test)", particularsTemplate: "Recurring charge {{month_name}}", debit: 0, credit: 100 },
  ];
}

async function createRecurringTemplate({ currencyId, ratePolicy, fixedRate, startDate }) {
  const result = await TemplateService.createTemplate(
    {
      moduleType: "invoice",
      templateName: `Test Recurring ${Date.now()}`,
      partyId: testPartyId,
      partyName: "Test Recurring Customer",
      descriptionTemplate: "Recurring charge for {{month_name}} {{year}}",
      currency: currencyId ? "USD" : "PHP",
      currencyId: currencyId || null,
      ratePolicy: ratePolicy || "RESOLVE_ON_GENERATION",
      fixedRate: fixedRate || null,
      amountMode: "FIXED",
      amountConfig: {},
      dueDateRule: { mode: "SAME_AS_TRANSACTION_DATE" },
      lines: templateLines(),
      schedule: { frequency: "MONTHLY", startDate, dateAdjustmentRule: "KEEP_ORIGINAL" },
    },
    adminUser.id,
    companyId
  );
  return result;
}

async function setNextRunDate(scheduleId, date) {
  await pool.execute("UPDATE recurring_transaction_schedules SET next_run_date = ? WHERE id = ?", [date, scheduleId]);
}

beforeAll(async () => {
  // Self-healing: a previous run that crashed/was interrupted before
  // reaching afterAll can leave this fixed-username user (and its
  // company/currencies) orphaned, which would otherwise fail every
  // subsequent run on a duplicate-username error.
  const [orphanedUsers] = await pool.execute("SELECT id FROM users WHERE username = 'test_admin_3d_rec'");
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
  await pool.execute("DELETE FROM chart_of_accounts WHERE code LIKE 'TEST3DR%'");
  await pool.execute("DELETE FROM general_libraries WHERE code = 'TEST3DRCUST'");

  companyId = await makeCompany("TEST CO - Checkpoint 3D Recurring");
  adminUser = await makeUser("test_admin_3d_rec", 2);

  const php = await CurrencyService.createCurrency(adminUser, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId,
  });
  phpId = php.id;
  const usd = await CurrencyService.createCurrency(adminUser, {
    currencyCode: "USD", currencyName: "US Dollar", currencySymbol: "$",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "MANUAL", companyId,
  });
  usdId = usd.id;

  arAccountId = await makeAccount("TEST3DRAR", "Accounts Receivable (Test)", "ASSET");
  revenueAccountId = await makeAccount("TEST3DRREV", "Service Revenue (Test)", "INCOME");

  const [partyResult] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, 'TEST3DRCUST', 'CUSTOMER', 'Test Recurring Customer', 'ACTIVE')",
    [companyId]
  );
  testPartyId = partyResult.insertId;
});

afterAll(async () => {
  // Catch-all by party, not just the tracked createdInvoiceIds array - a
  // test asserting rejection (e.g. test 8) never reaches a push() call,
  // but processSchedule can still have generated a real invoice if the
  // test's own premise turns out wrong, and an untracked leftover
  // invoice's snapshot would otherwise block deleting currencies below.
  const [allTestInvoices] = await pool.execute("SELECT id FROM invoice_headers WHERE customer_id = ?", [testPartyId]);
  const allInvoiceIds = Array.from(new Set([...createdInvoiceIds, ...allTestInvoices.map((r) => r.id)]));
  if (allInvoiceIds.length) {
    await pool.query(`DELETE FROM invoice_lines WHERE invoice_id IN (?)`, [allInvoiceIds]);
    await pool.query(`DELETE FROM transaction_currency_snapshots WHERE transaction_type = 'INV' AND transaction_id IN (?)`, [allInvoiceIds]);
    await pool.query(`DELETE FROM invoice_headers WHERE id IN (?)`, [allInvoiceIds]);
  }
  await pool.execute("DELETE FROM transaction_currency_snapshots WHERE company_id = ?", [companyId]);
  await pool.execute(
    `DELETE o FROM recurring_transaction_occurrences o
     JOIN recurring_transaction_schedules s ON s.id = o.schedule_id
     JOIN recurring_transaction_templates t ON t.id = s.template_id
     WHERE t.template_name LIKE 'Test Recurring %'`
  );
  await pool.execute(
    `DELETE s FROM recurring_transaction_schedules s
     JOIN recurring_transaction_templates t ON t.id = s.template_id
     WHERE t.template_name LIKE 'Test Recurring %'`
  );
  await pool.execute(
    `DELETE l FROM recurring_transaction_template_lines l
     JOIN recurring_transaction_templates t ON t.id = l.template_id
     WHERE t.template_name LIKE 'Test Recurring %'`
  );
  await pool.execute(`DELETE FROM recurring_transaction_templates WHERE template_name LIKE 'Test Recurring %'`);
  await pool.execute("DELETE FROM chart_of_accounts WHERE code LIKE 'TEST3DR%'");
  if (testPartyId) await pool.execute("DELETE FROM general_libraries WHERE id = ?", [testPartyId]);
  await pool.execute("DELETE FROM currency_rates WHERE company_id = ?", [companyId]);
  await pool.execute("DELETE FROM currencies WHERE company_id = ?", [companyId]);
  if (createdUserIds.length) {
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [createdUserIds]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [createdUserIds]);
  }
  await pool.execute("DELETE FROM companies WHERE id = ?", [companyId]);
  await pool.end();
});

describe("Recurring Invoice multi-currency", () => {
  test("1. PHP recurring Invoice generates at rate 1, stays Draft", async () => {
    const { scheduleId } = await createRecurringTemplate({ startDate: "2026-02-01" });
    const result = await GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: adminUser.id });
    expect(result.status).toBe("SUCCESS");
    createdInvoiceIds.push(result.generatedId);

    const [inv] = await pool.execute("SELECT status, total_debit, total_credit, currency_id FROM invoice_headers WHERE id = ?", [result.generatedId]);
    expect(inv[0].status).toBe("Draft");
    expect(Number(inv[0].total_debit)).toBe(100);
  });

  test("2. USD recurring Invoice (RESOLVE_ON_GENERATION) converts at the currently available rate", async () => {
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 57.0, effectiveDate: "2026-02-01" });
    const { scheduleId } = await createRecurringTemplate({ currencyId: usdId, startDate: "2026-02-01" });
    const result = await GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: adminUser.id });
    expect(result.status).toBe("SUCCESS");
    createdInvoiceIds.push(result.generatedId);

    const [inv] = await pool.execute("SELECT total_debit, currency_id, foreign_balance_amount AS foreignBalance FROM invoice_headers WHERE id = ?", [result.generatedId]);
    expect(Number(inv[0].total_debit)).toBeCloseTo(5700, 2);
    expect(inv[0].currency_id).toBe(usdId);
    expect(Number(inv[0].foreignBalance)).toBe(100);

    const [lines] = await pool.execute("SELECT foreign_debit AS foreignDebit, debit FROM invoice_lines WHERE invoice_id = ? ORDER BY id LIMIT 1", [result.generatedId]);
    expect(Number(lines[0].foreignDebit)).toBe(100);
    expect(Number(lines[0].debit)).toBeCloseTo(5700, 2);

    const snap = await TransactionCurrencyService.getSnapshot("INV", result.generatedId);
    expect(snap.exchangeRate).toBe(57.0);
    expect(snap.rateLocked).toBe(false); // Draft - never locks
  });

  test("3/4. Occurrence #1 and #2 each keep their OWN rate - critical acceptance test", async () => {
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 57.2, effectiveDate: "2026-03-01" });
    const { scheduleId, templateId } = await createRecurringTemplate({ currencyId: usdId, startDate: "2026-03-01" });

    const occ1 = await GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: adminUser.id });
    expect(occ1.status).toBe("SUCCESS");
    createdInvoiceIds.push(occ1.generatedId);
    const [inv1Before] = await pool.execute("SELECT total_debit FROM invoice_headers WHERE id = ?", [occ1.generatedId]);
    expect(Number(inv1Before[0].total_debit)).toBeCloseTo(5720, 2); // 100 * 57.20

    // New rate becomes available for the SECOND occurrence's date.
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 57.8, effectiveDate: "2026-04-01" });
    await setNextRunDate(scheduleId, "2026-04-01");

    const occ2 = await GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: adminUser.id });
    expect(occ2.status).toBe("SUCCESS");
    createdInvoiceIds.push(occ2.generatedId);
    const [inv2] = await pool.execute("SELECT total_debit FROM invoice_headers WHERE id = ?", [occ2.generatedId]);
    expect(Number(inv2[0].total_debit)).toBeCloseTo(5780, 2); // 100 * 57.80

    // Occurrence #1 must be COMPLETELY unaffected by occurrence #2's generation.
    const [inv1After] = await pool.execute("SELECT total_debit FROM invoice_headers WHERE id = ?", [occ1.generatedId]);
    expect(Number(inv1After[0].total_debit)).toBeCloseTo(5720, 2);
    const snap1 = await TransactionCurrencyService.getSnapshot("INV", occ1.generatedId);
    expect(snap1.exchangeRate).toBe(57.2);

    // The template's own row was never overwritten with an occurrence rate.
    const [templateRow] = await pool.execute("SELECT fixed_rate AS fixedRate, rate_policy AS ratePolicy FROM recurring_transaction_templates WHERE id = ?", [templateId]);
    expect(templateRow[0].fixedRate).toBeNull();
    expect(templateRow[0].ratePolicy).toBe("RESOLVE_ON_GENERATION");
  });

  test("6. Fixed-rate recurring uses the configured rate regardless of the market rate", async () => {
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 99.0, effectiveDate: "2026-05-01" }); // market rate, should be ignored
    const { scheduleId } = await createRecurringTemplate({ currencyId: usdId, ratePolicy: "FIXED_RATE", fixedRate: 57.5, startDate: "2026-05-01" });
    const result = await GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: adminUser.id });
    expect(result.status).toBe("SUCCESS");
    createdInvoiceIds.push(result.generatedId);

    const [inv] = await pool.execute("SELECT total_debit FROM invoice_headers WHERE id = ?", [result.generatedId]);
    expect(Number(inv[0].total_debit)).toBeCloseTo(5750, 2); // 100 * 57.50, NOT 99.00
  });

  test("7. Manual-review recurring holds the occurrence until a rate is approved", async () => {
    const { scheduleId } = await createRecurringTemplate({ currencyId: usdId, ratePolicy: "MANUAL_REVIEW", startDate: "2026-06-01" });

    const held = await GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: adminUser.id });
    expect(held.status).toBe("RATE_REVIEW_REQUIRED");
    const [heldRows] = await pool.execute("SELECT status, reason FROM recurring_transaction_occurrences WHERE id = ?", [held.occurrenceId]);
    expect(heldRows[0].status).toBe("RATE_REVIEW_REQUIRED");

    // No invoice was created for the held occurrence.
    const [scheduleRow] = await pool.execute("SELECT generated_count, next_run_date FROM recurring_transaction_schedules WHERE id = ?", [scheduleId]);
    expect(scheduleRow[0].generated_count).toBe(0);

    // A human approves a rate - retrying the SAME due occurrence now generates.
    const approved = await GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: adminUser.id, approvedRate: 58.0 });
    expect(approved.status).toBe("SUCCESS");
    createdInvoiceIds.push(approved.generatedId);
    const [inv] = await pool.execute("SELECT total_debit FROM invoice_headers WHERE id = ?", [approved.generatedId]);
    expect(Number(inv[0].total_debit)).toBeCloseTo(5800, 2);
  });

  test("8. No approved rate available for RESOLVE_ON_GENERATION fails the occurrence safely", async () => {
    // A brand-new currency with NO rate ever recorded - reusing usdId here
    // would wrongly resolve via "last approved carries forward" (a legit
    // resolver behavior: once ANY historical rate exists, it's valid for
    // any later date), which earlier tests in this file already recorded.
    const noRateCurrency = await CurrencyService.createCurrency(adminUser, {
      currencyCode: "GBP", currencyName: "British Pound", currencySymbol: "£",
      decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "MANUAL", companyId,
    });
    const { scheduleId } = await createRecurringTemplate({ currencyId: noRateCurrency.id, startDate: "2026-09-01" });
    await expect(
      GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: adminUser.id })
    ).rejects.toMatchObject({ statusCode: 422 });

    const [occRows] = await pool.execute(
      "SELECT status, reason FROM recurring_transaction_occurrences WHERE schedule_id = ? ORDER BY id DESC LIMIT 1",
      [scheduleId]
    );
    expect(occRows[0].status).toBe("FAILED");
    expect(occRows[0].reason).toBe("NO_APPROVED_RATE");
  });

  test("9. Inactive template currency blocks generation with CURRENCY_INACTIVE", async () => {
    const inactiveCurrency = await CurrencyService.createCurrency(adminUser, {
      currencyCode: "JPY", currencyName: "Japanese Yen", currencySymbol: "¥",
      decimalPlaces: 0, symbolPosition: "BEFORE", defaultRateMode: "MANUAL", companyId,
    });
    await CurrencyService.recordRate(adminUser, inactiveCurrency.id, { rateMode: "MANUAL", rate: 0.39, effectiveDate: "2026-07-01" });
    const { scheduleId } = await createRecurringTemplate({ currencyId: inactiveCurrency.id, startDate: "2026-07-01" });
    await CurrencyService.setStatus(adminUser, inactiveCurrency.id, false);

    await expect(
      GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: adminUser.id })
    ).rejects.toMatchObject({ statusCode: 422 });
    const [occRows] = await pool.execute(
      "SELECT status, reason FROM recurring_transaction_occurrences WHERE schedule_id = ? ORDER BY id DESC LIMIT 1",
      [scheduleId]
    );
    expect(occRows[0].reason).toBe("CURRENCY_INACTIVE");
    // Cleanup deferred to afterAll (deletes templates before currencies) -
    // this template's currency_id FK would otherwise block an immediate delete here.
  });

  test("16. Duplicate occurrence protection: generating the same due date twice only creates one invoice", async () => {
    const { scheduleId } = await createRecurringTemplate({ startDate: "2026-08-01" });
    const first = await GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: adminUser.id });
    expect(first.status).toBe("SUCCESS");
    createdInvoiceIds.push(first.generatedId);

    // Force next_run_date back to the SAME already-generated date to
    // simulate a retry race.
    await setNextRunDate(scheduleId, "2026-08-01");
    const second = await GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: adminUser.id });
    expect(second.status).toBe("ALREADY_GENERATED");

    const [count] = await pool.execute(
      "SELECT COUNT(*) AS c FROM recurring_transaction_occurrences WHERE schedule_id = ? AND occurrence_date = '2026-08-01'",
      [scheduleId]
    );
    expect(count[0].c).toBe(1);
  });
});
