const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Proves two additive-only wirings on GET /api/invoice-print/:id
// (invoicePrintDataService.getInvoicePrintViewModel):
//   1. seller.{phone,email,vatRegistration,branchCode,logoUrl,birPermitNumber,
//      atpDate,serialNumbers} now read from companies' contact/BIR columns
//      (companies_contact_bir_fields_migration.sql) instead of being
//      hardcoded null.
//   2. document.terms now reads from invoice_headers.terms
//      (invoice_terms_migration.sql) instead of being hardcoded null.
//
// Checkpoint: Companies Contact/BIR Fields retired company_profile (the
// single global row previously read regardless of which company's
// document was being printed) in favor of `companies`, which is already
// company-scoped everywhere else in this system. This test therefore
// seeds its OWN throwaway companies row (companyId, created below) and
// mutates only that row - no shared/global state, no snapshot-and-restore
// dance needed (unlike this file's previous version, which had to
// snapshot/restore company_profile's real row since that table had no
// company_id at all).
//
// Also proves backward compatibility: an invoice with no terms, and a
// company with the new columns NULL, both print with graceful nulls
// (invoicePrintDataService never invents a value) - not an error.

jest.setTimeout(180000);

let companyId, token;
let arId, revId;
let custId;
const createdInvoiceIds = [];

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

async function cleanupStaleFixtures() {
  const [companies] = await pool.query("SELECT id FROM companies WHERE name LIKE 'TEST Invoice New Fields%'");
  const companyIds = companies.map((c) => c.id);

  if (companyIds.length) {
    await pool.query("DELETE FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoice_headers WHERE company_id IN (?))", [companyIds]);
    await pool.query("DELETE FROM invoice_headers WHERE company_id IN (?)", [companyIds]);
    await pool.query("DELETE FROM general_libraries WHERE company_id IN (?)", [companyIds]);
  }

  const [users] = await pool.query("SELECT id FROM users WHERE username LIKE 'test_invf%'");
  const userIds = users.map((u) => u.id);
  if (userIds.length) {
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [userIds]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [userIds]);
  }

  if (companyIds.length) {
    // FK-safe order: this fixture also creates a base-currency row (and the
    // invoice flow writes a currency snapshot) that reference companies.id -
    // remove those test-created child rows before the parent company row,
    // scoped strictly to this fixture's own company ids.
    await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id IN (?)", [companyIds]);
    await pool.query("DELETE FROM currencies WHERE company_id IN (?)", [companyIds]);
    await pool.query("DELETE FROM companies WHERE id IN (?)", [companyIds]);
  }
  await pool.execute("DELETE FROM chart_of_accounts WHERE code LIKE 'TESTINVF%'");
}

async function createInvoice({ voucherNo, terms }) {
  const body = {
    voucherNo,
    customerId: custId,
    customerName: "x",
    transactionDate: "2026-08-01",
    dueDate: "2026-08-08",
    terms,
    status: "Draft",
    lines: [
      { accountId: arId, accountCode: "TESTINVFAR", accountTitle: "Accounts Receivable", particulars: "x", debit: 1000, credit: 0, genRef: "", genName: "" },
      { accountId: revId, accountCode: "TESTINVFREV", accountTitle: "Sales Revenue", particulars: "x", debit: 0, credit: 1000, genRef: "", genName: "" },
    ],
    totalDebit: 1000,
    totalCredit: 1000,
    currency: { companyId },
  };
  const res = await request(app).post("/api/invoices").set("Authorization", `Bearer ${token}`).send(body);
  if (res.status !== 200 || !res.body.success) throw new Error(`Invoice create failed: ${JSON.stringify(res.body)}`);
  createdInvoiceIds.push(res.body.id);
  return res.body.id;
}

async function getPrintViewModel(id) {
  const res = await request(app)
    .get(`/api/invoice-print/${id}`)
    .set("Authorization", `Bearer ${token}`)
    .query({ companyId });
  expect(res.status).toBe(200);
  return res.body;
}

beforeAll(async () => {
  assertNotProductionDatabase();

  await cleanupStaleFixtures();

  companyId = await makeCompany("TEST Invoice New Fields Co");
  const adminId = await makeLoginUser("test_invf_admin", "InvfPass!1", 2, companyId);
  token = await loginAs("test_invf_admin", "InvfPass!1");

  arId = await makeAccount("TESTINVFAR", "Accounts Receivable (New Fields Test)", "ASSET");
  revId = await makeAccount("TESTINVFREV", "Sales Revenue (New Fields Test)", "INCOME");
  custId = await makeParty("TESTINVF-CUST", "CUSTOMER", "New Fields Test Customer", companyId);

  const CurrencyService = require("../services/currencyService");
  await CurrencyService.createCurrency({ id: adminId, roleCode: "ADMIN" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId,
  }).catch(() => {
    // A base PHP currency for this company may already exist from a prior
    // run's incomplete cleanup - non-fatal, the invoice create below only
    // needs one base-currency row to exist for this companyId.
  });
});

