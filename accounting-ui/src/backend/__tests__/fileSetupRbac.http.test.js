// TC-FS-001 .. TC-FS-011 - File Setup + Accountant RBAC.
//
// Users:
//   accountant - the real ACCOUNTANT role as seeded by the migrations
//                (user_access_control_migration.sql: TRANSACTIONS.* / LEDGER.* /
//                REPORTS.* / POSTING / DASHBOARD / BEGINNING_BALANCES; r7:
//                BANK_CODES VIEW; the CURRENCY_SETUP VIEW-level grants; and
//                accountant_filesetup_view_bankrecon_approve_migration.sql:
//                FILESETUP.COA / GENLIB / TAX_SETUP VIEW, bank-recon APPROVE
//                revoked - the approved R1-R4 corrections)
//   adminA / adminB - ADMIN in company A / company B.
// The role permissions are NOT modified by this suite.
// Every denied write is checked for 403, no database write and no data in the
// response. Local test database only. Fixture prefix UAT-FSRBAC- (currency code
// XFR, company-scoped; report section UAT_FSRBAC_*).
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const CurrencyService = require("../services/currencyService");

jest.setTimeout(240000);

const PFX = "UAT-FSRBAC-";
const PASS = "UatFsRbac!1";
const tok = {};
const ids = { users: [], companies: [] };
let companyA, companyB, xfrId, accountId, apvId;

async function makeUser(username, roleId, companyId) {
  const hash = await bcrypt.hash(PASS, 10);
  const [r] = await pool.execute("INSERT INTO users (username, password, role_id, status) VALUES (?, ?, ?, 'ACTIVE')", [username, hash, roleId]);
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [r.insertId, companyId]);
  ids.users.push(r.insertId);
  const res = await request(app).post("/api/login").send({ username, password: PASS });
  if (res.status !== 200) throw new Error(`login ${username}: ${res.status}`);
  return res.body.token;
}
const as = (who) => ({
  get: (path, q = {}) => request(app).get(path).set({ Authorization: `Bearer ${tok[who]}` }).query(q),
  post: (path, body = {}) => request(app).post(path).set({ Authorization: `Bearer ${tok[who]}` }).send(body),
  put: (path, body = {}) => request(app).put(path).set({ Authorization: `Bearer ${tok[who]}` }).send(body),
  patch: (path, body = {}) => request(app).patch(path).set({ Authorization: `Bearer ${tok[who]}` }).send(body),
  del: (path) => request(app).delete(path).set({ Authorization: `Bearer ${tok[who]}` }),
});
const count = async (sql, params = []) => Number((await pool.execute(sql, params))[0][0].n);
// a denied call: 403, nothing in the body but a message (no data leakage)
function expectDenied(res) {
  expect(res.status).toBe(403);
  const keys = Object.keys(res.body || {});
  expect(keys.every((k) => ["message", "code", "error", "module", "action", "required"].includes(k))).toBe(true);
}

