const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Phase 3B: proves the new read-only preview/built-in endpoints. Preview
// must never write anything, must validate config through the exact same
// Phase 2 validator create/update use, and must be gated by the real
// transaction's own PRINT permission (not PRINT.DOCUMENT_TEMPLATES) so it
// can never become a side-door into another company's data or a wider
// config surface than create/update already allow.

jest.setTimeout(180000);

let companyAId, companyBId;
let tokenA, tokenB, adminAId, adminBId;
let cashA, arA, revA;
let custAId;
let invoiceAId, orAId;

const TEST_COMPANY_NAME_PATTERN = "TEST Print Preview%";
const TEST_USERNAME_PATTERN = "test_ptprev%";
const TEST_ACCOUNT_CODE_PATTERN = "TESTPTPREV%";

async function cleanupAllStaleFixtures() {
  const [staleCompanies] = await pool.query("SELECT id FROM companies WHERE name LIKE ?", [TEST_COMPANY_NAME_PATTERN]);
  const staleCompanyIds = staleCompanies.map((r) => r.id);

  if (staleCompanyIds.length) {
    await pool.query("DELETE FROM document_print_templates WHERE company_id IN (?)", [staleCompanyIds]);
    await pool.query("DELETE FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoice_headers WHERE company_id IN (?))", [staleCompanyIds]);
    await pool.query("DELETE FROM or_lines WHERE or_id IN (SELECT id FROM or_headers WHERE company_id IN (?))", [staleCompanyIds]);
    await pool.query(
      "DELETE FROM transaction_currency_snapshots WHERE (transaction_type = 'INV' AND transaction_id IN (SELECT id FROM invoice_headers WHERE company_id IN (?))) OR (transaction_type = 'OR' AND transaction_id IN (SELECT id FROM or_headers WHERE company_id IN (?)))",
      [staleCompanyIds, staleCompanyIds]
    );
    await pool.query("DELETE FROM transaction_applications WHERE applied_type = 'OR' AND applied_id IN (SELECT id FROM or_headers WHERE company_id IN (?))", [staleCompanyIds]);
    await pool.query("DELETE FROM or_headers WHERE company_id IN (?)", [staleCompanyIds]);
    await pool.query("DELETE FROM invoice_headers WHERE company_id IN (?)", [staleCompanyIds]);
    await pool.query("DELETE FROM currencies WHERE company_id IN (?)", [staleCompanyIds]);
    await pool.query("DELETE FROM general_libraries WHERE company_id IN (?)", [staleCompanyIds]);
    await pool.query("DELETE FROM user_companies WHERE company_id IN (?)", [staleCompanyIds]);
  }

  const [staleUsers] = await pool.query("SELECT id FROM users WHERE username LIKE ?", [TEST_USERNAME_PATTERN]);
  const staleUserIds = staleUsers.map((r) => r.id);
  if (staleUserIds.length) {
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [staleUserIds]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [staleUserIds]);
  }

  if (staleCompanyIds.length) {
    await pool.query("DELETE FROM companies WHERE id IN (?)", [staleCompanyIds]);
  }

  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE ?", [TEST_ACCOUNT_CODE_PATTERN]);
}

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
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, companyId]);
  return userId;
}
async function makeAccount(code, title, cls) {
  const [existing] = await pool.execute("SELECT id FROM chart_of_accounts WHERE code = ?", [code]);
  if (existing.length) return existing[0].id;
  const [result] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, cls]
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

beforeAll(async () => {
  assertNotProductionDatabase();
  await cleanupAllStaleFixtures();

  companyAId = await makeCompany("TEST Print Preview Co A");
  companyBId = await makeCompany("TEST Print Preview Co B");
  adminAId = await makeLoginUser("test_ptprev_admin_a", "PtprevPass!A1", 2, companyAId);
  adminBId = await makeLoginUser("test_ptprev_admin_b", "PtprevPass!B1", 2, companyBId);
  tokenA = await loginAs("test_ptprev_admin_a", "PtprevPass!A1");
  tokenB = await loginAs("test_ptprev_admin_b", "PtprevPass!B1");

  cashA = await makeAccount("TESTPTPREVCASH", "Cash (Print Preview Test)", "ASSET");
  arA = await makeAccount("TESTPTPREVAR", "Accounts Receivable (Print Preview Test)", "ASSET");
  revA = await makeAccount("TESTPTPREVREV", "Revenue (Print Preview Test)", "INCOME");
  custAId = await makeParty("TESTPTPREV-CUSTA", "CUSTOMER", "Print Preview Test Customer A", companyAId);

  const CurrencyService = require("../services/currencyService");
  await CurrencyService.createCurrency({ id: adminAId, roleCode: "ADMIN" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: companyAId,
  });
  await CurrencyService.createCurrency({ id: adminBId, roleCode: "ADMIN" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: companyBId,
  });

  const invRes = await request(app).post("/api/invoices").set("Authorization", `Bearer ${tokenA}`).send({
    voucherNo: "TESTPTPREV-INV-1", customerId: custAId, customerName: "x", transactionDate: "2026-08-01", dueDate: "2026-08-08",
    status: "Posted",
    lines: [
      { accountId: arA, accountCode: "TESTPTPREVAR", accountTitle: "AR", particulars: "x", debit: 5000, credit: 0 },
      { accountId: revA, accountCode: "TESTPTPREVREV", accountTitle: "Revenue", particulars: "x", debit: 0, credit: 5000 },
    ],
    totalDebit: 5000, totalCredit: 5000, currency: { companyId: companyAId },
  });
  invoiceAId = invRes.body.id;

  const orRes = await request(app).post("/api/or").set("Authorization", `Bearer ${tokenA}`).send({
    voucherNo: "TESTPTPREV-OR-1", customerId: custAId, customerName: "x", transactionDate: "2026-08-05", status: "Posted",
    lines: [
      { accountId: cashA, accountCode: "TESTPTPREVCASH", accountTitle: "Cash", particulars: "x", debit: 5000, credit: 0 },
      { accountId: arA, accountCode: "TESTPTPREVAR", accountTitle: "AR", particulars: "x", debit: 0, credit: 5000 },
    ],
    totalDebit: 5000, totalCredit: 5000, currency: { companyId: companyAId },
    invoiceApplications: [{ sourceId: invoiceAId, amount: 5000, applicationDate: "2026-08-05" }],
  });
  orAId = orRes.body.id;
});

