const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const CurrencyService = require("../services/currencyService");

// Phase 7F: /api/reports/output-vat is now structured-first (transaction_tax_entries
// OUTPUT_VAT rows, classified by the Phase 7E vat_treatment snapshot) with a GL
// fallback for transactions that have no structured entry (historical Invoices,
// and every OR). Covers: STANDARD / ZERO_RATED / EXEMPT buckets, VAT amount per
// treatment, no double-count of a structured transaction's GL line, GL fallback
// for a historical row, Draft excluded, row + report totals reconcile.

jest.setTimeout(180000);

let companyId, userId, token;
let arId, revId, outputVatId;
let custId;

async function makeCompany(name) {
  const [r] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [name]);
  return r.insertId;
}
async function makeAccount(code, title, accountClass) {
  const [r] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, accountClass]
  );
  return r.insertId;
}

beforeAll(async () => {
  assertNotProductionDatabase();
  companyId = await makeCompany("PH7F-U Company");

  const hash = await bcrypt.hash("Ph7fuPass!1", 10);
  const [u] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('ph7fu_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  userId = u.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, companyId]);
  token = (await request(app).post("/api/login").send({ username: "ph7fu_admin", password: "Ph7fuPass!1" })).body.token;

  await CurrencyService.createCurrency(
    { id: userId, roleCode: "ADMIN" },
    { currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱", decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId }
  );

  arId = await makeAccount("PH7FU-AR", "Accounts Receivable", "ASSET");
  revId = await makeAccount("PH7FU-REV", "Sales Revenue", "INCOME");
  outputVatId = await makeAccount("PH7FU-OVAT", "Output VAT Payable", "LIABILITY");

  const [c] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, status, tin) VALUES (?, 'PH7FU-CUST', 'CUSTOMER', 'PH7F-U Customer', 'ACTIVE', '123-456-789-000')"
  , [companyId]);
  custId = c.insertId;
});

afterAll(async () => {
  await pool.query("DELETE FROM transaction_tax_entries WHERE company_id = ?", [companyId]);
  await pool.query("DELETE l FROM invoice_lines l JOIN invoice_headers h ON h.id = l.invoice_id WHERE h.company_id = ?", [companyId]);
  await pool.query("DELETE FROM invoice_headers WHERE company_id = ?", [companyId]);
  await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id = ?", [companyId]);
  await pool.query("DELETE FROM general_libraries WHERE company_id = ?", [companyId]);
  await pool.query("DELETE FROM currencies WHERE company_id = ?", [companyId]);
  await pool.query("DELETE FROM user_companies WHERE user_id = ?", [userId]);
  await pool.query("DELETE FROM users WHERE id = ?", [userId]);
  await pool.query("DELETE FROM companies WHERE id = ?", [companyId]);
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'PH7FU-%'");
  await pool.end();
});

// A structured Output VAT invoice. amount = gross (VAT-inclusive) for STANDARD;
// amount = base for ZERO_RATED / EXEMPT.
async function structuredInvoice({ voucher, date, amount, treatment, vatCode, status = "Posted" }) {
  const t = treatment || "STANDARD";
  const zero = t === "ZERO_RATED" || t === "EXEMPT";
  const net = zero ? amount : Math.round((amount / 1.12) * 100) / 100;
  const vat = zero ? 0 : Math.round((amount - net) * 100) / 100;
  const rate = zero ? 0 : 12;
  return request(app).post("/api/invoices").set("Authorization", `Bearer ${token}`).send({
    voucherNo: voucher, customerId: custId, customerName: "PH7F-U Customer",
    transactionDate: date, referenceNo: voucher, description: "unify test", status,
    lines: [
      { accountId: arId, accountCode: "PH7FU-AR", accountTitle: "AR", particulars: "AR", genRef: "", genName: "", debit: amount, credit: 0 },
      { accountId: revId, accountCode: "PH7FU-REV", accountTitle: "Rev", particulars: "Rev", genRef: "", genName: "", debit: 0, credit: net },
      {
        accountId: outputVatId, accountCode: "PH7FU-OVAT", accountTitle: "Output VAT Payable",
        particulars: zero ? `${t} sale` : `Output VAT (12%)`, genRef: "", genName: "", debit: 0, credit: vat,
        taxEntry: {
          entryType: "OUTPUT_VAT", accountId: outputVatId, partyId: custId, partyName: "PH7F-U Customer",
          partyTin: "123-456-789-000", partyAddress: "Manila", transactionDate: date,
          grossAmount: amount, netAmount: net, vatRate: rate, vatAmount: vat,
          vatTreatment: t, vatCode: vatCode || null,
        },
      },
    ],
    totalDebit: amount, totalCredit: amount,
  });
}

