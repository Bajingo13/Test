const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Phase 2 (Document Print Template Infrastructure). Proves the whole
// chain: config validation/whitelisting, company isolation, default/
// active-state resolution rules, and that the print pipeline's
// resolveEffectiveConfig() actually reaches the right config (requested
// -> company default -> built-in) without ever touching an accounting
// value. Companion to orPrintApplications.http.test.js, which this file
// deliberately does not duplicate (existing print regression is proven
// there; this file proves the NEW template layer sitting alongside it).

jest.setTimeout(180000);

let companyAId, companyBId;
let tokenA, tokenB, adminAId, adminBId;
let cashA, arA, revA;
let custAId;

// Naming convention this whole suite is scoped to - used by
// cleanupAllStaleFixtures() below so cleanup NEVER depends on captured
// `let` variables (which may still be undefined if beforeAll aborted
// partway, or may be stale after a prior run crashed mid-teardown).
// Looking rows up fresh by name/username/code prefix every time makes
// cleanup idempotent regardless of how much of a previous run actually
// completed.
const TEST_COMPANY_NAME_PATTERN = "TEST Print Templates%";
const TEST_USERNAME_PATTERN = "test_ptpl%";
const TEST_ACCOUNT_CODE_PATTERN = "TESTPTPL%";

// FK-safe cleanup of every row this suite could ever have created,
// discovered fresh each time via the naming convention above rather than
// via captured ids - safe to call from both beforeAll (defensive
// pre-clean, handles fixtures left behind by a previous aborted run) and
// afterAll (this run's own teardown), and safe to call when nothing
// matches at all (every step is a no-op DELETE on an empty id list).
// Order matters: child rows (referencing a company via FK) before the
// company row itself.
async function cleanupAllStaleFixtures() {
  const [staleCompanies] = await pool.query("SELECT id FROM companies WHERE name LIKE ?", [TEST_COMPANY_NAME_PATTERN]);
  const staleCompanyIds = staleCompanies.map((r) => r.id);

  if (staleCompanyIds.length) {
    await pool.query("DELETE FROM document_print_templates WHERE company_id IN (?)", [staleCompanyIds]);
    // Invoices are the only transaction fixture this suite creates -
    // clear their FK-dependent rows (lines, currency snapshots) before
    // the header, then the header, before touching currencies.
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

  // Users are matched by username pattern independently of the company
  // lookup above, since a user row can outlive its user_companies link
  // (e.g. if a prior run's teardown died between those two deletes).
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

  // Defensive: a previous run that crashed mid-teardown can leave a
  // company row whose currencies/users/etc. still reference it - a plain
  // "DELETE FROM companies WHERE name LIKE ..." would then fail on a
  // foreign-key violation before this suite's own fixtures ever get
  // created, taking every test down with it. cleanupAllStaleFixtures()
  // clears every FK-dependent table first, in dependency order, so this
  // is safe whether the prior run left nothing, everything, or something
  // in between.
  await cleanupAllStaleFixtures();

  companyAId = await makeCompany("TEST Print Templates Co A");
  companyBId = await makeCompany("TEST Print Templates Co B");
  adminAId = await makeLoginUser("test_ptpl_admin_a", "PtplPass!A1", 2, companyAId);
  adminBId = await makeLoginUser("test_ptpl_admin_b", "PtplPass!B1", 2, companyBId);
  tokenA = await loginAs("test_ptpl_admin_a", "PtplPass!A1");
  tokenB = await loginAs("test_ptpl_admin_b", "PtplPass!B1");

  cashA = await makeAccount("TESTPTPLCASH", "Cash (Print Template Test)", "ASSET");
  arA = await makeAccount("TESTPTPLAR", "Accounts Receivable (Print Template Test)", "ASSET");
  revA = await makeAccount("TESTPTPLREV", "Revenue (Print Template Test)", "INCOME");
  custAId = await makeParty("TESTPTPL-CUSTA", "CUSTOMER", "Print Template Test Customer A", companyAId);

  const CurrencyService = require("../services/currencyService");
  await CurrencyService.createCurrency({ id: adminAId, roleCode: "ADMIN" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: companyAId,
  });
  await CurrencyService.createCurrency({ id: adminBId, roleCode: "ADMIN" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: companyBId,
  });
});

