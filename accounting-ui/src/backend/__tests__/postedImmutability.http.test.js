const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Checkpoint 7A.1: permanent HTTP-level regression coverage for the backend
// Posted-immutability guard. Before this checkpoint, PUT/DELETE routes for
// Invoice/APV/OR/CV/JV/Petty Cash/Debit Memo/Credit Memo checked company
// ownership and period-lock only - a Posted transaction's core fields
// (amount, account, party, date, lines) could be freely edited, and Posted
// records could be deleted outright, as long as the accounting period was
// still open. This is an accounting-integrity rule (Posted history is
// immutable unless an explicit Void/Reversal workflow exists, which none
// of these routes are), not an RBAC rule - it applies regardless of role,
// including SUPER_ADMIN, and is based on the STORED status only, never the
// client-submitted one. PO is deliberately excluded (Open/Closed
// lifecycle, not Draft/Posted - see the Phase 7A.1 architecture note).

jest.setTimeout(120000);

let companyId;
let tokenAdmin, tokenSuper;
let arId, apId, revId, expId, cashId;
let custId, suppId;
let adminUserId, superUserId;

const createdIds = { invoice: [], apv: [], or: [], cv: [], jv: [], pettyCash: [], memo: [] };

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
  if (companyId) {
    await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, companyId]);
  }
  return userId;
}
async function makeAccount(code, title, accountClass) {
  const [result] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, accountClass]
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

  companyId = await makeCompany("PIM7A1 Company");
  adminUserId = await makeLoginUser("pim7a1_admin", "Pim7a1Pass!1", 2, companyId);
  superUserId = await makeLoginUser("pim7a1_super", "Pim7a1Pass!2", 1, null);

  arId = await makeAccount("PIM7A1AR", "AR (7A.1)", "ASSET");
  apId = await makeAccount("PIM7A1AP", "AP (7A.1)", "LIABILITY");
  revId = await makeAccount("PIM7A1REV", "Revenue (7A.1)", "INCOME");
  expId = await makeAccount("PIM7A1EXP", "Expense (7A.1)", "EXPENSE");
  cashId = await makeAccount("PIM7A1CASH", "Cash (7A.1)", "ASSET");

  custId = await makeParty("PIM7A1-CUST", "CUSTOMER", "7A.1 Customer", companyId);
  suppId = await makeParty("PIM7A1-SUPP", "SUPPLIER", "7A.1 Supplier", companyId);

  // Every module here is currency-eligible and calls resolveTransactionCurrency()
  // even for a base-currency (PHP) transaction - it requires a base currency
  // to be configured for the company, same as every other test file's fixture.
  const CurrencyService = require("../services/currencyService");
  await CurrencyService.createCurrency({ id: adminUserId, roleCode: "ADMIN" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId,
  });

  tokenAdmin = await loginAs("pim7a1_admin", "Pim7a1Pass!1");
  tokenSuper = await loginAs("pim7a1_super", "Pim7a1Pass!2");
});

afterAll(async () => {
  // currencies must be deleted AFTER every header table that FKs to it
  // (jv_headers.currency_id etc.), not before.
  await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id = ?", [companyId]);
  await pool.query("DELETE FROM memo_lines WHERE memo_id IN (SELECT id FROM memo_headers WHERE company_id = ?)", [companyId]);
  await pool.query("DELETE FROM memo_headers WHERE company_id = ?", [companyId]);
  await pool.query("DELETE FROM petty_cash_lines WHERE petty_cash_id IN (SELECT id FROM petty_cash_headers WHERE company_id = ?)", [companyId]);
  await pool.query("DELETE FROM petty_cash_headers WHERE company_id = ?", [companyId]);
  await pool.query("DELETE FROM jv_lines WHERE jv_id IN (SELECT id FROM jv_headers WHERE company_id = ?)", [companyId]);
  await pool.query("DELETE FROM jv_headers WHERE company_id = ?", [companyId]);
  await pool.query("DELETE FROM cv_lines WHERE cv_id IN (SELECT id FROM cv_headers WHERE company_id = ?)", [companyId]);
  await pool.query("DELETE FROM cv_headers WHERE company_id = ?", [companyId]);
  await pool.query("DELETE FROM or_lines WHERE or_id IN (SELECT id FROM or_headers WHERE company_id = ?)", [companyId]);
  await pool.query("DELETE FROM or_headers WHERE company_id = ?", [companyId]);
  await pool.query("DELETE FROM apv_lines WHERE apv_id IN (SELECT id FROM apv_headers WHERE company_id = ?)", [companyId]);
  await pool.query("DELETE FROM apv_headers WHERE company_id = ?", [companyId]);
  await pool.query("DELETE FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoice_headers WHERE company_id = ?)", [companyId]);
  await pool.query("DELETE FROM invoice_headers WHERE company_id = ?", [companyId]);
  await pool.query("DELETE FROM currency_rates WHERE company_id = ?", [companyId]);
  await pool.query("DELETE FROM currencies WHERE company_id = ?", [companyId]);
  await pool.query("DELETE FROM general_libraries WHERE company_id = ?", [companyId]);
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'PIM7A1%'");
  await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [adminUserId]);
  await pool.query("DELETE FROM users WHERE id IN (?,?)", [adminUserId, superUserId]);
  await pool.query("DELETE FROM companies WHERE id = ?", [companyId]);
  await pool.end();
});