afterAll(async () => {
  try {
    await cleanupAllStaleFixtures();
  } finally {
    await pool.end();
  }
});

describe("1-2: valid unsaved-config preview", () => {
  test("1: valid Invoice preview returns real accounting data + normalized config, no template saved", async () => {
    const res = await request(app).post("/api/print-templates/preview").set("Authorization", `Bearer ${tokenA}`).send({
      moduleType: "invoice",
      transactionId: invoiceAId,
      config: { header: { documentTitle: "PREVIEW TITLE" } },
    });
    expect(res.status).toBe(200);
    expect(res.body.doc.voucherNo).toBe("TESTPTPREV-INV-1");
    expect(Number(res.body.doc.totalDebit)).toBe(5000);
    expect(res.body.templateConfig.header.documentTitle).toBe("PREVIEW TITLE");
    // Fields not supplied still resolve from the built-in default, exactly
    // like create/update's own merge behavior.
    expect(res.body.templateConfig.party.sectionLabel).toBe("Bill To");
    expect(res.body.templateMeta.source).toBe("preview");
  });

  test("2: valid OR preview includes real applied-invoice data and normalized config", async () => {
    const res = await request(app).post("/api/print-templates/preview").set("Authorization", `Bearer ${tokenA}`).send({
      moduleType: "or",
      transactionId: orAId,
      config: { party: { sectionLabel: "COLLECTED FROM" } },
    });
    expect(res.status).toBe(200);
    expect(res.body.appliedInvoices).toHaveLength(1);
    expect(res.body.appliedInvoices[0].invoiceNo).toBe("TESTPTPREV-INV-1");
    expect(res.body.templateConfig.party.sectionLabel).toBe("COLLECTED FROM");
  });
});

describe("3: preview performs no DB write", () => {
  test("no document_print_templates row is created by preview", async () => {
    const [before] = await pool.query("SELECT COUNT(*) c FROM document_print_templates WHERE company_id = ?", [companyAId]);
    await request(app).post("/api/print-templates/preview").set("Authorization", `Bearer ${tokenA}`).send({
      moduleType: "invoice", transactionId: invoiceAId, config: { header: { documentTitle: "NO WRITE CHECK" } },
    });
    const [after] = await pool.query("SELECT COUNT(*) c FROM document_print_templates WHERE company_id = ?", [companyAId]);
    expect(after[0].c).toBe(before[0].c);
  });

  test("the transaction's own accounting data is unchanged after preview", async () => {
    await request(app).post("/api/print-templates/preview").set("Authorization", `Bearer ${tokenA}`).send({
      moduleType: "invoice", transactionId: invoiceAId, config: { header: { documentTitle: "ANOTHER PREVIEW" } },
    });
    const [rows] = await pool.query("SELECT total_debit, total_credit, voucher_no FROM invoice_headers WHERE id = ?", [invoiceAId]);
    expect(Number(rows[0].total_debit)).toBe(5000);
    expect(Number(rows[0].total_credit)).toBe(5000);
    expect(rows[0].voucher_no).toBe("TESTPTPREV-INV-1");
  });
});

