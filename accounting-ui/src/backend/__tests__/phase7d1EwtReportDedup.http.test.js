const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const CurrencyService = require("../services/currencyService");

// Phase 7D.1: proves /api/reports/alphalist and /api/reports/2307 no
// longer double-count EWT that exists on both a source APV and the CV(s)
// that settle it - see ewtReportReconciliationService.js for the full
// authority-rule reasoning (CV supersedes APV only when it safely,
// unambiguously settles exactly one APV and independently recorded its
// own EWT). Also proves the company-isolation bug discovered while fixing
// this (both report routes previously had NO company_id filter at all)
// is closed.

jest.setTimeout(180000);

let companyA, companyB, userId, token;
let expId, apId, cashId, ewtPayableId;
let suppA1, suppA2, suppB1;
let usdId;

async function makeCompany(name) {
  const [result] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [name]);
  return result.insertId;
}
async function makeAccount(code, title, accountClass) {
  const [result] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, accountClass]
  );
  return result.insertId;
}
async function makeParty(companyId, code, name, tin) {
  const [result] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, status, tin) VALUES (?, ?, 'SUPPLIER', ?, 'ACTIVE', ?)",
    [companyId, code, name, tin]
  );
  return result.insertId;
}

// Phase 7C.1's backend now REQUIRES that any new APV/CV with a non-null
// atcCode also carries a matching taxEntry-tagged EWT journal line
// (reconcileEwtTaxEntry - "EWT was submitted without its corresponding
// journal line"). Both helpers build one, matching the exact
// outbound-direction (credit side) EwtEntryModal/handleEwtEntryConfirm
// already implements for APV/CV - see the Phase 7C.1 report.
function ewtLine({ ewtAmount, atcCode, partyId, partyName, date, taxableBase }) {
  return {
    accountId: ewtPayableId, accountCode: "PH7D1EWTP", accountTitle: "Withholding Tax Payable",
    particulars: `EWT - ${atcCode}`, genRef: "", genName: partyName, debit: 0, credit: ewtAmount,
    taxEntry: {
      entryType: "EWT", accountId: ewtPayableId,
      partyId, partyName, partyTin: "", partyAddress: "",
      transactionDate: date, atcCode, taxType: "EWT", taxableBase, withheldAmount: ewtAmount,
    },
  };
}

// Phase 7K: the EWT alphalist/2307 reports now recognize an APV/CV only
// while its header status is POSTED (a Cancelled/Void document stops being
// reportable). These fixtures post their transactions - the supersession /
// de-dup / date-basis / isolation behaviour under test is unchanged.
async function createApv(companyIdForAuth, { voucherNo, supplierId, supplierName, supplierTin, date, gross, ewtAmount, atcCode, currency }) {
  const net = gross - (ewtAmount || 0);
  const lines = [
    { accountId: expId, accountCode: "PH7D1EXP", accountTitle: "Purchases Expense", particulars: "Purchase", genRef: "", genName: "", debit: gross, credit: 0 },
  ];
  if (ewtAmount) lines.push(ewtLine({ ewtAmount, atcCode, partyId: supplierId, partyName: supplierName, date, taxableBase: gross }));
  lines.push({ accountId: apId, accountCode: "PH7D1AP", accountTitle: "Accounts Payable", particulars: "Payable", genRef: "", genName: "", debit: 0, credit: net });

  return request(app).post("/api/apv").set("Authorization", `Bearer ${token}`).send({
    voucherNo, supplierId, supplierName, transactionDate: date, referenceNo: voucherNo, description: "Purchase", status: "Posted",
    // payeeTin is what the APV route actually stores into apv_headers.payee_tin
    // (the report's TIN source) - the party master's own TIN is a
    // separate thing entirely, matching real usage where the EWT card
    // auto-fills this from the selected party but still sends it explicitly.
    atcCode: atcCode || undefined, taxWithheldAmount: ewtAmount || undefined, payeeTin: supplierTin || undefined,
    lines,
    totalDebit: gross, totalCredit: gross, // net + ewtAmount === gross
    // The fixture user belongs to BOTH companyA and companyB (needed for
    // the isolation tests), so resolveCompanyIdForWrite requires an
    // explicit companyId - every route reads it from currency.companyId.
    currency: currency || { companyId: companyIdForAuth },
  });
}