// ---- Fixture builders: one Draft + one Posted header/lines pair per module ----

async function makeInvoice(status, voucherNo) {
  const [h] = await pool.execute(
    `INSERT INTO invoice_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, ?, '7A.1 Customer', '2026-08-01', 500, 500, 0, 500, 'Unpaid', ?)`,
    [companyId, voucherNo, custId, status]
  );
  await pool.execute(`INSERT INTO invoice_lines (invoice_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'PIM7A1AR', 'AR', 'x', 500, 0)`, [h.insertId, arId]);
  await pool.execute(`INSERT INTO invoice_lines (invoice_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'PIM7A1REV', 'REV', 'x', 0, 500)`, [h.insertId, revId]);
  return h.insertId;
}
async function makeApv(status, voucherNo) {
  const [h] = await pool.execute(
    `INSERT INTO apv_headers (company_id, voucher_no, supplier_id, supplier_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, ?, '7A.1 Supplier', '2026-08-01', 300, 300, 0, 300, 'Unpaid', ?)`,
    [companyId, voucherNo, suppId, status]
  );
  await pool.execute(`INSERT INTO apv_lines (apv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'PIM7A1EXP', 'EXP', 'x', 300, 0)`, [h.insertId, expId]);
  await pool.execute(`INSERT INTO apv_lines (apv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'PIM7A1AP', 'AP', 'x', 0, 300)`, [h.insertId, apId]);
  return h.insertId;
}
async function makeOr(status, voucherNo) {
  const [h] = await pool.execute(
    `INSERT INTO or_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, '7A.1 Customer', '2026-08-01', 200, 200, ?)`,
    [companyId, voucherNo, custId, status]
  );
  await pool.execute(`INSERT INTO or_lines (or_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'PIM7A1CASH', 'CASH', 'x', 200, 0)`, [h.insertId, cashId]);
  await pool.execute(`INSERT INTO or_lines (or_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'PIM7A1AR', 'AR', 'x', 0, 200)`, [h.insertId, arId]);
  return h.insertId;
}
async function makeCv(status, voucherNo) {
  const [h] = await pool.execute(
    `INSERT INTO cv_headers (company_id, voucher_no, payee_id, payee_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, '7A.1 Supplier', '2026-08-01', 150, 150, ?)`,
    [companyId, voucherNo, suppId, status]
  );
  await pool.execute(`INSERT INTO cv_lines (cv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'PIM7A1AP', 'AP', 'x', 150, 0)`, [h.insertId, apId]);
  await pool.execute(`INSERT INTO cv_lines (cv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'PIM7A1CASH', 'CASH', 'x', 0, 150)`, [h.insertId, cashId]);
  return h.insertId;
}
async function makeJv(status, voucherNo) {
  const [h] = await pool.execute(
    `INSERT INTO jv_headers (company_id, voucher_no, transaction_date, description, total_debit, total_credit, status)
     VALUES (?, ?, '2026-08-01', 'x', 100, 100, ?)`,
    [companyId, voucherNo, status]
  );
  await pool.execute(`INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'PIM7A1AR', 'AR', 'x', 100, 0)`, [h.insertId, arId]);
  await pool.execute(`INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'PIM7A1REV', 'REV', 'x', 0, 100)`, [h.insertId, revId]);
  return h.insertId;
}
async function makePettyCash(status, voucherNo) {
  const [h] = await pool.execute(
    `INSERT INTO petty_cash_headers (company_id, voucher_no, payee_id, payee_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, '7A.1 Supplier', '2026-08-01', 50, 50, ?)`,
    [companyId, voucherNo, suppId, status]
  );
  await pool.execute(`INSERT INTO petty_cash_lines (petty_cash_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'PIM7A1EXP', 'EXP', 'x', 50, 0)`, [h.insertId, expId]);
  await pool.execute(`INSERT INTO petty_cash_lines (petty_cash_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'PIM7A1CASH', 'CASH', 'x', 0, 50)`, [h.insertId, cashId]);
  return h.insertId;
}
async function makeMemo(memoType, status, voucherNo) {
  const [h] = await pool.execute(
    `INSERT INTO memo_headers (company_id, voucher_no, memo_type, party_id, party_name, party_type, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, ?, '7A.1 Customer', 'CUSTOMER', '2026-08-01', 75, 75, ?)`,
    [companyId, voucherNo, memoType, custId, status]
  );
  await pool.execute(`INSERT INTO memo_lines (memo_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'PIM7A1AR', 'AR', 'x', 75, 0)`, [h.insertId, arId]);
  await pool.execute(`INSERT INTO memo_lines (memo_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'PIM7A1REV', 'REV', 'x', 0, 75)`, [h.insertId, revId]);
  return h.insertId;
}