describe("4-6: config validation reuses the exact Phase 2 validator", () => {
  test("4: invalid config type rejected", async () => {
    const res = await request(app).post("/api/print-templates/preview").set("Authorization", `Bearer ${tokenA}`).send({
      moduleType: "invoice", transactionId: invoiceAId, config: { header: { showCompanyName: "yes" } },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/showCompanyName must be true or false/);
  });

  test("5: unknown config key rejected", async () => {
    const res = await request(app).post("/api/print-templates/preview").set("Authorization", `Bearer ${tokenA}`).send({
      moduleType: "invoice", transactionId: invoiceAId, config: { customCss: "body{color:red}" },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Unsupported config section/);
  });

  test("6: cross-module config (appliedInvoiceColumns) rejected for Invoice", async () => {
    const res = await request(app).post("/api/print-templates/preview").set("Authorization", `Bearer ${tokenA}`).send({
      moduleType: "invoice",
      transactionId: invoiceAId,
      config: { table: { appliedInvoiceColumns: [{ key: "invoiceNo", label: "No." }] } },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/only supported for the OR module/);
  });
});

describe("7: company isolation", () => {
  test("Company B cannot preview Company A's Invoice transaction", async () => {
    const res = await request(app).post("/api/print-templates/preview").set("Authorization", `Bearer ${tokenB}`).send({
      moduleType: "invoice", transactionId: invoiceAId, companyId: companyBId, config: {},
    });
    expect(res.status).toBe(404);
  });
});

describe("8-9: preview requires the real transaction PRINT permission, not PRINT.DOCUMENT_TEMPLATES", () => {
  test("8: a user without TRANSACTIONS.INVOICE.PRINT cannot preview an Invoice", async () => {
    const [[perm]] = await pool.query("SELECT id FROM permissions WHERE module_key = 'TRANSACTIONS.INVOICE' AND action = 'PRINT'");
    await pool.execute("UPDATE role_permissions SET granted = 0 WHERE role_id = 3 AND permission_id = ?", [perm.id]);
    try {
      const hash = await bcrypt.hash("PtprevPass!D1", 10);
      const [userResult] = await pool.execute(
        "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, 3, 'ACTIVE')",
        ["test_ptprev_noprint", hash]
      );
      const noprintUserId = userResult.insertId;
      await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [noprintUserId, companyAId]);
      const noprintToken = await loginAs("test_ptprev_noprint", "PtprevPass!D1");

      const res = await request(app).post("/api/print-templates/preview").set("Authorization", `Bearer ${noprintToken}`).send({
        moduleType: "invoice", transactionId: invoiceAId, config: {},
      });
      expect(res.status).toBe(403);

      await pool.query("DELETE FROM user_companies WHERE user_id = ?", [noprintUserId]);
      await pool.query("DELETE FROM users WHERE id = ?", [noprintUserId]);
    } finally {
      await pool.execute("UPDATE role_permissions SET granted = 1 WHERE role_id = 3 AND permission_id = ?", [perm.id]);
    }
  });

  test("9: a user without TRANSACTIONS.OR.PRINT cannot preview an OR", async () => {
    const [[perm]] = await pool.query("SELECT id FROM permissions WHERE module_key = 'TRANSACTIONS.OR' AND action = 'PRINT'");
    await pool.execute("UPDATE role_permissions SET granted = 0 WHERE role_id = 3 AND permission_id = ?", [perm.id]);
    try {
      const hash = await bcrypt.hash("PtprevPass!E1", 10);
      const [userResult] = await pool.execute(
        "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, 3, 'ACTIVE')",
        ["test_ptprev_noprint_or", hash]
      );
      const noprintUserId = userResult.insertId;
      await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [noprintUserId, companyAId]);
      const noprintToken = await loginAs("test_ptprev_noprint_or", "PtprevPass!E1");

      const res = await request(app).post("/api/print-templates/preview").set("Authorization", `Bearer ${noprintToken}`).send({
        moduleType: "or", transactionId: orAId, config: {},
      });
      expect(res.status).toBe(403);

      await pool.query("DELETE FROM user_companies WHERE user_id = ?", [noprintUserId]);
      await pool.query("DELETE FROM users WHERE id = ?", [noprintUserId]);
    } finally {
      await pool.execute("UPDATE role_permissions SET granted = 1 WHERE role_id = 3 AND permission_id = ?", [perm.id]);
    }
  });
});

describe("10-12: built-in default endpoint", () => {
  test("10: built-in Invoice config endpoint returns the module's own default shape", async () => {
    const res = await request(app).get("/api/print-templates/built-in?moduleType=invoice").set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.moduleType).toBe("invoice");
    expect(res.body.source).toBe("built_in");
    expect(res.body.config.party.sectionLabel).toBe("Bill To");
    expect(res.body.config.table.columns).toEqual([
      { key: "description", label: "Description" },
      { key: "amount", label: "Amount" },
    ]);
  });

  test("11: built-in OR config endpoint returns the module's own default shape", async () => {
    const res = await request(app).get("/api/print-templates/built-in?moduleType=or").set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.moduleType).toBe("or");
    expect(res.body.config.party.sectionLabel).toBe("Received From");
    expect(res.body.config.summary.showAmountInWords).toBe(true);
  });

  test("12: unsupported module rejected on both preview and built-in", async () => {
    const previewRes = await request(app).post("/api/print-templates/preview").set("Authorization", `Bearer ${tokenA}`).send({
      moduleType: "apv", transactionId: 1, config: {},
    });
    expect(previewRes.status).toBe(400);
    expect(previewRes.body.message).toMatch(/Unsupported print-template module type/);

    const builtInRes = await request(app).get("/api/print-templates/built-in?moduleType=apv").set("Authorization", `Bearer ${tokenA}`);
    expect(builtInRes.status).toBe(400);
    expect(builtInRes.body.message).toMatch(/Unsupported print-template module type/);
  });
});