// A historical Invoice: plain GL Output VAT line, no taxEntry -> no structured row.
async function historicalGlInvoice({ voucher, date, gross, vat, status = "Posted" }) {
  return request(app).post("/api/invoices").set("Authorization", `Bearer ${token}`).send({
    voucherNo: voucher, customerId: custId, customerName: "PH7F-U Customer",
    transactionDate: date, referenceNo: voucher, description: "historical GL", status,
    lines: [
      { accountId: arId, accountCode: "PH7FU-AR", accountTitle: "AR", particulars: "AR", genRef: "", genName: "", debit: gross, credit: 0 },
      { accountId: revId, accountCode: "PH7FU-REV", accountTitle: "Rev", particulars: "Rev", genRef: "", genName: "", debit: 0, credit: gross - vat },
      { accountId: outputVatId, accountCode: "PH7FU-OVAT", accountTitle: "Output VAT Payable", particulars: "Output VAT (12%)", genRef: "", genName: "", debit: 0, credit: vat },
    ],
    totalDebit: gross, totalCredit: gross,
  });
}

function report(extra = {}) {
  return request(app).get("/api/reports/output-vat").set("Authorization", `Bearer ${token}`)
    .query({ from: "2026-10-01", to: "2026-10-31", accountCode: "PH7FU-OVAT", companyId, ...extra });
}

