const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Phase 3D (Column Configuration UI). Same discipline as
// printTemplateLayout.http.test.js's own header note: the Column Editor
// UI and the renderer's actual column drawing (computeColumnLayout, wrap
// behavior, width redistribution) live in frontend/pdf-lib code that is
// known, documented, and untestable under this repo's Jest setup - proven
// separately via live Playwright + rasterized-PDF visual inspection. This
// file proves everything genuinely backend-testable: the column
// whitelist/validation rules Phase 2 already shipped (show/hide is simply
// "present in the array or not", relabel is the `label` field, reorder is
// array order - no new backend code was needed for Phase 3D, only a
// frontend UI on top of infrastructure that already existed), and that
// none of it ever touches accounting data.

jest.setTimeout(180000);

let companyAId, companyBId;
let tokenA, tokenB, adminAId, adminBId;
let cashA, arA, revA;
let custAId;
let invoiceAId;
let orWithAppliedInvoiceAId;
let orDirectAId;
let orLongInvoiceNoAId;
let orMultiLongInvoiceNoAId;

const TEST_COMPANY_NAME_PATTERN = "TEST Print Columns%";
const TEST_USERNAME_PATTERN = "test_ptcol%";
const TEST_ACCOUNT_CODE_PATTERN = "TESTPTCOL%";

