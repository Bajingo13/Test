// Multi-Branch Phase C-3 - branch-aware Beginning Balances (GL / AR / AP,
// manual + import + template), recurring branch inheritance, transaction /
// invoice print branch isolation (incl. PDF render tokens and public
// verification), and the reversal branch re-check.
// Local test database only. Fixture prefix UAT-MC3-.
jest.mock("../services/invoicePrintPdfService", () => ({
  ...jest.requireActual("../services/invoicePrintPdfService"),
  renderInvoicePdf: jest.fn(),
  renderInvoiceListPdf: jest.fn(),
}));

const fs = require("fs");
const path = require("path");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { signSessionToken } = require("../lib/sessionPolicy");
const CurrencyService = require("../services/currencyService");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const PdfService = require("../services/invoicePrintPdfService");
const { signInvoicePrintRenderToken, signPublicVerifiedInvoiceRenderToken } = require("../services/invoicePrintRenderTokenService");
const InvoiceVerificationService = require("../services/invoiceVerificationService");

jest.setTimeout(300000);

const P = "UAT-MC3-";
const DATE = "2097-03-31";
const TX_DATE = "2097-06-10";
const REC_START = "2096-11-05"; // recurring occurrences: 2096-11 / 2096-12
const ids = { companies: [], users: [] };
const co = {};
const br = {};
const tok = {};
const usr = {};
const acc = {};
const party = {};
let counterSnapshot = [];

const as = (who) => ({ Authorization: `Bearer ${tok[who]}` });
const api = (method, who, url, body) => { const r = request(app)[method](url).set(as(who)); return body === undefined ? r : r.send(body); };

async function roleId(code) { const [[r]] = await pool.query("SELECT id FROM roles WHERE code = ?", [code]); return r.id; }
async function mkCompany(tag, branches) {
  const [c] = await pool.query("INSERT INTO companies (name, status) VALUES (?, 'Active')", [`${P}${tag}`]);
  co[tag] = c.insertId; ids.companies.push(c.insertId);
  for (const [code, status = "ACTIVE"] of branches) {
    const [b] = await pool.query("INSERT INTO branches (company_id, name, code, status) VALUES (?, ?, ?, ?)", [c.insertId, `${P}${code}`, `${P}${code}`, status]);
    br[code] = b.insertId;
  }
  await CurrencyService.createCurrency({ id: 0, roleCode: "SUPER_ADMIN" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "P", decimalPlaces: 2,
    symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: c.insertId,
  });
}
async function mkUser(tag, roleCode, companies, branches = []) {
  const [u] = await pool.query("INSERT INTO users (username, full_name, password, role_id, status) VALUES (?, ?, 'x', ?, 'ACTIVE')", [`${P}${tag}`, `${P}${tag}`, await roleId(roleCode)]);
  for (const c of companies) await pool.query("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  for (const b of branches) await pool.query("INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)", [u.insertId, b]);
  ids.users.push(u.insertId);
  usr[tag] = { id: u.insertId, username: `${P}${tag}`, role: roleCode, roleCode, token_version: 0 };
  tok[tag] = signSessionToken(usr[tag]);
}
async function mkAccount(key, cls, validations = [], branchId = null) {
  const [r] = await pool.query("INSERT INTO chart_of_accounts (code, account_date, title, account_class, branch_id) VALUES (?, '2097-01-01', ?, ?, ?)", [`${P}${key}`, `${P}${key}`, cls, branchId]);
  for (const v of validations) await pool.query("INSERT INTO coa_validations (coa_id, validation_name) VALUES (?, ?)", [r.insertId, v]);
  acc[key] = { id: r.insertId, code: `${P}${key}`, title: `${P}${key}` };
}
async function mkParty(key, companyId, type, branchId = null) {
  const [r] = await pool.query("INSERT INTO general_libraries (company_id, code, party_type, name, status, branch_id) VALUES (?, ?, ?, ?, 'ACTIVE', ?)", [companyId, `${P}${key}`, type, `${P}${key}`, branchId]);
  party[key] = { id: r.insertId, code: `${P}${key}`, name: `${P}${key}`, type };
}
async function docRow(kind, companyId, branchId, no, amount, partyKey) {
  const cfg = {
    apv: ["apv_headers", "apv_lines", "apv_id", "supplier_id", "supplier_name", [["EXP", amount, 0], ["AP", 0, amount]]],
    cv: ["cv_headers", "cv_lines", "cv_id", "payee_id", "payee_name", [["AP", amount, 0], ["CASH", 0, amount]]],
    invoice: ["invoice_headers", "invoice_lines", "invoice_id", "customer_id", "customer_name", [["AR", amount, 0], ["REV", 0, amount]]],
  }[kind];
  const [head, lines, fk, pid, pname, entries] = cfg;
  const p = party[partyKey];
  const extra = kind === "cv" ? "" : ", paid_amount, balance_amount, payment_status";
  const extraVals = kind === "cv" ? "" : ", 0, ?, 'Unpaid'";
  const [r] = await pool.query(
    `INSERT INTO ${head} (company_id, branch_id, voucher_no, ${pid}, ${pname}, transaction_date, total_debit, total_credit, status${extra})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Posted'${extraVals})`,
    [companyId, branchId, `${P}${no}`, p ? p.id : null, p ? p.name : "", TX_DATE, amount, amount, ...(kind === "cv" ? [] : [amount])]
  );
  for (const [key, d, c] of entries) {
    await pool.query(`INSERT INTO ${lines} (${fk}, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, ?, ?, 'x', ?, ?)`, [r.insertId, acc[key].id, acc[key].code, acc[key].title, d, c]);
  }
  return r.insertId;
}
const arapLine = (partyKey, accountKey, amount, extra = {}) => ({
  partyId: party[partyKey].id, partyCode: party[partyKey].code, partyName: party[partyKey].name,
  accountId: acc[accountKey].id, accountCode: acc[accountKey].code, accountTitle: acc[accountKey].title,
  referenceNo: `${P}REF-${Math.random().toString(36).slice(2, 8)}`, dueDate: DATE, debit: amount, credit: 0, balanceAmount: amount, ...extra,
});
const arapPost = (who, body) => api("post", who, "/api/arap-beginning-balances", { balanceType: "AR", balanceDate: DATE, currencyCode: "PHP", currencyName: "PHILIPPINE PESO", ...body });
const glRows = (debitKey, creditKey, amount) => [
  { code: acc[debitKey].code, title: acc[debitKey].title, otherDebit: amount, otherCredit: 0 },
  { code: acc[creditKey].code, title: acc[creditKey].title, otherDebit: 0, otherCredit: amount },
];
const glPost = (who, companyId, rows, branchId, date = DATE) =>
  api("post", who, "/api/gl-beginning-balances", { header: { date, filterCode: "NON", currency: "PHP", currencyName: "PHILIPPINE PESO", companyId, ...(branchId !== undefined ? { branchId } : {}) }, rows });