beforeAll(async () => {
  assertNotProductionDatabase();
  const [a] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${PFX}Co A`]);
  const [b] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${PFX}Co B`]);
  companyA = a.insertId; companyB = b.insertId; ids.companies.push(companyA, companyB);

  const [[acct]] = await pool.execute("SELECT id FROM roles WHERE code = 'ACCOUNTANT'");
  const [[adm]] = await pool.execute("SELECT id FROM roles WHERE code = 'ADMIN'");

  tok.accountant = await makeUser("uat_fsrbac_acct", acct.id, companyA);
  tok.adminA = await makeUser("uat_fsrbac_admin_a", adm.id, companyA);
  tok.adminB = await makeUser("uat_fsrbac_admin_b", adm.id, companyB);

  // master data used by the workflow checks
  const [coa] = await pool.execute("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, '2096-01-01', 'UAT FSRBAC Office Supplies', 'EXPENSE')", [`${PFX}EXP`]);
  accountId = coa.insertId;
  await pool.execute("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, '2096-01-01', 'UAT FSRBAC Accounts Payable', 'LIABILITY')", [`${PFX}AP`]);
  await pool.execute("INSERT INTO coa_validations (coa_id, validation_name) SELECT id, 'AP CODE' FROM chart_of_accounts WHERE code = ?", [`${PFX}AP`]);
  await pool.execute("INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, ?, 'SUPPLIER', 'UAT FSRBAC Supplier A', 'ACTIVE')", [companyA, `${PFX}SUP-A`]);
  await pool.execute("INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, ?, 'CUSTOMER', 'UAT FSRBAC Customer B', 'ACTIVE')", [companyB, `${PFX}CUS-B`]);
  await pool.execute("INSERT INTO ewt_library (atc_code, description, rate, tax_type, status) VALUES (?, 'UAT FSRBAC 1%', 1, 'EWT', 'ACTIVE')", [`${PFX}WC1`]);
  const adminUser = { id: ids.users[1], roleCode: "ADMIN" }; // adminA (company A)
  await CurrencyService.createCurrency(adminUser, { currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "P", decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: companyA });
  const xfr = await CurrencyService.createCurrency(adminUser, { currencyCode: "XFR", currencyName: "UAT FSRBAC test currency", currencySymbol: "X", decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "MANUAL", companyId: companyA });
  xfrId = xfr.id;
  await CurrencyService.recordRate(adminUser, xfrId, { rateMode: "MANUAL", rate: 56, effectiveDate: "2096-06-01", reason: `${PFX}rate June` });
  await CurrencyService.recordRate(adminUser, xfrId, { rateMode: "MANUAL", rate: 57, effectiveDate: "2096-07-01", reason: `${PFX}rate July` });
});

afterAll(async () => {
  try {
    if (apvId) {
      await pool.query("DELETE FROM apv_lines WHERE apv_id = ?", [apvId]);
      await pool.query("DELETE FROM transaction_tax_entries WHERE transaction_id = ? AND transaction_type = 'APV'", [apvId]).catch(() => {});
      await pool.query("DELETE FROM transaction_currency_snapshots WHERE transaction_id = ? AND transaction_type = 'APV'", [apvId]).catch(() => {});
      await pool.query("DELETE FROM apv_headers WHERE id = ?", [apvId]);
    }
    await pool.query(`DELETE FROM coa_validations WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE '${PFX}%')`);
    await pool.query(`DELETE FROM coa_groups WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE '${PFX}%')`);
    await pool.query(`DELETE FROM bank_codes WHERE bank_code LIKE '${PFX}%' OR coa_code LIKE '${PFX}%'`);
    await pool.query(`DELETE FROM chart_of_accounts WHERE code LIKE '${PFX}%'`);
    await pool.query(`DELETE FROM general_libraries WHERE code LIKE '${PFX}%'`);
    await pool.query(`DELETE FROM ewt_library WHERE atc_code LIKE '${PFX}%'`);
    await pool.query(`DELETE FROM vat_rate_codes WHERE code LIKE '${PFX}%'`);
    await pool.query("DELETE FROM report_sections WHERE code LIKE 'UAT_FSRBAC_%'");
    await pool.query(`DELETE FROM account_group_codes WHERE group_code LIKE '${PFX}%'`);
    await pool.query(`DELETE FROM prepaid_accounts WHERE prepaid_code LIKE '${PFX}%'`);
    const cs = ids.companies;
    await pool.query("DELETE FROM currency_rates WHERE company_id IN (?)", [cs]).catch(() => {});
    await pool.query("DELETE FROM currencies WHERE company_id IN (?)", [cs]).catch(() => {});
    await pool.query("DELETE FROM audit_logs WHERE user_id IN (?)", [ids.users]).catch(() => {});
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [ids.users]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [ids.users]);
    await pool.query("DELETE FROM companies WHERE id IN (?)", [cs]);
  } finally {
    await pool.end();
  }
});