async function createCv({ voucherNo, payeeId, payeeName, payeeTin, date, amount, ewtAmount, atcCode, apvApplications = [], currency, companyIdForAuth = companyA }) {
  const netCash = amount - (ewtAmount || 0);
  const lines = [
    { accountId: apId, accountCode: "PH7D1AP", accountTitle: "Accounts Payable", particulars: "Payable", genRef: "", genName: "", debit: amount, credit: 0 },
  ];
  if (ewtAmount) lines.push(ewtLine({ ewtAmount, atcCode, partyId: payeeId, partyName: payeeName, date, taxableBase: amount }));
  lines.push({ accountId: cashId, accountCode: "PH7D1CASH", accountTitle: "Cash", particulars: "Cash", genRef: "", genName: "", debit: 0, credit: netCash });

  return request(app).post("/api/cv").set("Authorization", `Bearer ${token}`).send({
    voucherNo, payeeId, payeeName, transactionDate: date, referenceNo: voucherNo, description: "Payment", status: "Posted",
    paymentMethod: "Cash",
    atcCode: atcCode || undefined, taxWithheldAmount: ewtAmount || undefined, payeeTin: payeeTin || undefined,
    lines,
    totalDebit: amount, totalCredit: amount, // netCash + ewtAmount === amount
    apvApplications,
    currency: currency || { companyId: companyIdForAuth },
  });
}

beforeAll(async () => {
  assertNotProductionDatabase();

  companyA = await makeCompany("PH7D1 Company A");
  companyB = await makeCompany("PH7D1 Company B");

  const hash = await bcrypt.hash("Ph7d1Pass!1", 10);
  const [userResult] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('ph7d1_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  userId = userResult.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, companyA]);
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, companyB]);

  const loginRes = await request(app).post("/api/login").send({ username: "ph7d1_admin", password: "Ph7d1Pass!1" });
  token = loginRes.body.token;

  const adminUser = { id: userId, roleCode: "ADMIN" };
  await CurrencyService.createCurrency(adminUser, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: companyA,
  });
  const usd = await CurrencyService.createCurrency(adminUser, {
    currencyCode: "USD", currencyName: "US Dollar", currencySymbol: "$",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "MANUAL", companyId: companyA,
  });
  usdId = usd.id;
  await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 58, effectiveDate: "2026-06-01", reason: "PH7D1 fixture" });
  await CurrencyService.createCurrency(adminUser, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: companyB,
  });

  expId = await makeAccount("PH7D1EXP", "Purchases Expense", "EXPENSE");
  apId = await makeAccount("PH7D1AP", "Accounts Payable", "LIABILITY");
  cashId = await makeAccount("PH7D1CASH", "Cash", "ASSET");
  ewtPayableId = await makeAccount("PH7D1EWTP", "Withholding Tax Payable", "LIABILITY");

  suppA1 = await makeParty(companyA, "PH7D1-S1", "PH7D1 Supplier One", "111-111-111-000");
  suppA2 = await makeParty(companyA, "PH7D1-S2", "PH7D1 Supplier Two", "222-222-222-000");
  suppB1 = await makeParty(companyB, "PH7D1-B1", "PH7D1 Company B Supplier", "333-333-333-000");

  await pool.execute(
    "INSERT INTO ewt_library (atc_code, description, rate, tax_type, status) VALUES ('PH7D1-ATC', 'Professional fees - PH7D1 fixture', 10, 'EWT', 'ACTIVE')"
  );
});

afterAll(async () => {
  for (const companyId of [companyA, companyB]) {
    await pool.query("DELETE FROM transaction_applications WHERE applied_id IN (SELECT id FROM cv_headers WHERE company_id = ?) AND applied_type = 'CV'", [companyId]);
    await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id = ?", [companyId]);
    await pool.query("DELETE FROM cv_lines WHERE cv_id IN (SELECT id FROM cv_headers WHERE company_id = ?)", [companyId]);
    await pool.query("DELETE FROM cv_headers WHERE company_id = ?", [companyId]);
    await pool.query("DELETE FROM apv_lines WHERE apv_id IN (SELECT id FROM apv_headers WHERE company_id = ?)", [companyId]);
    await pool.query("DELETE FROM apv_headers WHERE company_id = ?", [companyId]);
    await pool.query("DELETE FROM general_libraries WHERE company_id = ?", [companyId]);
  }
  for (const companyId of [companyA, companyB]) {
    await pool.query("DELETE FROM currency_rates WHERE company_id = ?", [companyId]);
    await pool.query("DELETE FROM currencies WHERE company_id = ?", [companyId]);
  }
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'PH7D1%'");
  await pool.query("DELETE FROM ewt_library WHERE atc_code = 'PH7D1-ATC'");
  await pool.query("DELETE FROM user_companies WHERE user_id = ?", [userId]);
  await pool.query("DELETE FROM users WHERE id = ?", [userId]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [companyA, companyB]);
  await pool.end();
});

