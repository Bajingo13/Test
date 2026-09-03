// Batch 8 Commit 1: POST /api/or/:id/email
//
// nodemailer is mocked so we can (a) run a "delivered" path deterministically
// and (b) assert the PDF attachment reaches the transport. The
// SMTP-not-configured path is exercised with the mock forced off.

const mockSendMail = jest.fn().mockResolvedValue({ messageId: "test" });
let smtpConfigured = true;
jest.mock("nodemailer", () => ({
  createTransport: jest.fn(() => ({ sendMail: mockSendMail })),
}));

const request = require("supertest");
const bcrypt = require("bcryptjs");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const CurrencyService = require("../services/currencyService");

// emailService.isConfigured() reads SMTP_* env; set them so getTransporter()
// returns the mock. Individual tests flip `smtpConfigured` to simulate "not
// configured" by clearing the vars before the call.
process.env.SMTP_HOST = "smtp.test";
process.env.SMTP_USER = "u";
process.env.SMTP_PASS = "p";
process.env.SMTP_FROM = "accounting@test";

const app = require("../server");

jest.setTimeout(220000);

let CO, CO2, token, token2, noPermToken;
let cashId, arId, revId;
let custId, custNoEmailId, custOtherCoId;

const authH = (t = token) => ({ Authorization: `Bearer ${t}` });
let seq = 0;

async function mkAcc(code, title, cls) {
  const [ex] = await pool.execute("SELECT id FROM chart_of_accounts WHERE code = ?", [code]);
  if (ex.length) return ex[0].id;
  const [r] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, cls]
  );
  return r.insertId;
}

async function createOr({ status = "Posted", customerId, customerName, companyId = CO } = {}) {
  const v = `PH8OR-${++seq}`;
  const res = await request(app).post("/api/or").set(authH()).send({
    voucherNo: v,
    customerId,
    customerName,
    transactionDate: "2026-09-03",
    referenceNo: v,
    description: "Payment received",
    status,
    paymentMethod: "Cash",
    currency: { companyId },
    lines: [
      { accountId: cashId, accountCode: "PH8-CASH", accountTitle: "Cash", particulars: "Cash", genRef: "", genName: "", debit: 5000, credit: 0 },
      { accountId: arId, accountCode: "PH8-AR", accountTitle: "Accounts Receivable", particulars: "AR", genRef: "", genName: "", debit: 0, credit: 5000 },
    ],
    totalDebit: 5000,
    totalCredit: 5000,
  });
  return { res, voucherNo: v };
}

beforeAll(async () => {
  assertNotProductionDatabase();
  const [c] = await pool.execute("INSERT INTO companies (name, status) VALUES ('PH8 Co', 'Active')");
  CO = c.insertId;
  const [c2] = await pool.execute("INSERT INTO companies (name, status) VALUES ('PH8 Co2', 'Active')");
  CO2 = c2.insertId;

  const hash = await bcrypt.hash("Ph8Pass!1", 10);
  const [u] = await pool.execute("INSERT INTO users (username, password, role_id, status) VALUES ('ph8_admin', ?, 2, 'ACTIVE')", [hash]);
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, CO]);
  token = (await request(app).post("/api/login").send({ username: "ph8_admin", password: "Ph8Pass!1" })).body.token;

  const [u2] = await pool.execute("INSERT INTO users (username, password, role_id, status) VALUES ('ph8_admin2', ?, 2, 'ACTIVE')", [hash]);
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u2.insertId, CO2]);
  token2 = (await request(app).post("/api/login").send({ username: "ph8_admin2", password: "Ph8Pass!1" })).body.token;

  // a role with NO TRANSACTIONS.OR/EMAIL grant
  const [role] = await pool.execute("INSERT INTO roles (code, name, is_system) VALUES ('PH8_NOEMAIL', 'PH8 No Email', 0)");
  // give it OR VIEW so it can at least reach the route's auth layer
  await pool.execute(
    `INSERT INTO role_permissions (role_id, permission_id, granted)
     SELECT ?, p.id, 1 FROM permissions p WHERE p.module_key = 'TRANSACTIONS.OR' AND p.action IN ('VIEW','CREATE')`,
    [role.insertId]
  );
  const [nu] = await pool.execute("INSERT INTO users (username, password, role_id, status) VALUES ('ph8_noemail', ?, ?, 'ACTIVE')", [hash, role.insertId]);
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [nu.insertId, CO]);
  noPermToken = (await request(app).post("/api/login").send({ username: "ph8_noemail", password: "Ph8Pass!1" })).body.token;

  const admin = { id: u.insertId, roleCode: "ADMIN" };
  await CurrencyService.createCurrency(admin, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "P",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: CO,
  });
  const admin2 = { id: u2.insertId, roleCode: "ADMIN" };
  await CurrencyService.createCurrency(admin2, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "P",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: CO2,
  });

  cashId = await mkAcc("PH8-CASH", "Cash in Bank", "ASSET");
  arId = await mkAcc("PH8-AR", "Accounts Receivable", "ASSET");
  revId = await mkAcc("PH8-REV", "Service Income", "INCOME");

  const [p1] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, status, email) VALUES (?, 'PH8-C1', 'CUSTOMER', 'PH8 Customer One', 'ACTIVE', 'cust1@example.com')",
    [CO]
  );
  custId = p1.insertId;
  const [p2] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, status, email) VALUES (?, 'PH8-C2', 'CUSTOMER', 'PH8 Customer NoEmail', 'ACTIVE', NULL)",
    [CO]
  );
  custNoEmailId = p2.insertId;
  const [p3] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, status, email) VALUES (?, 'PH8-C3', 'CUSTOMER', 'PH8 Other Co Cust', 'ACTIVE', 'other@example.com')",
    [CO2]
  );
  custOtherCoId = p3.insertId;

  await pool.execute(
    "INSERT INTO company_profile (id, payor_name, payor_tin, payor_address, payor_zip) VALUES (1, 'PH8 Test Co', '000-000-000-000', 'Test Addr', '1000') ON DUPLICATE KEY UPDATE payor_name = payor_name"
  );
});