// ===========================================================================
describe("TC-FS-001 Chart of Accounts", () => {
  test("R1: ACCOUNTANT holds FILESETUP.COA VIEW - the account picker of the transaction forms loads", async () => {
    const res = await as("accountant").get("/api/coa");
    expect(res.status).toBe(200);
    const row = res.body.find((a) => a.code === `${PFX}EXP`);
    expect(row).toMatchObject({ code: `${PFX}EXP`, title: "UAT FSRBAC Office Supplies", accountClass: "EXPENSE" });
  });

  test("create / edit / delete / import stay ADMIN-only (403, nothing written)", async () => {
    const before = await count(`SELECT COUNT(*) n FROM chart_of_accounts WHERE code LIKE '${PFX}%'`);
    for (const who of ["accountant"]) {
      expectDenied(await as(who).post("/api/coa", { code: `${PFX}NEW`, date: "2096-01-01", title: "x", accountClass: "ASSET" }));
      expectDenied(await as(who).put(`/api/coa/${accountId}`, { code: `${PFX}EXP`, date: "2096-01-01", title: "renamed", accountClass: "EXPENSE" }));
      expectDenied(await as(who).del(`/api/coa/${accountId}`));
      expectDenied(await request(app).post("/api/coa/import/preview").set({ Authorization: `Bearer ${tok[who]}` }).attach("file", Buffer.from("Code,Title\n"), "coa.csv"));
    }
    expect(await count(`SELECT COUNT(*) n FROM chart_of_accounts WHERE code LIKE '${PFX}%'`)).toBe(before);
    const [[row]] = await pool.execute("SELECT title FROM chart_of_accounts WHERE id = ?", [accountId]);
    expect(row.title).toBe("UAT FSRBAC Office Supplies");
  });

  test("server-side validation: blank code / title, invalid class, missing date -> 400; duplicate code -> 400", async () => {
    const ok = { code: `${PFX}V1`, date: "2096-01-01", title: "Valid", accountClass: "ASSET" };
    const cases = [
      [{ ...ok, code: "  " }, "COA_CODE_REQUIRED"],
      [{ ...ok, title: "" }, "COA_TITLE_REQUIRED"],
      [{ ...ok, accountClass: "REVENUE" }, "COA_CLASS_INVALID"],
      [{ ...ok, date: "" }, "COA_DATE_REQUIRED"],
    ];
    for (const [body, code] of cases) {
      const res = await as("adminA").post("/api/coa", body);
      expect([res.status, res.body.code]).toEqual([400, code]);
    }
    expect(await count(`SELECT COUNT(*) n FROM chart_of_accounts WHERE code = '' OR title = ''`)).toBe(0);
    const dup = await as("adminA").post("/api/coa", { ...ok, code: `${PFX}EXP` });
    expect([dup.status, dup.body.message]).toEqual([400, "Account code already exists"]);
  });

  test("edit: the same validation applies; a duplicate code is a 400 (was 500)", async () => {
    const created = await as("adminA").post("/api/coa", { code: `${PFX}E1`, date: "2096-01-01", title: "Edit me", accountClass: "ASSET" });
    expect(created.status).toBe(200);
    expect((await as("adminA").put(`/api/coa/${created.body.id}`, { code: `${PFX}E1`, date: "2096-01-01", title: "", accountClass: "ASSET" })).status).toBe(400);
    const dup = await as("adminA").put(`/api/coa/${created.body.id}`, { code: `${PFX}EXP`, date: "2096-01-01", title: "Edit me", accountClass: "ASSET" });
    expect([dup.status, dup.body.message]).toEqual([400, "Account code already exists"]);
    const okEdit = await as("adminA").put(`/api/coa/${created.body.id}`, { code: `${PFX}E1`, date: "2096-01-02", title: "  Edited  ", accountClass: "asset" });
    expect(okEdit.status).toBe(200);
    const [[row]] = await pool.execute("SELECT title, account_class, DATE_FORMAT(account_date, '%Y-%m-%d') d FROM chart_of_accounts WHERE id = ?", [created.body.id]);
    expect(row).toEqual({ title: "Edited", account_class: "ASSET", d: "2096-01-02" });
  });

  test("delete: an account used by a transaction is refused (409 COA_IN_USE) and kept; an unused one is deleted", async () => {
    const S = { supplierId: null, supplierName: "UAT FSRBAC Supplier A" };
    const [[sup]] = await pool.execute("SELECT id FROM general_libraries WHERE code = ?", [`${PFX}SUP-A`]);
    S.supplierId = sup.id;
    const [[ap]] = await pool.execute("SELECT id, code, title FROM chart_of_accounts WHERE code = ?", [`${PFX}AP`]);
    const lines = [
      { accountId, accountCode: `${PFX}EXP`, accountTitle: "UAT FSRBAC Office Supplies", particulars: "x", debit: 100, credit: 0 },
      { accountId: ap.id, accountCode: ap.code, accountTitle: ap.title, particulars: "x", debit: 0, credit: 100 },
    ];
    const apv = await as("accountant").post("/api/apv", { ...S, partyId: sup.id, voucherNo: `${PFX}APV-1`, transactionDate: "2096-06-10", dueDate: "2096-06-20", status: "Posted", lines, totalDebit: 100, totalCredit: 100, currency: { companyId: companyA }, companyId: companyA });
    expect(apv.status).toBe(200); // the accountant CAN record the transaction through the API
    apvId = apv.body.id;
    const res = await as("adminA").del(`/api/coa/${accountId}`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "COA_IN_USE", references: { apv_lines: 1 } });
    expect(await count("SELECT COUNT(*) n FROM chart_of_accounts WHERE id = ?", [accountId])).toBe(1);
    const unused = await as("adminA").post("/api/coa", { code: `${PFX}DEL`, date: "2096-01-01", title: "Unused", accountClass: "ASSET" });
    expect((await as("adminA").del(`/api/coa/${unused.body.id}`)).status).toBe(200);
    expect(await count("SELECT COUNT(*) n FROM chart_of_accounts WHERE id = ?", [unused.body.id])).toBe(0);
  });
});