async function alphalist(month, companyId) {
  return request(app).get("/api/reports/alphalist").set("Authorization", `Bearer ${token}`)
    .query({ taxType: "EWT", month, ...(companyId ? { companyId } : {}) });
}
async function report2307(supplierId, year, quarter, companyId) {
  return request(app).get("/api/reports/2307").set("Authorization", `Bearer ${token}`)
    .query({ supplierId, year, quarter, ...(companyId ? { companyId } : {}) });
}

describe("Phase 7D.1 - A: APV EWT only (no CV)", () => {
  test("an APV with EWT and no settling CV reports its own accrual figure", async () => {
    const apvRes = await createApv(companyA, { voucherNo: "PH7D1-APV-A", supplierId: suppA1, supplierName: "PH7D1 Supplier One", supplierTin: "111-111-111-000", date: "2026-06-05", gross: 20000, ewtAmount: 2000, atcCode: "PH7D1-ATC" });
    expect(apvRes.status).toBe(200);

    const res = await alphalist("2026-06", companyA);
    const row = res.body.find((r) => r.tin === "111-111-111-000");
    expect(row).toBeTruthy();
    expect(Number(row.taxWithheld)).toBeCloseTo(2000, 2);
  });
});

describe("Phase 7D.1 - B/G: direct CV with no APV", () => {
  test("a CV with its own EWT and no APV application reports on its own", async () => {
    const cvRes = await createCv({ voucherNo: "PH7D1-CV-DIRECT", payeeId: suppA1, payeeName: "PH7D1 Supplier One", payeeTin: "111-111-111-000", date: "2026-06-06", amount: 9000, ewtAmount: 900, atcCode: "PH7D1-ATC" });
    expect(cvRes.status).toBe(200);

    const res = await alphalist("2026-06", companyA);
    const row = res.body.find((r) => r.tin === "111-111-111-000");
    // Combined with test A's APV (2000) since both are in scope this month - 2000 + 900 = 2900, two distinct events, not a duplicate.
    expect(Number(row.taxWithheld)).toBeCloseTo(2900, 2);
  });
});

describe("Phase 7D.1 - C: APV + related CV with the SAME EWT - no double count", () => {
  test("CV supersedes the APV; report shows 2000, not 4000", async () => {
    const apvRes = await createApv(companyA, { voucherNo: "PH7D1-APV-C", supplierId: suppA2, supplierName: "PH7D1 Supplier Two", supplierTin: "222-222-222-000", date: "2026-07-01", gross: 20000, ewtAmount: 2000, atcCode: "PH7D1-ATC" });
    const apvId = apvRes.body.id;

    // resolveTaxWithholding recomputes EWT from THIS voucher's own
    // totalCredit x the ATC rate (10%) - amounts here are chosen to match
    // the intended EWT figures under that formula, not to model a fully
    // realistic net-of-withholding cash disbursement (this test proves
    // the report de-dup logic, not full double-entry realism).
    const cvRes = await createCv({
      voucherNo: "PH7D1-CV-C", payeeId: suppA2, payeeName: "PH7D1 Supplier Two", payeeTin: "222-222-222-000", date: "2026-07-10", amount: 20000, ewtAmount: 2000, atcCode: "PH7D1-ATC",
      apvApplications: [{ sourceId: apvId, amount: 20000, applicationDate: "2026-07-10" }],
    });
    expect(cvRes.status).toBe(200);

    const res = await alphalist("2026-07", companyA);
    const row = res.body.find((r) => r.tin === "222-222-222-000");
    expect(Number(row.taxWithheld)).toBeCloseTo(2000, 2); // NOT 4000
    expect(row.transactionCount).toBe(1); // only the CV counted, APV excluded
  });
});

