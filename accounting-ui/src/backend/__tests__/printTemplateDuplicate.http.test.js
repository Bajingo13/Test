const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Phase 3E (Final Print Template Builder Polish). No backend code changed
// for this checkpoint - "Duplicate existing template" and "Duplicate
// System Default to Customize" are both pure frontend compositions of
// already-existing endpoints (GET built-in / the already-loaded list data,
// then POST create). This file proves those existing endpoints behave
// correctly for exactly the sequence the new Builder UI actions send, so a
// regression in create/list/built-in would be caught here even though no
// new backend surface was added. The Builder UI itself (System Default
// row, Duplicate buttons, dirty-guard, variant defaults) is frontend-only
// and verified separately via live Playwright.

jest.setTimeout(180000);

let companyAId;
let tokenA, adminAId;

const TEST_COMPANY_NAME_PATTERN = "TEST Print Duplicate%";
const TEST_USERNAME_PATTERN = "test_ptdup%";

async function cleanupAllStaleFixtures() {
  const [staleCompanies] = await pool.query("SELECT id FROM companies WHERE name LIKE ?", [TEST_COMPANY_NAME_PATTERN]);
  const staleCompanyIds = staleCompanies.map((r) => r.id);

  if (staleCompanyIds.length) {
    await pool.query("DELETE FROM document_print_templates WHERE company_id IN (?)", [staleCompanyIds]);
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
async function loginAs(username, password) {
  const res = await request(app).post("/api/login").send({ username, password });
  return res.body.token;
}
async function createTemplate(token, body) {
  return request(app).post("/api/print-templates").set("Authorization", `Bearer ${token}`).send(body);
}

// Mirrors PrintTemplateList.jsx's buildConfigPayload() exactly: a GET/POST
// response's config is the fully-populated STORED shape (every field
// always present, e.g. summary.showAppliedInvoices: false even for
// Invoice), but mergeAndValidateConfig() rejects that same key's mere
// PRESENCE as INPUT for a non-OR module - see its "only supported for the
// OR module" checks. The real frontend never resends a fetched config
// raw; it always routes it through configToForm() -> buildConfigPayload()
// first, which is what strips these module-conditional fields. This test
// file has no access to that React module, so it reproduces the same
// stripping rule here to test the real sequence the UI actually sends.
function stripForModule(config, moduleType) {
  const isOr = moduleType === "or";
  const { showAppliedInvoices, ...restSummary } = config.summary || {};
  const { appliedInvoiceColumns, ...restTable } = config.table || {};
  return {
    ...config,
    summary: isOr ? config.summary : restSummary,
    table: isOr ? config.table : restTable,
  };
}

beforeAll(async () => {
  assertNotProductionDatabase();
  await cleanupAllStaleFixtures();

  companyAId = await makeCompany("TEST Print Duplicate Co A");
  adminAId = await makeLoginUser("test_ptdup_admin_a", "PtDupPass!A1", 2, companyAId);
  tokenA = await loginAs("test_ptdup_admin_a", "PtDupPass!A1");
});

afterAll(async () => {
  try {
    await cleanupAllStaleFixtures();
  } finally {
    await pool.end();
  }
});

describe("1: Duplicate System Default to Customize - built-in config round-trips exactly", () => {
  test("a template created from the full built-in config matches that config exactly", async () => {
    const builtInRes = await request(app).get("/api/print-templates/built-in?moduleType=invoice").set("Authorization", `Bearer ${tokenA}`);
    expect(builtInRes.status).toBe(200);

    const created = await createTemplate(tokenA, {
      moduleType: "invoice", templateCode: "ptdup-system-default-copy", templateName: "System Default (Customized)",
      documentVariant: "sales_invoice", config: stripForModule(builtInRes.body.config, "invoice"),
    });
    expect(created.status).toBe(201);
    expect(created.body.config).toEqual(builtInRes.body.config);
    expect(created.body.isDefault).toBe(false);
  });

  test("OR built-in config (including appliedInvoiceColumns) also round-trips exactly", async () => {
    const builtInRes = await request(app).get("/api/print-templates/built-in?moduleType=or").set("Authorization", `Bearer ${tokenA}`);
    expect(builtInRes.status).toBe(200);

    const created = await createTemplate(tokenA, {
      moduleType: "or", templateCode: "ptdup-or-system-default-copy", templateName: "System Default (Customized)",
      documentVariant: "official_receipt", config: stripForModule(builtInRes.body.config, "or"),
    });
    expect(created.status).toBe(201);
    expect(created.body.config).toEqual(builtInRes.body.config);
  });
});

describe("2: Duplicate existing template", () => {
  let sourceTemplate;

  beforeAll(async () => {
    const created = await createTemplate(tokenA, {
      moduleType: "invoice", templateCode: "ptdup-source", templateName: "Source Template",
      documentVariant: "commercial_invoice",
      config: { header: { documentTitle: "CUSTOM TITLE" }, table: { columns: [{ key: "amount", label: "Total Due" }] } },
    });
    expect(created.status).toBe(201);
    sourceTemplate = created.body;
  });

  test("duplicate receives a new id and matches the source's config/variant", async () => {
    const dup = await createTemplate(tokenA, {
      moduleType: "invoice", templateCode: "ptdup-source-copy", templateName: `${sourceTemplate.templateName} (Copy)`,
      documentVariant: sourceTemplate.documentVariant, config: stripForModule(sourceTemplate.config, "invoice"),
    });
    expect(dup.status).toBe(201);
    expect(dup.body.id).not.toBe(sourceTemplate.id);
    expect(dup.body.config).toEqual(sourceTemplate.config);
    expect(dup.body.documentVariant).toBe(sourceTemplate.documentVariant);
  });

  test("duplicate is not the default automatically", async () => {
    const dup = await createTemplate(tokenA, {
      moduleType: "invoice", templateCode: "ptdup-source-copy2", templateName: `${sourceTemplate.templateName} (Copy 2)`,
      documentVariant: sourceTemplate.documentVariant, config: stripForModule(sourceTemplate.config, "invoice"),
    });
    expect(dup.status).toBe(201);
    expect(dup.body.isDefault).toBe(false);
  });

  test("duplicate cannot reuse the source's existing template code", async () => {
    const dup = await createTemplate(tokenA, {
      moduleType: "invoice", templateCode: sourceTemplate.templateCode, templateName: "Colliding Copy",
      documentVariant: sourceTemplate.documentVariant, config: stripForModule(sourceTemplate.config, "invoice"),
    });
    expect(dup.status).toBe(409);
    expect(dup.body.message).toMatch(new RegExp(`code "${sourceTemplate.templateCode}" already exists`));
  });

  test("the source template itself is unmodified after being duplicated", async () => {
    const reread = await request(app).get(`/api/print-templates/${sourceTemplate.id}`).set("Authorization", `Bearer ${tokenA}`);
    expect(reread.status).toBe(200);
    expect(reread.body.templateName).toBe("Source Template");
    expect(reread.body.config).toEqual(sourceTemplate.config);
  });
});