const headerOf = async (table, id) => (await pool.query(`SELECT company_id, branch_id, balance_date FROM ${table} WHERE id = ?`, [id]))[0][0];

beforeAll(async () => {
  assertNotProductionDatabase();
  const [counters] = await pool.query("SELECT module_type, period_key, last_number FROM recurring_number_counters WHERE period_key IN ('209611', '209612')");
  counterSnapshot = counters;
  await mkCompany("A", [["BA"], ["BB"], ["BX", "INACTIVE"]]);
  await mkCompany("B", [["B1"]]);
  await mkCompany("N", []);
  await mkCompany("S", [["S1"]]);
  await mkUser("adminA", "ADMIN", [co.A]);
  await mkUser("acctA", "ACCOUNTANT", [co.A], [br.BA]);
  await mkUser("acctAB", "ACCOUNTANT", [co.A], [br.BA, br.BB]);
  await mkUser("acctBB", "ACCOUNTANT", [co.A], [br.BB]);
  await mkUser("adminB", "ADMIN", [co.B]);
  await mkUser("adminN", "ADMIN", [co.N]);
  await mkUser("adminS", "ADMIN", [co.S]);
  await mkAccount("CASH", "ASSET");
  await mkAccount("AR", "ASSET", ["AR CODE"]);
  await mkAccount("AP", "LIABILITY", ["AP CODE"]);
  await mkAccount("EXP", "EXPENSE");
  await mkAccount("REV", "INCOME");
  await mkAccount("EQ", "EQUITY");
  await mkAccount("ARB", "ASSET", ["AR CODE"], br.BB); // Branch B-only AR account
  await mkAccount("EXPB", "EXPENSE", [], br.BB);       // Branch B-only expense
  await mkParty("CUSA", co.A, "CUSTOMER", br.BA);
  await mkParty("CUSB", co.A, "CUSTOMER", br.BB);
  await mkParty("CUSS", co.A, "CUSTOMER");
  await mkParty("SUPA", co.A, "SUPPLIER", br.BA);
  await mkParty("SUPB", co.A, "SUPPLIER", br.BB);
  await mkParty("CUSN", co.N, "CUSTOMER");
  await mkParty("SUPS1", co.S, "SUPPLIER");
});

afterAll(async () => {
  try {
    const cos = ids.companies.concat(0);
    const usersIn = ids.users.concat(0);
    // recurring
    await pool.query("DELETE o FROM recurring_transaction_occurrences o JOIN recurring_transaction_schedules s ON s.id = o.schedule_id JOIN recurring_transaction_templates t ON t.id = s.template_id WHERE t.company_id IN (?)", [cos]);
    await pool.query("DELETE s FROM recurring_transaction_schedules s JOIN recurring_transaction_templates t ON t.id = s.template_id WHERE t.company_id IN (?)", [cos]);
    await pool.query("DELETE l FROM recurring_transaction_template_lines l JOIN recurring_transaction_templates t ON t.id = l.template_id WHERE t.company_id IN (?)", [cos]);
    await pool.query("DELETE FROM recurring_transaction_templates WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM recurring_number_counters WHERE period_key IN ('209611', '209612')");
    for (const c of counterSnapshot) await pool.query("INSERT INTO recurring_number_counters (module_type, period_key, last_number) VALUES (?, ?, ?)", [c.module_type, c.period_key, c.last_number]);
    // beginning balances + imports
    await pool.query("DELETE s FROM arap_payment_schedules s JOIN arap_beginning_balance_lines l ON l.id = s.beginning_balance_line_id JOIN arap_beginning_balance_headers h ON h.id = l.header_id WHERE h.company_id IN (?)", [cos]);
    await pool.query("DELETE l FROM arap_beginning_balance_lines l JOIN arap_beginning_balance_headers h ON h.id = l.header_id WHERE h.company_id IN (?)", [cos]);
    await pool.query("DELETE FROM arap_beginning_balance_headers WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE l FROM gl_beginning_balance_lines l JOIN gl_beginning_balance_headers h ON h.id = l.header_id WHERE h.company_id IN (?)", [cos]);
    await pool.query("DELETE FROM gl_beginning_balance_headers WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE r FROM import_batch_rows r JOIN import_batches b ON b.id = r.batch_id WHERE b.created_by IN (?)", [usersIn]);
    await pool.query("DELETE FROM import_batches WHERE created_by IN (?)", [usersIn]);
    // transactions
    await pool.query("DELETE FROM transaction_applications WHERE applied_id IN (SELECT id FROM cv_headers WHERE company_id IN (?)) OR applied_id IN (SELECT id FROM or_headers WHERE company_id IN (?))", [cos, cos]);
    for (const [lines, fk, head] of [["apv_lines", "apv_id", "apv_headers"], ["cv_lines", "cv_id", "cv_headers"], ["invoice_lines", "invoice_id", "invoice_headers"], ["or_lines", "or_id", "or_headers"], ["jv_lines", "jv_id", "jv_headers"], ["purchase_order_lines", "po_id", "purchase_order_headers"]]) {
      await pool.query(`DELETE l FROM ${lines} l JOIN ${head} h ON h.id = l.${fk} WHERE h.company_id IN (?)`, [cos]).catch(() => {});
    }
    for (const t of ["transaction_tax_entries", "transaction_currency_snapshots"]) await pool.query(`DELETE FROM ${t} WHERE company_id IN (?)`, [cos]);
    for (const t of ["jv_headers", "apv_headers", "invoice_headers", "cv_headers", "or_headers", "purchase_order_headers"]) await pool.query(`DELETE FROM ${t} WHERE company_id IN (?)`, [cos]);
    await pool.query("DELETE FROM audit_logs WHERE company_id IN (?) OR user_id IN (?) OR description LIKE ?", [cos, usersIn, `%${P}%`]);
    await pool.query("DELETE FROM general_libraries WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM coa_validations WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE ?)", [`${P}%`]);
    await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE ?", [`${P}%`]);
    await pool.query("DELETE FROM currency_rates WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM currencies WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM user_branches WHERE user_id IN (?)", [usersIn]);
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [usersIn]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [usersIn]);
    await pool.query("DELETE FROM branches WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM companies WHERE id IN (?)", [cos]);
  } finally {
    await pool.end();
  }
});