afterAll(async () => {
  await pool.query("DELETE ln FROM or_lines ln JOIN or_headers h ON h.id = ln.or_id WHERE h.company_id IN (?, ?)", [CO, CO2]);
  await pool.query("DELETE FROM or_headers WHERE company_id IN (?, ?)", [CO, CO2]);
  await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id IN (?, ?)", [CO, CO2]);
  await pool.query("DELETE FROM audit_logs WHERE module = 'TRANSACTIONS.OR' AND action = 'EMAIL'");
  await pool.query("DELETE FROM currencies WHERE company_id IN (?, ?)", [CO, CO2]);
  await pool.query("DELETE FROM general_libraries WHERE company_id IN (?, ?)", [CO, CO2]);
  await pool.query("DELETE FROM user_companies WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'ph8_%')");
  await pool.query("DELETE FROM users WHERE username LIKE 'ph8_%'");
  await pool.query("DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE code = 'PH8_NOEMAIL')");
  await pool.query("DELETE FROM roles WHERE code = 'PH8_NOEMAIL'");
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [CO, CO2]);
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'PH8-%'");
  await pool.end();
});

beforeEach(() => {
  mockSendMail.mockClear();
  smtpConfigured = true;
  process.env.SMTP_HOST = "smtp.test";
  process.env.SMTP_USER = "u";
  process.env.SMTP_PASS = "p";
});

async function auditRows(orId) {
  const [rows] = await pool.query(
    "SELECT * FROM audit_logs WHERE module = 'TRANSACTIONS.OR' AND action = 'EMAIL' AND entity_id = ? ORDER BY id DESC",
    [orId]
  );
  return rows;
}