describe("Phase 7F - Output VAT report: structured-first + treatment buckets", () => {
  let res;

  beforeAll(async () => {
    await structuredInvoice({ voucher: "PH7FU-STD", date: "2026-10-05", amount: 11200, treatment: "STANDARD" });
    await structuredInvoice({ voucher: "PH7FU-ZR", date: "2026-10-06", amount: 5000, treatment: "ZERO_RATED", vatCode: "VAT_ZERO_RATED" });
    await structuredInvoice({ voucher: "PH7FU-EX", date: "2026-10-07", amount: 3000, treatment: "EXEMPT", vatCode: "VAT_EXEMPT" });
    await historicalGlInvoice({ voucher: "PH7FU-HIST", date: "2026-10-08", gross: 2240, vat: 240 });
    await structuredInvoice({ voucher: "PH7FU-DRAFT", date: "2026-10-09", amount: 1120, treatment: "STANDARD", status: "Draft" });
    res = await report();
  });

  test("all four Posted rows appear; the Draft does not", () => {
    expect(res.status).toBe(200);
    const refs = res.body.rows.map((r) => r.docRef).sort();
    expect(refs).toEqual(["PH7FU-EX", "PH7FU-HIST", "PH7FU-STD", "PH7FU-ZR"]);
  });

  test("STANDARD row: net -> VATable Sales, VAT -> VAT Amount, source structured", () => {
    const r = res.body.rows.find((x) => x.docRef === "PH7FU-STD");
    expect(r.source).toBe("structured");
    expect(r.vatableSales).toBeCloseTo(10000, 2);
    expect(r.zeroRatedSales).toBe(0);
    expect(r.exemptSales).toBe(0);
    expect(r.vatAmount).toBeCloseTo(1200, 2);
    expect(r.customer).toBe("PH7F-U Customer");
    expect(r.tin).toBe("123-456-789-000");
  });

  test("ZERO_RATED row: base -> Zero-Rated Sales, VAT Amount 0, NOT in VATable", () => {
    const r = res.body.rows.find((x) => x.docRef === "PH7FU-ZR");
    expect(r.source).toBe("structured");
    expect(r.zeroRatedSales).toBeCloseTo(5000, 2);
    expect(r.vatableSales).toBe(0);
    expect(r.exemptSales).toBe(0);
    expect(r.vatAmount).toBe(0);
  });

  test("EXEMPT row: base -> VAT-Exempt Sales, VAT Amount 0, kept distinct from zero-rated", () => {
    const r = res.body.rows.find((x) => x.docRef === "PH7FU-EX");
    expect(r.exemptSales).toBeCloseTo(3000, 2);
    expect(r.zeroRatedSales).toBe(0);
    expect(r.vatableSales).toBe(0);
    expect(r.vatAmount).toBe(0);
  });

  test("historical Invoice with no structured entry falls back to GL (VAT amount only)", () => {
    const r = res.body.rows.find((x) => x.docRef === "PH7FU-HIST");
    expect(r.source).toBe("gl");
    expect(r.vatAmount).toBeCloseTo(240, 2);
    expect(r.vatableSales).toBeNull(); // GL line carries no net/base
  });

  test("no double-counting: the STANDARD invoice's GL Output VAT line is NOT also counted", () => {
    // PH7FU-STD has a structured OUTPUT_VAT entry AND a GL credit of 1200 to
    // PH7FU-OVAT. It must appear exactly once, as the structured row.
    const stdRows = res.body.rows.filter((r) => r.docRef === "PH7FU-STD");
    expect(stdRows).toHaveLength(1);
    expect(stdRows[0].source).toBe("structured");
  });

  test("report totals reconcile with the rows", () => {
    const sum = (f) => res.body.rows.reduce((s, r) => s + (Number(r[f]) || 0), 0);
    expect(res.body.totals.vatableSales).toBeCloseTo(sum("vatableSales"), 2);
    expect(res.body.totals.zeroRatedSales).toBeCloseTo(sum("zeroRatedSales"), 2);
    expect(res.body.totals.exemptSales).toBeCloseTo(sum("exemptSales"), 2);
    expect(res.body.totals.vatAmount).toBeCloseTo(sum("vatAmount"), 2);
    expect(res.body.totals.grossAmount).toBeCloseTo(sum("grossAmount"), 2);
  });

  test("bucket totals: VATable 10000, Zero-Rated 5000, Exempt 3000, VAT 1200+240", () => {
    expect(res.body.totals.vatableSales).toBeCloseTo(10000, 2);
    expect(res.body.totals.zeroRatedSales).toBeCloseTo(5000, 2);
    expect(res.body.totals.exemptSales).toBeCloseTo(3000, 2);
    expect(res.body.totals.vatAmount).toBeCloseTo(1200 + 240, 2);
  });

  test("with no accountCode, only structured rows are returned (no GL fallback)", async () => {
    const r2 = await report({ accountCode: undefined });
    expect(r2.status).toBe(200);
    const refs = r2.body.rows.map((x) => x.docRef).sort();
    expect(refs).toEqual(["PH7FU-EX", "PH7FU-STD", "PH7FU-ZR"]); // PH7FU-HIST (GL-only) drops out
    expect(r2.body.rows.every((x) => x.source === "structured")).toBe(true);
  });

  test("STANDARD structured row reconciles: gross ~= vatable + vat", () => {
    const r = res.body.rows.find((x) => x.docRef === "PH7FU-STD");
    expect(r.reconciles).toBe(true);
    expect(r.grossAmount).toBeCloseTo(r.vatableSales + r.zeroRatedSales + r.exemptSales + r.vatAmount, 2);
  });
});