// ===========================================================================
describe("Beginning balances - AR / AP manual entry (Company + Branch + Date)", () => {
  test("TC-C3-001 one authorized branch: the branch is used automatically", async () => {
    const r = await arapPost("acctA", { companyId: co.A, line: arapLine("CUSA", "AR", 1000) });
    expect(r.status).toBe(200);
    expect(r.body.branchId).toBe(br.BA);
    expect(await headerOf("arap_beginning_balance_headers", r.body.headerId)).toMatchObject({ company_id: co.A, branch_id: br.BA });
  });

  test("TC-C3-002 several branches: the branch must be chosen", async () => {
    const r = await arapPost("adminA", { companyId: co.A, line: arapLine("CUSS", "AR", 1000) });
    expect([r.status, r.body.code]).toEqual([400, "BRANCH_REQUIRED"]);
    expect(r.body.message).toBe("Select the branch this beginning balance belongs to.");
  });

  test("TC-C3-003 explicit branch + no duplicate header for the same Company + Branch + type + Date", async () => {
    const a = await arapPost("adminA", { companyId: co.A, branchId: br.BB, line: arapLine("CUSB", "AR", 500) });
    const b = await arapPost("adminA", { companyId: co.A, branchId: br.BB, line: arapLine("CUSS", "AR", 700) });
    const c = await arapPost("adminA", { companyId: co.A, branchId: br.BA, line: arapLine("CUSS", "AR", 900) });
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect(b.body.headerId).toBe(a.body.headerId);
    expect(c.body.headerId).not.toBe(a.body.headerId);
    const [[n]] = await pool.query("SELECT COUNT(*) n FROM arap_beginning_balance_headers WHERE company_id = ? AND branch_id = ? AND balance_type = 'AR' AND balance_date = ?", [co.A, br.BB, DATE]);
    expect(Number(n.n)).toBe(1);
    const [[lines]] = await pool.query("SELECT COUNT(*) n FROM arap_beginning_balance_lines WHERE header_id = ?", [a.body.headerId]);
    expect(Number(lines.n)).toBe(2);
  });

  test("TC-C3-004 concurrent saves for one key still produce one header", async () => {
    const date = "2097-03-30";
    const results = await Promise.all([1, 2, 3, 4].map((i) => arapPost("adminA", { companyId: co.A, branchId: br.BA, balanceDate: date, line: arapLine("CUSS", "AR", 100 + i) })));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const [[n]] = await pool.query("SELECT COUNT(*) n FROM arap_beginning_balance_headers WHERE company_id = ? AND branch_id = ? AND balance_type = 'AR' AND balance_date = ?", [co.A, br.BA, date]);
    expect(Number(n.n)).toBe(1);
  });

  test("TC-C3-005 unauthorized / foreign / inactive branch rejected (never trusted from the browser)", async () => {
    expect((await arapPost("acctA", { companyId: co.A, branchId: br.BB, line: arapLine("CUSS", "AR", 1) })).body.code).toBe("BRANCH_ACCESS_DENIED");
    expect((await arapPost("adminA", { companyId: co.A, branchId: br.B1, line: arapLine("CUSS", "AR", 1) })).body.code).toBe("BRANCH_COMPANY_MISMATCH");
    const inactive = await arapPost("adminA", { companyId: co.A, branchId: br.BX, line: arapLine("CUSS", "AR", 1) });
    expect([inactive.status, inactive.body.code]).toEqual([409, "BRANCH_INACTIVE"]);
  });

  test("TC-C3-006 party and account must be shared or the branch's own", async () => {
    expect((await arapPost("acctA", { companyId: co.A, line: arapLine("CUSB", "AR", 1) })).body.code).toBe("PARTY_BRANCH_MISMATCH");
    expect((await arapPost("acctA", { companyId: co.A, line: arapLine("CUSA", "ARB", 1) })).body.code).toBe("ACCOUNT_BRANCH_MISMATCH");
    expect((await arapPost("adminA", { companyId: co.A, branchId: br.BB, line: arapLine("CUSB", "ARB", 50) })).status).toBe(200);
  });

  test("TC-C3-007 a company without branches keeps legacy company-level balances", async () => {
    const r = await arapPost("adminN", { companyId: co.N, line: arapLine("CUSN", "AR", 300) });
    expect(r.status).toBe(200);
    expect((await headerOf("arap_beginning_balance_headers", r.body.headerId)).branch_id).toBeNull();
  });

  describe("branch-aware list / edit / delete", () => {
    let legacyLine, bLine;
    beforeAll(async () => {
      // an unresolved historical header of the multi-branch company (never guessed)
      const [h] = await pool.query("INSERT INTO arap_beginning_balance_headers (company_id, branch_id, balance_type, balance_date, currency_code, currency_name, status) VALUES (?, NULL, 'AR', ?, 'PHP', 'PHILIPPINE PESO', 'Posted')", [co.A, DATE]);
      const [l] = await pool.query("INSERT INTO arap_beginning_balance_lines (header_id, party_id, party_code, party_name, account_id, account_code, account_title, reference_no, debit, credit, balance_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 10, 0, 10)",
        [h.insertId, party.CUSS.id, party.CUSS.code, party.CUSS.name, acc.AR.id, acc.AR.code, acc.AR.title, `${P}LEGACY`]);
      legacyLine = l.insertId;
      const r = await arapPost("adminA", { companyId: co.A, branchId: br.BB, line: arapLine("CUSB", "AR", 222, { referenceNo: `${P}B-LINE` }) });
      const [[row]] = await pool.query("SELECT id FROM arap_beginning_balance_lines WHERE header_id = ? AND reference_no = ?", [r.body.headerId, `${P}B-LINE`]);
      bLine = row.id;
    });
    const branchesIn = (res) => [...new Set(res.body.map((x) => x.branchId))].sort();

    test("TC-C3-008 Branch A accountant sees Branch A only; A+B sees both; ADMIN sees all incl. unresolved history", async () => {
      const a = await api("get", "acctA", `/api/arap-beginning-balances/AR?companyId=${co.A}`);
      expect(branchesIn(a)).toEqual([br.BA]);
      const ab = await api("get", "acctAB", `/api/arap-beginning-balances/AR?companyId=${co.A}`);
      expect(branchesIn(ab)).toEqual([br.BA, br.BB].sort());
      expect(ab.body.map((x) => x.id)).not.toContain(legacyLine); // A+B is not the whole company (BX) -> no unresolved rows
      const admin = await api("get", "adminA", `/api/arap-beginning-balances/AR?companyId=${co.A}`);
      expect(admin.body.map((x) => x.id)).toEqual(expect.arrayContaining([legacyLine, bLine]));
      expect(admin.body.find((x) => x.id === bLine).branchName).toBe(`${P}BB`);
    });

    test("TC-C3-009 another company / another branch: not listed, not editable, not deletable (same 404)", async () => {
      const b = await api("get", "adminB", `/api/arap-beginning-balances/AR?companyId=${co.B}`);
      expect(b.body.map((x) => x.id)).not.toContain(bLine);
      const put = await api("put", "acctA", "/api/arap-beginning-balances", { companyId: co.A, line: { ...arapLine("CUSS", "AR", 1), id: bLine } });
      expect([put.status, put.body.message]).toEqual([404, "Beginning balance line not found"]);
      const del = await api("delete", "acctA", `/api/arap-beginning-balances/${bLine}?companyId=${co.A}`);
      expect([del.status, del.body.message]).toEqual([404, "Beginning balance line not found"]);
      const unknown = await api("delete", "acctA", `/api/arap-beginning-balances/999999999?companyId=${co.A}`);
      expect(unknown.body.message).toBe(del.body.message);
      const [[still]] = await pool.query("SELECT COUNT(*) n FROM arap_beginning_balance_lines WHERE id = ?", [bLine]);
      expect(Number(still.n)).toBe(1);
    });

    test("TC-C3-010 edits stay in the line's branch (another branch's party refused); the authorized admin may edit", async () => {
      const wrong = await api("put", "acctAB", "/api/arap-beginning-balances", { companyId: co.A, line: { ...arapLine("CUSA", "AR", 300), id: bLine } });
      expect(wrong.body.code).toBe("PARTY_BRANCH_MISMATCH");
      const ok = await api("put", "acctAB", "/api/arap-beginning-balances", { companyId: co.A, line: { ...arapLine("CUSB", "AR", 300), id: bLine } });
      expect(ok.status).toBe(200);
    });
  });
});