const MODULES = [
  {
    name: "Invoice", endpoint: "invoices", make: makeInvoice, hasDelete: true,
    editBody: (id) => ({ voucherNo: `PIM-INV-EDIT-${id}`, customerId: custId, customerName: "x", transactionDate: "2026-08-01", totalDebit: 999, totalCredit: 999, status: "Draft", currency: { companyId }, lines: [{ accountId: arId, accountCode: "PIM7A1AR", accountTitle: "AR", particulars: "x", debit: 999, credit: 0 }, { accountId: revId, accountCode: "PIM7A1REV", accountTitle: "REV", particulars: "x", debit: 0, credit: 999 }] }),
  },
  {
    name: "APV", endpoint: "apv", make: makeApv, hasDelete: true,
    editBody: (id) => ({ voucherNo: `PIM-APV-EDIT-${id}`, supplierId: suppId, supplierName: "x", transactionDate: "2026-08-01", totalDebit: 999, totalCredit: 999, status: "Draft", currency: { companyId }, lines: [{ accountId: expId, accountCode: "PIM7A1EXP", accountTitle: "EXP", particulars: "x", debit: 999, credit: 0 }, { accountId: apId, accountCode: "PIM7A1AP", accountTitle: "AP", particulars: "x", debit: 0, credit: 999 }] }),
  },
  {
    name: "OR", endpoint: "or", make: makeOr, hasDelete: false,
    editBody: (id) => ({ voucherNo: `PIM-OR-EDIT-${id}`, customerId: custId, customerName: "x", transactionDate: "2026-08-01", totalDebit: 999, totalCredit: 999, status: "Draft", currency: { companyId }, lines: [{ accountId: cashId, accountCode: "PIM7A1CASH", accountTitle: "CASH", particulars: "x", debit: 999, credit: 0 }, { accountId: arId, accountCode: "PIM7A1AR", accountTitle: "AR", particulars: "x", debit: 0, credit: 999 }] }),
  },
  {
    name: "CV", endpoint: "cv", make: makeCv, hasDelete: false,
    editBody: (id) => ({ voucherNo: `PIM-CV-EDIT-${id}`, payeeId: suppId, payeeName: "x", transactionDate: "2026-08-01", totalDebit: 999, totalCredit: 999, status: "Draft", currency: { companyId }, lines: [{ accountId: apId, accountCode: "PIM7A1AP", accountTitle: "AP", particulars: "x", debit: 999, credit: 0 }, { accountId: cashId, accountCode: "PIM7A1CASH", accountTitle: "CASH", particulars: "x", debit: 0, credit: 999 }] }),
  },
  {
    name: "JV", endpoint: "jv", make: makeJv, hasDelete: true,
    editBody: (id) => ({ voucherNo: `PIM-JV-EDIT-${id}`, transactionDate: "2026-08-01", description: "x", status: "Draft", currency: { companyId }, lines: [{ accountId: arId, accountCode: "PIM7A1AR", accountTitle: "AR", particulars: "x", debit: 999, credit: 0 }, { accountId: revId, accountCode: "PIM7A1REV", accountTitle: "REV", particulars: "x", debit: 0, credit: 999 }] }),
  },
  {
    name: "Petty Cash", endpoint: "petty-cash", make: makePettyCash, hasDelete: true,
    editBody: (id) => ({ voucherNo: `PIM-PCV-EDIT-${id}`, payeeId: suppId, payeeName: "x", transactionDate: "2026-08-01", status: "Draft", currency: { companyId }, lines: [{ accountId: expId, accountCode: "PIM7A1EXP", accountTitle: "EXP", particulars: "x", debit: 999, credit: 0 }, { accountId: cashId, accountCode: "PIM7A1CASH", accountTitle: "CASH", particulars: "x", debit: 0, credit: 999 }] }),
  },
  {
    name: "Debit Memo", endpoint: "debit-memos", make: (status, v) => makeMemo("DEBIT", status, v), hasDelete: true,
    editBody: (id) => ({ voucherNo: `PIM-DM-EDIT-${id}`, partyId: custId, partyName: "x", partyType: "CUSTOMER", transactionDate: "2026-08-01", status: "Draft", currency: { companyId }, lines: [{ accountId: arId, accountCode: "PIM7A1AR", accountTitle: "AR", particulars: "x", debit: 999, credit: 0 }, { accountId: revId, accountCode: "PIM7A1REV", accountTitle: "REV", particulars: "x", debit: 0, credit: 999 }] }),
  },
  {
    name: "Credit Memo", endpoint: "credit-memos", make: (status, v) => makeMemo("CREDIT", status, v), hasDelete: true,
    editBody: (id) => ({ voucherNo: `PIM-CM-EDIT-${id}`, partyId: custId, partyName: "x", partyType: "CUSTOMER", transactionDate: "2026-08-01", status: "Draft", currency: { companyId }, lines: [{ accountId: revId, accountCode: "PIM7A1REV", accountTitle: "REV", particulars: "x", debit: 999, credit: 0 }, { accountId: arId, accountCode: "PIM7A1AR", accountTitle: "AR", particulars: "x", debit: 0, credit: 999 }] }),
  },
];

