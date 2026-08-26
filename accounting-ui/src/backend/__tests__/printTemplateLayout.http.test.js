const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Phase 3C (Activate Section Reordering + Spacing/Alignment Presets).
// documentPdfBuilder.js's own section-dispatch/normalization logic is
// frontend-only client code with a pdf-lib dependency that is known,
// documented, and untestable under this repo's Jest setup (the same
// "Unexpected export statement in CJS module" failure the Phase 1
// checkpoint hit and resolved by relying on live/manual PDF generation +
// visual inspection instead of a Jest unit test - see that checkpoint's
// completion report). This file instead proves everything that genuinely
// IS backend-testable: the layout schema's existing (unchanged)
// validation rules, the built-in default's own section order, that an
// unsaved-config preview correctly carries a custom layout through to the
// same payload the renderer consumes, and that none of it ever touches
// accounting data. The renderer's own behavior (order actually changes,
// spacing/alignment actually render, no page-break regressions) is
// verified separately via live Playwright + rasterized-PDF visual
// inspection, per this engagement's established pattern for untestable
// client-side PDF code.

jest.setTimeout(180000);

let companyAId, companyBId;
let tokenA, tokenB, adminAId, adminBId;
let cashA, arA, revA;
let custAId;
let invoiceAId;

const TEST_COMPANY_NAME_PATTERN = "TEST Print Layout%";
const TEST_USERNAME_PATTERN = "test_ptlayout%";
const TEST_ACCOUNT_CODE_PATTERN = "TESTPTLAYOUT%";

async function cleanupAllStaleFixtures() {
  const [staleCompanies] = await pool.query("SELECT id FROM companies WHERE name LIKE ?", [TEST_COMPANY_NAME_PATTERN]);
  const staleCompanyIds = staleCompanies.map((r) => r.id);

  if (staleCompanyIds.length) {
    await pool.query("DELETE FROM document_print_templates WHERE company_id IN (?)", [staleCompanyIds]);
    await pool.query("DELETE FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoice_headers WHERE company_id IN (?))", [staleCompanyIds]);
    await pool.query(
      "DELETE FROM transaction_currency_snapshots WHERE transaction_type = 'INV' AND transaction_id IN (SELECT id FROM invoice_headers WHERE company_id IN (?))",
      [staleCompanyIds]
    );
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

  companyAId = await makeCompany("TEST Print Layout Co A");
  companyBId = await makeCompany("TEST Print Layout Co B");
  adminAId = await makeLoginUser("test_ptlayout_admin_a", "PtLayoutPass!A1", 2, companyAId);
  adminBId = await makeLoginUser("test_ptlayout_admin_b", "PtLayoutPass!B1", 2, companyBId);
  tokenA = await loginAs("test_ptlayout_admin_a", "PtLayoutPass!A1");
  tokenB = await loginAs("test_ptlayout_admin_b", "PtLayoutPass!B1");

  cashA = await makeAccount("TESTPTLAYOUTCASH", "Cash (Print Layout Test)", "ASSET");
  arA = await makeAccount("TESTPTLAYOUTAR", "Accounts Receivable (Print Layout Test)", "ASSET");
  revA = await makeAccount("TESTPTLAYOUTREV", "Revenue (Print Layout Test)", "INCOME");
  custAId = await makeParty("TESTPTLAYOUT-CUSTA", "CUSTOMER", "Print Layout Test Customer A", companyAId);

  const CurrencyService = require("../services/currencyService");
  await CurrencyService.createCurrency({ id: adminAId, roleCode: "ADMIN" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: companyAId,
  });

  const invRes = await request(app).post("/api/invoices").set("Authorization", `Bearer ${tokenA}`).send({
    voucherNo: "TESTPTLAYOUT-INV-1", customerId: custAId, customerName: "x", transactionDate: "2026-08-01", dueDate: "2026-08-08",
    status: "Posted",
    lines: [
      { accountId: arA, accountCode: "TESTPTLAYOUTAR", accountTitle: "AR", particulars: "x", debit: 6600, credit: 0 },
      { accountId: revA, accountCode: "TESTPTLAYOUTREV", accountTitle: "Revenue", particulars: "x", debit: 0, credit: 6600 },
    ],
    totalDebit: 6600, totalCredit: 6600, currency: { companyId: companyAId },
  });
  invoiceAId = invRes.body.id;
});