// ===========================================================================
describe("Beginning balances - GL manual entry", () => {
  test("TC-C3-011 GL: automatic branch, explicit branch, one header per Company + Branch + Date", async () => {
    const a = await glPost("acctA", co.A, glRows("CASH", "EQ", 100));
    expect(a.status).toBe(200);
    expect(a.body.branchId).toBe(br.BA);
    const a2 = await glPost("acctA", co.A, glRows("EXP", "AP", 50)); // other accounts: one line per account per header
    expect(a2.body.headerId).toBe(a.body.headerId);
    const b = await glPost("adminA", co.A, glRows("CASH", "EQ", 100), br.BB);
    expect(b.status).toBe(200);
    expect(b.body.headerId).not.toBe(a.body.headerId);
    expect((await headerOf("gl_beginning_balance_headers", b.body.headerId)).branch_id).toBe(br.BB);
    expect((await glPost("adminA", co.A, glRows("CASH", "EQ", 1))).body.code).toBe("BRANCH_REQUIRED");
  });

  test("TC-C3-012 GL: another branch's account code / branch refused", async () => {
    expect((await glPost("acctA", co.A, glRows("EXPB", "EQ", 10))).body.code).toBe("ACCOUNT_BRANCH_MISMATCH");
    expect((await glPost("acctA", co.A, glRows("CASH", "EQ", 10), br.BB)).body.code).toBe("BRANCH_ACCESS_DENIED");
    expect((await glPost("adminA", co.A, glRows("EXPB", "AR", 10), br.BB)).status).toBe(200);
  });

  test("TC-C3-013 GL list respects branch visibility", async () => {
    const a = await api("get", "acctA", `/api/gl-beginning-balances?companyId=${co.A}`);
    expect(a.status).toBe(200);
    expect([...new Set(a.body.map((h) => h.branchId))]).toEqual([br.BA]);
    const admin = await api("get", "adminA", `/api/gl-beginning-balances?companyId=${co.A}`);
    expect([...new Set(admin.body.map((h) => h.branchId))].sort()).toEqual([br.BA, br.BB].sort());
    const b = await api("get", "adminB", `/api/gl-beginning-balances?companyId=${co.B}`);
    expect(b.body.filter((h) => h.branchId === br.BA || h.branchId === br.BB)).toHaveLength(0);
  });
});

