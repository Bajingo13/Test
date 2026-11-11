// APV payment eligibility is enforced on SAVE, not just in the selection
// list. /api/apv/unpaid offers only payable APVs; this suite proves the CV
// save path (applyApvPayment) and the legacy /api/apply-payment route apply
// the same rule to a hand-crafted request:
//
//   payable  = Posted, same company, not reversed (no POSTED APV_REVERSAL
//              JV), outstanding balance > 0
//   rejected = Draft, Cancelled, Void, reversed, fully paid  -> 400 APV_NOT_PAYABLE
//
// A rejected CV save rolls back completely (no CV, no application row).
// Local test database only.
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(180000);

const P = "apvpe-";
const ACC = "APVPE-";
const PASSWORD = "ApvPePass!1";
const DATE = "2097-06-10";

let companyId;
let otherCompanyId;
let supplierId;
let otherSupplierId;
const acc = {};
const users = {};
const tokens = {};
const ids = {};
let cvSeq = 0;

async function makeUser(tag, roleCode, companyIds) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const [u] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, (SELECT id FROM roles WHERE code = ?), 'ACTIVE')",
    [`${P}${tag}`, hash, roleCode]
  );
  for (const c of companyIds) await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  users[tag] = u.insertId;
  const res = await request(app).post("/api/login").send({ username: `${P}${tag}`, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login ${tag}: ${res.status}`);
  tokens[tag] = res.body.token;
}

async function mkAccount(key, title, cls, validations = []) {
  const [r] = await pool.execute("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)", [`${ACC}${key}`, title, cls]);
  for (const v of validations) await pool.execute("INSERT INTO coa_validations (coa_id, validation_name) VALUES (?, ?)", [r.insertId, v]);
  acc[key] = { id: r.insertId, code: `${ACC}${key}` };
}

const auth = (who) => ({ Authorization: `Bearer ${tokens[who]}` });

async function makeApv(voucherNo, amount, status) {
  const res = await request(app).post("/api/apv").set(auth("acct")).send({
    voucherNo, supplierId, supplierName: "Eligibility Supplier", transactionDate: "2097-06-01", dueDate: "2097-06-30",
    totalDebit: amount, totalCredit: amount, status,
    lines: [
      { accountId: acc.EXP.id, accountCode: acc.EXP.code, accountTitle: "Expense", particulars: "x", debit: amount, credit: 0 },
      { accountId: acc.AP.id, accountCode: acc.AP.code, accountTitle: "AP", particulars: "x", debit: 0, credit: amount },
    ],
  });
  if (res.status !== 200) throw new Error(`apv ${voucherNo}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id;
}

// A Check Voucher that pays `amount` against one source document - the
// exact request shape the CV form sends, so "crafted" just means the source
// was never offered by /api/apv/unpaid.
function saveCv(who, { sourceId, amount, sourceType = "APV", payeeId = supplierId, companyQuery }) {
  cvSeq += 1;
  const r = request(app).post("/api/cv").set(auth(who));
  if (companyQuery) r.query({ companyId: String(companyQuery) });
  return r.send({
    voucherNo: `${P}CV-${cvSeq}`, payeeId, payeeName: "Eligibility Supplier",
    transactionDate: DATE, totalDebit: amount, totalCredit: amount, status: "Draft",
    lines: [
      { accountId: acc.AP.id, accountCode: acc.AP.code, accountTitle: "AP", particulars: "x", debit: amount, credit: 0 },
      { accountId: acc.BANK.id, accountCode: acc.BANK.code, accountTitle: "Bank", particulars: "x", debit: 0, credit: amount },
    ],
    apvApplications: [{ sourceType, sourceId, amount, applicationDate: DATE }],
  });
}

async function applications(sourceType, sourceId) {
  const [rows] = await pool.execute("SELECT amount FROM transaction_applications WHERE source_type = ? AND source_id = ?", [sourceType, sourceId]);
  return rows.map((r) => Number(r.amount));
}
async function apvBalance(id) {
  const [[r]] = await pool.execute("SELECT balance_amount AS b, payment_status AS s FROM apv_headers WHERE id = ?", [id]);
  return { balance: Number(r.b), paymentStatus: r.s };
}

beforeAll(async () => {
  assertNotProductionDatabase();
  const [c] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${P}Co`]);
  companyId = c.insertId;
  const [c2] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${P}Other Co`]);
  otherCompanyId = c2.insertId;
  for (const id of [companyId, otherCompanyId]) {
    await pool.execute(
      "INSERT INTO currencies (company_id, currency_code, currency_name, currency_symbol, is_base_currency, is_active) VALUES (?, 'PHP', 'Philippine Peso', 'P', 1, 1)",
      [id]
    );
  }
  const [g] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, tin, status) VALUES (?, ?, 'SUPPLIER', 'Eligibility Supplier', '123-456-789-000', 'ACTIVE')",
    [companyId, `${P}sup`]
  );
  supplierId = g.insertId;
  const [g2] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, tin, status) VALUES (?, ?, 'SUPPLIER', 'Other Supplier', '123-456-789-001', 'ACTIVE')",
    [otherCompanyId, `${P}sup2`]
  );
  otherSupplierId = g2.insertId;
  await mkAccount("AP", "Eligibility Payable", "LIABILITY", ["AP CODE"]);
  await mkAccount("EXP", "Eligibility Expense", "EXPENSE");
  await mkAccount("BANK", "Eligibility Bank", "ASSET");

  await makeUser("acct", "ACCOUNTANT", [companyId]);
  await makeUser("acctOther", "ACCOUNTANT", [otherCompanyId]);

  ids.posted = await makeApv(`${P}POSTED`, 1000, "Posted");
  ids.partial = await makeApv(`${P}PARTIAL`, 1000, "Posted");
  ids.full = await makeApv(`${P}FULL`, 250, "Posted");
  ids.draft = await makeApv(`${P}DRAFT`, 300, "Draft");
  ids.cancelled = await makeApv(`${P}CANCELLED`, 200, "Draft");
  ids.voided = await makeApv(`${P}VOID`, 700, "Posted");
  ids.reversed = await makeApv(`${P}REVERSED`, 800, "Posted");
  ids.isolated = await makeApv(`${P}ISOLATED`, 500, "Posted");

  let res = await request(app).post(`/api/apv/${ids.cancelled}/cancel`).set(auth("acct")).send({ reason: "test cancel" });
  if (res.status !== 200) throw new Error(`cancel: ${res.status} ${JSON.stringify(res.body)}`);
  res = await request(app).post(`/api/apv/${ids.voided}/void`).set(auth("acct")).send({ reason: "test void" });
  if (res.status !== 200) throw new Error(`void: ${res.status} ${JSON.stringify(res.body)}`);
  // Closed-period reversal model: the APV stays Posted and a Posted JV with
  // source_module 'APV_REVERSAL' points at it.
  const [jv] = await pool.execute(
    `INSERT INTO jv_headers (company_id, voucher_no, transaction_date, description, total_debit, total_credit, status, source_module, source_reference_id)
     VALUES (?, ?, '2097-06-05', 'reversal', 800, 800, 'Posted', 'APV_REVERSAL', ?)`,
    [companyId, `${P}REV-JV`, ids.reversed]
  );
  await pool.execute("INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, ?, 'x', 'x', 800, 0)", [jv.insertId, acc.AP.id, acc.AP.code]);
  await pool.execute("INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, ?, 'x', 'x', 0, 800)", [jv.insertId, acc.EXP.id, acc.EXP.code]);

  for (const [status, ref] of [["Posted", "BB-POSTED"], ["Draft", "BB-DRAFT"]]) {
    const [h] = await pool.execute(
      `INSERT INTO arap_beginning_balance_headers (company_id, balance_type, balance_date, currency_code, currency_name, remarks, status)
       VALUES (?, 'AP', '2097-01-01', 'PHP', 'PHILIPPINE PESO', 'eligibility test', ?)`,
      [companyId, status]
    );
    const [l] = await pool.execute(
      `INSERT INTO arap_beginning_balance_lines (header_id, party_id, party_name, account_code, account_title, reference_no, due_date, debit, credit, balance_amount, paid_amount, status)
       VALUES (?, ?, 'Eligibility Supplier', ?, 'AP', ?, '2097-02-15', 0, 150, 150, 0, 'Unpaid')`,
      [h.insertId, supplierId, acc.AP.code, `${P}${ref}`]
    );
    ids[ref] = l.insertId;
  }
});