afterAll(async () => {
  // Cleanup is looked up fresh by naming convention (same helper as the
  // defensive pre-clean in beforeAll) rather than by the captured
  // companyAId/companyBId/adminAId/adminBId variables - those can be
  // undefined if beforeAll itself failed partway, and passing undefined
  // as a bind parameter is exactly what caused this suite's own
  // teardown to throw before reaching pool.end() (see the Phase 2 test
  // harness diagnosis). pool.end() is guaranteed to run via `finally`
  // regardless of whether cleanup succeeds, so a cleanup failure can
  // never again leave the MySQL pool open and Jest hanging.
  try {
    await cleanupAllStaleFixtures();
  } finally {
    await pool.end();
  }
});

async function createTemplate(token, body) {
  return request(app).post("/api/print-templates").set("Authorization", `Bearer ${token}`).send(body);
}

async function createPostedInvoice(token, { voucherNo, amount }) {
  const res = await request(app)
    .post("/api/invoices")
    .set("Authorization", `Bearer ${token}`)
    .send({
      voucherNo, customerId: custAId, customerName: "x", transactionDate: "2026-08-01", dueDate: "2026-08-08",
      status: "Posted",
      lines: [
        { accountId: arA, accountCode: "TESTPTPLAR", accountTitle: "AR", particulars: "x", debit: amount, credit: 0 },
        { accountId: revA, accountCode: "TESTPTPLREV", accountTitle: "Revenue", particulars: "x", debit: 0, credit: amount },
      ],
      totalDebit: amount, totalCredit: amount, currency: { companyId: companyAId },
    });
  if (res.status !== 200 || !res.body.success) throw new Error(`Invoice create failed: ${JSON.stringify(res.body)}`);
  return res.body.id;
}

describe("1-2: create valid templates", () => {
  test("create valid Invoice template", async () => {
    const res = await createTemplate(tokenA, {
      moduleType: "invoice", templateCode: "ptpl-sales-a", templateName: "PTPL Sales Invoice",
      documentVariant: "sales_invoice", config: { header: { documentTitle: "SALES INVOICE" } },
    });
    expect(res.status).toBe(201);
    expect(res.body.moduleType).toBe("invoice");
    expect(res.body.config.header.documentTitle).toBe("SALES INVOICE");
    // Fields not provided are filled from the built-in default, not left
    // missing - proves the merge-onto-default behavior.
    expect(res.body.config.party.sectionLabel).toBe("Bill To");
    expect(res.body.config.table.columns).toEqual([
      { key: "description", label: "Description" },
      { key: "amount", label: "Amount" },
    ]);
  });

  test("create valid OR template", async () => {
    const res = await createTemplate(tokenA, {
      moduleType: "or", templateCode: "ptpl-official-a", templateName: "PTPL Official Receipt",
      documentVariant: "official_receipt", config: {},
    });
    expect(res.status).toBe(201);
    expect(res.body.moduleType).toBe("or");
    expect(res.body.config.party.sectionLabel).toBe("Received From");
    expect(res.body.config.summary.showAmountInWords).toBe(true);
  });
});