describe("Phase 7D.1 - D: APV + related CV with DIFFERENT EWT - CV wins, not summed", () => {
  test("report shows the CV's corrected figure (1800), not APV's stale estimate (2000) nor their sum (3800)", async () => {
    const supp = await makeParty(companyA, "PH7D1-S3", "PH7D1 Supplier Three", "444-444-444-000");
    const apvRes = await createApv(companyA, { voucherNo: "PH7D1-APV-D", supplierId: supp, supplierName: "PH7D1 Supplier Three", supplierTin: "444-444-444-000", date: "2026-07-02", gross: 20000, ewtAmount: 2000, atcCode: "PH7D1-ATC" });
    const apvId = apvRes.body.id;

    const cvRes = await createCv({
      voucherNo: "PH7D1-CV-D", payeeId: supp, payeeName: "PH7D1 Supplier Three", payeeTin: "444-444-444-000", date: "2026-07-11", amount: 18000, ewtAmount: 1800, atcCode: "PH7D1-ATC",
      apvApplications: [{ sourceId: apvId, amount: 18000, applicationDate: "2026-07-11" }],
    });
    expect(cvRes.status).toBe(200);

    const res = await alphalist("2026-07", companyA);
    const row = res.body.find((r) => r.tin === "444-444-444-000");
    expect(Number(row.taxWithheld)).toBeCloseTo(1800, 2);
  });
});

describe("Phase 7D.1 - E: one APV + two single-APV CVs (installments) - both CVs sum, APV excluded", () => {
  test("two distinct, unambiguous CV withholdings sum together; the APV's own accrual figure is dropped", async () => {
    const supp = await makeParty(companyA, "PH7D1-S4", "PH7D1 Supplier Four", "555-555-555-000");
    const apvRes = await createApv(companyA, { voucherNo: "PH7D1-APV-E", supplierId: supp, supplierName: "PH7D1 Supplier Four", supplierTin: "555-555-555-000", date: "2026-07-03", gross: 20000, ewtAmount: 2000, atcCode: "PH7D1-ATC" });
    const apvId = apvRes.body.id;

    const cv1 = await createCv({
      voucherNo: "PH7D1-CV-E1", payeeId: supp, payeeName: "PH7D1 Supplier Four", payeeTin: "555-555-555-000", date: "2026-07-12", amount: 10000, ewtAmount: 1000, atcCode: "PH7D1-ATC",
      apvApplications: [{ sourceId: apvId, amount: 10000, applicationDate: "2026-07-12" }],
    });
    expect(cv1.status).toBe(200);
    const cv2 = await createCv({
      voucherNo: "PH7D1-CV-E2", payeeId: supp, payeeName: "PH7D1 Supplier Four", payeeTin: "555-555-555-000", date: "2026-07-20", amount: 10000, ewtAmount: 1000, atcCode: "PH7D1-ATC",
      apvApplications: [{ sourceId: apvId, amount: 10000, applicationDate: "2026-07-20" }],
    });
    expect(cv2.status).toBe(200);

    const res = await alphalist("2026-07", companyA);
    const row = res.body.find((r) => r.tin === "555-555-555-000");
    expect(Number(row.taxWithheld)).toBeCloseTo(2000, 2); // 1000 + 1000, APV's 2000 dropped
    expect(row.transactionCount).toBe(2); // both CVs, not the APV
  });
});

