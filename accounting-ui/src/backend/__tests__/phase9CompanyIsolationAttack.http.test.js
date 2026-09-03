// Batch 9 Part 12: explicit cross-company attack matrix for the routes
// touched by Batch 8/9 (OR email, quotation convert, APV reverse) plus the
// ewt-audit report, which Batch 9 discovered was NOT company-scoped
// (same leak class Phase 7D.1 fixed for alphalist/2307).

const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const CurrencyService = require("../services/currencyService");

jest.setTimeout(220000);

let A, B; // company ids
let tokenA, tokenB, uidA, uidB;
let expA, apA, ivatA, ewtpA, cashA, arA, revA;
let expB, apB;
let suppA, custA, suppB;
const ATC = "PH9-WC010";
const D = "2026-08-15";
const H = (t) => ({ Authorization: `Bearer ${t}` });
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
async function mkCo(name) {
  const [r] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [name]);
  return r.insertId;
}
async function mkUser(username, coId) {
  const hash = await bcrypt.hash("Ph9Pass!1", 10);
  const [u] = await pool.execute("INSERT INTO users (username, password, role_id, status) VALUES (?, ?, 2, 'ACTIVE')", [username, hash]);
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, coId]);
  return u.insertId;
}
async function login(username) {
  return (await request(app).post("/api/login").send({ username, password: "Ph9Pass!1" })).body.token;
}

async function apvWithEwt(token, companyId, { expId, apId, ivatId, ewtpId, supplierId }) {
  const v = `PH9-APV-${++seq}`;
  return request(app).post("/api/apv").set(H(token)).send({
    voucherNo: v, supplierId, supplierName: "S", transactionDate: D, referenceNo: v,
    description: "p", status: "Posted", atcCode: ATC, taxWithheldAmount: 1000,
    currency: { companyId },
    lines: [
      { accountId: expId, accountCode: "X", accountTitle: "Purchases", particulars: "p", genRef: "", genName: "", debit: 10000, credit: 0 },
      {
        accountId: ivatId, accountCode: "X", accountTitle: "Input VAT", particulars: "Input VAT (12%)",
        genRef: "", genName: "", debit: 1200, credit: 0,
        taxEntry: { entryType: "INPUT_VAT", accountId: ivatId, partyId: supplierId, partyName: "S", partyTin: "1", partyAddress: "M", transactionDate: D, grossAmount: 11200, netAmount: 10000, vatRate: 12, vatAmount: 1200, vatTreatment: "STANDARD", vatCode: null, vatEntryMode: "INCLUSIVE", purchaseClassification: "Services" },
      },
      {
        accountId: ewtpId, accountCode: "X", accountTitle: "Withholding Tax Payable", particulars: `EWT - ${ATC}`,
        genRef: "", genName: "", debit: 0, credit: 1000,
        taxEntry: { entryType: "EWT", accountId: ewtpId, partyId: supplierId, partyName: "S", partyTin: "1", partyAddress: "M", transactionDate: D, atcCode: ATC, taxType: "EWT", taxableBase: 10000, withheldAmount: 1000 },
      },
      { accountId: apId, accountCode: "X", accountTitle: "Accounts Payable", particulars: "ap", genRef: "", genName: "", debit: 0, credit: 10200 },
    ],
    totalDebit: 11200, totalCredit: 11200,
  });
}