afterAll(async () => {
  try {
    await cleanupStaleFixtures();
  } finally {
    await pool.end();
  }
});

describe("1: seller fields wired from companies' contact/BIR columns", () => {
  test("seller.{phone,email,vatRegistration,branchCode,logoUrl,birPermitNumber,atpDate,serialNumbers} reflect stored values", async () => {
    await pool.execute(
      `UPDATE companies SET
        telephone = '(02) 8123-4567', email = 'billing@testinvf.example',
        vat_registered = 1, branch_code = 'HO',
        logo_url = 'https://example.test/logo.png', bir_permit_no = 'BIR-PERMIT-001',
        atp_date = '2026-01-15', approved_serial_from = '000001', approved_serial_to = '000100'
      WHERE id = ?`,
      [companyId]
    );

    const id = await createInvoice({ voucherNo: "TESTINVF-INV-1", terms: "Net 30" });
    const data = await getPrintViewModel(id);

    expect(data.seller.phone).toBe("(02) 8123-4567");
    expect(data.seller.email).toBe("billing@testinvf.example");
    expect(data.seller.vatRegistration).toBe(true);
    expect(data.seller.branchCode).toBe("HO");
    expect(data.seller.logoUrl).toBe("https://example.test/logo.png");

    // ATP/permit/serial-number data's visual home is the FOOTER (per the
    // BIR reference layout - below "THIS IS SYSTEM GENERATED", not in the
    // header block with name/address/TIN). `footer` is the authoritative
    // copy; `seller` carries the exact same values (birComplianceInfo is
    // computed once and spread into both) rather than a second,
    // independently-derived block.
    expect(data.footer.birPermitNumber).toBe("BIR-PERMIT-001");
    expect(String(data.footer.atpDate)).toContain("2026-01-15");
    expect(data.footer.serialNumbers).toEqual({ from: "000001", to: "000100" });
    expect(data.footer.atpNumber).toBeNull(); // no backing column exists

    expect(data.seller.birPermitNumber).toBe(data.footer.birPermitNumber);
    expect(data.seller.atpDate).toBe(data.footer.atpDate);
    expect(data.seller.serialNumbers).toEqual(data.footer.serialNumbers);
    expect(data.seller.atpNumber).toBe(data.footer.atpNumber);
  });
});

describe("2: document.terms wired from invoice_headers.terms", () => {
  test("terms round-trips exactly as submitted", async () => {
    const id = await createInvoice({ voucherNo: "TESTINVF-INV-2", terms: "Due on Receipt" });
    const data = await getPrintViewModel(id);
    expect(data.document.terms).toBe("Due on Receipt");
  });
});

describe("3: backward compatibility - graceful nulls, not errors", () => {
  test("an invoice with no terms and a company with the new columns NULL prints without error", async () => {
    await pool.execute(
      `UPDATE companies SET
        telephone = NULL, email = NULL, vat_registered = 0, branch_code = NULL,
        logo_url = NULL, bir_permit_no = NULL, atp_date = NULL,
        approved_serial_from = NULL, approved_serial_to = NULL
      WHERE id = ?`,
      [companyId]
    );

    const id = await createInvoice({ voucherNo: "TESTINVF-INV-3", terms: undefined });
    const data = await getPrintViewModel(id);

    expect(data.document.terms).toBeNull();
    expect(data.seller.phone).toBeNull();
    expect(data.seller.email).toBeNull();
    expect(data.seller.vatRegistration).toBe(false);
    expect(data.seller.branchCode).toBeNull();
    expect(data.seller.logoUrl).toBeNull();
    expect(data.seller.birPermitNumber).toBeNull();
    expect(data.seller.atpDate).toBeNull();
    expect(data.seller.serialNumbers).toBeNull();
    expect(data.seller.atpNumber).toBeNull();

    // The footer (this data's actual visual home) is equally null-safe -
    // hasBirInfo in InvoicePrintFooter.jsx hides the whole BIR block
    // rather than rendering blank lines.
    expect(data.footer.birPermitNumber).toBeNull();
    expect(data.footer.atpDate).toBeNull();
    expect(data.footer.serialNumbers).toBeNull();
    expect(data.footer.atpNumber).toBeNull();

    // Never regresses the always-wired fields while the new ones are null.
    expect(data.seller.name).toBeTruthy();
  });
});