async function cleanupAllStaleFixtures() {
  const [staleCompanies] = await pool.query("SELECT id FROM companies WHERE name LIKE ?", [TEST_COMPANY_NAME_PATTERN]);
  const staleCompanyIds = staleCompanies.map((r) => r.id);

  if (staleCompanyIds.length) {
    await pool.query("DELETE FROM document_print_templates WHERE company_id IN (?)", [staleCompanyIds]);
    await pool.query(
      "DELETE FROM transaction_applications WHERE applied_type = 'OR' AND applied_id IN (SELECT id FROM or_headers WHERE company_id IN (?))",
      [staleCompanyIds]
    );
    await pool.query("DELETE FROM or_lines WHERE or_id IN (SELECT id FROM or_headers WHERE company_id IN (?))", [staleCompanyIds]);
    await pool.query(
      "DELETE FROM transaction_currency_snapshots WHERE transaction_type = 'OR' AND transaction_id IN (SELECT id FROM or_headers WHERE company_id IN (?))",
      [staleCompanyIds]
    );
    await pool.query("DELETE FROM or_headers WHERE company_id IN (?)", [staleCompanyIds]);
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
  return res.body.token;
}

beforeAll(async () => {
  assertNotProductionDatabase();
  await cleanupAllStaleFixtures();

  companyAId = await makeCompany("TEST Print Columns Co A");
  companyBId = await makeCompany("TEST Print Columns Co B");
  adminAId = await makeLoginUser("test_ptcol_admin_a", "PtColPass!A1", 2, companyAId);
  adminBId = await makeLoginUser("test_ptcol_admin_b", "PtColPass!B1", 2, companyBId);
  tokenA = await loginAs("test_ptcol_admin_a", "PtColPass!A1");
  tokenB = await loginAs("test_ptcol_admin_b", "PtColPass!B1");

  cashA = await makeAccount("TESTPTCOLCASH", "Cash (Print Columns Test)", "ASSET");
  arA = await makeAccount("TESTPTCOLAR", "Accounts Receivable (Print Columns Test)", "ASSET");
  revA = await makeAccount("TESTPTCOLREV", "Revenue (Print Columns Test)", "INCOME");
  custAId = await makeParty("TESTPTCOL-CUSTA", "CUSTOMER", "Print Columns Test Customer A", companyAId);

  const CurrencyService = require("../services/currencyService");
  await CurrencyService.createCurrency({ id: adminAId, roleCode: "ADMIN" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: companyAId,
  });

  const invRes = await request(app).post("/api/invoices").set("Authorization", `Bearer ${tokenA}`).send({
    voucherNo: "TESTPTCOL-INV-1", customerId: custAId, customerName: "x", transactionDate: "2026-08-01", dueDate: "2026-08-08",
    status: "Posted",
    lines: [
      { accountId: arA, accountCode: "TESTPTCOLAR", accountTitle: "AR", particulars: "x", debit: 7700, credit: 0 },
      { accountId: revA, accountCode: "TESTPTCOLREV", accountTitle: "Revenue", particulars: "x", debit: 0, credit: 7700 },
    ],
    totalDebit: 7700, totalCredit: 7700, currency: { companyId: companyAId },
  });
  invoiceAId = invRes.body.id;

  // Settlement OR with one applied invoice (source-invoice voucher kept
  // short and predictable so the "amounts unchanged" test has a clean
  // number to assert against).
  const invForOrRes = await request(app).post("/api/invoices").set("Authorization", `Bearer ${tokenA}`).send({
    voucherNo: "TESTPTCOL-INV-2", customerId: custAId, customerName: "x", transactionDate: "2026-08-01", dueDate: "2026-08-08",
    status: "Posted",
    lines: [
      { accountId: arA, accountCode: "TESTPTCOLAR", accountTitle: "AR", particulars: "x", debit: 3300, credit: 0 },
      { accountId: revA, accountCode: "TESTPTCOLREV", accountTitle: "Revenue", particulars: "x", debit: 0, credit: 3300 },
    ],
    totalDebit: 3300, totalCredit: 3300, currency: { companyId: companyAId },
  });
  const orRes = await request(app).post("/api/or").set("Authorization", `Bearer ${tokenA}`).send({
    voucherNo: "TESTPTCOL-OR-1", customerId: custAId, customerName: "x", transactionDate: "2026-08-10",
    status: "Posted", paymentMethod: "Cash",
    lines: [
      { accountId: cashA, accountCode: "TESTPTCOLCASH", accountTitle: "Cash", particulars: "x", debit: 3300, credit: 0 },
      { accountId: arA, accountCode: "TESTPTCOLAR", accountTitle: "AR", particulars: "x", debit: 0, credit: 3300 },
    ],
    totalDebit: 3300, totalCredit: 3300, currency: { companyId: companyAId },
    invoiceApplications: [{ sourceId: invForOrRes.body.id, amount: 3300, applicationDate: "2026-08-10" }],
  });
  orWithAppliedInvoiceAId = orRes.body.id;

  // Direct OR, no applications - control case for "unaffected by column config".
  const orDirectRes = await request(app).post("/api/or").set("Authorization", `Bearer ${tokenA}`).send({
    voucherNo: "TESTPTCOL-OR-2", customerId: custAId, customerName: "x", transactionDate: "2026-08-11",
    status: "Posted", paymentMethod: "Cash",
    lines: [
      { accountId: cashA, accountCode: "TESTPTCOLCASH", accountTitle: "Cash", particulars: "x", debit: 1500, credit: 0 },
      { accountId: revA, accountCode: "TESTPTCOLREV", accountTitle: "Revenue", particulars: "x", debit: 0, credit: 1500 },
    ],
    totalDebit: 1500, totalCredit: 1500, currency: { companyId: companyAId },
  });
  orDirectAId = orDirectRes.body.id;

  // Long invoice-number stress case (data-level): a source invoice with a
  // deliberately long voucher number, applied to its own OR - visual
  // wrapping/overlap is verified separately via rasterized PDF inspection,
  // but the DATA the renderer would receive is asserted here.
  const invLongRes = await request(app).post("/api/invoices").set("Authorization", `Bearer ${tokenA}`).send({
    voucherNo: "TESTPTCOL-VERY-LONG-INVOICE-NUMBER-0001", customerId: custAId, customerName: "x",
    transactionDate: "2026-08-01", dueDate: "2026-08-08", status: "Posted",
    lines: [
      { accountId: arA, accountCode: "TESTPTCOLAR", accountTitle: "AR", particulars: "x", debit: 2200, credit: 0 },
      { accountId: revA, accountCode: "TESTPTCOLREV", accountTitle: "Revenue", particulars: "x", debit: 0, credit: 2200 },
    ],
    totalDebit: 2200, totalCredit: 2200, currency: { companyId: companyAId },
  });
  const orLongRes = await request(app).post("/api/or").set("Authorization", `Bearer ${tokenA}`).send({
    voucherNo: "TESTPTCOL-OR-LONG-1", customerId: custAId, customerName: "x", transactionDate: "2026-08-12",
    status: "Posted", paymentMethod: "Cash",
    lines: [
      { accountId: cashA, accountCode: "TESTPTCOLCASH", accountTitle: "Cash", particulars: "x", debit: 2200, credit: 0 },
      { accountId: arA, accountCode: "TESTPTCOLAR", accountTitle: "AR", particulars: "x", debit: 0, credit: 2200 },
    ],
    totalDebit: 2200, totalCredit: 2200, currency: { companyId: companyAId },
    invoiceApplications: [{ sourceId: invLongRes.body.id, amount: 2200, applicationDate: "2026-08-12" }],
  });
  orLongInvoiceNoAId = orLongRes.body.id;

  // Standalone wrap fix: multiple long invoice numbers applied to one OR,
  // for the "multiple long Invoice numbers" data-level regression check.
  const longSources = [];
  let longMultiTotal = 0;
  for (let i = 1; i <= 3; i++) {
    const amt = 1000 * i;
    longMultiTotal += amt;
    const r = await request(app).post("/api/invoices").set("Authorization", `Bearer ${tokenA}`).send({
      voucherNo: `TESTPTCOL-VERY-LONG-INVOICE-NUMBER-MULTI-${i}-0001`, customerId: custAId, customerName: "x",
      transactionDate: "2026-08-01", dueDate: "2026-08-08", status: "Posted",
      lines: [
        { accountId: arA, accountCode: "TESTPTCOLAR", accountTitle: "AR", particulars: "x", debit: amt, credit: 0 },
        { accountId: revA, accountCode: "TESTPTCOLREV", accountTitle: "Revenue", particulars: "x", debit: 0, credit: amt },
      ],
      totalDebit: amt, totalCredit: amt, currency: { companyId: companyAId },
    });
    longSources.push({ id: r.body.id, amt });
  }
  const orMultiLongRes = await request(app).post("/api/or").set("Authorization", `Bearer ${tokenA}`).send({
    voucherNo: "TESTPTCOL-OR-MULTILONG-1", customerId: custAId, customerName: "x", transactionDate: "2026-08-13",
    status: "Posted", paymentMethod: "Cash",
    lines: [
      { accountId: cashA, accountCode: "TESTPTCOLCASH", accountTitle: "Cash", particulars: "x", debit: longMultiTotal, credit: 0 },
      { accountId: arA, accountCode: "TESTPTCOLAR", accountTitle: "AR", particulars: "x", debit: 0, credit: longMultiTotal },
    ],
    totalDebit: longMultiTotal, totalCredit: longMultiTotal, currency: { companyId: companyAId },
    invoiceApplications: longSources.map((s) => ({ sourceId: s.id, amount: s.amt, applicationDate: "2026-08-13" })),
  });
  orMultiLongInvoiceNoAId = orMultiLongRes.body.id;
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
async function preview(token, moduleType, transactionId, config) {
  return request(app).post("/api/print-templates/preview").set("Authorization", `Bearer ${token}`).send({ moduleType, transactionId, config });
}

describe("1-2: built-in columns unchanged", () => {
  test("1: built-in Invoice main-table columns are exactly description, amount", async () => {
    const res = await request(app).get("/api/print-templates/built-in?moduleType=invoice").set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.config.table.columns).toEqual([
      { key: "description", label: "Description" },
      { key: "amount", label: "Amount" },
    ]);
  });

  test("2: built-in OR main-table columns AND applied-invoice columns match the canonical whitelist", async () => {
    const res = await request(app).get("/api/print-templates/built-in?moduleType=or").set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.config.table.columns).toEqual([
      { key: "description", label: "Description" },
      { key: "amount", label: "Amount" },
    ]);
    expect(res.body.config.table.appliedInvoiceColumns).toEqual([
      { key: "invoiceNo", label: "Invoice No." },
      { key: "invoiceDate", label: "Date" },
      { key: "description", label: "Description" },
      { key: "invoiceAmount", label: "Invoice Amount" },
      { key: "amountPaid", label: "Amount Paid" },
    ]);
  });
});

describe("3: Invoice hide/relabel/reorder column", () => {
  test("hides amount, relabels description, and persists through create+read", async () => {
    const created = await createTemplate(tokenA, {
      moduleType: "invoice", templateCode: "ptcol-inv-hide", templateName: "Invoice Hide Amount",
      documentVariant: "sales_invoice",
      config: { table: { columns: [{ key: "description", label: "Item Description" }] } },
    });
    expect(created.status).toBe(201);
    expect(created.body.config.table.columns).toEqual([{ key: "description", label: "Item Description" }]);

    const read = await request(app).get(`/api/print-templates/${created.body.id}`).set("Authorization", `Bearer ${tokenA}`);
    expect(read.body.config.table.columns).toEqual([{ key: "description", label: "Item Description" }]);
  });

  test("reorders amount before description", async () => {
    const created = await createTemplate(tokenA, {
      moduleType: "invoice", templateCode: "ptcol-inv-reorder", templateName: "Invoice Reordered",
      documentVariant: "sales_invoice",
      config: { table: { columns: [{ key: "amount", label: "Amount Due" }, { key: "description", label: "Description" }] } },
    });
    expect(created.status).toBe(201);
    expect(created.body.config.table.columns.map((c) => c.key)).toEqual(["amount", "description"]);
    expect(created.body.config.table.columns[0].label).toBe("Amount Due");
  });
});

describe("4: OR main-table column customization", () => {
  test("OR main table accepts the same hide/relabel/reorder shape as Invoice", async () => {
    const created = await createTemplate(tokenA, {
      moduleType: "or", templateCode: "ptcol-or-maintable", templateName: "OR Main Table Custom",
      documentVariant: "official_receipt",
      config: { table: { columns: [{ key: "amount", label: "Amount Received" }] } },
    });
    expect(created.status).toBe(201);
    expect(created.body.config.table.columns).toEqual([{ key: "amount", label: "Amount Received" }]);
  });
});

describe("5: OR Applied Invoice hide/relabel/reorder column", () => {
  test("hides invoiceDate, relabels invoiceNo, reorders amountPaid first", async () => {
    const created = await createTemplate(tokenA, {
      moduleType: "or", templateCode: "ptcol-or-applied", templateName: "OR Applied Custom",
      documentVariant: "official_receipt",
      config: {
        table: {
          appliedInvoiceColumns: [
            { key: "amountPaid", label: "Paid" },
            { key: "invoiceNo", label: "Inv. No." },
            { key: "description", label: "Description" },
            { key: "invoiceAmount", label: "Invoice Amount" },
          ],
        },
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.config.table.appliedInvoiceColumns.map((c) => c.key)).toEqual([
      "amountPaid", "invoiceNo", "description", "invoiceAmount",
    ]);
    expect(created.body.config.table.appliedInvoiceColumns[1].label).toBe("Inv. No.");
    // invoiceDate correctly omitted (hidden), not silently re-added.
    expect(created.body.config.table.appliedInvoiceColumns.find((c) => c.key === "invoiceDate")).toBeUndefined();
  });
});

describe("6-7: duplicate/unsupported/blank-label rejection (existing Phase 2 validator, exercised for Phase 3D)", () => {
  test("6: duplicate column key rejected", async () => {
    const res = await createTemplate(tokenA, {
      moduleType: "invoice", templateCode: "ptcol-dup", templateName: "Bad", documentVariant: "sales_invoice",
      config: { table: { columns: [{ key: "description", label: "A" }, { key: "description", label: "B" }] } },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/lists column "description" more than once/);
  });

  test("7: unsupported column key rejected (arbitrary DB field cannot be entered)", async () => {
    const res = await createTemplate(tokenA, {
      moduleType: "invoice", templateCode: "ptcol-unsupported", templateName: "Bad", documentVariant: "sales_invoice",
      config: { table: { columns: [{ key: "quantity", label: "Qty" }] } },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/column "quantity" is not supported/);
  });

  test("8: blank visible-column label rejected", async () => {
    const res = await createTemplate(tokenA, {
      moduleType: "invoice", templateCode: "ptcol-blank-label", templateName: "Bad", documentVariant: "sales_invoice",
      config: { table: { columns: [{ key: "description", label: "   " }] } },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/requires a non-empty label/);
  });

  test("9: zero-visible-column case rejected (empty columns array)", async () => {
    const res = await createTemplate(tokenA, {
      moduleType: "invoice", templateCode: "ptcol-zero-visible", templateName: "Bad", documentVariant: "sales_invoice",
      config: { table: { columns: [] } },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/must be a non-empty array of columns/);
  });

  test("10: appliedInvoiceColumns rejected outright for the Invoice module (not just ignored)", async () => {
    const res = await createTemplate(tokenA, {
      moduleType: "invoice", templateCode: "ptcol-applied-on-invoice", templateName: "Bad", documentVariant: "sales_invoice",
      config: { table: { appliedInvoiceColumns: [{ key: "invoiceNo", label: "x" }] } },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/only supported for the OR module/);
  });
});

describe("11: existing template without column config still works", () => {
  test("a template saved with no table config at all falls back to built-in default columns", async () => {
    const created = await createTemplate(tokenA, {
      moduleType: "invoice", templateCode: "ptcol-no-table-cfg", templateName: "No Table Config", documentVariant: "sales_invoice",
      config: { header: { showCompanyName: true } },
    });
    expect(created.status).toBe(201);
    expect(created.body.config.table.columns).toEqual([
      { key: "description", label: "Description" },
      { key: "amount", label: "Amount" },
    ]);
  });
});

describe("12: custom columns never alter the accounting payload", () => {
  test("a hidden/relabeled/reordered Invoice column config returns byte-identical accounting data to the default", async () => {
    const withoutCols = await preview(tokenA, "invoice", invoiceAId, {});
    const withCols = await preview(tokenA, "invoice", invoiceAId, {
      table: { columns: [{ key: "amount", label: "Amount Due" }] },
    });
    expect(withCols.status).toBe(200);
    expect(withCols.body.doc.totalDebit).toBe(withoutCols.body.doc.totalDebit);
    expect(withCols.body.doc.totalCredit).toBe(withoutCols.body.doc.totalCredit);
    expect(withCols.body.doc.voucherNo).toBe(withoutCols.body.doc.voucherNo);
    expect(withCols.body.lines).toEqual(withoutCols.body.lines);
    expect(withCols.body.templateConfig.table.columns).not.toEqual(withoutCols.body.templateConfig.table.columns);
  });

  test("settlement OR Applied Invoice amounts unchanged under a reordered/relabeled column config", async () => {
    const withoutCols = await preview(tokenA, "or", orWithAppliedInvoiceAId, {});
    const withCols = await preview(tokenA, "or", orWithAppliedInvoiceAId, {
      table: {
        appliedInvoiceColumns: [
          { key: "amountPaid", label: "Paid" },
          { key: "invoiceAmount", label: "Original" },
          { key: "invoiceNo", label: "Inv #" },
        ],
      },
    });
    expect(withCols.status).toBe(200);
    expect(withCols.body.appliedInvoices).toEqual(withoutCols.body.appliedInvoices);
    expect(withCols.body.appliedInvoices?.length).toBeGreaterThan(0);
    expect(withCols.body.doc.totalDebit).toBe(withoutCols.body.doc.totalDebit);
    expect(withCols.body.doc.totalCredit).toBe(withoutCols.body.doc.totalCredit);
  });
});

describe("13: unsaved preview honors column changes", () => {
  test("preview payload's templateConfig reflects the exact unsaved column config sent, not a saved template", async () => {
    const res = await preview(tokenA, "or", orWithAppliedInvoiceAId, {
      table: {
        columns: [{ key: "amount", label: "Total Received" }],
        appliedInvoiceColumns: [{ key: "invoiceNo", label: "Ref" }, { key: "amountPaid", label: "Paid" }],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.templateConfig.table.columns).toEqual([{ key: "amount", label: "Total Received" }]);
    expect(res.body.templateConfig.table.appliedInvoiceColumns).toEqual([
      { key: "invoiceNo", label: "Ref" }, { key: "amountPaid", label: "Paid" },
    ]);
    expect(res.body.templateMeta).toEqual({ source: "preview", templateId: null, templateName: null });
  });
});

describe("14: built-in preview still works", () => {
  test("previewing with an empty config resolves to the full built-in column set", async () => {
    const res = await preview(tokenA, "or", orWithAppliedInvoiceAId, {});
    expect(res.status).toBe(200);
    expect(res.body.templateConfig.table.columns).toEqual([
      { key: "description", label: "Description" },
      { key: "amount", label: "Amount" },
    ]);
    expect(res.body.templateConfig.table.appliedInvoiceColumns).toEqual([
      { key: "invoiceNo", label: "Invoice No." },
      { key: "invoiceDate", label: "Date" },
      { key: "description", label: "Description" },
      { key: "invoiceAmount", label: "Invoice Amount" },
      { key: "amountPaid", label: "Amount Paid" },
    ]);
  });
});

describe("15: direct OR (no applications) unaffected by applied-invoice column config", () => {
  test("a direct OR's appliedInvoices stays an empty array regardless of appliedInvoiceColumns config", async () => {
    const res = await preview(tokenA, "or", orDirectAId, {
      table: { appliedInvoiceColumns: [{ key: "amountPaid", label: "Paid" }] },
    });
    expect(res.status).toBe(200);
    expect(res.body.appliedInvoices).toEqual([]);
  });
});

describe("16: long invoice-number stress case (data level)", () => {
  test("a long source-invoice voucher number passes through the print payload unmodified/untruncated", async () => {
    const res = await preview(tokenA, "or", orLongInvoiceNoAId, {});
    expect(res.status).toBe(200);
    expect(res.body.appliedInvoices).toHaveLength(1);
    expect(res.body.appliedInvoices[0].invoiceNo).toBe("TESTPTCOL-VERY-LONG-INVOICE-NUMBER-0001");
  });
});

describe("17: standalone invoiceNo wrap fix - data-level regression coverage", () => {
  // The wrap/width fix itself (documentPdfBuilder.js's row-drawing loop and
  // pdfKit.js's wrapText hard-break fallback) is pure frontend/pdf-lib
  // rendering code - untestable under Jest per this file's header note, and
  // proven separately via live Playwright + rasterized-PDF visual
  // inspection (default, reordered, hidden-column, relabeled, Compact,
  // Relaxed, and a 6-row multi-long-invoice page-break case, all clean).
  // What's genuinely backend-testable is that none of this ever touches
  // the DATA the renderer consumes, regardless of how the column config
  // asks it to be laid out.

  test("multiple long invoice numbers all pass through the print payload complete and in order", async () => {
    const res = await preview(tokenA, "or", orMultiLongInvoiceNoAId, {});
    expect(res.status).toBe(200);
    expect(res.body.appliedInvoices).toHaveLength(3);
    expect(res.body.appliedInvoices.map((a) => a.invoiceNo)).toEqual([
      "TESTPTCOL-VERY-LONG-INVOICE-NUMBER-MULTI-1-0001",
      "TESTPTCOL-VERY-LONG-INVOICE-NUMBER-MULTI-2-0001",
      "TESTPTCOL-VERY-LONG-INVOICE-NUMBER-MULTI-3-0001",
    ]);
    expect(res.body.appliedInvoices.map((a) => a.amountPaid)).toEqual([1000, 2000, 3000]);
  });

  test("a long invoiceNo survives reordering, hiding invoiceDate, relabeling, and Compact spacing together, with accounting values unchanged", async () => {
    const withoutCfg = await preview(tokenA, "or", orLongInvoiceNoAId, {});
    const withCfg = await preview(tokenA, "or", orLongInvoiceNoAId, {
      layout: { spacingPreset: "compact", alignmentPreset: "left", sectionOrder: ["header", "meta", "party", "appliedInvoices", "table", "summary"] },
      table: {
        appliedInvoiceColumns: [
          { key: "description", label: "Description" },
          { key: "invoiceAmount", label: "Invoice Amount" },
          { key: "amountPaid", label: "Amount Paid" },
          { key: "invoiceNo", label: "Ref. No." },
        ],
      },
    });
    expect(withCfg.status).toBe(200);
    // Data is untouched by the layout/column config.
    expect(withCfg.body.appliedInvoices[0].invoiceNo).toBe("TESTPTCOL-VERY-LONG-INVOICE-NUMBER-0001");
    expect(withCfg.body.appliedInvoices).toEqual(withoutCfg.body.appliedInvoices);
    expect(withCfg.body.doc.totalDebit).toBe(withoutCfg.body.doc.totalDebit);
    expect(withCfg.body.doc.totalCredit).toBe(withoutCfg.body.doc.totalCredit);
    expect(withCfg.body.lines).toEqual(withoutCfg.body.lines);
    // The column config itself DID round-trip as requested (hidden
    // invoiceDate, reordered, relabeled) - proves the fix's compatibility
    // with Phase 3D column configuration, not just that data is inert.
    expect(withCfg.body.templateConfig.table.appliedInvoiceColumns.map((c) => c.key)).toEqual([
      "description", "invoiceAmount", "amountPaid", "invoiceNo",
    ]);
    expect(withCfg.body.templateConfig.table.appliedInvoiceColumns.find((c) => c.key === "invoiceDate")).toBeUndefined();
    expect(withCfg.body.templateConfig.table.appliedInvoiceColumns.find((c) => c.key === "invoiceNo").label).toBe("Ref. No.");
  });

  test("Relaxed spacing with a long invoiceNo leaves accounting values unchanged", async () => {
    const withoutCfg = await preview(tokenA, "or", orLongInvoiceNoAId, {});
    const withCfg = await preview(tokenA, "or", orLongInvoiceNoAId, {
      layout: { spacingPreset: "relaxed", alignmentPreset: "left", sectionOrder: ["header", "meta", "party", "appliedInvoices", "table", "summary"] },
    });
    expect(withCfg.status).toBe(200);
    expect(withCfg.body.appliedInvoices).toEqual(withoutCfg.body.appliedInvoices);
    expect(withCfg.body.doc.totalDebit).toBe(withoutCfg.body.doc.totalDebit);
  });
});

describe("18: company isolation for column-bearing templates", () => {
  test("Company B cannot read Company A's custom-column template", async () => {
    const created = await createTemplate(tokenA, {
      moduleType: "invoice", templateCode: "ptcol-isolation", templateName: "Isolation Check",
      documentVariant: "sales_invoice", config: { table: { columns: [{ key: "amount", label: "x" }] } },
    });
    const res = await request(app).get(`/api/print-templates/${created.body.id}`).set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
  });
});
