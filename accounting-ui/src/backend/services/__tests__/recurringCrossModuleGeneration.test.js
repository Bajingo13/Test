const pool = require("../../db");
const CurrencyService = require("../currencyService");
const TemplateService = require("../recurringTemplateService");
const GenerationService = require("../recurringGenerationService");

// Checkpoint 6: cross-module generalization (apv/jv/po/or/cv). Invoice's
// own recurring behavior is covered exhaustively already
// (recurringSchedulerGeneration.test.js, recurringInvoiceCurrency.test.js)
// and is NOT re-tested here beyond one small regression smoke test -
// invoice's GENERATION_MODULE_CONFIG entry was not touched by this work.
//
// Per-module HEADER_TABLE/GENERATED_TABLES below drive the shared cleanup
// helper so every fixture this file creates (across 5 different header/
// line table pairs) is torn down the same way.

jest.setTimeout(60000);

let companyId, otherCompanyId, adminUser, otherCompanyUser;
let expenseAccountId, apAccountId, cashAccountId, arAccountId, revenueAccountId, purchaseAccountId;
let supplierId, customerId, otherCompanySupplierId;
const createdUserIds = [];
const generatedByModule = { invoice: [], apv: [], jv: [], po: [], or: [], cv: [] };

const HEADER_TABLE = {
  invoice: "invoice_headers", apv: "apv_headers", jv: "jv_headers",
  po: "purchase_order_headers", or: "or_headers", cv: "cv_headers",
};
const LINE_TABLE = {
  invoice: "invoice_lines", apv: "apv_lines", jv: "jv_lines",
  po: "purchase_order_lines", or: "or_lines", cv: "cv_lines",
};
const LINE_ID_COL = {
  invoice: "invoice_id", apv: "apv_id", jv: "jv_id",
  po: "po_id", or: "or_id", cv: "cv_id",
};

async function makeCompany(name) {
  const [result] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [name]);
  return result.insertId;
}

async function makeUser(username, companyIdForUser) {
  const [result] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, 'test-hash-not-used-for-login', 2, 'ACTIVE')",
    [username]
  );
  const userId = result.insertId;
  createdUserIds.push(userId);
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, companyIdForUser]);
  return { id: userId, roleCode: "NON_SUPER" };
}

async function makeAccount(code, title, accountClass) {
  const [result] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, accountClass]
  );
  return result.insertId;
}

function linesFor(moduleType) {
  switch (moduleType) {
    case "apv":
      return [
        { accountId: expenseAccountId, accountCode: "TESTX6EXP", accountTitle: "Expense (Test)", particularsTemplate: "Recurring {{month_name}}", debit: 200, credit: 0 },
        { accountId: apAccountId, accountCode: "TESTX6AP", accountTitle: "Accounts Payable (Test)", particularsTemplate: "Recurring {{month_name}}", debit: 0, credit: 200 },
      ];
    case "jv":
      return [
        { accountId: expenseAccountId, accountCode: "TESTX6EXP", accountTitle: "Expense (Test)", particularsTemplate: "Depreciation {{month_name}}", debit: 150, credit: 0 },
        { accountId: cashAccountId, accountCode: "TESTX6CASH", accountTitle: "Cash (Test)", particularsTemplate: "Depreciation {{month_name}}", debit: 0, credit: 150 },
      ];
    case "po":
      return [
        { accountId: purchaseAccountId, accountCode: "TESTX6PUR", accountTitle: "Purchases (Test)", particularsTemplate: "Standing order {{month_name}}", debit: 300, credit: 0 },
        { accountId: apAccountId, accountCode: "TESTX6AP", accountTitle: "Accounts Payable (Test)", particularsTemplate: "Standing order {{month_name}}", debit: 0, credit: 300 },
      ];
    case "or":
      return [
        { accountId: cashAccountId, accountCode: "TESTX6CASH", accountTitle: "Cash (Test)", particularsTemplate: "Collection {{month_name}}", debit: 250, credit: 0 },
        { accountId: arAccountId, accountCode: "TESTX6AR", accountTitle: "Accounts Receivable (Test)", particularsTemplate: "Collection {{month_name}}", debit: 0, credit: 250 },
      ];
    case "cv":
      return [
        { accountId: apAccountId, accountCode: "TESTX6AP", accountTitle: "Accounts Payable (Test)", particularsTemplate: "Disbursement {{month_name}}", debit: 180, credit: 0 },
        { accountId: cashAccountId, accountCode: "TESTX6CASH", accountTitle: "Cash (Test)", particularsTemplate: "Disbursement {{month_name}}", debit: 0, credit: 180 },
      ];
    default:
      throw new Error(`no fixture lines defined for ${moduleType}`);
  }
}