beforeAll(async () => {
  assertNotProductionDatabase();
  A = await mkCo("PH9 Co A");
  B = await mkCo("PH9 Co B");
  uidA = await mkUser("ph9_a", A);
  uidB = await mkUser("ph9_b", B);
  tokenA = await login("ph9_a");
  tokenB = await login("ph9_b");

  for (const [uid, co] of [[uidA, A], [uidB, B]]) {
    await CurrencyService.createCurrency({ id: uid, roleCode: "ADMIN" }, {
      currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "P",
      decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: co,
    });
  }

  expA = await mkAcc("PH9A-EXP", "Purchases", "EXPENSE");
  apA = await mkAcc("PH9A-AP", "Accounts Payable", "LIABILITY");
  ivatA = await mkAcc("PH9A-IVAT", "Input VAT", "ASSET");
  ewtpA = await mkAcc("PH9A-EWTP", "Withholding Tax Payable", "LIABILITY");
  cashA = await mkAcc("PH9A-CASH", "Cash in Bank", "ASSET");
  arA = await mkAcc("PH9A-AR", "Accounts Receivable", "ASSET");
  revA = await mkAcc("PH9A-REV", "Sales Revenue", "INCOME");
  expB = await mkAcc("PH9B-EXP", "Purchases B", "EXPENSE");
  apB = await mkAcc("PH9B-AP", "Accounts Payable B", "LIABILITY");
  await pool.execute("INSERT INTO coa_validations (coa_id, validation_name) VALUES (?, 'INPUT VAT'), (?, 'EXPANDED TAX')", [ivatA, ewtpA]);

  const [s1] = await pool.execute("INSERT INTO general_libraries (company_id, code, party_type, name, status, tin, email) VALUES (?, 'PH9A-S', 'SUPPLIER', 'S A', 'ACTIVE', '1', NULL)", [A]);
  suppA = s1.insertId;
  const [c1] = await pool.execute("INSERT INTO general_libraries (company_id, code, party_type, name, status, email) VALUES (?, 'PH9A-C', 'CUSTOMER', 'C A', 'ACTIVE', 'ca@x.io')", [A]);
  custA = c1.insertId;
  const [s2] = await pool.execute("INSERT INTO general_libraries (company_id, code, party_type, name, status, tin) VALUES (?, 'PH9B-S', 'SUPPLIER', 'S B', 'ACTIVE', '2')", [B]);
  suppB = s2.insertId;

  await pool.execute("INSERT INTO ewt_library (atc_code, description, rate, tax_type, status) VALUES (?, 'ph9', 10, 'EWT', 'ACTIVE')", [ATC]);
  await pool.execute("INSERT INTO accounting_periods (company_id, year, period_month, start_date, end_date, status) VALUES (?, 2026, 8, '2026-08-01', '2026-08-31', 'OPEN'), (?, 2026, 8, '2026-08-01', '2026-08-31', 'OPEN')", [A, B]);
  await pool.execute("INSERT INTO company_profile (id, payor_name) VALUES (1, 'PH9') ON DUPLICATE KEY UPDATE payor_name = payor_name");
});

afterAll(async () => {
  await pool.query("DELETE FROM transaction_tax_entries WHERE company_id IN (?, ?)", [A, B]);
  await pool.query("DELETE FROM transaction_applications WHERE applied_id IN (SELECT id FROM cv_headers WHERE company_id IN (?, ?))", [A, B]);
  for (const t of ["apv", "cv", "jv", "invoice", "quotation", "or"]) {
    await pool.query(`DELETE ln FROM ${t}_lines ln JOIN ${t}_headers h ON h.id = ln.${t}_id WHERE h.company_id IN (?, ?)`, [A, B]);
  }
  for (const t of ["apv_headers", "cv_headers", "jv_headers", "invoice_headers", "quotation_headers", "or_headers"]) {
    await pool.query(`DELETE FROM ${t} WHERE company_id IN (?, ?)`, [A, B]);
  }
  await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id IN (?, ?)", [A, B]);
  await pool.query("DELETE FROM accounting_periods WHERE company_id IN (?, ?)", [A, B]);
  await pool.query("DELETE FROM audit_logs WHERE entity_id IN (SELECT id FROM apv_headers WHERE company_id IN (?, ?))", [A, B]);
  await pool.query("DELETE FROM ewt_library WHERE atc_code = ?", [ATC]);
  await pool.query("DELETE FROM general_libraries WHERE company_id IN (?, ?)", [A, B]);
  await pool.query("DELETE FROM currencies WHERE company_id IN (?, ?)", [A, B]);
  await pool.query("DELETE FROM user_companies WHERE user_id IN (?, ?)", [uidA, uidB]);
  await pool.query("DELETE FROM users WHERE id IN (?, ?)", [uidA, uidB]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [A, B]);
  await pool.query("DELETE FROM coa_validations WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE 'PH9%')");
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'PH9%'");
  await pool.end();
});