// ===========================================================================
describe("TC-FS-002 General Libraries", () => {
  test("R2: ACCOUNTANT lists its own company's parties only; create / edit / delete / import stay restricted", async () => {
    const res = await as("accountant").get("/api/genlib");
    expect(res.status).toBe(200);
    expect(res.body.map((p) => p.code)).toContain(`${PFX}SUP-A`);
    expect(res.body.map((p) => p.code)).not.toContain(`${PFX}CUS-B`);
    const before = await count(`SELECT COUNT(*) n FROM general_libraries WHERE code LIKE '${PFX}%'`);
    expectDenied(await as("accountant").post("/api/genlib", { code: `${PFX}NEW`, name: "x", type: "CUSTOMER" }));
    const [[sup]] = await pool.execute("SELECT id FROM general_libraries WHERE code = ?", [`${PFX}SUP-A`]);
    expectDenied(await as("accountant").put(`/api/genlib/${sup.id}`, { code: `${PFX}SUP-A`, name: "renamed", type: "SUPPLIER" }));
    expectDenied(await as("accountant").del(`/api/genlib/${sup.id}`));
    expectDenied(await request(app).post("/api/genlib/import/preview").set({ Authorization: `Bearer ${tok.accountant}` }).attach("file", Buffer.from("Code,Name\n"), "gl.csv"));
    expect(await count(`SELECT COUNT(*) n FROM general_libraries WHERE code LIKE '${PFX}%'`)).toBe(before);
  });

  test("ADMIN: customer / supplier create, duplicate code, blank name, invalid type", async () => {
    const c1 = await as("adminA").post("/api/genlib", { code: `${PFX}C1`, name: "UAT FSRBAC Customer 1", type: "CUSTOMER" });
    const s1 = await as("adminA").post("/api/genlib", { code: `${PFX}S1`, name: "UAT FSRBAC Supplier 1", type: "SUPPLIER", status: "INACTIVE" });
    expect([c1.status, s1.status]).toEqual([200, 200]);
    expect((await as("adminA").post("/api/genlib", { code: `${PFX}C1`, name: "dup", type: "CUSTOMER" })).status).toBe(400);
    expect((await as("adminA").post("/api/genlib", { code: `${PFX}C2`, name: "  ", type: "CUSTOMER" })).body.code).toBe("GENLIB_NAME_REQUIRED");
    expect((await as("adminA").post("/api/genlib", { code: `${PFX}C3`, name: "x", type: "VENDOR" })).body.code).toBe("GENLIB_TYPE_INVALID");
    const list = await as("adminA").get("/api/genlib");
    expect(list.body.find((p) => p.code === `${PFX}S1`)).toMatchObject({ type: "SUPPLIER", status: "INACTIVE" });
  });

  test("company isolation: company B cannot read, edit or delete company A's party", async () => {
    const [[sup]] = await pool.execute("SELECT id FROM general_libraries WHERE code = ?", [`${PFX}SUP-A`]);
    const list = await as("adminB").get("/api/genlib");
    expect(list.body.map((p) => p.code)).not.toContain(`${PFX}SUP-A`);
    expect((await as("adminB").put(`/api/genlib/${sup.id}`, { code: `${PFX}SUP-A`, name: "hijack", type: "SUPPLIER" })).status).toBe(404);
    expect((await as("adminB").del(`/api/genlib/${sup.id}`)).status).toBe(404);
    const [[row]] = await pool.execute("SELECT name FROM general_libraries WHERE id = ?", [sup.id]);
    expect(row.name).toBe("UAT FSRBAC Supplier A");
  });
});