describe("Batch 8 - OR Email (POST /api/or/:id/email)", () => {
  test("Posted OR + configured SMTP -> delivered, PDF attachment reaches the mailer, audit row written", async () => {
    const { res: cr } = await createOr({ customerId: custId, customerName: "PH8 Customer One" });
    expect(cr.status).toBe(200);
    const orId = cr.body.id;

    const [[before]] = await pool.query("SELECT * FROM or_headers WHERE id = ?", [orId]);
    const beforeLineCount = (await pool.query("SELECT COUNT(*) c FROM or_lines WHERE or_id = ?", [orId]))[0][0].c;

    const res = await request(app).post(`/api/or/${orId}/email`).set(authH()).send({ companyId: CO });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, delivered: true, recipient: "cust1@example.com", recipientSource: "general_library" });
    expect(res.body.attachment).toMatch(/^OR-PH8OR-\d+\.pdf$/);

    // mailer got the PDF
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const call = mockSendMail.mock.calls[0][0];
    expect(call.to).toBe("cust1@example.com");
    expect(Array.isArray(call.attachments)).toBe(true);
    expect(call.attachments[0].filename).toBe(res.body.attachment);
    expect(Buffer.isBuffer(call.attachments[0].content)).toBe(true);
    expect(call.attachments[0].content.slice(0, 4).toString()).toBe("%PDF");

    // OR completely unchanged
    const [[after]] = await pool.query("SELECT * FROM or_headers WHERE id = ?", [orId]);
    expect(after).toEqual(before);
    const afterLineCount = (await pool.query("SELECT COUNT(*) c FROM or_lines WHERE or_id = ?", [orId]))[0][0].c;
    expect(afterLineCount).toBe(beforeLineCount);

    // no tax rows, no applications
    const [[te]] = await pool.query("SELECT COUNT(*) c FROM transaction_tax_entries WHERE transaction_type = 'OR' AND transaction_id = ?", [orId]);
    expect(te.c).toBe(0);
    const [[ap]] = await pool.query("SELECT COUNT(*) c FROM transaction_applications WHERE applied_type = 'OR' AND applied_id = ?", [orId]);
    expect(ap.c).toBe(0);

    // audit row
    const audits = await auditRows(orId);
    expect(audits.length).toBe(1);
    expect(audits[0].description).toMatch(/Emailed OR PH8OR-\d+ to cust1@example.com/);
    expect(audits[0].description).not.toMatch(/SMTP_PASS|smtp\.test/i);
    const after_data = typeof audits[0].after_data === "string" ? JSON.parse(audits[0].after_data) : audits[0].after_data;
    expect(after_data).toMatchObject({ recipient: "cust1@example.com", delivered: true });
  });

  test("SMTP not configured -> best-effort result (200, delivered:false, reason SMTP_NOT_CONFIGURED), still audited", async () => {
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;

    const { res: cr } = await createOr({ customerId: custId, customerName: "PH8 Customer One" });
    const orId = cr.body.id;

    const res = await request(app).post(`/api/or/${orId}/email`).set(authH()).send({ companyId: CO });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, delivered: false, reason: "SMTP_NOT_CONFIGURED" });
    expect(mockSendMail).not.toHaveBeenCalled();

    const audits = await auditRows(orId);
    expect(audits.length).toBe(1);
    expect(audits[0].description).toMatch(/not delivered: SMTP_NOT_CONFIGURED/);
  });

  test("recipient body override wins over the customer library email", async () => {
    const { res: cr } = await createOr({ customerId: custId, customerName: "PH8 Customer One" });
    const orId = cr.body.id;
    const res = await request(app).post(`/api/or/${orId}/email`).set(authH()).send({ to: "override@x.io", companyId: CO });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ recipient: "override@x.io", recipientSource: "request" });
    expect(mockSendMail.mock.calls[0][0].to).toBe("override@x.io");
  });

  test("no override + customer has no email -> 400 EMAIL_RECIPIENT_REQUIRED", async () => {
    const { res: cr } = await createOr({ customerId: custNoEmailId, customerName: "PH8 Customer NoEmail" });
    const orId = cr.body.id;
    const res = await request(app).post(`/api/or/${orId}/email`).set(authH()).send({ companyId: CO });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("EMAIL_RECIPIENT_REQUIRED");
    expect(mockSendMail).not.toHaveBeenCalled();
    expect((await auditRows(orId)).length).toBe(0);
  });

  test("invalid override email -> 400 EMAIL_RECIPIENT_REQUIRED (does NOT fall back to library)", async () => {
    const { res: cr } = await createOr({ customerId: custId, customerName: "PH8 Customer One" });
    const orId = cr.body.id;
    const res = await request(app).post(`/api/or/${orId}/email`).set(authH()).send({ to: "not-an-email", companyId: CO });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("EMAIL_RECIPIENT_REQUIRED");
  });

  test("no TRANSACTIONS.OR/EMAIL permission -> 403", async () => {
    const { res: cr } = await createOr({ customerId: custId, customerName: "PH8 Customer One" });
    const orId = cr.body.id;
    const res = await request(app).post(`/api/or/${orId}/email`).set(authH(noPermToken)).send({ companyId: CO });
    expect(res.status).toBe(403);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test("cross-company OR -> 404 (never emails another company's OR)", async () => {
    const { res: cr } = await createOr({ customerId: custId, customerName: "PH8 Customer One" });
    const orId = cr.body.id;
    // company 2 admin tries to email company 1's OR
    const res = await request(app).post(`/api/or/${orId}/email`).set(authH(token2)).send({ companyId: CO2 });
    expect([403, 404]).toContain(res.status);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test("Draft OR: toolbar hides Email; endpoint still renders read-only if reached (no lifecycle change)", async () => {
    const { res: cr } = await createOr({ status: "Draft", customerId: custId, customerName: "PH8 Customer One" });
    const orId = cr.body.id;
    const [[before]] = await pool.query("SELECT status FROM or_headers WHERE id = ?", [orId]);
    const res = await request(app).post(`/api/or/${orId}/email`).set(authH()).send({ companyId: CO });
    // BD-1: no new lifecycle state - emailing a Draft neither posts nor blocks; it's just read-only.
    expect(res.status).toBe(200);
    const [[after]] = await pool.query("SELECT status FROM or_headers WHERE id = ?", [orId]);
    expect(after.status).toBe(before.status);
  });

  test("Posted OR stays immutable through an email (status never flips)", async () => {
    const { res: cr } = await createOr({ customerId: custId, customerName: "PH8 Customer One" });
    const orId = cr.body.id;
    await request(app).post(`/api/or/${orId}/email`).set(authH()).send({ companyId: CO });
    const [[row]] = await pool.query("SELECT status FROM or_headers WHERE id = ?", [orId]);
    expect(String(row.status).toUpperCase()).toBe("POSTED");
  });
});