async function createRecurringTemplate({ moduleType, startDate, endDate, forCompanyId = companyId, forUser = adminUser, partyIdOverride }) {
  const needsParty = moduleType !== "jv";
  const partyId = needsParty ? (partyIdOverride !== undefined ? partyIdOverride : (moduleType === "or" ? customerId : supplierId)) : null;
  const partyName = needsParty ? (moduleType === "or" ? "Test X6 Customer" : "Test X6 Supplier") : "Finance Team";

  return TemplateService.createTemplate(
    {
      moduleType,
      templateName: `Test Recurring X6 ${moduleType} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      partyId,
      partyName,
      descriptionTemplate: `Recurring ${moduleType} for {{month_name}} {{year}}`,
      currency: "PHP",
      currencyId: null,
      amountMode: "FIXED",
      amountConfig: {},
      dueDateRule: { mode: "SAME_AS_TRANSACTION_DATE" },
      lines: linesFor(moduleType),
      schedule: { frequency: "MONTHLY", startDate, endDate: endDate || null, dateAdjustmentRule: "KEEP_ORIGINAL" },
    },
    forUser.id,
    forCompanyId
  );
}

async function setNextRunDate(scheduleId, date) {
  await pool.execute("UPDATE recurring_transaction_schedules SET next_run_date = ? WHERE id = ?", [date, scheduleId]);
}

beforeAll(async () => {
  await pool.execute("DELETE FROM chart_of_accounts WHERE code LIKE 'TESTX6%'");
  await pool.execute("DELETE FROM general_libraries WHERE code IN ('TESTX6SUPP', 'TESTX6CUST', 'TESTX6SUPPB')");
  await pool.execute("DELETE FROM companies WHERE name IN ('TEST CO - Checkpoint 6 Cross-Module', 'TEST CO - Checkpoint 6 Other Company')");

  companyId = await makeCompany("TEST CO - Checkpoint 6 Cross-Module");
  otherCompanyId = await makeCompany("TEST CO - Checkpoint 6 Other Company");
  adminUser = await makeUser("test_admin_x6", companyId);
  otherCompanyUser = await makeUser("test_admin_x6_other", otherCompanyId);

  await CurrencyService.createCurrency(adminUser, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId,
  });
  await CurrencyService.createCurrency(otherCompanyUser, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: otherCompanyId,
  });

  // Global chart-of-accounts catalog (code has a real UNIQUE index - one
  // set of account rows, shared across both test companies, exactly the
  // structural isolation-proof technique established in Phase 7F).
  expenseAccountId = await makeAccount("TESTX6EXP", "Expense (Test)", "EXPENSE");
  apAccountId = await makeAccount("TESTX6AP", "Accounts Payable (Test)", "LIABILITY");
  cashAccountId = await makeAccount("TESTX6CASH", "Cash (Test)", "ASSET");
  arAccountId = await makeAccount("TESTX6AR", "Accounts Receivable (Test)", "ASSET");
  revenueAccountId = await makeAccount("TESTX6REV", "Revenue (Test)", "INCOME");
  purchaseAccountId = await makeAccount("TESTX6PUR", "Purchases (Test)", "EXPENSE");

  const [supp] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, 'TESTX6SUPP', 'SUPPLIER', 'Test X6 Supplier', 'ACTIVE')",
    [companyId]
  );
  supplierId = supp.insertId;
  const [cust] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, 'TESTX6CUST', 'CUSTOMER', 'Test X6 Customer', 'ACTIVE')",
    [companyId]
  );
  customerId = cust.insertId;

  const [otherSupp] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, 'TESTX6SUPPB', 'SUPPLIER', 'Test X6 Other Co Supplier', 'ACTIVE')",
    [otherCompanyId]
  );
  otherCompanySupplierId = otherSupp.insertId;
});

afterAll(async () => {
  for (const moduleType of Object.keys(generatedByModule)) {
    const ids = generatedByModule[moduleType];
    if (!ids.length) continue;
    const headerTable = HEADER_TABLE[moduleType];
    const lineTable = LINE_TABLE[moduleType];
    const lineIdCol = LINE_ID_COL[moduleType];
    await pool.query(`DELETE FROM ${lineTable} WHERE ${lineIdCol} IN (?)`, [ids]);
    await pool.query(`DELETE FROM transaction_applications WHERE (source_type = ? AND source_id IN (?)) OR (applied_type = ? AND applied_id IN (?))`, [moduleType.toUpperCase(), ids, moduleType.toUpperCase(), ids]);
    await pool.query(`DELETE FROM transaction_currency_snapshots WHERE transaction_type = ? AND transaction_id IN (?)`, [moduleType === "invoice" ? "INV" : moduleType.toUpperCase(), ids]);
    await pool.query(`DELETE FROM ${headerTable} WHERE id IN (?)`, [ids]);
  }

  await pool.execute(
    `DELETE o FROM recurring_transaction_occurrences o
     JOIN recurring_transaction_schedules s ON s.id = o.schedule_id
     JOIN recurring_transaction_templates t ON t.id = s.template_id
     WHERE t.template_name LIKE 'Test Recurring X6 %'`
  );
  await pool.execute(
    `DELETE s FROM recurring_transaction_schedules s
     JOIN recurring_transaction_templates t ON t.id = s.template_id
     WHERE t.template_name LIKE 'Test Recurring X6 %'`
  );
  await pool.execute(
    `DELETE l FROM recurring_transaction_template_lines l
     JOIN recurring_transaction_templates t ON t.id = l.template_id
     WHERE t.template_name LIKE 'Test Recurring X6 %'`
  );
  await pool.execute(`DELETE FROM recurring_transaction_templates WHERE template_name LIKE 'Test Recurring X6 %'`);
  await pool.execute("DELETE FROM chart_of_accounts WHERE code LIKE 'TESTX6%'");
  if (supplierId) await pool.execute("DELETE FROM general_libraries WHERE id = ?", [supplierId]);
  if (customerId) await pool.execute("DELETE FROM general_libraries WHERE id = ?", [customerId]);
  if (otherCompanySupplierId) await pool.execute("DELETE FROM general_libraries WHERE id = ?", [otherCompanySupplierId]);
  await pool.execute("DELETE FROM accounting_periods WHERE company_id IN (?, ?)", [companyId, otherCompanyId]);
  for (const cid of [companyId, otherCompanyId]) {
    await pool.execute("DELETE FROM transaction_currency_snapshots WHERE company_id = ?", [cid]);
    await pool.execute("DELETE FROM currency_rates WHERE company_id = ?", [cid]);
    await pool.execute("DELETE FROM currencies WHERE company_id = ?", [cid]);
  }
  if (createdUserIds.length) {
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [createdUserIds]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [createdUserIds]);
  }
  await pool.execute("DELETE FROM companies WHERE id IN (?, ?)", [companyId, otherCompanyId]);
  await pool.end();
});

describe("1-3: Draft generation with correct module-specific fields", () => {
  test("APV generation creates a Draft with correct fields (supplier party, due date, no EWT annotation)", async () => {
    const { scheduleId } = await createRecurringTemplate({ moduleType: "apv", startDate: "2026-10-01" });
    const result = await GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: adminUser.id });
    expect(result.status).toBe("SUCCESS");
    generatedByModule.apv.push(result.generatedId);

    const [rows] = await pool.execute(
      "SELECT status, supplier_id AS supplierId, due_date AS dueDate, atc_code AS atcCode, source_po_id AS sourcePoId FROM apv_headers WHERE id = ?",
      [result.generatedId]
    );
    expect(rows[0].status).toBe("Draft");
    expect(rows[0].supplierId).toBe(supplierId);
    expect(rows[0].dueDate).not.toBeNull();
    expect(rows[0].atcCode).toBeNull();
    expect(rows[0].sourcePoId).toBeNull();
    expect(result.voucherNo).toMatch(/^APV-REC-\d{6}-\d{4}$/);
  });

  test("JV generation creates a Draft with correct fields (no party required, prepared_for carries template name)", async () => {
    const { scheduleId } = await createRecurringTemplate({ moduleType: "jv", startDate: "2026-10-01" });
    const result = await GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: adminUser.id });
    expect(result.status).toBe("SUCCESS");
    generatedByModule.jv.push(result.generatedId);

    const [rows] = await pool.execute(
      "SELECT status, prepared_for AS preparedFor FROM jv_headers WHERE id = ?",
      [result.generatedId]
    );
    expect(rows[0].status).toBe("Draft");
    expect(rows[0].preparedFor).toBe("Finance Team");
    expect(result.voucherNo).toMatch(/^JV-REC-\d{6}-\d{4}$/);
  });

  test("PO generation creates a Draft with correct fields (never the manual route's default 'Open', no EWT)", async () => {
    const { scheduleId } = await createRecurringTemplate({ moduleType: "po", startDate: "2026-10-01" });
    const result = await GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: adminUser.id });
    expect(result.status).toBe("SUCCESS");
    generatedByModule.po.push(result.generatedId);

    const [rows] = await pool.execute(
      "SELECT status, supplier_id AS supplierId, atc_code AS atcCode, tax_withheld_amount AS taxWithheldAmount FROM purchase_order_headers WHERE id = ?",
      [result.generatedId]
    );
    expect(rows[0].status).toBe("Draft"); // NOT 'Open' - the manual route's default
    expect(rows[0].supplierId).toBe(supplierId);
    expect(rows[0].atcCode).toBeNull();
    expect(rows[0].taxWithheldAmount).toBeNull();
    expect(result.voucherNo).toMatch(/^PO-REC-\d{6}-\d{4}$/);
  });
});

describe("4-7: OR/CV direct-only restriction", () => {
  test("OR generation creates a Draft direct transaction only, no source-application linkage", async () => {
    const { scheduleId } = await createRecurringTemplate({ moduleType: "or", startDate: "2026-10-01" });
    const result = await GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: adminUser.id });
    expect(result.status).toBe("SUCCESS");
    generatedByModule.or.push(result.generatedId);

    const [rows] = await pool.execute(
      "SELECT status, customer_id AS customerId, payment_method AS paymentMethod, bank_account_id AS bankAccountId, check_no AS checkNo, check_date AS checkDate FROM or_headers WHERE id = ?",
      [result.generatedId]
    );
    expect(rows[0].status).toBe("Draft");
    expect(rows[0].customerId).toBe(customerId);
    expect(rows[0].paymentMethod).toBe("Cash");
    expect(rows[0].bankAccountId).toBeNull();
    expect(rows[0].checkNo).toBe("");
    expect(rows[0].checkDate).toBeNull();

    const [apps] = await pool.execute(
      "SELECT COUNT(*) AS c FROM transaction_applications WHERE applied_type = 'OR' AND applied_id = ?",
      [result.generatedId]
    );
    expect(apps[0].c).toBe(0);
  });

  test("CV generation creates a Draft direct transaction only, leaves check number blank, no source-application linkage", async () => {
    const { scheduleId } = await createRecurringTemplate({ moduleType: "cv", startDate: "2026-10-01" });
    const result = await GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: adminUser.id });
    expect(result.status).toBe("SUCCESS");
    generatedByModule.cv.push(result.generatedId);

    const [rows] = await pool.execute(
      "SELECT status, payee_id AS payeeId, payment_method AS paymentMethod, check_no AS checkNo, check_date AS checkDate FROM cv_headers WHERE id = ?",
      [result.generatedId]
    );
    expect(rows[0].status).toBe("Draft");
    expect(rows[0].payeeId).toBe(supplierId);
    expect(rows[0].paymentMethod).toBe("Cash");
    expect(rows[0].checkNo).toBe(""); // never auto-filled from a physical checkbook
    expect(rows[0].checkDate).toBeNull();

    const [apps] = await pool.execute(
      "SELECT COUNT(*) AS c FROM transaction_applications WHERE applied_type = 'CV' AND applied_id = ?",
      [result.generatedId]
    );
    expect(apps[0].c).toBe(0);
  });
});

describe("8: Unsupported module types still reject cleanly", () => {
  test("Creating a template for an unsupported module type (e.g. 'debitMemo') is rejected at validation, not silently accepted", async () => {
    await expect(
      TemplateService.createTemplate(
        {
          moduleType: "debitMemo",
          templateName: "Should never be created",
          partyId: supplierId,
          partyName: "Test X6 Supplier",
          lines: linesFor("apv"),
          schedule: { frequency: "MONTHLY", startDate: "2026-10-01" },
        },
        adminUser.id,
        companyId
      )
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test("A schedule whose template somehow has an unimplemented module_type fails generation cleanly (400), not a crash or silent misgeneration", async () => {
    const { scheduleId } = await createRecurringTemplate({ moduleType: "apv", startDate: "2026-10-02" });
    const [sched] = await pool.execute("SELECT template_id FROM recurring_transaction_schedules WHERE id = ?", [scheduleId]);
    await pool.execute("UPDATE recurring_transaction_templates SET module_type = 'pettyCash' WHERE id = ?", [sched[0].template_id]);

    await expect(
      GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: adminUser.id })
    ).rejects.toMatchObject({ statusCode: 400 });

    // Restore so this schedule's rows don't confuse the shared cleanup pass.
    await pool.execute("UPDATE recurring_transaction_templates SET module_type = 'apv' WHERE id = ?", [sched[0].template_id]);
  });
});

describe("9: Company isolation", () => {
  test("Template bootstrap for a new module type only reads transactions belonging to the requesting company", async () => {
    const [otherApv] = await pool.execute(
      `INSERT INTO apv_headers (company_id, voucher_no, supplier_id, supplier_name, transaction_date, total_debit, total_credit, status)
       VALUES (?, 'TESTX6-OTHERCO-APV', ?, 'Other Co Supplier', '2026-10-01', 200, 200, 'Posted')`,
      [otherCompanyId, otherCompanySupplierId]
    );
    generatedByModule.apv.push(otherApv.insertId);
    await pool.execute(
      `INSERT INTO apv_lines (apv_id, account_id, account_code, account_title, debit, credit) VALUES (?, ?, 'TESTX6EXP', 'Expense', 200, 0)`,
      [otherApv.insertId, expenseAccountId]
    );

    await expect(
      TemplateService.createTemplateFromTransaction("apv", otherApv.insertId, adminUser.id, companyId)
    ).rejects.toMatchObject({ statusCode: 404 }); // exists, but not in THIS company - must not leak across companies

    const ok = await TemplateService.createTemplateFromTransaction("apv", otherApv.insertId, otherCompanyUser.id, otherCompanyId);
    expect(ok.partyId).toBe(otherCompanySupplierId);
  });

  test("A generated transaction for a new module type is stamped with the template's own company_id, never a caller-supplied one", async () => {
    const { scheduleId } = await createRecurringTemplate({ moduleType: "cv", startDate: "2026-10-03", forCompanyId: otherCompanyId, forUser: otherCompanyUser, partyIdOverride: otherCompanySupplierId });
    const result = await GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: otherCompanyUser.id });
    expect(result.status).toBe("SUCCESS");
    generatedByModule.cv.push(result.generatedId);

    const [rows] = await pool.execute("SELECT company_id AS companyId FROM cv_headers WHERE id = ?", [result.generatedId]);
    expect(rows[0].companyId).toBe(otherCompanyId);
  });
});

describe("10: Numbering uniqueness across all six module codes", () => {
  test("Generating one occurrence of each module type in the same period produces six distinct, correctly-prefixed voucher numbers", async () => {
    const templates = await Promise.all(
      ["apv", "jv", "po", "or", "cv"].map((moduleType) => createRecurringTemplate({ moduleType, startDate: "2026-11-01" }))
    );
    const results = [];
    for (let i = 0; i < templates.length; i++) {
      const moduleType = ["apv", "jv", "po", "or", "cv"][i];
      const result = await GenerationService.processSchedule(templates[i].scheduleId, { triggerType: "MANUAL", userId: adminUser.id });
      expect(result.status).toBe("SUCCESS");
      generatedByModule[moduleType].push(result.generatedId);
      results.push({ moduleType, voucherNo: result.voucherNo });
    }

    const prefixes = { apv: "APV", jv: "JV", po: "PO", or: "OR", cv: "CV" };
    for (const { moduleType, voucherNo } of results) {
      expect(voucherNo).toMatch(new RegExp(`^${prefixes[moduleType]}-REC-\\d{6}-\\d{4}$`));
    }
    const allVoucherNos = results.map((r) => r.voucherNo);
    expect(new Set(allVoucherNos).size).toBe(allVoucherNos.length); // no collisions
  });
});

describe("11: Recurring history resolves correctly for all six module types", () => {
  test("getHistory() returns the correct documentNumber/documentStatus for a generated APV, JV, PO, OR, and CV occurrence", async () => {
    for (const moduleType of ["apv", "jv", "po", "or", "cv"]) {
      const { scheduleId } = await createRecurringTemplate({ moduleType, startDate: "2026-12-01" });
      const result = await GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: adminUser.id });
      expect(result.status).toBe("SUCCESS");
      generatedByModule[moduleType].push(result.generatedId);

      const history = await TemplateService.getHistory(scheduleId);
      const row = history.find((h) => h.id === result.occurrenceId);
      expect(row).toBeDefined();
      expect(row.documentNumber).toBe(result.voucherNo);
      expect(row.documentStatus).toBe("Draft");
    }
  });
});

describe("12-14: Generate Now, scheduler batch processing, idempotency for new modules", () => {
  test("processDueSchedules (the scheduler/run-due batch entry point) generates a mixed batch of new module types in one pass", async () => {
    const apvDue = await createRecurringTemplate({ moduleType: "apv", startDate: "2020-01-01" });
    await setNextRunDate(apvDue.scheduleId, "2020-01-01");
    const poDue = await createRecurringTemplate({ moduleType: "po", startDate: "2020-01-01" });
    await setNextRunDate(poDue.scheduleId, "2020-01-01");

    const result = await GenerationService.processDueSchedules({ triggerType: "SCHEDULED", limit: 200 });
    const apvResult = result.results.find((r) => r.scheduleId === apvDue.scheduleId);
    const poResult = result.results.find((r) => r.scheduleId === poDue.scheduleId);
    expect(apvResult.status).toBe("SUCCESS");
    expect(poResult.status).toBe("SUCCESS");
    if (apvResult.generatedId) generatedByModule.apv.push(apvResult.generatedId);
    if (poResult.generatedId) generatedByModule.po.push(poResult.generatedId);
  });

  test("Duplicate scheduler execution for a new module type (APV) remains idempotent under a simulated race", async () => {
    const { scheduleId } = await createRecurringTemplate({ moduleType: "apv", startDate: "2026-10-05" });

    const [resultA, resultB] = await Promise.all([
      GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: adminUser.id }),
      GenerationService.processSchedule(scheduleId, { triggerType: "SCHEDULED" }),
    ]);
    expect(resultA.status).toBe("SUCCESS");
    expect(resultB.status).toBe("SUCCESS");
    expect(resultA.occurrenceDate).not.toBe(resultB.occurrenceDate);
    generatedByModule.apv.push(resultA.generatedId, resultB.generatedId);

    for (const date of [resultA.occurrenceDate, resultB.occurrenceDate]) {
      const [occCount] = await pool.execute(
        "SELECT COUNT(*) AS c FROM recurring_transaction_occurrences WHERE schedule_id = ? AND occurrence_date = ?",
        [scheduleId, date]
      );
      expect(occCount[0].c).toBe(1);
    }
  });
});

describe("16: Occurrence-specific FX for a new module type", () => {
  const createdCurrencyIds = [];

  afterAll(async () => {
    // transaction_currency_snapshots must go first (FK to currencies) - the
    // generated APV's own snapshot row is deleted here rather than left for
    // the outer file-level afterAll, since Jest runs this inner afterAll
    // BEFORE the outer one (registration order is innermost-first).
    for (const currencyId of createdCurrencyIds) {
      await pool.execute("DELETE FROM transaction_currency_snapshots WHERE currency_id = ?", [currencyId]);
      await pool.execute("DELETE FROM recurring_transaction_templates WHERE currency_id = ?", [currencyId]);
      await pool.execute("DELETE FROM currency_rates WHERE currency_id = ?", [currencyId]);
      await pool.execute("DELETE FROM currencies WHERE id = ?", [currencyId]);
    }
  });

  test("Recurring APV in a foreign currency resolves its own occurrence rate fresh, converts to base correctly", async () => {
    const eur = await CurrencyService.createCurrency(adminUser, {
      currencyCode: "EUR", currencyName: "Euro (X6 FX test)", currencySymbol: "€",
      decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "MANUAL", companyId,
    });
    createdCurrencyIds.push(eur.id);
    await CurrencyService.recordRate(adminUser, eur.id, { rateMode: "MANUAL", rate: 60.0, effectiveDate: "2026-10-01" });

    const created = await TemplateService.createTemplate(
      {
        moduleType: "apv", templateName: `Test Recurring X6 apv-fx ${Date.now()}`,
        partyId: supplierId, partyName: "Test X6 Supplier", descriptionTemplate: "x",
        currencyId: eur.id, ratePolicy: "RESOLVE_ON_GENERATION", amountMode: "FIXED", amountConfig: {},
        dueDateRule: { mode: "SAME_AS_TRANSACTION_DATE" },
        lines: [
          { accountId: expenseAccountId, accountCode: "TESTX6EXP", accountTitle: "Expense", debit: 100, credit: 0 },
          { accountId: apAccountId, accountCode: "TESTX6AP", accountTitle: "AP", debit: 0, credit: 100 },
        ],
        schedule: { frequency: "MONTHLY", startDate: "2026-10-01", dateAdjustmentRule: "KEEP_ORIGINAL" },
      },
      adminUser.id, companyId
    );
    const result = await GenerationService.processSchedule(created.scheduleId, { triggerType: "MANUAL", userId: adminUser.id });
    expect(result.status).toBe("SUCCESS");
    generatedByModule.apv.push(result.generatedId);

    const [rows] = await pool.execute("SELECT total_debit AS totalDebit, currency_id AS currencyId FROM apv_headers WHERE id = ?", [result.generatedId]);
    expect(rows[0].currencyId).toBe(eur.id);
    expect(Number(rows[0].totalDebit)).toBeCloseTo(6000, 2); // 100 EUR * 60.00
  });
});

describe("17: Invoice recurring behavior has no regression", () => {
  test("Invoice recurring generation still works exactly as before - GENERATION_MODULE_CONFIG.invoice was not modified", async () => {
    const created = await TemplateService.createTemplate(
      {
        moduleType: "invoice", templateName: `Test Recurring X6 invoice-regression ${Date.now()}`,
        partyId: customerId, partyName: "Test X6 Customer", descriptionTemplate: "x",
        currencyId: null, amountMode: "FIXED", amountConfig: {},
        dueDateRule: { mode: "SAME_AS_TRANSACTION_DATE" },
        lines: [
          { accountId: arAccountId, accountCode: "TESTX6AR", accountTitle: "AR", debit: 500, credit: 0 },
          { accountId: revenueAccountId, accountCode: "TESTX6REV", accountTitle: "Revenue", debit: 0, credit: 500 },
        ],
        schedule: { frequency: "MONTHLY", startDate: "2026-10-01", dateAdjustmentRule: "KEEP_ORIGINAL" },
      },
      adminUser.id, companyId
    );
    const result = await GenerationService.processSchedule(created.scheduleId, { triggerType: "MANUAL", userId: adminUser.id });
    expect(result.status).toBe("SUCCESS");
    generatedByModule.invoice.push(result.generatedId);
    expect(result.voucherNo).toMatch(/^INV-REC-\d{6}-\d{4}$/);

    const [rows] = await pool.execute("SELECT status, customer_id AS customerId FROM invoice_headers WHERE id = ?", [result.generatedId]);
    expect(rows[0].status).toBe("Draft");
    expect(rows[0].customerId).toBe(customerId);
  });
});

describe("18: OR/CV settlement duplicate-tax protections remain unchanged", () => {
  test("Recurring generation for OR/CV never creates a transaction_applications row - the settlement-duplication protection surface is structurally untouched", async () => {
    // Already directly asserted per-generation in describe block 4-7 above;
    // this is the aggregate confirmation across every OR/CV row this file
    // generated - zero application rows for ANY of them.
    const orIds = generatedByModule.or;
    const cvIds = generatedByModule.cv;
    if (orIds.length) {
      const [apps] = await pool.query("SELECT COUNT(*) AS c FROM transaction_applications WHERE applied_type = 'OR' AND applied_id IN (?)", [orIds]);
      expect(apps[0].c).toBe(0);
    }
    if (cvIds.length) {
      const [apps] = await pool.query("SELECT COUNT(*) AS c FROM transaction_applications WHERE applied_type = 'CV' AND applied_id IN (?)", [cvIds]);
      expect(apps[0].c).toBe(0);
    }
  });
});

// 15: Closed-period behavior for a new module type. Deliberately placed
// LAST in this file: inserting an accounting_periods row for `companyId`
// makes that company "opt in" to period management for the rest of this
// process's lifetime (see accountingPeriodService.js's own documented
// policy) - every OTHER test in this file generates transactions dated
// outside 2027-01 and would start failing with ACCOUNTING_PERIOD_NOT_
// CONFIGURED if this ran earlier and left that opt-in behind for them.
describe("15: Closed-period behavior for a new module type", () => {
  test("A due JV occurrence landing in a closed period is recorded as PERIOD_CLOSED, not silently generated or skipped", async () => {
    await pool.execute(
      `INSERT INTO accounting_periods (company_id, year, period_month, start_date, end_date, status, created_by)
       VALUES (?, 2027, 1, '2027-01-01', '2027-01-31', 'CLOSED', ?)`,
      [companyId, adminUser.id]
    );

    const { scheduleId } = await createRecurringTemplate({ moduleType: "jv", startDate: "2027-01-15" });
    const result = await GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: adminUser.id });
    expect(result.status).toBe("PERIOD_CLOSED");
    expect(result.occurrenceId).toBeTruthy();

    const [occ] = await pool.execute(
      "SELECT status, generated_transaction_id AS gid FROM recurring_transaction_occurrences WHERE id = ?",
      [result.occurrenceId]
    );
    expect(occ[0].status).toBe("PERIOD_CLOSED");
    expect(occ[0].gid).toBeNull(); // no JV was actually created for the closed period
  });
});