describe("Batch 9 - cross-company attack matrix", () => {
  test("ewt-audit report is company-scoped: Company A's admin never sees Company B's flagged rows", async () => {
    // A: a genuinely tampered APV (base mismatch) so it flags.
    const a = await apvWithEwt(tokenA, A, { expId: expA, apId: apA, ivatId: ivatA, ewtpId: ewtpA, supplierId: suppA });
    expect(a.status).toBe(200);
    await pool.query("UPDATE apv_headers SET taxable_base = 111 WHERE id = ?", [a.body.id]);
    // B: a plain APV header row with an ATC + a mismatched base (no structured lines needed to flag).
    await pool.query(
      "INSERT INTO apv_headers (company_id, voucher_no, supplier_id, supplier_name, transaction_date, total_credit, total_debit, status, atc_code, tax_type, tax_rate, tax_withheld_amount, taxable_base) VALUES (?, 'PH9B-APV-1', ?, 'S B', ?, 5000, 5000, 'Posted', ?, 'EWT', 10, 500, 222)",
      [B, suppB, D, ATC]
    );
    const [[bRow]] = await pool.query("SELECT id FROM apv_headers WHERE voucher_no = 'PH9B-APV-1'");

    const resA = await request(app).get(`/api/reports/ewt-audit?companyId=${A}`).set(H(tokenA));
    expect(resA.status).toBe(200);
    const idsA = resA.body.flagged.map((f) => f.id);
    expect(idsA).toContain(a.body.id);
    expect(idsA).not.toContain(bRow.id); // <-- B's row must NOT leak to A
    expect(resA.body.flagged.some((f) => String(f.voucherNo).startsWith("PH9B-"))).toBe(false);

    const resB = await request(app).get(`/api/reports/ewt-audit?companyId=${B}`).set(H(tokenB));
    expect(resB.body.flagged.map((f) => f.id)).toContain(bRow.id);
    expect(resB.body.flagged.map((f) => f.id)).not.toContain(a.body.id);

    // A asking for B's companyId is never honored: resolveCompanyIdForWrite
    // rejects the foreign company (this report family surfaces that as a
    // non-200, same as /api/reports/alphalist and /2307). The invariant that
    // matters: A never receives B's rows.
    const resAtamper = await request(app).get(`/api/reports/ewt-audit?companyId=${B}`).set(H(tokenA));
    expect(
      resAtamper.status !== 200 ||
        !(resAtamper.body.flagged || []).map((f) => f.id).includes(bRow.id)
    ).toBe(true);
  });

  test("OR email: Company A admin cannot email Company B's OR", async () => {
    const [orB] = await pool.query(
      "INSERT INTO or_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_credit, total_debit, status) VALUES (?, 'PH9B-OR-1', NULL, 'x', ?, 1, 1, 'Posted')",
      [B, D]
    );
    const res = await request(app).post(`/api/or/${orB.insertId}/email`).set(H(tokenA)).send({ to: "x@x.io", companyId: A });
    expect([403, 404]).toContain(res.status);
  });

  test("Quotation convert: Company A admin cannot convert Company B's quotation", async () => {
    const [qB] = await pool.query(
      "INSERT INTO quotation_headers (company_id, quotation_no, customer_name, quotation_date, status, total_amount) VALUES (?, 'PH9B-Q-1', 'x', ?, 'Draft', 100)",
      [B, D]
    );
    await pool.query(
      "INSERT INTO quotation_lines (quotation_id, sort_order, line_type, description, quantity, unit_price, tax_rate, amount) VALUES (?, 0, 'item', 'x', 1, 100, 12, 100)",
      [qB.insertId]
    );
    const res = await request(app).post(`/api/quotations/${qB.insertId}/convert-to-invoice`).set(H(tokenA)).send({ companyId: A });
    expect([403, 404]).toContain(res.status);
    const [[q]] = await pool.query("SELECT status FROM quotation_headers WHERE id = ?", [qB.insertId]);
    expect(q.status).toBe("Draft"); // not converted
  });

  test("APV reverse: Company A admin cannot reverse Company B's APV", async () => {
    const [apvB] = await pool.query(
      "INSERT INTO apv_headers (company_id, voucher_no, supplier_id, supplier_name, transaction_date, total_credit, total_debit, status) VALUES (?, 'PH9B-APV-REV', ?, 'S B', ?, 100, 100, 'Posted')",
      [B, suppB, D]
    );
    const res = await request(app).post(`/api/apv/${apvB.insertId}/reverse`).set(H(tokenA)).send({ reason: "x", companyId: A });
    expect([403, 404]).toContain(res.status);
    const [[row]] = await pool.query("SELECT status FROM apv_headers WHERE id = ?", [apvB.insertId]);
    expect(row.status).toBe("Posted");
  });
});