afterAll(async () => {
  try {
    await cleanupAllStaleFixtures();
  } finally {
    await pool.end();
  }
});

async function createTemplate(token, body) {
  return request(app).post("/api/print-templates").set("Authorization", `Bearer ${token}`).send(body);
}

describe("1-2: built-in default section order unchanged", () => {
  test("1: built-in Invoice order matches the pre-Phase-3C production sequence", async () => {
    const res = await request(app).get("/api/print-templates/built-in?moduleType=invoice").set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.config.layout.sectionOrder).toEqual(["header", "meta", "party", "table", "summary"]);
    expect(res.body.config.layout.spacingPreset).toBe("normal");
    expect(res.body.config.layout.alignmentPreset).toBe("left");
  });

  test("2: built-in OR order matches the pre-Phase-3C production sequence", async () => {
    const res = await request(app).get("/api/print-templates/built-in?moduleType=or").set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.config.layout.sectionOrder).toEqual(["header", "meta", "party", "appliedInvoices", "table", "summary"]);
  });
});

describe("3-4: custom section order respected", () => {
  test("3: a custom Invoice section order round-trips exactly through create+read", async () => {
    const customOrder = ["summary", "table", "party", "meta", "header"];
    const created = await createTemplate(tokenA, {
      moduleType: "invoice", templateCode: "ptlayout-custom-order-inv", templateName: "Custom Order Invoice",
      documentVariant: "sales_invoice", config: { layout: { sectionOrder: customOrder } },
    });
    expect(created.status).toBe(201);
    expect(created.body.config.layout.sectionOrder).toEqual(customOrder);

    const read = await request(app).get(`/api/print-templates/${created.body.id}`).set("Authorization", `Bearer ${tokenA}`);
    expect(read.body.config.layout.sectionOrder).toEqual(customOrder);
  });

  test("4: a custom OR section order (moving appliedInvoices) round-trips exactly", async () => {
    const customOrder = ["header", "appliedInvoices", "party", "meta", "table", "summary"];
    const created = await createTemplate(tokenA, {
      moduleType: "or", templateCode: "ptlayout-custom-order-or", templateName: "Custom Order OR",
      documentVariant: "official_receipt", config: { layout: { sectionOrder: customOrder } },
    });
    expect(created.status).toBe(201);
    expect(created.body.config.layout.sectionOrder).toEqual(customOrder);
  });
});