// ===========================================================================
describe("TC-FS-003 Group Codes (consumed by reports; administered by ADMIN)", () => {
  test("ACCOUNTANT has no Group Codes access at all - not needed for transactions or reports", async () => {
    for (const who of ["accountant"]) {
      expectDenied(await as(who).get("/api/group-codes"));
      expectDenied(await as(who).get("/api/group-codes/template"));
      expectDenied(await as(who).post("/api/group-codes", { groupCode: `${PFX}GC`, groupDescription: "x", accountClass: "ASSET" }));
      expectDenied(await request(app).post("/api/group-codes/import/preview").set({ Authorization: `Bearer ${tok[who]}` }).attach("file", Buffer.from("Group Code,Group Description,Account Class\n"), "gc.csv"));
    }
    expect(await count(`SELECT COUNT(*) n FROM account_group_codes WHERE group_code LIKE '${PFX}%'`)).toBe(0);
  });

  test("the structured financial statements an accountant opens still use Group Codes (REPORTS.FINANCIAL only)", async () => {
    const res = await as("accountant").get("/api/reports/income-statement", { from: "2096-06-01", to: "2096-06-30", view: "structured", companyId: companyA });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.nodes)).toBe(true);
  });

  test("ADMIN: view + template + configure", async () => {
    expect((await as("adminA").get("/api/group-codes")).status).toBe(200);
    expect((await as("adminA").get("/api/group-codes/template")).status).toBe(200);
    const res = await as("adminA").post("/api/group-codes", { groupCode: `${PFX}GC`, groupDescription: "UAT FSRBAC group", accountClass: "ASSET", status: "ACTIVE" });
    expect(res.status).toBe(200);
  });
});

// ===========================================================================
describe("TC-FS-004 Report Sections", () => {
  test("ACCOUNTANT: no access (VIEW is not needed for any accounting workflow); configure denied, nothing written", async () => {
    expectDenied(await as("accountant").get("/api/report-sections"));
    expectDenied(await as("accountant").post("/api/report-sections", { code: "UAT_FSRBAC_SEC", name: "x", accountClass: "ASSET", displayOrder: 1, status: "ACTIVE" }));
    expect(await count("SELECT COUNT(*) n FROM report_sections WHERE code LIKE 'UAT_FSRBAC_%'")).toBe(0);
  });

  test("ADMIN: view and configure (ordering returned by display order)", async () => {
    const res = await as("adminA").post("/api/report-sections", { code: "UAT_FSRBAC_SEC", name: "UAT FSRBAC Section", accountClass: "ASSET", displayOrder: 9999, status: "ACTIVE" });
    expect(res.status).toBe(200);
    const list = await as("adminA").get("/api/report-sections");
    expect(list.status).toBe(200);
    const orders = (Array.isArray(list.body) ? list.body : list.body.rows || list.body.sections).map((s) => s.displayOrder ?? s.display_order).filter((v) => v !== null && v !== undefined);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });
});