let seq = 0;
function nextVoucher(prefix) {
  seq += 1;
  return `PIM-${prefix}-${Date.now()}-${seq}`;
}

describe.each(MODULES)("$name: Posted-immutability guard", (mod) => {
  test(`Draft + EDIT permission -> update allowed`, async () => {
    const id = await mod.make("Draft", nextVoucher(`${mod.name}D`));
    const res = await request(app).put(`/api/${mod.endpoint}/${id}`).set("Authorization", `Bearer ${tokenAdmin}`).send(mod.editBody(id));
    expect(res.status).toBe(200);
  });

  test(`Posted + EDIT permission -> update rejected`, async () => {
    const id = await mod.make("Posted", nextVoucher(`${mod.name}P`));
    const res = await request(app).put(`/api/${mod.endpoint}/${id}`).set("Authorization", `Bearer ${tokenAdmin}`).send(mod.editBody(id));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("TRANSACTION_ALREADY_POSTED");
  });

  test(`Posted + Super Admin -> still rejected (accounting integrity, not RBAC)`, async () => {
    const id = await mod.make("Posted", nextVoucher(`${mod.name}PS`));
    const res = await request(app).put(`/api/${mod.endpoint}/${id}`).set("Authorization", `Bearer ${tokenSuper}`).send(mod.editBody(id));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("TRANSACTION_ALREADY_POSTED");
  });

  test(`Direct API tampering: submitting status:"Draft" against a Posted record does not "unpost" it`, async () => {
    const id = await mod.make("Posted", nextVoucher(`${mod.name}T`));
    const res = await request(app).put(`/api/${mod.endpoint}/${id}`).set("Authorization", `Bearer ${tokenAdmin}`).send(mod.editBody(id)); // editBody always sends status: "Draft"
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("TRANSACTION_ALREADY_POSTED");
  });

  if (mod.hasDelete) {
    test(`Draft + DELETE permission -> delete allowed`, async () => {
      const id = await mod.make("Draft", nextVoucher(`${mod.name}DD`));
      const res = await request(app).delete(`/api/${mod.endpoint}/${id}`).set("Authorization", `Bearer ${tokenAdmin}`);
      expect(res.status).toBe(200);
    });

    test(`Posted + DELETE permission -> delete rejected`, async () => {
      const id = await mod.make("Posted", nextVoucher(`${mod.name}PD`));
      const res = await request(app).delete(`/api/${mod.endpoint}/${id}`).set("Authorization", `Bearer ${tokenAdmin}`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("TRANSACTION_ALREADY_POSTED");
    });

    test(`Posted + Super Admin DELETE -> still rejected`, async () => {
      const id = await mod.make("Posted", nextVoucher(`${mod.name}PDS`));
      // Super Admin has no company membership row, so resolveCompanyIdForWrite()
      // defaults to the first company in the whole table unless told
      // explicitly which company this request concerns - the real frontend
      // always sends this; DELETE routes read it from the query string.
      const res = await request(app).delete(`/api/${mod.endpoint}/${id}?companyId=${companyId}`).set("Authorization", `Bearer ${tokenSuper}`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("TRANSACTION_ALREADY_POSTED");
    });
  } else {
    test(`no DELETE route exists (${mod.name}) - confirmed absent, not merely permission-hidden`, async () => {
      const id = await mod.make("Draft", nextVoucher(`${mod.name}ND`));
      const res = await request(app).delete(`/api/${mod.endpoint}/${id}`).set("Authorization", `Bearer ${tokenAdmin}`);
      expect(res.status).toBe(404); // no route registered at all for this path+method
    });
  }
});

describe("Draft -> Post -> immutable regression (real posting endpoint)", () => {
  test("JV: create Draft, post via the real PUT-with-status-Posted path, then edit/delete are both rejected", async () => {
    const id = await makeJv("Draft", nextVoucher("JVREG"));

    const postRes = await request(app).put(`/api/jv/${id}`).set("Authorization", `Bearer ${tokenAdmin}`).send({
      voucherNo: `PIM-JVREG-POSTED-${id}`, transactionDate: "2026-08-01", description: "x", status: "Posted",
      lines: [
        { accountId: arId, accountCode: "PIM7A1AR", accountTitle: "AR", particulars: "x", debit: 100, credit: 0 },
        { accountId: revId, accountCode: "PIM7A1REV", accountTitle: "REV", particulars: "x", debit: 0, credit: 100 },
      ],
    });
    expect(postRes.status).toBe(200);

    const [[row]] = await pool.query("SELECT status FROM jv_headers WHERE id = ?", [id]);
    expect(row.status).toBe("Posted");

    const editAfterPostRes = await request(app).put(`/api/jv/${id}`).set("Authorization", `Bearer ${tokenAdmin}`).send({
      voucherNo: `PIM-JVREG-POSTED-${id}`, transactionDate: "2026-08-01", description: "x", status: "Posted",
      lines: [
        { accountId: arId, accountCode: "PIM7A1AR", accountTitle: "AR", particulars: "x", debit: 999, credit: 0 },
        { accountId: revId, accountCode: "PIM7A1REV", accountTitle: "REV", particulars: "x", debit: 0, credit: 999 },
      ],
    });
    expect(editAfterPostRes.status).toBe(409);
    expect(editAfterPostRes.body.code).toBe("TRANSACTION_ALREADY_POSTED");

    const deleteAfterPostRes = await request(app).delete(`/api/jv/${id}`).set("Authorization", `Bearer ${tokenAdmin}`);
    expect(deleteAfterPostRes.status).toBe(409);
    expect(deleteAfterPostRes.body.code).toBe("TRANSACTION_ALREADY_POSTED");
  });
});

describe("No APV contamination regression (Petty Cash / Memo, Checkpoint 6 protection)", () => {
  test("Posted-guard rejections on Petty Cash/Memo never create or touch an apv_headers row", async () => {
    const [[before]] = await pool.query("SELECT COUNT(*) AS c FROM apv_headers WHERE company_id = ?", [companyId]);

    const pcvId = await makePettyCash("Posted", nextVoucher("PCVNOAPV"));
    await request(app).put(`/api/petty-cash/${pcvId}`).set("Authorization", `Bearer ${tokenAdmin}`).send({ voucherNo: "x", payeeId: suppId, payeeName: "x", transactionDate: "2026-08-01", status: "Draft", currency: { companyId }, lines: [] });
    await request(app).delete(`/api/petty-cash/${pcvId}`).set("Authorization", `Bearer ${tokenAdmin}`);

    const dmId = await makeMemo("DEBIT", "Posted", nextVoucher("DMNOAPV"));
    await request(app).put(`/api/debit-memos/${dmId}`).set("Authorization", `Bearer ${tokenAdmin}`).send({ voucherNo: "x", partyId: custId, partyName: "x", partyType: "CUSTOMER", transactionDate: "2026-08-01", status: "Draft", currency: { companyId }, lines: [] });
    await request(app).delete(`/api/debit-memos/${dmId}`).set("Authorization", `Bearer ${tokenAdmin}`);

    const [[after]] = await pool.query("SELECT COUNT(*) AS c FROM apv_headers WHERE company_id = ?", [companyId]);
    expect(after.c).toBe(before.c);
  });
});