describe("5-6: duplicate/unsupported section keys", () => {
  test("5: duplicate section key rejected (existing validator rule, now exercised)", async () => {
    const res = await createTemplate(tokenA, {
      moduleType: "invoice", templateCode: "ptlayout-dup", templateName: "Bad", documentVariant: "sales_invoice",
      config: { layout: { sectionOrder: ["header", "meta", "header", "party", "table", "summary"] } },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/lists section "header" more than once/);
  });

  test("6: unsupported section key rejected (\"footer\" is deliberately not in the Phase 2 whitelist)", async () => {
    const res = await createTemplate(tokenA, {
      moduleType: "invoice", templateCode: "ptlayout-unsupported", templateName: "Bad", documentVariant: "sales_invoice",
      config: { layout: { sectionOrder: ["header", "footer"] } },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/unsupported section "footer"/);
  });
});

describe("7: spacing/alignment preset validation", () => {
  test("valid spacingPreset + alignmentPreset save correctly", async () => {
    const res = await createTemplate(tokenA, {
      moduleType: "invoice", templateCode: "ptlayout-spacing-valid", templateName: "Compact Centered",
      documentVariant: "sales_invoice", config: { layout: { spacingPreset: "compact", alignmentPreset: "center" } },
    });
    expect(res.status).toBe(201);
    expect(res.body.config.layout.spacingPreset).toBe("compact");
    expect(res.body.config.layout.alignmentPreset).toBe("center");
    // Omitted sectionOrder still falls back to the module's built-in order
    // (partial layout config falls back safely).
    expect(res.body.config.layout.sectionOrder).toEqual(["header", "meta", "party", "table", "summary"]);
  });

  test("invalid spacingPreset rejected", async () => {
    const res = await createTemplate(tokenA, {
      moduleType: "invoice", templateCode: "ptlayout-spacing-invalid", templateName: "Bad", documentVariant: "sales_invoice",
      config: { layout: { spacingPreset: "cozy" } },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/spacingPreset must be one of/);
  });

  test("invalid alignmentPreset rejected", async () => {
    const res = await createTemplate(tokenA, {
      moduleType: "invoice", templateCode: "ptlayout-alignment-invalid", templateName: "Bad", documentVariant: "sales_invoice",
      config: { layout: { alignmentPreset: "justify" } },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/alignmentPreset must be one of/);
  });
});

describe("8-9: unsaved-config preview honors a custom section order", () => {
  test("8: Invoice preview reflects the exact unsaved sectionOrder sent", async () => {
    const customOrder = ["party", "header", "meta", "table", "summary"];
    const res = await request(app).post("/api/print-templates/preview").set("Authorization", `Bearer ${tokenA}`).send({
      moduleType: "invoice", transactionId: invoiceAId, config: { layout: { sectionOrder: customOrder, spacingPreset: "relaxed" } },
    });
    expect(res.status).toBe(200);
    expect(res.body.templateConfig.layout.sectionOrder).toEqual(customOrder);
    expect(res.body.templateConfig.layout.spacingPreset).toBe("relaxed");
  });

  test("9: preview rejects the same invalid layout values create/update would reject", async () => {
    const res = await request(app).post("/api/print-templates/preview").set("Authorization", `Bearer ${tokenA}`).send({
      moduleType: "invoice", transactionId: invoiceAId, config: { layout: { sectionOrder: ["header", "header"] } },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/more than once/);
  });
});

describe("10: layout changes never affect accounting values", () => {
  test("accounting payload is byte-identical between built-in order and a fully reordered/relaxed/centered layout", async () => {
    const withoutLayout = await request(app).post("/api/print-templates/preview").set("Authorization", `Bearer ${tokenA}`).send({
      moduleType: "invoice", transactionId: invoiceAId, config: {},
    });
    const withLayout = await request(app).post("/api/print-templates/preview").set("Authorization", `Bearer ${tokenA}`).send({
      moduleType: "invoice", transactionId: invoiceAId,
      config: { layout: { sectionOrder: ["summary", "table", "party", "meta", "header"], spacingPreset: "relaxed", alignmentPreset: "center" } },
    });
    expect(withLayout.status).toBe(200);
    expect(withLayout.body.doc.totalDebit).toBe(withoutLayout.body.doc.totalDebit);
    expect(withLayout.body.doc.totalCredit).toBe(withoutLayout.body.doc.totalCredit);
    expect(withLayout.body.doc.voucherNo).toBe(withoutLayout.body.doc.voucherNo);
    expect(withLayout.body.doc.transactionDate).toBe(withoutLayout.body.doc.transactionDate);
    expect(withLayout.body.doc.status).toBe(withoutLayout.body.doc.status);
    expect(withLayout.body.doc.currency).toEqual(withoutLayout.body.doc.currency);
    expect(withLayout.body.lines).toEqual(withoutLayout.body.lines);
    // Only the presentation layer differs.
    expect(withLayout.body.templateConfig.layout).not.toEqual(withoutLayout.body.templateConfig.layout);
  });
});

describe("11: company isolation for layout-bearing templates", () => {
  test("Company B cannot read Company A's custom-order template", async () => {
    const created = await createTemplate(tokenA, {
      moduleType: "invoice", templateCode: "ptlayout-isolation", templateName: "Isolation Check",
      documentVariant: "sales_invoice", config: { layout: { sectionOrder: ["summary", "header", "meta", "party", "table"] } },
    });
    const res = await request(app).get(`/api/print-templates/${created.body.id}`).set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
  });
});