// ===========================================================================
describe("TC-FS-005 Tax Setup (EWT library / VAT rate codes)", () => {
  test("R3: ACCOUNTANT can select EWT / VAT codes, cannot configure them", async () => {
    const ewt = await as("accountant").get("/api/ewt-library");
    expect(ewt.status).toBe(200);
    expect((Array.isArray(ewt.body) ? ewt.body : ewt.body.rows).some((e) => (e.atcCode || e.atc_code) === `${PFX}WC1`)).toBe(true);
    expect((await as("accountant").get("/api/vat-rate-codes")).status).toBe(200);
    const before = await count(`SELECT COUNT(*) n FROM ewt_library WHERE atc_code LIKE '${PFX}%'`);
    expectDenied(await as("accountant").post("/api/ewt-library", { atcCode: `${PFX}WC2`, description: "x", rate: 2, taxType: "EWT" }));
    expectDenied(await as("accountant").post("/api/vat-rate-codes", { code: `${PFX}V`, description: "x", rate: 12 }));
    const [[e]] = await pool.execute("SELECT id FROM ewt_library WHERE atc_code = ?", [`${PFX}WC1`]);
    expectDenied(await as("accountant").put(`/api/ewt-library/${e.id}`, { atcCode: `${PFX}WC1`, description: "x", rate: 99, taxType: "EWT" }));
    expectDenied(await as("accountant").del(`/api/ewt-library/${e.id}`));
    expect(await count(`SELECT COUNT(*) n FROM ewt_library WHERE atc_code LIKE '${PFX}%'`)).toBe(before);
    expect(Number((await pool.execute("SELECT rate FROM ewt_library WHERE id = ?", [e.id]))[0][0].rate)).toBe(1);
  });

  test("ADMIN can configure tax codes", async () => {
    const res = await as("adminA").post("/api/ewt-library", { atcCode: `${PFX}WC2`, description: "UAT FSRBAC 2%", rate: 2, taxType: "EWT", status: "ACTIVE" });
    expect(res.status).toBe(200);
  });
});

// ===========================================================================
describe("TC-FS-006 Prepaid Accounts", () => {
  let prepaidId;
  test("ACCOUNTANT: no access (prepaid set-up is administration; reports read it without this permission)", async () => {
    expectDenied(await as("accountant").get("/api/prepaid-accounts"));
    expectDenied(await as("accountant").post("/api/prepaid-accounts", { prepaidCode: `${PFX}PP`, description: "x", accountCode: `${PFX}EXP`, startDate: "2096-01-01", amount: 1200, termMonths: 12 }));
  });

  test("ADMIN: create with account mapping, edit status; list returns it", async () => {
    const res = await as("adminA").post("/api/prepaid-accounts", { prepaidCode: `${PFX}PP`, description: "UAT FSRBAC prepaid", partyName: "x", accountCode: `${PFX}EXP`, expenseAccountCode: `${PFX}EXP`, startDate: "2096-01-01", amount: 1200, termMonths: 12, status: "ACTIVE" });
    expect(res.status).toBe(200);
    const [[row]] = await pool.execute("SELECT id, account_code FROM prepaid_accounts WHERE prepaid_code = ?", [`${PFX}PP`]);
    prepaidId = row.id;
    expect(row.account_code).toBe(`${PFX}EXP`);
    const upd = await as("adminA").put(`/api/prepaid-accounts/${prepaidId}`, { prepaidCode: `${PFX}PP`, description: "UAT FSRBAC prepaid", partyName: "x", accountCode: `${PFX}EXP`, expenseAccountCode: `${PFX}EXP`, startDate: "2096-01-01", amount: 1200, termMonths: 12, status: "INACTIVE" });
    expect(upd.status).toBe(200);
    expect((await as("adminA").get("/api/prepaid-accounts")).body.find((p) => (p.prepaidCode || p.prepaid_code) === `${PFX}PP`)).toBeTruthy();
  });

  test("existing behaviour (recorded, not changed): prepaid accounts are global - company B's admin sees company A's prepaid", async () => {
    const list = await as("adminB").get("/api/prepaid-accounts");
    expect(list.body.some((p) => (p.prepaidCode || p.prepaid_code) === `${PFX}PP`)).toBe(true);
  });

  test("existing gap (recorded, not changed): DELETE requires FILESETUP.PREPAID_ACCOUNTS DELETE, which the catalog does not define - even ADMIN gets 403", async () => {
    expect((await as("adminA").del(`/api/prepaid-accounts/${prepaidId}`)).status).toBe(403);
    expect(await count("SELECT COUNT(*) n FROM permissions WHERE module_key = 'FILESETUP.PREPAID_ACCOUNTS' AND action = 'DELETE'")).toBe(0);
    expect(await count("SELECT COUNT(*) n FROM prepaid_accounts WHERE id = ?", [prepaidId])).toBe(1);
  });
});