// ===========================================================================
describe("Beginning balances - import / template export", () => {
  const csv = (rows) => Buffer.from(rows.map((r) => r.join(",")).join("\n"));
  const glFile = (date, lines, withBranch = null) => csv([
    ["Account Code", "Balance Date", "Debit", "Credit", ...(withBranch !== null ? ["Branch Code"] : [])],
    ...lines.map(([k, d, c]) => [acc[k].code, date, d, c, ...(withBranch !== null ? [withBranch] : [])]),
  ]);
  const preview = (who, module, file, branchId) => {
    const r = request(app).post(`/api/beginning-balances/${module}/import/preview`).set(as(who)).field("duplicateMode", "REJECT");
    if (branchId !== undefined) r.field("branchId", String(branchId));
    return r.attach("file", file, "bb.csv");
  };
  const commit = (who, module, batchId, branchId) => api("post", who, `/api/beginning-balances/${module}/import/commit`, { batchId, ...(branchId !== undefined ? { branchId } : {}) });

  test("TC-C3-014 GL import: previewed + committed into the resolved branch", async () => {
    const p = await preview("acctA", "gl", glFile("2097-02-28", [["CASH", 500, 0], ["EQ", 0, 500]]));
    expect(p.status).toBe(200);
    expect(p.body.branch).toMatchObject({ id: br.BA, code: `${P}BA` });
    expect(p.body.summary.validRows).toBe(2);
    const c = await commit("acctA", "gl", p.body.batchId);
    expect([c.status, c.body.imported, c.body.branchId]).toEqual([200, 2, br.BA]);
    const [heads] = await pool.query("SELECT branch_id FROM gl_beginning_balance_headers WHERE company_id = ? AND balance_date = '2097-02-28'", [co.A]);
    expect(heads.map((h) => h.branch_id)).toEqual([br.BA]);
  });

  test("TC-C3-015 import rejects an inaccessible / foreign / inactive branch before reading the file", async () => {
    const file = glFile("2097-02-27", [["CASH", 1, 0], ["EQ", 0, 1]]);
    expect((await preview("acctA", "gl", file, br.BB)).body.code).toBe("BRANCH_ACCESS_DENIED");
    expect((await preview("adminA", "gl", file, br.B1)).body.code).toBe("BRANCH_COMPANY_MISMATCH");
    expect((await preview("adminA", "gl", file, br.BX)).body.code).toBe("BRANCH_INACTIVE");
    expect((await preview("adminA", "gl", file)).body.code).toBe("BRANCH_REQUIRED");
  });

  test("TC-C3-016 no cross-branch insertion: Branch Code column, other-branch accounts, branch switch at commit, other company", async () => {
    const mismatch = await preview("acctA", "gl", glFile("2097-02-26", [["CASH", 5, 0], ["EQ", 0, 5]], `${P}BB`));
    expect(mismatch.body.summary.invalidRows).toBe(2);
    expect(JSON.stringify(mismatch.body.rows[0].errors)).toMatch(/does not match the selected branch/);
    const foreignAccount = await preview("acctA", "gl", glFile("2097-02-26", [["EXPB", 5, 0], ["EQ", 0, 5]]));
    expect(foreignAccount.body.rows[0].status).toBe("INVALID");
    const ok = await preview("adminA", "gl", glFile("2097-02-25", [["CASH", 7, 0], ["EQ", 0, 7]], `${P}BA`), br.BA);
    expect(ok.body.summary.validRows).toBe(2);
    const switched = await commit("adminA", "gl", ok.body.batchId, br.BB);
    expect([switched.status, switched.body.code]).toEqual([409, "IMPORT_BRANCH_MISMATCH"]);
    const otherCompany = await commit("adminB", "gl", ok.body.batchId);
    expect(otherCompany.status).toBe(404);
    const [[none]] = await pool.query("SELECT COUNT(*) n FROM gl_beginning_balance_headers WHERE balance_date = '2097-02-25'");
    expect(Number(none.n)).toBe(0);
    expect((await commit("adminA", "gl", ok.body.batchId)).status).toBe(200);
  });

  test("TC-C3-017 the same account + date in Branch A and Branch B are separate balances (never merged / flagged)", async () => {
    const a = await preview("adminA", "gl", glFile("2097-02-24", [["CASH", 9, 0], ["EQ", 0, 9]]), br.BA);
    expect((await commit("adminA", "gl", a.body.batchId)).status).toBe(200);
    const b = await preview("adminA", "gl", glFile("2097-02-24", [["CASH", 9, 0], ["EQ", 0, 9]]), br.BB);
    expect(b.body.summary.duplicateRows).toBe(0);
    expect((await commit("adminA", "gl", b.body.batchId)).status).toBe(200);
    const again = await preview("adminA", "gl", glFile("2097-02-24", [["CASH", 9, 0], ["EQ", 0, 9]]), br.BB);
    expect(again.body.summary.duplicateRows).toBe(2);
    const [heads] = await pool.query("SELECT branch_id FROM gl_beginning_balance_headers WHERE company_id = ? AND balance_date = '2097-02-24' ORDER BY branch_id", [co.A]);
    expect(heads.map((h) => h.branch_id)).toEqual([br.BA, br.BB].sort((x, y) => x - y));
  });

  test("TC-C3-018 AR import files into the branch; parties of another branch are unknown there", async () => {
    const file = (cust) => csv([
      ["Customer Code", "Account Code", "Document Number", "Balance Date", "Due Date", "Original Amount"],
      [party[cust].code, acc.AR.code, `${P}DOC-${cust}`, "2097-02-20", "2097-04-30", "1200"],
    ]);
    const bad = await preview("acctA", "ar", file("CUSB"));
    expect(bad.body.rows[0].status).toBe("INVALID");
    const p = await preview("acctA", "ar", file("CUSA"));
    expect(p.body.rows[0].status).toBe("VALID");
    expect((await commit("acctA", "ar", p.body.batchId)).status).toBe(200);
    const [heads] = await pool.query("SELECT branch_id FROM arap_beginning_balance_headers WHERE company_id = ? AND balance_type = 'AR' AND balance_date = '2097-02-20'", [co.A]);
    expect(heads.map((h) => h.branch_id)).toEqual([br.BA]);
  });

  test("TC-C3-019 template export is branch-scoped (reference data of that branch only)", async () => {
    const a = await api("get", "adminA", `/api/beginning-balances/ar/template?format=csv&companyId=${co.A}&branchId=${br.BA}`);
    const b = await api("get", "adminA", `/api/beginning-balances/ar/template?format=csv&companyId=${co.A}&branchId=${br.BB}`);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.text).toContain(party.CUSA.code);
    expect(a.text).not.toContain(party.CUSB.code);
    expect(b.text).toContain(party.CUSB.code);
    expect((await api("get", "acctA", `/api/beginning-balances/ar/template?format=csv&companyId=${co.A}&branchId=${br.BB}`)).body.code).toBe("BRANCH_ACCESS_DENIED");
    const xlsx = await api("get", "acctA", `/api/beginning-balances/gl/template?format=xlsx&companyId=${co.A}`).buffer(true).parse((res, cb) => { const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks))); });
    expect(xlsx.status).toBe(200);
    expect(xlsx.body.slice(0, 2).toString()).toBe("PK");
  });
});

// ===========================================================================
describe("Beginning balances - historical data", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../../../../multi_branch_foundation_migration.sql"), "utf8");
  const backfill = (table) => {
    const m = migration.match(new RegExp(`UPDATE ${table} x[\\s\\S]*?WHERE x\\.branch_id IS NULL;`));
    return m[0].replace(/;$/, "").concat(" AND x.company_id IN (?)");
  };

  test("TC-C3-020 single-branch company: history assigned to its branch; multi-branch history stays unresolved (never guessed)", async () => {
    const [s] = await pool.query("INSERT INTO gl_beginning_balance_headers (company_id, branch_id, balance_date, status) VALUES (?, NULL, '2096-12-31', 'Posted')", [co.S]);
    const [m] = await pool.query("INSERT INTO gl_beginning_balance_headers (company_id, branch_id, balance_date, status) VALUES (?, NULL, '2096-12-31', 'Posted')", [co.A]);
    const [sa] = await pool.query("INSERT INTO arap_beginning_balance_headers (company_id, branch_id, balance_type, balance_date, status) VALUES (?, NULL, 'AP', '2096-12-31', 'Posted')", [co.S]);
    const [ma] = await pool.query("INSERT INTO arap_beginning_balance_headers (company_id, branch_id, balance_type, balance_date, status) VALUES (?, NULL, 'AP', '2096-12-31', 'Posted')", [co.A]);
    await pool.query(backfill("gl_beginning_balance_headers"), [[co.S, co.A]]);
    await pool.query(backfill("arap_beginning_balance_headers"), [[co.S, co.A]]);
    expect((await headerOf("gl_beginning_balance_headers", s.insertId)).branch_id).toBe(br.S1);
    expect((await headerOf("gl_beginning_balance_headers", m.insertId)).branch_id).toBeNull();
    expect((await headerOf("arap_beginning_balance_headers", sa.insertId)).branch_id).toBe(br.S1);
    expect((await headerOf("arap_beginning_balance_headers", ma.insertId)).branch_id).toBeNull();
  });

  test("TC-C3-021 unresolved multi-branch history: visible only with whole-company authority, and new lines never join it", async () => {
    const acct = await api("get", "acctAB", `/api/gl-beginning-balances?companyId=${co.A}`);
    expect(acct.body.some((h) => h.branchId === null)).toBe(false);
    const admin = await api("get", "adminA", `/api/gl-beginning-balances?companyId=${co.A}`);
    expect(admin.body.some((h) => h.branchId === null && h.balanceDate === "2096-12-31")).toBe(true);
    const r = await glPost("adminA", co.A, glRows("CASH", "EQ", 3), br.BA, "2096-12-31");
    expect(r.status).toBe(200);
    expect((await headerOf("gl_beginning_balance_headers", r.body.headerId)).branch_id).toBe(br.BA);
  });
});