afterAll(async () => {
  try {
    const companies = [companyId, otherCompanyId].filter(Boolean);
    await pool.query("DELETE ta FROM transaction_applications ta JOIN cv_headers h ON h.id = ta.applied_id AND ta.applied_type = 'CV' WHERE h.company_id IN (?)", [companies]);
    await pool.query("DELETE ln FROM arap_beginning_balance_lines ln JOIN arap_beginning_balance_headers h ON h.id = ln.header_id WHERE h.company_id IN (?)", [companies]);
    await pool.query("DELETE FROM arap_beginning_balance_headers WHERE company_id IN (?)", [companies]);
    await pool.query("DELETE ln FROM cv_lines ln JOIN cv_headers h ON h.id = ln.cv_id WHERE h.company_id IN (?)", [companies]);
    await pool.query("DELETE FROM cv_headers WHERE company_id IN (?)", [companies]);
    await pool.query("DELETE ln FROM jv_lines ln JOIN jv_headers h ON h.id = ln.jv_id WHERE h.company_id IN (?)", [companies]);
    await pool.query("DELETE FROM jv_headers WHERE company_id IN (?)", [companies]);
    await pool.query("DELETE FROM transaction_tax_entries WHERE company_id IN (?)", [companies]);
    await pool.query("DELETE ln FROM apv_lines ln JOIN apv_headers h ON h.id = ln.apv_id WHERE h.company_id IN (?)", [companies]);
    await pool.query("DELETE FROM apv_headers WHERE company_id IN (?)", [companies]);
    await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id IN (?)", [companies]);
    await pool.query("DELETE FROM audit_logs WHERE company_id IN (?)", [companies]);
    await pool.query("DELETE FROM general_libraries WHERE company_id IN (?)", [companies]);
    await pool.query("DELETE FROM currencies WHERE company_id IN (?)", [companies]);
    const userIds = Object.values(users);
    if (userIds.length) {
      await pool.query("DELETE FROM audit_logs WHERE user_id IN (?)", [userIds]);
      await pool.query("DELETE FROM user_permissions WHERE user_id IN (?)", [userIds]);
      await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [userIds]);
      await pool.query("DELETE FROM users WHERE id IN (?)", [userIds]);
    }
    await pool.query("DELETE FROM companies WHERE id IN (?)", [companies]);
    await pool.query(`DELETE FROM coa_validations WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE '${ACC}%')`);
    await pool.query(`DELETE FROM chart_of_accounts WHERE code LIKE '${ACC}%'`);
  } finally {
    await pool.end();
  }
});