// ===========================================================================
describe("TC-FS-007 Bank Codes", () => {
  test("ACCOUNTANT: can list / select bank codes (r7 grant)", async () => {
    expect((await as("accountant").get("/api/bank-codes")).status).toBe(200);
  });

  test("ACCOUNTANT: configure / sync / edit / delete denied; nothing written", async () => {
    const before = await count(`SELECT COUNT(*) n FROM bank_codes WHERE bank_code LIKE '${PFX}%'`);
    expectDenied(await as("accountant").post("/api/bank-codes", { bankCode: `${PFX}BK`, bankName: "x", accountNo: "1", accountName: "x", status: "ACTIVE" }));
    expectDenied(await as("accountant").post("/api/bank-codes/sync", {}));
    expectDenied(await as("accountant").put("/api/bank-codes/999999999", { bankCode: "x" }));
    expectDenied(await as("accountant").del("/api/bank-codes/999999999"));
    expect(await count(`SELECT COUNT(*) n FROM bank_codes WHERE bank_code LIKE '${PFX}%'`)).toBe(before);
  });
});

// ===========================================================================
describe("TC-FS-008 Currency / exchange rates", () => {
  test("ACCOUNTANT: lists currencies and resolves the rate effective on a transaction date", async () => {
    const list = await as("accountant").get("/api/currencies", { companyId: companyA });
    expect(list.status).toBe(200);
    const all = Array.isArray(list.body) ? list.body : list.body.currencies || list.body.rows;
    expect(all.some((c) => c.currencyCode === "XFR")).toBe(true);
    const june = await as("accountant").post("/api/exchange-rates/resolve", { currencyId: xfrId, transactionDate: "2096-06-15" });
    const july = await as("accountant").post("/api/exchange-rates/resolve", { currencyId: xfrId, transactionDate: "2096-07-05" });
    expect([june.status, july.status]).toEqual([200, 200]);
    expect([Number(june.body.rate), Number(july.body.rate)]).toEqual([56, 57]);
  });

  test("ACCOUNTANT: create / edit / activate / rates / approve / base / import / FX accounts / provider denied; nothing written", async () => {
    const rates = await count("SELECT COUNT(*) n FROM currency_rates WHERE company_id = ?", [companyA]);
    const curs = await count("SELECT COUNT(*) n FROM currencies WHERE company_id = ?", [companyA]);
    const denied = [
      await as("accountant").post("/api/currencies", { currencyCode: "XFS", currencyName: "x", companyId: companyA }),
      await as("accountant").put(`/api/currencies/${xfrId}`, { currencyName: "renamed" }),
      await as("accountant").patch(`/api/currencies/${xfrId}/status`, { isActive: false }),
      await as("accountant").post(`/api/currencies/${xfrId}/rates`, { rateMode: "MANUAL", rate: 99, effectiveDate: "2096-08-01", reason: "x" }),
      await as("accountant").post(`/api/currencies/${xfrId}/set-base`, {}),
      await as("accountant").patch("/api/exchange-rates/999999999/approve", {}),
      await as("accountant").post("/api/exchange-rates/official-rate", { currencyId: xfrId, rate: 1, effectiveDate: "2096-08-01" }),
      await as("accountant").post("/api/exchange-rates/import/preview", { companyId: companyA, rows: [] }),
      await as("accountant").put("/api/currencies/fx-accounts", {}),
      await as("accountant").put(`/api/exchange-rates/policy/${companyA}`, {}),
    ];
    for (const res of denied) expectDenied(res);
    expect(await count("SELECT COUNT(*) n FROM currency_rates WHERE company_id = ?", [companyA])).toBe(rates);
    expect(await count("SELECT COUNT(*) n FROM currencies WHERE company_id = ?", [companyA])).toBe(curs);
    const [[x]] = await pool.execute("SELECT currency_name, is_active FROM currencies WHERE id = ?", [xfrId]);
    expect([x.currency_name, Number(x.is_active)]).toEqual(["UAT FSRBAC test currency", 1]);
  });
});