// ===========================================================================
describe("Recurring - branch inheritance", () => {
  const lines = (debitKey, creditKey, amount) => [
    { accountId: acc[debitKey].id, accountCode: acc[debitKey].code, accountTitle: acc[debitKey].title, debit: amount, credit: 0 },
    { accountId: acc[creditKey].id, accountCode: acc[creditKey].code, accountTitle: acc[creditKey].title, debit: 0, credit: amount },
  ];
  const SHAPES = {
    apv: { partyKey: "SUPA", lines: () => lines("EXP", "AP", 1000), table: "apv_headers" },
    cv: { partyKey: "SUPA", lines: () => lines("AP", "CASH", 800), table: "cv_headers" },
    invoice: { partyKey: "CUSA", lines: () => lines("AR", "REV", 600), table: "invoice_headers" },
  };
  let seq = 0;
  const createTemplate = (who, moduleType, overrides = {}) => {
    const shape = SHAPES[moduleType];
    const p = party[overrides.partyKey || shape.partyKey];
    return api("post", who, "/api/recurring-transactions", {
      companyId: overrides.companyId ?? co.A, moduleType, templateName: `${P}TPL-${++seq}`,
      partyId: p.id, partyName: p.name, lines: overrides.lines || shape.lines(),
      schedule: { frequency: "MONTHLY", startDate: REC_START, maxOccurrences: 12 },
      ...(overrides.branchId !== undefined ? { branchId: overrides.branchId } : {}),
    });
  };
  const generate = (who, id, companyId = co.A) => api("post", who, `/api/recurring-transactions/${id}/generate`, { companyId });
  const tplBranch = async (id) => (await pool.query("SELECT branch_id FROM recurring_transaction_templates WHERE id = ?", [id]))[0][0].branch_id;

  test.each(["apv", "cv", "invoice"])("TC-C3-022 %s: Branch A template -> generated document in Branch A; numbering unchanged", async (moduleType) => {
    const t = await createTemplate("acctA", moduleType);
    expect(t.status).toBe(201);
    expect(t.body.branchId).toBe(br.BA);
    expect(await tplBranch(t.body.templateId)).toBe(br.BA);
    const g = await generate("acctA", t.body.templateId);
    expect(g.status).toBe(200);
    expect(g.body.status).toBe("SUCCESS");
    expect(g.body.voucherNo).toMatch(new RegExp(`^${{ apv: "APV", cv: "CV", invoice: "INV" }[moduleType]}-REC-209611-\\d{4}$`));
    const [[doc]] = await pool.query(`SELECT company_id, branch_id, transaction_date FROM ${SHAPES[moduleType].table} WHERE id = ?`, [g.body.generatedId]);
    expect([doc.company_id, doc.branch_id]).toEqual([co.A, br.BA]);
    const g2 = await generate("acctA", t.body.templateId);
    expect(g2.body.voucherNo).toMatch(/-REC-209612-\d{4}$/);
    const [[doc2]] = await pool.query(`SELECT branch_id FROM ${SHAPES[moduleType].table} WHERE id = ?`, [g2.body.generatedId]);
    expect(doc2.branch_id).toBe(br.BA);
  });

  test("TC-C3-023 Branch B template (admin) generates into Branch B; a Branch A user cannot see / use it", async () => {
    const t = await createTemplate("adminA", "invoice", { branchId: br.BB, partyKey: "CUSB" });
    expect(t.status).toBe(201);
    const list = await api("get", "acctA", `/api/recurring-transactions?companyId=${co.A}`);
    expect(list.body.map((x) => x.id)).not.toContain(t.body.templateId);
    expect(list.body.every((x) => x.branch_id === br.BA)).toBe(true);
    for (const res of [
      await api("get", "acctA", `/api/recurring-transactions/${t.body.templateId}?companyId=${co.A}`),
      await generate("acctA", t.body.templateId),
      await api("get", "acctA", `/api/recurring-transactions/${t.body.templateId}/history?companyId=${co.A}`),
      await api("post", "acctA", `/api/recurring-transactions/${t.body.templateId}/pause`, { companyId: co.A }),
      await api("put", "acctA", `/api/recurring-transactions/${t.body.templateId}`, { companyId: co.A, templateName: "x" }),
    ]) expect(res.status).toBe(404);
    const g = await generate("adminA", t.body.templateId);
    const [[doc]] = await pool.query("SELECT branch_id FROM invoice_headers WHERE id = ?", [g.body.generatedId]);
    expect(doc.branch_id).toBe(br.BB);
    const adminList = await api("get", "adminA", `/api/recurring-transactions?companyId=${co.A}`);
    expect(adminList.body.find((x) => x.id === t.body.templateId).branch_name).toBe(`${P}BB`);
  });

  test("TC-C3-024 template creation: unauthorized / wrong-company / inactive branch and other-branch party or account rejected", async () => {
    expect((await createTemplate("acctA", "apv", { branchId: br.BB, partyKey: "SUPB" })).body.code).toBe("BRANCH_ACCESS_DENIED");
    expect((await createTemplate("adminA", "apv", { branchId: br.B1 })).body.code).toBe("BRANCH_COMPANY_MISMATCH");
    expect((await createTemplate("adminA", "apv", { branchId: br.BX })).body.code).toBe("BRANCH_INACTIVE");
    expect((await createTemplate("adminA", "apv")).body.code).toBe("BRANCH_REQUIRED");
    expect((await createTemplate("acctA", "apv", { partyKey: "SUPB" })).body.code).toBe("PARTY_BRANCH_MISMATCH");
    expect((await createTemplate("acctA", "apv", { lines: lines("EXPB", "AP", 10) })).body.code).toBe("ACCOUNT_BRANCH_MISMATCH");
  });

  test("TC-C3-025 make-recurring bootstrap carries the source branch and hides another branch's transaction", async () => {
    const apvA = await docRow("apv", co.A, br.BA, "APV-SRC-A", 400, "SUPA");
    const apvB = await docRow("apv", co.A, br.BB, "APV-SRC-B", 400, "SUPB");
    const a = await api("post", "acctA", `/api/recurring-transactions/from-transaction/apv/${apvA}?companyId=${co.A}`);
    expect([a.status, a.body.sourceBranchId]).toEqual([200, br.BA]);
    const b = await api("post", "acctA", `/api/recurring-transactions/from-transaction/apv/${apvB}?companyId=${co.A}`);
    expect([b.status, b.body.message]).toEqual([404, "Source transaction not found."]);
  });

  test("TC-C3-026 stale template data re-validated at generation: inactive / foreign branch, other-branch party -> nothing generated", async () => {
    const countDocs = async () => Number((await pool.query("SELECT COUNT(*) n FROM apv_headers WHERE company_id IN (?)", [[co.A, co.B]]))[0][0].n);
    const GenerationService = require("../services/recurringGenerationService");
    const scheduleOf = async (templateId) => (await pool.query("SELECT id FROM recurring_transaction_schedules WHERE template_id = ?", [templateId]))[0][0].id;
    // [what goes stale, interactive answer (status, code), scheduler answer (status, code)]
    const cases = [
      ["UPDATE recurring_transaction_templates SET branch_id = ? WHERE id = ?", () => br.BX, [409, "BRANCH_INACTIVE"], [409, "BRANCH_INACTIVE"]],
      // another company's branch: the template no longer belongs to any branch the
      // admin may use -> hidden (404); the background scheduler refuses it (422)
      ["UPDATE recurring_transaction_templates SET branch_id = ? WHERE id = ?", () => br.B1, [404, undefined], [422, "BRANCH_COMPANY_MISMATCH"]],
      ["UPDATE recurring_transaction_templates SET party_id = ? WHERE id = ?", () => party.SUPB.id, [400, "PARTY_BRANCH_MISMATCH"], [400, "PARTY_BRANCH_MISMATCH"]],
    ];
    for (const [sql, value, [status, code], [schedStatus, schedCode]] of cases) {
      const t = await createTemplate("adminA", "apv", { branchId: br.BA });
      await pool.query(sql, [value(), t.body.templateId]);
      const before = await countDocs();
      const g = await generate("adminA", t.body.templateId);
      expect([g.status, g.body.code]).toEqual([status, code]);
      const scheduled = await GenerationService.processSchedule(await scheduleOf(t.body.templateId), { triggerType: "SCHEDULED" }).catch((e) => e);
      expect([scheduled.statusCode, scheduled.code]).toEqual([schedStatus, schedCode]);
      expect(await countDocs()).toBe(before);
      const [[occ]] = await pool.query("SELECT o.status FROM recurring_transaction_occurrences o JOIN recurring_transaction_schedules s ON s.id = o.schedule_id WHERE s.template_id = ?", [t.body.templateId]);
      expect(occ.status).toBe("FAILED");
    }
  });

  test("TC-C3-027 legacy templates without a branch: multi-branch refused until assigned (once); single-branch / no-branch companies unchanged", async () => {
    const t = await createTemplate("adminA", "apv", { branchId: br.BA });
    await pool.query("UPDATE recurring_transaction_templates SET branch_id = NULL WHERE id = ?", [t.body.templateId]);
    const refused = await generate("adminA", t.body.templateId);
    expect([refused.status, refused.body.message]).toEqual([422, "This recurring template has no branch. Assign its branch before generating."]);
    expect((await api("put", "acctAB", `/api/recurring-transactions/${t.body.templateId}`, { companyId: co.A, branchId: br.BX })).status).toBe(404); // unresolved: not visible to A+B
    expect((await api("put", "adminA", `/api/recurring-transactions/${t.body.templateId}`, { companyId: co.A, branchId: br.BX })).body.code).toBe("BRANCH_INACTIVE");
    expect((await api("put", "adminA", `/api/recurring-transactions/${t.body.templateId}`, { companyId: co.A, branchId: br.BA })).status).toBe(200);
    expect(await tplBranch(t.body.templateId)).toBe(br.BA);
    expect((await api("put", "adminA", `/api/recurring-transactions/${t.body.templateId}`, { companyId: co.A, branchId: br.BB })).body.code).toBe("BRANCH_CHANGE_NOT_ALLOWED");
    const ok = await generate("adminA", t.body.templateId);
    expect(ok.body.status).toBe("SUCCESS");

    const s = await createTemplate("adminS", "apv", { companyId: co.S, partyKey: "SUPS1" });
    await pool.query("UPDATE recurring_transaction_templates SET branch_id = NULL WHERE id = ?", [s.body.templateId]);
    const gs = await generate("adminS", s.body.templateId, co.S);
    expect((await pool.query("SELECT branch_id FROM apv_headers WHERE id = ?", [gs.body.generatedId]))[0][0].branch_id).toBe(br.S1);

    const n = await api("post", "adminN", "/api/recurring-transactions", {
      companyId: co.N, moduleType: "invoice", templateName: `${P}TPL-N`, partyId: party.CUSN.id, partyName: party.CUSN.name,
      lines: lines("AR", "REV", 100), schedule: { frequency: "MONTHLY", startDate: REC_START },
    });
    expect([n.status, n.body.branchId]).toEqual([201, null]);
    const gn = await generate("adminN", n.body.templateId, co.N);
    expect((await pool.query("SELECT branch_id FROM invoice_headers WHERE id = ?", [gn.body.generatedId]))[0][0].branch_id).toBeNull();
  });
});