describe("Phase 7D.1 - F: one CV -> multiple APVs (ambiguous) - no fabricated allocation, documented non-de-dup", () => {
  test("a multi-APV CV never supersedes any APV; each APV keeps its own figure and the CV also reports its own", async () => {
    const supp = await makeParty(companyA, "PH7D1-S5", "PH7D1 Supplier Five", "666-666-666-000");
    const apv1 = await createApv(companyA, { voucherNo: "PH7D1-APV-F1", supplierId: supp, supplierName: "PH7D1 Supplier Five", supplierTin: "666-666-666-000", date: "2026-08-01", gross: 20000, ewtAmount: 2000, atcCode: "PH7D1-ATC" });
    const apv2 = await createApv(companyA, { voucherNo: "PH7D1-APV-F2", supplierId: supp, supplierName: "PH7D1 Supplier Five", supplierTin: "666-666-666-000", date: "2026-08-02", gross: 20000, ewtAmount: 2000, atcCode: "PH7D1-ATC" });

    const cvRes = await createCv({
      voucherNo: "PH7D1-CV-F", payeeId: supp, payeeName: "PH7D1 Supplier Five", payeeTin: "666-666-666-000", date: "2026-08-15", amount: 40000, ewtAmount: 4000, atcCode: "PH7D1-ATC",
      apvApplications: [
        { sourceId: apv1.body.id, amount: 20000, applicationDate: "2026-08-15" },
        { sourceId: apv2.body.id, amount: 20000, applicationDate: "2026-08-15" },
      ],
    });
    expect(cvRes.status).toBe(200);

    const res = await alphalist("2026-08", companyA);
    const row = res.body.find((r) => r.tin === "666-666-666-000");
    // Documented limitation: APV1(2000) + APV2(2000) + CV(4000) = 8000 -
    // NOT de-duplicated, because attributing the CV's one EWT amount to
    // two different APVs would be a fabricated allocation.
    expect(Number(row.taxWithheld)).toBeCloseTo(8000, 2);
    expect(row.transactionCount).toBe(3);
  });
});

describe("Phase 7D.1 - H: company isolation", () => {
  test("Company B's APV/CV EWT never appears in Company A's report, and vice versa", async () => {
    const apvB = await createApv(companyB, { voucherNo: "PH7D1-APV-B", supplierId: suppB1, supplierName: "PH7D1 Company B Supplier", supplierTin: "333-333-333-000", date: "2026-06-05", gross: 25000, ewtAmount: 2500, atcCode: "PH7D1-ATC" });
    expect(apvB.status).toBe(200);

    const resA = await alphalist("2026-06", companyA);
    expect(resA.body.find((r) => r.tin === "333-333-333-000")).toBeUndefined();

    const resB = await alphalist("2026-06", companyB);
    const rowB = resB.body.find((r) => r.tin === "333-333-333-000");
    expect(rowB).toBeTruthy();
    expect(Number(rowB.taxWithheld)).toBeCloseTo(2500, 2);
    // And Company A's own June suppliers must never leak into Company B's report.
    expect(resB.body.find((r) => r.tin === "111-111-111-000")).toBeUndefined();
  });

  test("2307 payee lookup is company-scoped - a Company B supplierId is not found under Company A", async () => {
    const res = await report2307(suppB1, 2026, 3, companyA);
    expect(res.status).toBe(404);
  });
});

describe("Phase 7D.1 - I: date-range filtering across a period boundary", () => {
  test("an APV superseded by a next-period CV disappears from BOTH periods except the CV's own - no cross-period double count", async () => {
    const supp = await makeParty(companyA, "PH7D1-S6", "PH7D1 Supplier Six", "777-777-777-000");
    const apvRes = await createApv(companyA, { voucherNo: "PH7D1-APV-I", supplierId: supp, supplierName: "PH7D1 Supplier Six", supplierTin: "777-777-777-000", date: "2026-09-05", gross: 20000, ewtAmount: 2000, atcCode: "PH7D1-ATC" });
    const apvId = apvRes.body.id;

    const cvRes = await createCv({
      voucherNo: "PH7D1-CV-I", payeeId: supp, payeeName: "PH7D1 Supplier Six", payeeTin: "777-777-777-000", date: "2026-10-03", amount: 20000, ewtAmount: 2000, atcCode: "PH7D1-ATC",
      apvApplications: [{ sourceId: apvId, amount: 20000, applicationDate: "2026-10-03" }],
    });
    expect(cvRes.status).toBe(200);

    const septRes = await alphalist("2026-09", companyA);
    expect(septRes.body.find((r) => r.tin === "777-777-777-000")).toBeUndefined(); // APV superseded - gone from its own accrual month

    const octRes = await alphalist("2026-10", companyA);
    const rowOct = octRes.body.find((r) => r.tin === "777-777-777-000");
    expect(rowOct).toBeTruthy();
    expect(Number(rowOct.taxWithheld)).toBeCloseTo(2000, 2); // appears exactly once, under the CV's remittance month
  });
});