describe("3-6: validation rejects unsafe/unsupported config", () => {
  test("invalid module type rejected", async () => {
    const res = await createTemplate(tokenA, {
      moduleType: "apv", templateCode: "ptpl-bad-module", templateName: "Bad", documentVariant: "sales_invoice", config: {},
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Unsupported print-template module type/);
  });

  test("invalid variant rejected", async () => {
    const res = await createTemplate(tokenA, {
      moduleType: "invoice", templateCode: "ptpl-bad-variant", templateName: "Bad", documentVariant: "not_a_real_variant", config: {},
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Unsupported document variant/);
  });

  test("invalid config field (wrong type) rejected", async () => {
    const res = await createTemplate(tokenA, {
      moduleType: "invoice", templateCode: "ptpl-bad-type", templateName: "Bad", documentVariant: "sales_invoice",
      config: { header: { showCompanyName: "yes" } },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/showCompanyName must be true or false/);
  });

  test("arbitrary/unapproved top-level field rejected", async () => {
    const res = await createTemplate(tokenA, {
      moduleType: "invoice", templateCode: "ptpl-bad-field", templateName: "Bad", documentVariant: "sales_invoice",
      config: { customCss: "body { color: red }" },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Unsupported config section/);
  });

  test("unapproved main-table column key rejected (accounting-safety whitelist)", async () => {
    const res = await createTemplate(tokenA, {
      moduleType: "invoice", templateCode: "ptpl-bad-column", templateName: "Bad", documentVariant: "sales_invoice",
      config: { table: { columns: [{ key: "unitPrice", label: "Unit Price" }] } },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not supported/);
  });

  test("appliedInvoiceColumns rejected for the Invoice module (OR-only field)", async () => {
    const res = await createTemplate(tokenA, {
      moduleType: "invoice", templateCode: "ptpl-bad-applied", templateName: "Bad", documentVariant: "sales_invoice",
      config: { table: { appliedInvoiceColumns: [{ key: "invoiceNo", label: "No." }] } },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/only supported for the OR module/);
  });
});

describe("7-8: company isolation", () => {
  let companyATemplateId;

  beforeAll(async () => {
    const res = await createTemplate(tokenA, {
      moduleType: "invoice", templateCode: "ptpl-isolation", templateName: "PTPL Isolation Test",
      documentVariant: "sales_invoice", config: {},
    });
    companyATemplateId = res.body.id;
  });

  test("Company B cannot read Company A's template", async () => {
    const res = await request(app).get(`/api/print-templates/${companyATemplateId}`).set("Authorization", `Bearer ${tokenB}`).query({ companyId: companyBId });
    expect(res.status).toBe(404);
  });

  test("Company B cannot modify Company A's template", async () => {
    const res = await request(app)
      .put(`/api/print-templates/${companyATemplateId}`)
      .set("Authorization", `Bearer ${tokenB}`)
      .query({ companyId: companyBId })
      .send({ templateName: "Hijacked" });
    expect(res.status).toBe(404);
  });

  test("Company B's own template list never includes Company A's rows", async () => {
    const res = await request(app).get("/api/print-templates").set("Authorization", `Bearer ${tokenB}`).query({ companyId: companyBId, moduleType: "invoice" });
    expect(res.status).toBe(200);
    expect(res.body.find((t) => t.id === companyATemplateId)).toBeUndefined();
  });
});

describe("9-10: default and active-state rules", () => {
  test("setting a new default unsets the prior one (at most one default per company+module)", async () => {
    const t1 = await createTemplate(tokenA, { moduleType: "invoice", templateCode: "ptpl-def-1", templateName: "Default 1", documentVariant: "sales_invoice", config: {}, isDefault: true });
    const t2 = await createTemplate(tokenA, { moduleType: "invoice", templateCode: "ptpl-def-2", templateName: "Default 2", documentVariant: "service_invoice", config: {} });
    expect(t1.body.isDefault).toBe(true);

    const setRes = await request(app).post(`/api/print-templates/${t2.body.id}/set-default`).set("Authorization", `Bearer ${tokenA}`).query({ companyId: companyAId });
    expect(setRes.status).toBe(200);
    expect(setRes.body.isDefault).toBe(true);

    const reread = await request(app).get(`/api/print-templates/${t1.body.id}`).set("Authorization", `Bearer ${tokenA}`).query({ companyId: companyAId });
    expect(reread.body.isDefault).toBe(false);
  });

  test("deactivating the current default clears is_default, and it stops resolving as effective", async () => {
    const t = await createTemplate(tokenA, { moduleType: "invoice", templateCode: "ptpl-deact", templateName: "Will Deactivate", documentVariant: "cash_invoice", config: {}, isDefault: true });
    const deact = await request(app).post(`/api/print-templates/${t.body.id}/deactivate`).set("Authorization", `Bearer ${tokenA}`).query({ companyId: companyAId });
    expect(deact.status).toBe(200);
    expect(deact.body.isActive).toBe(false);
    expect(deact.body.isDefault).toBe(false);

    // An inactive template must never resolve as "the effective default"
    // even though it briefly was one - proven via the real Invoice print
    // pipeline below (test 11-13's "no active default" case covers this
    // company/module state directly).
    const explicit = await request(app).get(`/api/print-templates/${t.body.id}`).set("Authorization", `Bearer ${tokenA}`).query({ companyId: companyAId });
    expect(explicit.body.isActive).toBe(false);
  });

  test("an inactive template cannot be set as default", async () => {
    const t = await createTemplate(tokenA, { moduleType: "invoice", templateCode: "ptpl-inactive-default", templateName: "Inactive", documentVariant: "cash_invoice", config: {} });
    await request(app).post(`/api/print-templates/${t.body.id}/deactivate`).set("Authorization", `Bearer ${tokenA}`).query({ companyId: companyAId });
    const res = await request(app).post(`/api/print-templates/${t.body.id}/set-default`).set("Authorization", `Bearer ${tokenA}`).query({ companyId: companyAId });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/inactive template cannot be set as default/);
  });
});

describe("11-13: print-pipeline resolution order", () => {
  let cleanCompanyId, cleanToken, cleanAdminId;

  // A dedicated third company with NO templates at all, so these three
  // tests can prove all three resolution tiers without interference from
  // the default/isolation tests above running in the same suite.
  beforeAll(async () => {
    cleanCompanyId = await makeCompany("TEST Print Templates Co C");
    cleanAdminId = await makeLoginUser("test_ptpl_admin_c", "PtplPass!C1", 2, cleanCompanyId);
    cleanToken = await loginAs("test_ptpl_admin_c", "PtplPass!C1");
    const CurrencyService = require("../services/currencyService");
    await CurrencyService.createCurrency({ id: cleanAdminId, roleCode: "ADMIN" }, {
      currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
      decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: cleanCompanyId,
    });
  });

  afterAll(async () => {
    // Early, best-effort cleanup of this describe's own company/currency/
    // user/invoices, scoped to cleanCompanyId specifically (in FK-safe
    // order: templates -> invoice lines/snapshots -> invoice headers ->
    // currencies -> user link -> user -> company). Wrapped in try/catch
    // (not rethrown) because the top-level afterAll's
    // cleanupAllStaleFixtures() independently re-cleans everything
    // matching the 'TEST Print Templates%' naming convention - including
    // this exact company - as an authoritative backstop, so a failure
    // here must never be allowed to block that later, guaranteed cleanup
    // or the pool.end() it protects.
    try {
      if (cleanCompanyId) {
        await pool.query("DELETE FROM document_print_templates WHERE company_id = ?", [cleanCompanyId]);
        await pool.query("DELETE FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoice_headers WHERE company_id = ?)", [cleanCompanyId]);
        await pool.query("DELETE FROM transaction_currency_snapshots WHERE transaction_type = 'INV' AND transaction_id IN (SELECT id FROM invoice_headers WHERE company_id = ?)", [cleanCompanyId]);
        await pool.query("DELETE FROM invoice_headers WHERE company_id = ?", [cleanCompanyId]);
        await pool.query("DELETE FROM currencies WHERE company_id = ?", [cleanCompanyId]);
      }
      if (cleanAdminId) {
        await pool.query("DELETE FROM user_companies WHERE user_id = ?", [cleanAdminId]);
        await pool.query("DELETE FROM users WHERE id = ?", [cleanAdminId]);
      }
      if (cleanCompanyId) {
        await pool.query("DELETE FROM companies WHERE id = ?", [cleanCompanyId]);
      }
    } catch (err) {
      console.warn("printTemplates.http.test.js: nested 11-13 cleanup failed (non-fatal, the top-level afterAll's cleanupAllStaleFixtures() will still catch it):", err.message);
    }
  });

  async function postedInvoiceFor(token, companyId, voucherNo) {
    const res = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        voucherNo, customerId: custAId, customerName: "x", transactionDate: "2026-08-01", dueDate: "2026-08-08",
        status: "Posted",
        lines: [
          { accountId: arA, accountCode: "TESTPTPLAR", accountTitle: "AR", particulars: "x", debit: 500, credit: 0 },
          { accountId: revA, accountCode: "TESTPTPLREV", accountTitle: "Revenue", particulars: "x", debit: 0, credit: 500 },
        ],
        totalDebit: 500, totalCredit: 500, currency: { companyId },
      });
    if (res.status !== 200 || !res.body.success) throw new Error(`Invoice create failed: ${JSON.stringify(res.body)}`);
    return res.body.id;
  }

  test("13: built-in fallback resolves when no DB template exists at all", async () => {
    const invId = await postedInvoiceFor(cleanToken, cleanCompanyId, "TESTPTPL-INV-13");
    const res = await request(app).get(`/api/print/invoice/${invId}`).set("Authorization", `Bearer ${cleanToken}`).query({ companyId: cleanCompanyId });
    expect(res.status).toBe(200);
    expect(res.body.templateMeta.source).toBe("built_in");
    expect(res.body.templateMeta.templateId).toBeNull();
    expect(res.body.templateConfig.header.documentTitle).toBeNull();
    expect(res.body.templateConfig.party.sectionLabel).toBe("Bill To");
  });

  test("12: company/module default resolves when one exists and no explicit template is requested", async () => {
    const created = await createTemplate(cleanToken, {
      moduleType: "invoice", templateCode: "ptpl-c-default", templateName: "Co C Default",
      documentVariant: "service_invoice", config: { header: { documentTitle: "SERVICE INVOICE" } }, isDefault: true,
    });
    expect(created.status).toBe(201);

    const invId = await postedInvoiceFor(cleanToken, cleanCompanyId, "TESTPTPL-INV-12");
    const res = await request(app).get(`/api/print/invoice/${invId}`).set("Authorization", `Bearer ${cleanToken}`).query({ companyId: cleanCompanyId });
    expect(res.status).toBe(200);
    expect(res.body.templateMeta.source).toBe("company_default");
    expect(res.body.templateMeta.templateId).toBe(created.body.id);
    expect(res.body.templateConfig.header.documentTitle).toBe("SERVICE INVOICE");
  });

  test("11: an explicitly requested template overrides the company default", async () => {
    const nonDefault = await createTemplate(cleanToken, {
      moduleType: "invoice", templateCode: "ptpl-c-explicit", templateName: "Co C Explicit",
      documentVariant: "commercial_invoice", config: { header: { documentTitle: "COMMERCIAL INVOICE" } },
    });
    expect(nonDefault.status).toBe(201);

    const invId = await postedInvoiceFor(cleanToken, cleanCompanyId, "TESTPTPL-INV-11");
    const res = await request(app)
      .get(`/api/print/invoice/${invId}`)
      .set("Authorization", `Bearer ${cleanToken}`)
      .query({ companyId: cleanCompanyId, templateId: nonDefault.body.id });
    expect(res.status).toBe(200);
    expect(res.body.templateMeta.source).toBe("requested");
    expect(res.body.templateMeta.templateId).toBe(nonDefault.body.id);
    expect(res.body.templateConfig.header.documentTitle).toBe("COMMERCIAL INVOICE");
  });

  test("a stale/deactivated requested template id is rejected, not silently substituted", async () => {
    const t = await createTemplate(cleanToken, {
      moduleType: "invoice", templateCode: "ptpl-c-stale", templateName: "Will Deactivate", documentVariant: "cash_invoice", config: {},
    });
    await request(app).post(`/api/print-templates/${t.body.id}/deactivate`).set("Authorization", `Bearer ${cleanToken}`).query({ companyId: cleanCompanyId });

    const invId = await postedInvoiceFor(cleanToken, cleanCompanyId, "TESTPTPL-INV-STALE");
    const res = await request(app)
      .get(`/api/print/invoice/${invId}`)
      .set("Authorization", `Bearer ${cleanToken}`)
      .query({ companyId: cleanCompanyId, templateId: t.body.id });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/inactive and cannot be used/);
  });

  test("17: a template for a different module cannot be used to print this module's documents", async () => {
    const orTemplate = await createTemplate(cleanToken, {
      moduleType: "or", templateCode: "ptpl-c-or-only", templateName: "Co C OR Template", documentVariant: "official_receipt", config: {},
    });
    const invId = await postedInvoiceFor(cleanToken, cleanCompanyId, "TESTPTPL-INV-17");
    const res = await request(app)
      .get(`/api/print/invoice/${invId}`)
      .set("Authorization", `Bearer ${cleanToken}`)
      .query({ companyId: cleanCompanyId, templateId: orTemplate.body.id });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not found for this company\/module/);
  });
});

describe("14-16, 18: existing print behavior is unaffected", () => {
  test("14: existing Invoice print still works exactly as before with no custom template", async () => {
    const invId = await createPostedInvoice(tokenA, { voucherNo: "TESTPTPL-INV-14", amount: 2500 });
    const res = await request(app).get(`/api/print/invoice/${invId}`).set("Authorization", `Bearer ${tokenA}`).query({ companyId: companyAId });
    expect(res.status).toBe(200);
    expect(res.body.doc.voucherNo).toBe("TESTPTPL-INV-14");
    expect(Number(res.body.doc.totalDebit)).toBe(2500);
    expect(res.body.lines.length).toBeGreaterThan(0);
  });

  test("16: accounting totals are byte-identical whether or not a template is attached", async () => {
    const invId = await createPostedInvoice(tokenA, { voucherNo: "TESTPTPL-INV-16", amount: 3300 });
    const withoutTemplate = await request(app).get(`/api/print/invoice/${invId}`).set("Authorization", `Bearer ${tokenA}`).query({ companyId: companyAId });

    const tpl = await createTemplate(tokenA, {
      moduleType: "invoice", templateCode: "ptpl-16-totals", templateName: "Totals Check", documentVariant: "sales_invoice",
      config: { header: { documentTitle: "CUSTOM TITLE" }, summary: { showTotal: false } },
    });
    const withTemplate = await request(app)
      .get(`/api/print/invoice/${invId}`)
      .set("Authorization", `Bearer ${tokenA}`)
      .query({ companyId: companyAId, templateId: tpl.body.id });

    // The template changed presentation (title, whether the total draws)
    // but never the underlying accounting figures themselves.
    expect(withTemplate.body.templateConfig.header.documentTitle).toBe("CUSTOM TITLE");
    expect(withTemplate.body.templateConfig.summary.showTotal).toBe(false);
    expect(withTemplate.body.doc.totalDebit).toBe(withoutTemplate.body.doc.totalDebit);
    expect(withTemplate.body.doc.totalCredit).toBe(withoutTemplate.body.doc.totalCredit);
    expect(withTemplate.body.lines).toEqual(withoutTemplate.body.lines);
  });

  test("18: print permission enforcement is unaffected - a user whose role loses TRANSACTIONS.INVOICE.PRINT still gets 403 on document print, independent of templates", async () => {
    // ADMIN/ACCOUNTANT are both broadly granted by this schema's seed data
    // (there is no third, deliberately-restricted role to reuse here, unlike
    // FILESETUP.COA's ACCOUNTANT exclusion) - so this proves the EXISTING
    // gate still works the same way it always has by temporarily revoking
    // one real grant row and restoring it afterward, rather than asserting
    // against a role state that doesn't exist in this schema.
    const [[perm]] = await pool.query("SELECT id FROM permissions WHERE module_key = 'TRANSACTIONS.INVOICE' AND action = 'PRINT'");
    await pool.execute("UPDATE role_permissions SET granted = 0 WHERE role_id = 3 AND permission_id = ?", [perm.id]);
    try {
      const hash = await bcrypt.hash("PtplPass!D1", 10);
      const [userResult] = await pool.execute(
        "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, 3, 'ACTIVE')",
        ["test_ptpl_noprint", hash]
      );
      const noprintUserId = userResult.insertId;
      await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [noprintUserId, companyAId]);
      const noprintToken = await loginAs("test_ptpl_noprint", "PtplPass!D1");

      const invId = await createPostedInvoice(tokenA, { voucherNo: "TESTPTPL-INV-18", amount: 750 });
      const res = await request(app).get(`/api/print/invoice/${invId}`).set("Authorization", `Bearer ${noprintToken}`).query({ companyId: companyAId });
      expect(res.status).toBe(403);

      await pool.query("DELETE FROM user_companies WHERE user_id = ?", [noprintUserId]);
      await pool.query("DELETE FROM users WHERE id = ?", [noprintUserId]);
    } finally {
      await pool.execute("UPDATE role_permissions SET granted = 1 WHERE role_id = 3 AND permission_id = ?", [perm.id]);
    }
  });

  test("PRINT.DOCUMENT_TEMPLATES permission is itself enforced (403 when not granted)", async () => {
    const [[perm]] = await pool.query("SELECT id FROM permissions WHERE module_key = 'PRINT.DOCUMENT_TEMPLATES' AND action = 'VIEW'");
    await pool.execute("UPDATE role_permissions SET granted = 0 WHERE role_id = 3 AND permission_id = ?", [perm.id]);
    try {
      const hash = await bcrypt.hash("PtplPass!E1", 10);
      const [userResult] = await pool.execute(
        "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, 3, 'ACTIVE')",
        ["test_ptpl_norole", hash]
      );
      const noRoleUserId = userResult.insertId;
      await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [noRoleUserId, companyAId]);
      const noRoleToken = await loginAs("test_ptpl_norole", "PtplPass!E1");

      const res = await request(app).get("/api/print-templates").set("Authorization", `Bearer ${noRoleToken}`).query({ companyId: companyAId });
      expect(res.status).toBe(403);

      await pool.query("DELETE FROM user_companies WHERE user_id = ?", [noRoleUserId]);
      await pool.query("DELETE FROM users WHERE id = ?", [noRoleUserId]);
    } finally {
      await pool.execute("UPDATE role_permissions SET granted = 1 WHERE role_id = 3 AND permission_id = ?", [perm.id]);
    }
  });
});