// ===========================================================================
describe("Printing - branch isolation", () => {
  let invA, invB, apvA, apvB;
  beforeAll(async () => {
    invA = await docRow("invoice", co.A, br.BA, "INV-PA", 1500, "CUSA");
    invB = await docRow("invoice", co.A, br.BB, "INV-PB", 2500, "CUSB");
    apvA = await docRow("apv", co.A, br.BA, "APV-PA", 300, "SUPA");
    apvB = await docRow("apv", co.A, br.BB, "APV-PB", 400, "SUPB");
  });

  test("TC-C3-028 Branch A prints Branch A; Branch B answers like a missing document", async () => {
    const a = await api("get", "acctA", `/api/invoice-print/${invA}?companyId=${co.A}`);
    expect(a.status).toBe(200);
    expect(a.body.branch).toMatchObject({ id: br.BA, code: `${P}BA` });
    const b = await api("get", "acctA", `/api/invoice-print/${invB}?companyId=${co.A}`);
    const missing = await api("get", "acctA", `/api/invoice-print/999999999?companyId=${co.A}`);
    expect([b.status, b.body.message]).toEqual([404, missing.body.message]);
    const tb = await api("get", "acctA", `/api/print/apv/${apvB}?companyId=${co.A}`);
    const tm = await api("get", "acctA", `/api/print/apv/999999999?companyId=${co.A}`);
    expect([tb.status, tb.body.message]).toEqual([404, tm.body.message]);
    const ta = await api("get", "acctA", `/api/print/apv/${apvA}?companyId=${co.A}&mode=with_entries`);
    expect(ta.status).toBe(200);
    expect(ta.body.doc.branch).toMatchObject({ id: br.BA });
  });

  test("TC-C3-029 ADMIN prints every branch of the company; another company is refused", async () => {
    expect((await api("get", "adminA", `/api/invoice-print/${invB}?companyId=${co.A}`)).status).toBe(200);
    expect((await api("get", "adminA", `/api/print/apv/${apvB}?companyId=${co.A}`)).status).toBe(200);
    expect((await api("get", "adminB", `/api/invoice-print/${invA}?companyId=${co.B}`)).status).toBe(404);
    expect((await api("get", "adminB", `/api/print/apv/${apvA}?companyId=${co.B}`)).status).toBe(404);
  });

  test("TC-C3-030 list printing lists only authorized branches", async () => {
    const body = { companyId: co.A, from: TX_DATE, to: TX_DATE, grouping: "number" };
    const a = await api("post", "acctA", "/api/print/apv/list", body);
    expect(a.status).toBe(200);
    const aIds = a.body.rows.map((r) => r.id);
    expect(aIds).toContain(apvA);
    expect(aIds).not.toContain(apvB);
    const admin = await api("post", "adminA", "/api/print/apv/list", body);
    expect(admin.body.rows.map((r) => r.id)).toEqual(expect.arrayContaining([apvA, apvB]));
    const inv = await api("get", "acctA", `/api/invoice-print/list?companyId=${co.A}&from=${TX_DATE}&to=${TX_DATE}`);
    expect(inv.status).toBe(200);
    expect(inv.body.rows.map((r) => r.id)).toContain(invA);
    expect(inv.body.rows.map((r) => r.id)).not.toContain(invB);
  });

  test("TC-C3-031 invoice PDF: the render token carries the branch scope and the renderer is held to it", async () => {
    let rendered = null;
    PdfService.renderInvoicePdf.mockImplementation(async (args) => {
      const token = signInvoicePrintRenderToken({ ...args, docType: "single" });
      rendered = await request(app).get(`/api/invoice-print/${args.invoiceId}?renderToken=${encodeURIComponent(token)}`);
      return Buffer.from("%PDF-1.4 UAT-MC3");
    });
    const ok = await api("get", "acctA", `/api/invoice-print/${invA}/pdf?companyId=${co.A}`);
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toMatch(/application\/pdf/);
    expect(PdfService.renderInvoicePdf).toHaveBeenLastCalledWith(expect.objectContaining({ branchId: br.BA, branchScope: { branchIds: [br.BA], includeUnassigned: false } }));
    expect(rendered.status).toBe(200);
    expect(rendered.body.branch.id).toBe(br.BA);
    PdfService.renderInvoicePdf.mockClear();
    const refused = await api("get", "acctA", `/api/invoice-print/${invB}/pdf?companyId=${co.A}`);
    expect(refused.status).toBe(404);
    expect(PdfService.renderInvoicePdf).not.toHaveBeenCalled();
  });

  test("TC-C3-032 forged / widened render tokens are refused; list PDF scope travels too", async () => {
    const base = { userId: usr.acctA.id, username: usr.acctA.username, companyId: co.A, docType: "single" };
    const scopeA = { branchIds: [br.BA], includeUnassigned: false };
    const outOfScope = signInvoicePrintRenderToken({ ...base, invoiceId: invB, branchScope: scopeA, branchId: br.BB });
    expect((await request(app).get(`/api/invoice-print/${invB}?renderToken=${outOfScope}`)).status).toBe(404);
    const wrongBranch = signInvoicePrintRenderToken({ ...base, invoiceId: invA, branchScope: { branchIds: [br.BA, br.BB] }, branchId: br.BB });
    expect((await request(app).get(`/api/invoice-print/${invA}?renderToken=${wrongBranch}`)).status).toBe(404);
    const noScope = signInvoicePrintRenderToken({ ...base, invoiceId: invA });
    expect((await request(app).get(`/api/invoice-print/${invA}?renderToken=${noScope}`)).status).toBe(403);

    let listRendered = null;
    PdfService.renderInvoiceListPdf.mockImplementation(async (args) => {
      const token = signInvoicePrintRenderToken({ ...args, docType: "list" });
      listRendered = await request(app).get(`/api/invoice-print/list?renderToken=${encodeURIComponent(token)}&from=${TX_DATE}&to=${TX_DATE}`);
      return Buffer.from("%PDF-1.4 UAT-MC3 list");
    });
    const list = await api("get", "acctA", `/api/invoice-print/list/pdf?companyId=${co.A}&from=${TX_DATE}&to=${TX_DATE}`);
    expect(list.status).toBe(200);
    expect(listRendered.status).toBe(200);
    expect(listRendered.body.rows.map((r) => r.id)).toContain(invA);
    expect(listRendered.body.rows.map((r) => r.id)).not.toContain(invB);
  });

  test("TC-C3-033 public verification (unauthenticated by design) still works, for any branch", async () => {
    const conn = await pool.getConnection();
    let token;
    try {
      const [[h]] = await conn.query("SELECT voucher_no, DATE_FORMAT(transaction_date, '%Y-%m-%d') d, customer_id, customer_name, total_debit, total_credit, currency_id FROM invoice_headers WHERE id = ?", [invB]);
      ({ verificationToken: token } = await InvoiceVerificationService.issueVerification(conn, {
        invoiceId: invB, voucherNo: h.voucher_no, transactionDate: h.d, customerId: h.customer_id, customerName: h.customer_name,
        totalDebit: h.total_debit, totalCredit: h.total_credit, currencyId: h.currency_id, companyId: co.A,
      }));
    } finally {
      conn.release();
    }
    const v = await request(app).get(`/api/verify/${token}`);
    expect(v.status).toBe(200);
    expect(v.body.status).toBe("valid");
    const publicToken = signPublicVerifiedInvoiceRenderToken({ invoiceId: invB, companyId: co.A });
    const page = await request(app).get(`/api/invoice-print/${invB}?renderToken=${publicToken}`);
    expect(page.status).toBe(200);
    expect(page.body.branch.id).toBe(br.BB);
  });

  test("TC-C3-034 print-template preview against a real transaction is branch-isolated too", async () => {
    const preview = (who, id) => api("post", who, "/api/print-templates/preview", { companyId: co.A, moduleType: "invoice", transactionId: id, config: {} });
    const a = await preview("acctA", invA);
    const b = await preview("acctA", invB);
    expect(a.status).toBe(200);
    expect(b.status).toBe(404);
  });
});