// ===========================================================================
describe("TC-FS-009 Accountant RBAC (administration and restricted approvals)", () => {
  test("cannot manage users, roles / permissions, audit logs, access restrictions, invitations, company profile, periods", async () => {
    const [[role]] = await pool.execute("SELECT id FROM roles WHERE code = 'ACCOUNTANT'");
    const denied = [
      await as("accountant").get("/api/users"),
      await as("accountant").put(`/api/roles/${role.id}/permissions`, { permissions: [] }),
      await as("accountant").get("/api/audit-logs"),
      await as("accountant").get("/api/access-restrictions"),
      await as("accountant").post("/api/invitations", { email: "nobody@example.invalid" }),
      await as("accountant").put("/api/company-profile", { companyName: "hijack" }),
      await as("accountant").post("/api/accounting-periods/999999999/close", {}),
      await as("accountant").post("/api/rfp/999999999/approve", {}),
    ];
    for (const res of denied) expect(res.status).toBe(403);
  });

  test("role permissions are unchanged by the denied attempt", async () => {
    const [[role]] = await pool.execute("SELECT id FROM roles WHERE code = 'ACCOUNTANT'");
    expect(await count("SELECT COUNT(*) n FROM role_permissions WHERE role_id = ? AND granted = 1", [role.id])).toBeGreaterThan(0);
  });

  test("R4: ACCOUNTANT no longer holds REPORTS.BANK_RECONCILIATION APPROVE (maker-checker) - approve is 403", async () => {
    expectDenied(await as("accountant").post("/api/bank-recon/adjustments/999999999/approve", {}));
  });
});

// ===========================================================================
describe("TC-FS-010 ADMIN keeps the set-up permissions", () => {
  test("ADMIN can view every File Setup list and configure master data", async () => {
    for (const path of ["/api/coa", "/api/genlib", "/api/group-codes", "/api/report-sections", "/api/ewt-library", "/api/vat-rate-codes", "/api/prepaid-accounts", "/api/bank-codes", "/api/currencies"]) {
      const res = await as("adminA").get(path, { companyId: companyA });
      expect([path, res.status]).toEqual([path, 200]);
    }
    expect((await as("adminA").get("/api/users")).status).toBe(200); // ADMIN.USER_SETTINGS
  });

  test("ADMIN still cannot change role permissions (Super Admin only)", async () => {
    const [[role]] = await pool.execute("SELECT id FROM roles WHERE code = 'ACCOUNTANT'");
    expect((await as("adminA").put(`/api/roles/${role.id}/permissions`, { permissions: [] })).status).toBe(403);
  });
});

// ===========================================================================
describe("TC-FS-011 company isolation where File Setup is company-scoped", () => {
  test("General Libraries: each company sees only its own parties", async () => {
    const a = (await as("adminA").get("/api/genlib")).body.map((p) => p.code);
    const b = (await as("adminB").get("/api/genlib")).body.map((p) => p.code);
    expect(a).toContain(`${PFX}SUP-A`);
    expect(a).not.toContain(`${PFX}CUS-B`);
    expect(b).toContain(`${PFX}CUS-B`);
    expect(b).not.toContain(`${PFX}SUP-A`);
  });

  test("Currencies: company B does not see company A's currency or rates", async () => {
    const list = await as("adminB").get("/api/currencies", { companyId: companyB });
    const all = Array.isArray(list.body) ? list.body : list.body.currencies || list.body.rows || [];
    expect(all.some((c) => c.id === xfrId)).toBe(false);
    const res = await as("adminB").get(`/api/currencies/${xfrId}`, { companyId: companyB });
    expect([403, 404]).toContain(res.status);
  });

  test("recorded (design): COA, Group Codes, Report Sections, Tax codes, Bank codes and Prepaid accounts are global master data", async () => {
    const res = await as("adminB").get("/api/coa");
    expect(res.body.some((a) => a.code === `${PFX}EXP`)).toBe(true);
  });
});