const cvCount = async () => (await pool.execute("SELECT COUNT(*) AS n FROM cv_headers WHERE company_id = ?", [companyId]))[0][0].n;

describe("CV save enforces APV payment eligibility", () => {
  test("a Posted APV with a balance can be paid", async () => {
    const res = await saveCv("acct", { sourceId: ids.posted, amount: 1000 });
    expect(res.status).toBe(200);
    expect(await applications("APV", ids.posted)).toEqual([1000]);
    expect(await apvBalance(ids.posted)).toEqual({ balance: 0, paymentStatus: "Paid" });
  });

  test.each([
    ["Draft", "draft", /not Posted \(status: Draft\)/],
    ["Cancelled", "cancelled", /not Posted \(status: Cancelled\)/],
    ["Void", "voided", /not Posted \(status: Void\)/],
    ["reversed", "reversed", /has been reversed/],
  ])("a %s APV is rejected with 400 APV_NOT_PAYABLE and nothing is saved", async (_label, key, message) => {
    const before = await cvCount();
    const res = await saveCv("acct", { sourceId: ids[key], amount: 100 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("APV_NOT_PAYABLE");
    expect(res.body.message).toMatch(message);
    expect(await applications("APV", ids[key])).toEqual([]);
    expect(await cvCount()).toBe(before); // the whole CV save rolled back
  });

  test("a fully paid APV is rejected", async () => {
    expect((await saveCv("acct", { sourceId: ids.full, amount: 250 })).status).toBe(200);
    expect((await apvBalance(ids.full)).paymentStatus).toBe("Paid");
    const res = await saveCv("acct", { sourceId: ids.full, amount: 10 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("APV_NOT_PAYABLE");
    expect(res.body.message).toMatch(/already fully paid/);
    expect(await applications("APV", ids.full)).toEqual([250]);
  });

  test("a partially paid Posted APV stays payable for exactly its outstanding amount", async () => {
    expect((await saveCv("acct", { sourceId: ids.partial, amount: 400 })).status).toBe(200);
    expect(await apvBalance(ids.partial)).toEqual({ balance: 600, paymentStatus: "Partially Paid" });
    const over = await saveCv("acct", { sourceId: ids.partial, amount: 600.5 });
    expect(over.status).not.toBe(200);
    expect(over.body.message).toMatch(/cannot exceed APV balance of 600\.00/);
    expect((await saveCv("acct", { sourceId: ids.partial, amount: 600 })).status).toBe(200);
    expect(await apvBalance(ids.partial)).toEqual({ balance: 0, paymentStatus: "Paid" });
    expect(await applications("APV", ids.partial)).toEqual([400, 600]);
  });

  test("company isolation: another company's user cannot pay this company's Posted APV", async () => {
    const res = await saveCv("acctOther", { sourceId: ids.isolated, amount: 100, payeeId: otherSupplierId });
    expect(res.status).not.toBe(200);
    expect(res.body.message).toMatch(/does not belong to this company/);
    expect(await applications("APV", ids.isolated)).toEqual([]);
    // ...and naming this company explicitly is refused before anything runs
    const named = await saveCv("acctOther", { sourceId: ids.isolated, amount: 100, payeeId: otherSupplierId, companyQuery: companyId });
    expect(named.status).not.toBe(200);
    expect(await applications("APV", ids.isolated)).toEqual([]);
  });

  test("AP beginning balances follow the same rule: Posted is payable, Draft is rejected", async () => {
    expect((await saveCv("acct", { sourceType: "AP_BEGINNING", sourceId: ids["BB-POSTED"], amount: 150 })).status).toBe(200);
    const draft = await saveCv("acct", { sourceType: "AP_BEGINNING", sourceId: ids["BB-DRAFT"], amount: 50 });
    expect(draft.status).toBe(400);
    expect(draft.body.code).toBe("APV_NOT_PAYABLE");
    expect(await applications("AP_BEGINNING", ids["BB-DRAFT"])).toEqual([]);
    // the Posted one is now fully paid
    const again = await saveCv("acct", { sourceType: "AP_BEGINNING", sourceId: ids["BB-POSTED"], amount: 1 });
    expect(again.status).toBe(400);
    expect(again.body.message).toMatch(/already fully paid/);
  });

  test("editing a Draft CV re-checks eligibility too (cannot be pointed at a Draft APV)", async () => {
    const created = await saveCv("acct", { sourceId: ids.isolated, amount: 100 });
    expect(created.status).toBe(200);
    const res = await request(app).put(`/api/cv/${created.body.id}`).set(auth("acct")).send({
      voucherNo: `${P}CV-EDIT`, payeeId: supplierId, payeeName: "Eligibility Supplier",
      transactionDate: DATE, totalDebit: 100, totalCredit: 100, status: "Draft",
      lines: [
        { accountId: acc.AP.id, accountCode: acc.AP.code, accountTitle: "AP", particulars: "x", debit: 100, credit: 0 },
        { accountId: acc.BANK.id, accountCode: acc.BANK.code, accountTitle: "Bank", particulars: "x", debit: 0, credit: 100 },
      ],
      apvApplications: [{ sourceType: "APV", sourceId: ids.draft, amount: 100, applicationDate: DATE }],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("APV_NOT_PAYABLE");
    expect(await applications("APV", ids.draft)).toEqual([]);
    expect(await applications("APV", ids.isolated)).toEqual([100]); // the edit rolled back
  });
});

describe("legacy /api/apply-payment enforces the same rule", () => {
  let cvId;
  beforeAll(async () => {
    const [h] = await pool.execute(
      "INSERT INTO cv_headers (company_id, voucher_no, payee_id, payee_name, transaction_date, total_debit, total_credit, status, payment_method) VALUES (?, ?, ?, 'Eligibility Supplier', ?, 0, 0, 'Draft', 'Check')",
      [companyId, `${P}CV-LEGACY`, supplierId, DATE]
    );
    cvId = h.insertId;
  });
  const legacy = (sourceId) => request(app).post("/api/apply-payment").set(auth("acct")).send({
    sourceType: "APV", sourceId, appliedType: "CV", appliedId: cvId, amount: 50, applicationDate: DATE, companyId,
  });

  test.each([["Draft", "draft"], ["Cancelled", "cancelled"], ["Void", "voided"], ["reversed", "reversed"], ["fully paid", "full"]])("a %s APV is rejected", async (_l, key) => {
    const before = await applications("APV", ids[key]);
    const res = await legacy(ids[key]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("APV_NOT_PAYABLE");
    expect(await applications("APV", ids[key])).toEqual(before);
  });
});