// ===========================================================================
describe.each([["APV", "apv"], ["CV", "cv"]])("Reversal re-check: %s Branch A -> reversing JV Branch A", (mod, ep) => {
  let original;
  beforeAll(async () => {
    original = await docRow(ep, co.A, br.BA, `${mod}-REV3`, 650, "SUPA");
  });
  const reverse = (who) => api("post", who, `/api/${ep}/${original}/reverse`, { companyId: co.A, reason: "UAT-MC3 reversal" });

  test(`TC-C3-035 a user without Branch A cannot reverse; no branch is substituted`, async () => {
    const r = await reverse("acctBB");
    expect(r.body.code).toBe("BRANCH_ACCESS_DENIED");
    const [jv] = await pool.query("SELECT id FROM jv_headers WHERE source_module = ? AND source_reference_id = ?", [`${mod}_REVERSAL`, original]);
    expect(jv).toHaveLength(0);
  });

  test(`TC-C3-036 the reversing JV is recorded in Branch A`, async () => {
    const r = await reverse("acctA");
    expect(r.status).toBe(200);
    const [[jv]] = await pool.query("SELECT company_id, branch_id FROM jv_headers WHERE id = ?", [r.body.reversalJvId]);
    expect(jv).toEqual({ company_id: co.A, branch_id: br.BA });
  });
});