describe("Phase 7D.1 - J: multi-currency source", () => {
  test("a foreign-currency APV's already-base-currency-stored EWT is used as-is, no re-resolved rate", async () => {
    const supp = await makeParty(companyA, "PH7D1-S7", "PH7D1 Supplier Seven", "888-888-888-000");
    // Gross/EWT here are in USD (foreign) - the backend independently
    // converts and stores tax_withheld_amount in BASE currency (PHP) at
    // save time (Phase 7C.1 confirmed this), same as every other APV.
    const apvRes = await request(app).post("/api/apv").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7D1-APV-J", supplierId: supp, supplierName: "PH7D1 Supplier Seven",
      transactionDate: "2026-06-07", referenceNo: "PH7D1-APV-J", description: "Foreign purchase", status: "Posted",
      atcCode: "PH7D1-ATC", taxWithheldAmount: 100, payeeTin: "888-888-888-000",
      lines: [
        { accountId: expId, accountCode: "PH7D1EXP", accountTitle: "Purchases Expense", particulars: "Purchase", genRef: "", genName: "", debit: 1000, credit: 0 },
        ewtLine({ ewtAmount: 100, atcCode: "PH7D1-ATC", partyId: supp, partyName: "PH7D1 Supplier Seven", date: "2026-06-07", taxableBase: 1000 }),
        { accountId: apId, accountCode: "PH7D1AP", accountTitle: "Accounts Payable", particulars: "Payable", genRef: "", genName: "", debit: 0, credit: 900 },
      ],
      totalDebit: 1000, totalCredit: 1000,
      currency: { currencyId: usdId, exchangeRate: 58, rateDate: "2026-06-01", companyId: companyA },
    });
    expect(apvRes.status).toBe(200);

    const [[headerRow]] = await pool.query("SELECT tax_withheld_amount FROM apv_headers WHERE id = ?", [apvRes.body.id]);
    const storedBaseEwt = Number(headerRow.tax_withheld_amount); // 100 USD x 58 = 5800 PHP

    const res = await alphalist("2026-06", companyA);
    const row = res.body.find((r) => r.tin === "888-888-888-000");
    expect(Number(row.taxWithheld)).toBeCloseTo(storedBaseEwt, 2);
  });
});

describe("Phase 7D.1 - K/L: no duplicate amount in either report for the same underlying event", () => {
  test("2307 and Alphalist agree on the same de-duplicated total for the same payee/period", async () => {
    const supp = await makeParty(companyA, "PH7D1-S8", "PH7D1 Supplier Eight", "999-999-999-000");
    const apvRes = await createApv(companyA, { voucherNo: "PH7D1-APV-KL", supplierId: supp, supplierName: "PH7D1 Supplier Eight", supplierTin: "999-999-999-000", date: "2026-11-05", gross: 20000, ewtAmount: 2000, atcCode: "PH7D1-ATC" });
    const cvRes = await createCv({
      voucherNo: "PH7D1-CV-KL", payeeId: supp, payeeName: "PH7D1 Supplier Eight", payeeTin: "999-999-999-000", date: "2026-11-12", amount: 20000, ewtAmount: 2000, atcCode: "PH7D1-ATC",
      apvApplications: [{ sourceId: apvRes.body.id, amount: 20000, applicationDate: "2026-11-12" }],
    });
    expect(cvRes.status).toBe(200);

    const alphaRes = await alphalist("2026-11", companyA);
    const alphaRow = alphaRes.body.find((r) => r.tin === "999-999-999-000");
    expect(Number(alphaRow.taxWithheld)).toBeCloseTo(2000, 2);

    const formRes = await report2307(supp, 2026, 4, companyA); // Q4 = Oct/Nov/Dec
    expect(formRes.status).toBe(200);
    expect(Number(formRes.body.totals.totalTaxWithheld)).toBeCloseTo(2000, 2);
    expect(Number(formRes.body.totals.month2Amount)).toBeGreaterThan(0); // November = month 2 of Q4

    // Both reports must agree - never 4000 in one and 2000 in the other.
    expect(Number(alphaRow.taxWithheld)).toBeCloseTo(Number(formRes.body.totals.totalTaxWithheld), 2);
  });
});
