// R11 - bank account ownership and payment data audit.
//   * the current model, including its known limit (BANK-OWNERSHIP-01): bank
//     accounts are global master data, documents and reconciliations are not;
//   * what happens around an inactive bank account;
//   * check number / transfer reference / receipt number never cross-match;
//   * deposit slips keep to their own company, bank account and rules;
//   * scripts/r11BankPaymentAudit.sql is read-only and finds what it claims.
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const { MIGRATION_ORDER } = require("../scripts/migrationOrder");
const { scoreCandidate } = require("../services/ConfidenceScoringService");
const { statementText } = require("../services/depositCombinationService");
const { namesSlip } = require("../services/depositSlipMatching");
const { loadBookItems } = require("../services/BankMatchingService");

jest.setTimeout(300000);

const P = "r11-";
const PW = "R11Pass!1";
const DAY = "2099-03-05";
const co = {};
const cur = {};
const acct = {};
const banks = [];
const bankCoa = {};
const tok = {};
const users = {};
const sessions = [];
let seq = 0;

const q = async (sql, params) => (await pool.query(sql, params))[0];
const one = async (sql, params) => (await q(sql, params))[0];
const api = (who, method, url, body) => {
  const r = request(app)[method](url).set({ Authorization: `Bearer ${tok[who]}` });
  return body === undefined ? r : r.send(body);
};
async function makeUser(tag, roleCode, companyIds = []) {
  const [[role]] = await pool.query("SELECT id FROM roles WHERE code = ?", [roleCode]);
  const [u] = await pool.query("INSERT INTO users (username, password, role_id, status, email) VALUES (?, ?, ?, 'ACTIVE', ?)",
    [`${P}${tag}`, await bcrypt.hash(PW, 10), role.id, `${P}${tag}@example.test`]);
  for (const c of companyIds) await pool.query("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  users[tag] = { id: u.insertId, roleCode };
  const res = await request(app).post("/api/login").send({ username: `${P}${tag}`, password: PW });
  if (res.status !== 200) throw new Error(`login ${tag}`);
  tok[tag] = res.body.token;
}
async function newBank(tag) {
  const code = `${P}BANK-${tag}`;
  const coa = { id: (await q("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, 'ASSET')", [code, `R11 Bank ${tag}`])).insertId, code, title: `R11 Bank ${tag}` };
  const id = (await q("INSERT INTO bank_codes (bank_code, bank_name, account_no, account_name, coa_account_id, coa_code, status) VALUES (?, ?, ?, 'R11', ?, ?, 'ACTIVE')",
    [`${P}${tag}`, `R11 ${tag}`, `000-${tag}`, coa.id, coa.code])).insertId;
  banks.push(id);
  bankCoa[id] = coa;
  return id;
}
const setBankStatus = (bank, status) => q("UPDATE bank_codes SET status = ? WHERE id = ?", [status, bank]);
const ln = (a, debit, credit) => ({ accountId: a.id, accountCode: a.code, accountTitle: a.title, particulars: "", debit, credit });
// o: { bank, gl, amount, date, method, checkNo, checkDate, paymentReference, paymentDate, receiptNo, status, company, moneyIn }
function docBody(kind, o) {
  const company = o.company || "A";
  const isCv = kind === "cv";
  const amt = o.amount || 100;
  const gl = o.gl || (o.bank ? bankCoa[o.bank] : acct.CASH);
  const no = `${P}${kind.toUpperCase()}-${++seq}`;
  const date = o.date || DAY;
  const b = {
    voucherNo: no, referenceNo: no, receiptNo: o.receiptNo || "", [isCv ? "payeeName" : "customerName"]: "R11 Party",
    transactionDate: date, description: "R11", status: o.status || "Posted",
    paymentMethod: o.method || "Cash", bankAccountId: o.bank ?? null, totalDebit: amt, totalCredit: amt,
    lines: isCv && !o.moneyIn ? [ln(acct.EXP, amt, 0), ln(gl, 0, amt)] : [ln(gl, amt, 0), ln(acct.AR, 0, amt)],
    currency: { companyId: co[company], currencyId: cur[company], exchangeRate: 1, rateDate: date },
  };
  if (o.method === "Check") Object.assign(b, { checkNo: o.checkNo ?? `CHK-${seq}`, checkDate: o.checkDate ?? date });
  if (o.method === "Bank Transfer") Object.assign(b, { paymentReference: o.paymentReference ?? `FT-${seq}`, paymentDate: o.paymentDate ?? date });
  for (const k of ["checkNo", "checkDate", "paymentReference", "paymentDate"]) if (o[k] !== undefined) b[k] = o[k];
  return b;
}
const post = (kind, o) => api((o.company || "A") === "A" ? "acctA" : "acctB", "post", `/api/${kind}`, docBody(kind, o));
async function doc(kind, o) {
  const res = await post(kind, o);
  if (res.status !== 200) throw new Error(`${kind}: ${res.status} ${res.body.message}`);
  return { type: kind.toUpperCase(), id: res.body.id };
}
const items = (...docs) => docs.map((d) => ({ type: d.type, id: d.id }));
const createSlip = (who, body) => api(who, "post", "/api/bank-recon/deposit-slips", body);
async function makeSlip(bank, depositDate, docs, { deposit = true } = {}) {
  const res = await createSlip("acctA", { bankAccountId: bank, depositDate, items: items(...docs) });
  if (res.status !== 200) throw new Error(`slip ${res.status} ${res.body.message}`);
  if (deposit) {
    const d = await api("acctA", "post", `/api/bank-recon/deposit-slips/${res.body.id}/deposit`);
    if (d.status !== 200) throw new Error(`deposit ${d.status} ${d.body.message}`);
  }
  return res.body;
}
async function newSession(bank, who = "acctA") {
  const res = await api(who, "post", "/api/bank-recon/sessions", { bankAccountId: bank, periodStart: "2099-03-01", periodEnd: "2099-03-31", dateToleranceDays: 3, statementBeginningBalance: 0, statementEndingBalance: 0 });
  if (res.status !== 200) throw new Error(`session ${res.status} ${res.body.message}`);
  sessions.push(res.body.id);
  return res.body.id;
}
const COLUMNS = "Date,Description,Reference,Check No,Debit,Credit,Bank Reference";
async function importRows(sid, rows, who = "acctA") {
  const res = await request(app).post(`/api/bank-recon/sessions/${sid}/import`).set({ Authorization: `Bearer ${tok[who]}` })
    .attach("file", Buffer.from([COLUMNS, ...rows].join("\n")), "stmt.csv");
  if (res.status !== 200) throw new Error(`import ${res.status} ${res.body.message}`);
}
const run = (sid, who = "acctA") => api(who, "post", `/api/bank-recon/sessions/${sid}/run-matching`);
async function candidatesOf(sid, description, who = "acctA") {
  const line = await one("SELECT id FROM bank_recon_statement_lines WHERE session_id = ? AND description = ?", [sid, description]);
  return (await api(who, "get", `/api/bank-recon/statement-lines/${line.id}/candidates`)).body;
}

beforeAll(async () => {
  assertNotProductionDatabase();
  for (const t of ["A", "B"]) {
    co[t] = (await q("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${P}Co ${t}`])).insertId;
    cur[t] = (await q("INSERT INTO currencies (company_id, currency_code, currency_name, currency_symbol, is_base_currency, is_active) VALUES (?, 'PHP', 'Philippine Peso', 'P', 1, 1)", [co[t]])).insertId;
  }
  for (const [k, t, c] of [["EXP", "R11 Expense", "EXPENSE"], ["AR", "R11 Receivable", "ASSET"], ["CASH", "R11 Cash on Hand", "ASSET"]]) {
    acct[k] = { id: (await q("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)", [`${P}${k}`, t, c])).insertId, code: `${P}${k}`, title: t };
  }
  await makeUser("acctA", "ACCOUNTANT", [co.A]);
  await makeUser("acctB", "ACCOUNTANT", [co.B]);
  await makeUser("adminB", "ADMIN", [co.B]);
});

afterAll(async () => {
  try {
    const cos = Object.values(co);
    const us = Object.values(users).map((u) => u.id);
    if (sessions.length) {
      for (const t of ["bank_recon_adjustments", "bank_recon_matches", "bank_recon_statement_lines", "bank_recon_import_batches"]) {
        await pool.query(`DELETE FROM ${t} WHERE session_id IN (?)`, [sessions]);
      }
      await pool.query("DELETE FROM bank_recon_sessions WHERE id IN (?)", [sessions]);
    }
    await pool.query("DELETE FROM deposit_slips WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE l FROM or_lines l JOIN or_headers h ON h.id = l.or_id WHERE h.company_id IN (?)", [cos]);
    await pool.query("DELETE l FROM cv_lines l JOIN cv_headers h ON h.id = l.cv_id WHERE h.company_id IN (?)", [cos]);
    for (const t of ["or_headers", "cv_headers", "transaction_currency_snapshots", "audit_logs", "currencies"]) await pool.query(`DELETE FROM ${t} WHERE company_id IN (?)`, [cos]);
    await pool.query("DELETE FROM audit_logs WHERE user_id IN (?)", [us]);
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [us]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [us]);
    if (banks.length) await pool.query("DELETE FROM bank_codes WHERE id IN (?)", [banks]);
    await pool.query("DELETE FROM companies WHERE id IN (?)", [cos]);
    await pool.query("DELETE v FROM coa_validations v JOIN chart_of_accounts c ON c.id = v.coa_id WHERE c.code LIKE ?", [`${P}%`]);
    await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE ?", [`${P}%`]);
  } finally {
    await pool.end();
  }
});

// ---------------------------------------------------------------------------
describe("current bank account model (BANK-OWNERSHIP-01)", () => {
  test("bank_codes has no company, and OR / CV bank_account_id has no foreign key", async () => {
    const cols = await q("SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bank_codes'");
    expect(cols.map((x) => x.c)).not.toContain("company_id");
    const fks = await q(`SELECT TABLE_NAME AS t FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = 'bank_codes' ORDER BY t`);
    expect(fks.map((f) => f.t)).toEqual(["bank_recon_sessions", "deposit_slips"]);
  });

  test("every company lists and can post to the same bank account, but documents and statements never cross companies", async () => {
    const bank = await newBank("SHARED");
    for (const who of ["acctA", "acctB"]) {
      expect((await api(who, "get", "/api/bank-codes")).body.map((b) => b.id)).toContain(bank);
    }
    const a = await doc("or", { bank, amount: 1000 });
    const b = await doc("or", { bank, amount: 1000, company: "B" });
    const sidA = await newSession(bank, "acctA");
    const sidB = await newSession(bank, "acctB");
    await importRows(sidA, [`${DAY},Shared deposit,,,,1000.00,`], "acctA");
    await importRows(sidB, [`${DAY},Shared deposit,,,,1000.00,`], "acctB");
    await run(sidA, "acctA");
    await run(sidB, "acctB");
    expect((await candidatesOf(sidA, "Shared deposit", "acctA")).map((c) => c.bookSourceId)).toEqual([a.id]);
    expect((await candidatesOf(sidB, "Shared deposit", "acctB")).map((c) => c.bookSourceId)).toEqual([b.id]);
    expect((await api("acctB", "get", `/api/bank-recon/sessions/${sidA}`)).status).toBe(404);
  });

  test("an administrator of one company changes a bank account for every company", async () => {
    const bank = await newBank("GLOBALCFG");
    const res = await api("adminB", "put", `/api/bank-codes/${bank}`, { bankCode: `${P}GLOBALCFG`, bankName: "R11", accountNo: "1", accountName: "R11", status: "INACTIVE" });
    expect(res.status).toBe(200);
    expect((await post("or", { bank })).body.code).toBe("BANK_ACCOUNT_INACTIVE");
  });
});

// ---------------------------------------------------------------------------
describe("payment methods", () => {
  test.each([
    ["Cash", { checkNo: "123" }, "PAYMENT_FIELD_NOT_ALLOWED"],
    ["Cash", { checkDate: DAY }, "PAYMENT_FIELD_NOT_ALLOWED"],
    ["Cash", { paymentReference: "FT-1" }, "PAYMENT_FIELD_NOT_ALLOWED"],
    ["Cash", { paymentDate: DAY }, "PAYMENT_FIELD_NOT_ALLOWED"],
    ["Bank Transfer", { checkNo: "123" }, "PAYMENT_FIELD_NOT_ALLOWED"],
    ["Bank Transfer", { checkDate: DAY }, "PAYMENT_FIELD_NOT_ALLOWED"],
    ["Check", { paymentReference: "FT-1" }, "PAYMENT_FIELD_NOT_ALLOWED"],
    ["Check", { paymentDate: DAY }, "PAYMENT_FIELD_NOT_ALLOWED"],
    ["Check", { checkNo: 123 }, "PAYMENT_FIELD_NOT_TEXT"],
  ])("%s refuses %j", async (method, fields, code) => {
    const bank = await newBank(`M${++seq}`);
    const res = await post("or", { bank, method, ...fields });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
  });

  test("a posted Cash document needs no check or transfer details and stores none", async () => {
    const d = await doc("or", { method: "Cash", amount: 50 });
    expect(await one("SELECT check_no, check_date, payment_reference, payment_date, bank_account_id FROM or_headers WHERE id = ?", [d.id]))
      .toEqual({ check_no: "", check_date: null, payment_reference: null, payment_date: null, bank_account_id: null });
  });

  test.each(["000123", "AB-0077", "0009-X"])("check number %s is stored exactly as typed, apart from the receipt number", async (checkNo) => {
    const bank = await newBank(`C${++seq}`);
    const d = await doc("or", { bank, method: "Check", checkNo, receiptNo: "RCPT-55" });
    expect(await one("SELECT check_no, receipt_no FROM or_headers WHERE id = ?", [d.id])).toEqual({ check_no: checkNo, receipt_no: "RCPT-55" });
  });

  test("Cash in Bank Recon: no bank account = not a bank item; a bank account = bank item, from its bank line or the fallback", async () => {
    const bank = await newBank("CASHREP");
    const session = { companyId: co.A, bankAccountId: bank, bankCoaAccountId: bankCoa[bank].id };
    await doc("or", { method: "Cash", amount: 61 });
    const onBankLine = await doc("or", { bank, method: "Cash", amount: 62 });
    const onCashOnHand = await doc("or", { bank, gl: acct.CASH, method: "Cash", amount: 63 });
    const found = await loadBookItems(pool, session, {});
    expect(found.map((t) => [t.sourceId, t.amount, t.amountSource]).sort((x, y) => x[1] - y[1])).toEqual([
      [onBankLine.id, 62, "BANK_LINE"],
      [onCashOnHand.id, 63, "GROSS_LESS_WITHHOLDING"],
    ]);
  });
});

// ---------------------------------------------------------------------------
describe("inactive bank accounts", () => {
  test("new documents are refused, for Cash as well", async () => {
    const bank = await newBank("OFF");
    await setBankStatus(bank, "INACTIVE");
    for (const method of ["Cash", "Check", "Bank Transfer"]) {
      expect((await post("or", { bank, method })).body.code).toBe("BANK_ACCOUNT_INACTIVE");
    }
  });

  test("bulk posting skips a draft whose bank account has since become inactive", async () => {
    const bank = await newBank("BULKOFF");
    const bank2 = await newBank("BULKON");
    const stale = await doc("cv", { bank, method: "Check", status: "Draft", company: "B" });
    const fine = await doc("cv", { bank: bank2, method: "Check", status: "Draft", company: "B" });
    await setBankStatus(bank, "INACTIVE");
    const res = await api("acctB", "post", "/api/posting/post", { scope: "ap" });
    expect(res.status).toBe(200);
    expect(res.body.paymentBlockedCount).toBe(1);
    expect((await one("SELECT status FROM cv_headers WHERE id = ?", [stale.id])).status).toBe("Draft");
    expect((await one("SELECT status FROM cv_headers WHERE id = ?", [fine.id])).status).toBe("Posted");
  });

  test("a document posted before deactivation stays usable: matched and confirmed in Bank Reconciliation", async () => {
    const bank = await newBank("HIST");
    const d = await doc("cv", { bank, method: "Check", checkNo: "445566", amount: 700 });
    await setBankStatus(bank, "INACTIVE");
    const sid = await newSession(bank);
    await importRows(sid, [`${DAY},Old check,,445566,700.00,,`]);
    await run(sid);
    const [c] = await candidatesOf(sid, "Old check");
    expect(c).toMatchObject({ bookSourceId: d.id, matchType: "EXACT", matchLevel: "CHECK_NO" });
    expect((await api("acctA", "post", `/api/bank-recon/matches/${c.id}/confirm`)).status).toBe(200);
  });

  test("a deposit slip cannot be edited or marked deposited once its bank account is inactive; one already deposited still reconciles", async () => {
    const bank = await newBank("SLIPOFF");
    const draftDoc = await doc("or", { bank, amount: 300 });
    const doneDoc = await doc("or", { bank, amount: 400 });
    const draft = await makeSlip(bank, DAY, [draftDoc], { deposit: false });
    const done = await makeSlip(bank, DAY, [doneDoc]);
    await setBankStatus(bank, "INACTIVE");
    expect((await api("acctA", "post", `/api/bank-recon/deposit-slips/${draft.id}/deposit`)).body.code).toBe("BANK_ACCOUNT_INACTIVE");
    expect((await api("acctA", "put", `/api/bank-recon/deposit-slips/${draft.id}`, { depositDate: DAY, items: items(draftDoc) })).body.code).toBe("BANK_ACCOUNT_INACTIVE");
    const sid = await newSession(bank);
    await importRows(sid, [`${DAY},Deposit ${done.depositNo},,,,400.00,`]);
    await run(sid);
    const [c] = await candidatesOf(sid, `Deposit ${done.depositNo}`);
    expect(c.depositSlip.depositNo).toBe(done.depositNo);
    expect((await api("acctA", "post", `/api/bank-recon/matches/${c.id}/confirm`, { expectedMatchIds: c.matchIds })).status).toBe(200);
  });

  test("a bank account in use cannot be deleted, so documents never lose it; an unused one can", async () => {
    const usedByDoc = await newBank("DELDOC");
    const d = await doc("or", { bank: usedByDoc, amount: 10 });
    let res = await api("adminB", "delete", `/api/bank-codes/${usedByDoc}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BANK_CODE_IN_USE");
    expect((await one("SELECT bank_account_id FROM or_headers WHERE id = ?", [d.id])).bank_account_id).toBe(usedByDoc);
    expect(await one("SELECT id FROM bank_codes WHERE id = ?", [usedByDoc])).toBeTruthy();

    const usedBySession = await newBank("DELSES");
    await newSession(usedBySession);
    res = await api("adminB", "delete", `/api/bank-codes/${usedBySession}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BANK_CODE_IN_USE");

    const unused = await newBank("DELFREE");
    expect((await api("adminB", "delete", `/api/bank-codes/${unused}`)).status).toBe(200);
    expect(await one("SELECT id FROM bank_codes WHERE id = ?", [unused])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe("identifiers never cross-match", () => {
  const session = { amountVarianceType: "FIXED", amountVarianceValue: 0, dateToleranceDays: 3 };
  const line = (o) => ({ debit: 0, credit: 100, txnDate: DAY, description: "x", referenceNo: "", checkNo: "", bankReference: "", ...o });
  const book = (o) => ({ amount: 100, date: DAY, voucherNo: "V-9001", referenceNo: "", receiptNo: "", checkNo: "", paymentReference: "", payeeOrCustomer: "", description: "", ...o });

  test.each([
    ["receipt number", { receiptNo: "556677" }],
    ["voucher number", { voucherNo: "556677" }],
    ["reference number", { referenceNo: "556677" }],
    ["transfer reference", { paymentMethod: "Bank Transfer", paymentReference: "556677" }],
  ])("a statement check number is no evidence for a document's %s - not even for ranking", (_label, fields) => {
    const c = scoreCandidate(line({ checkNo: "556677" }), book(fields), session);
    expect(c.matchLevel).toBe("AMOUNT_DATE");
    expect(c.matchType).toBe("SUGGESTED");
    expect(c.breakdown.identifierScore).toBe(0);
  });

  test("a partly equal statement check number is no evidence for a receipt number either", () => {
    expect(scoreCandidate(line({ checkNo: "5566770" }), book({ receiptNo: "556677" }), session).breakdown.identifierScore).toBe(0);
    expect(scoreCandidate(line({ checkNo: "5566770" }), book({ checkNo: "556677" }), session).breakdown.identifierScore).toBe(10);
    expect(scoreCandidate(line({ referenceNo: "5566770" }), book({ receiptNo: "556677" }), session).breakdown.identifierScore).toBe(10);
  });

  test("check number -> check evidence, including from the reference columns where banks often print it", () => {
    for (const fields of [{ checkNo: "000123" }, { referenceNo: "123" }, { bankReference: "123" }]) {
      expect(scoreCandidate(line(fields), book({ paymentMethod: "Check", checkNo: "000123" }), session).matchLevel).toBe("CHECK_NO");
    }
  });

  test("transfer reference -> transfer evidence; receipt number -> document evidence only", () => {
    const transfer = scoreCandidate(line({ referenceNo: "FT-4411" }), book({ paymentMethod: "Bank Transfer", paymentReference: "FT-4411" }), session);
    expect(transfer).toMatchObject({ matchLevel: "REFERENCE", breakdown: { evidence: "TRANSFER_REFERENCE" } });
    const receipt = scoreCandidate(line({ referenceNo: "556677" }), book({ receiptNo: "556677" }), session);
    expect(receipt.matchLevel).toBe("REFERENCE");
    expect(receipt.breakdown.evidence).toBeUndefined();
  });

  test("combinations look for receipt numbers in the statement text, not in its check column", () => {
    const text = statementText(line({ description: "Deposit", referenceNo: "REF-1", bankReference: "BR-2", checkNo: "556677" }));
    expect(text).toContain("ref-1");
    expect(text).toContain("br-2");
    expect(text).not.toContain("556677");
  });

  test("a check number in the statement's check column does not make a combination name a receipt", async () => {
    const bank = await newBank("COMBO");
    await doc("or", { bank, amount: 300, receiptNo: "770011" });
    await doc("or", { bank, amount: 200, receiptNo: "770022" });
    const sid = await newSession(bank);
    await importRows(sid, [`${DAY},Counter deposit,,770011 770022,,500.00,`]);
    await run(sid);
    const [c] = await candidatesOf(sid, "Counter deposit");
    expect(c.group).toBe(true);
    expect(c.explanation).toMatch(/Only the amounts add up/);
  });

  test("an explanation names the identifier that matched, also when only the bank-reference column has it", async () => {
    const bank = await newBank("EXPL");
    await doc("cv", { bank, method: "Bank Transfer", paymentReference: "IB-66120", amount: 910 });
    await doc("cv", { bank, method: "Check", checkNo: "778899", amount: 920 });
    const sid = await newSession(bank);
    await importRows(sid, [`${DAY},Transfer out,,,910.00,,IB-66120`, `${DAY},Check out,,,920.00,,778899`]);
    await run(sid);
    const [transfer] = await candidatesOf(sid, "Transfer out");
    expect(transfer.matchLevel).toBe("REFERENCE");
    expect(transfer.explanation).toContain("reference IB-66120 for");
    const [check] = await candidatesOf(sid, "Check out");
    expect(check.matchLevel).toBe("CHECK_NO");
    expect(check.explanation).toContain("check 778899 for");
  });

  test("the statement names a deposit slip only by its whole number", () => {
    const named = (o) => namesSlip(line(o), "DS-00125");
    for (const o of [{ description: "Deposit DS-00125" }, { description: "DEP DS00125 BDO" }, { description: "DS 125" }, { description: "ds125" }, { referenceNo: "00125" }, { referenceNo: "125" }, { bankReference: "DS-00125" }]) {
      expect([o, named(o)]).toEqual([o, true]);
    }
    for (const o of [{ description: "FUNDS 125" }, { description: "CARDS 00125" }, { description: "DS-001250" }, { description: "DS1250" }, { description: "DS-00125A" }, { referenceNo: "1250" }, { checkNo: "DS-00125" }, { checkNo: "125" }]) {
      expect([o, named(o)]).toEqual([o, false]);
    }
  });
});

// ---------------------------------------------------------------------------
describe("deposit slips", () => {
  test("only this company's posted Cash / Check documents of this bank account can enter a slip", async () => {
    const bank = await newBank("ELIG");
    const other = await newBank("ELIG2");
    const fine = await doc("or", { bank, amount: 11 });
    const refuse = async (d, code) => {
      const res = await createSlip("acctA", { bankAccountId: bank, depositDate: DAY, items: items(fine, d) });
      expect([res.body.code]).toEqual([code]);
    };
    await refuse(await doc("or", { bank, amount: 12, company: "B" }), "DEPOSIT_ITEM_NOT_FOUND");
    await refuse(await doc("or", { bank: other, amount: 13 }), "DEPOSIT_ITEM_NOT_ELIGIBLE");
    await refuse(await doc("or", { bank, amount: 14, method: "Bank Transfer" }), "DEPOSIT_ITEM_NOT_ELIGIBLE");
    await refuse(await doc("or", { bank, amount: 15, status: "Draft" }), "DEPOSIT_ITEM_NOT_ELIGIBLE");
    await refuse(await doc("or", { amount: 16 }), "DEPOSIT_ITEM_NOT_ELIGIBLE");
    await refuse(await doc("or", { bank, amount: 17, date: "2099-04-01" }), "DEPOSIT_ITEM_NOT_ELIGIBLE");
    await refuse(await doc("cv", { bank, amount: 18 }), "DEPOSIT_ITEM_NOT_ELIGIBLE");
    expect((await createSlip("acctA", { bankAccountId: bank, depositDate: DAY, items: items(fine) })).status).toBe(200);
  });

  test("receipts on a deposited slip are not offered alone or in a combination", async () => {
    const bank = await newBank("NODOUBLE");
    const a = await doc("or", { bank, amount: 3000 });
    const b = await doc("or", { bank, amount: 2000 });
    const slip = await makeSlip(bank, DAY, [a, b]);
    const sid = await newSession(bank);
    await importRows(sid, [`${DAY},Single deposit,,,,3000.00,`, `${DAY},Whole deposit,,,,5000.00,`]);
    await run(sid);
    expect(await candidatesOf(sid, "Single deposit")).toEqual([]);
    const whole = await candidatesOf(sid, "Whole deposit");
    expect(whole.map((c) => c.depositSlip?.depositNo)).toEqual([slip.depositNo]);
  });

  test("receipts of a slip that can no longer match stay out of single and combination proposals too", async () => {
    const bank = await newBank("BROKEN");
    const a = await doc("or", { bank, amount: 800 });
    const b = await doc("or", { bank, amount: 600 });
    const c = await doc("or", { bank, amount: 400 });
    await makeSlip(bank, DAY, [a, b, c]);
    await q("UPDATE or_headers SET status = 'Draft' WHERE id = ?", [c.id]);
    const sid = await newSession(bank);
    await importRows(sid, [`${DAY},Part deposit,,,,800.00,`, `${DAY},Part sum,,,,1400.00,`]);
    await run(sid);
    expect(await candidatesOf(sid, "Part deposit")).toEqual([]);
    expect(await candidatesOf(sid, "Part sum")).toEqual([]);
  });

  test("a statement description that merely contains the digits does not claim a slip", async () => {
    const bank = await newBank("FUNDS");
    const a = await doc("or", { bank, amount: 2500, date: "2099-01-05" });
    const slip = await makeSlip(bank, "2099-01-10", [a]);
    const digits = Number(slip.depositNo.replace("DS-", ""));
    const sid = await newSession(bank);
    // far outside the slip's deposit date window, so only a false "named" could propose it
    await importRows(sid, [`${DAY},FUNDS ${digits},,,,2500.00,`]);
    await run(sid);
    expect((await candidatesOf(sid, `FUNDS ${digits}`)).filter((c) => c.depositSlip)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("scripts/r11BankPaymentAudit.sql", () => {
  const raw = (name) => fs.readFileSync(path.join(__dirname, "..", "scripts", name), "utf8");
  const split = (sql) => sql.replace(/^--.*$/gm, "").split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean);
  const statements = () => split(raw("r11BankPaymentAudit.sql"));

  test.each(["r11BankPaymentAudit.sql", "r9PaymentFieldAudit.sql"])("%s is read-only, runs, and is not a migration", async (name) => {
    const list = split(raw(name));
    expect(list.length).toBeGreaterThanOrEqual(8);
    for (const s of list) {
      expect(s).toMatch(/^SELECT /);
      expect(s).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|REPLACE|GRANT|SET)\b/);
      await q(s);
    }
    expect(MIGRATION_ORDER).not.toContain(name);
  });

  test("selects no bank account numbers or party names", () => {
    const sql = statements().join("\n");
    expect(sql).not.toMatch(/customer_name|payee_name/);
    expect(sql).not.toMatch(/bc\.account_no\s*(,|AS\b|FROM\b)/);
  });

  test("Part 1 uses nothing a database on the pushed code lacks", () => {
    const part1 = raw("r11BankPaymentAudit.sql").split("-- PART 1:")[1].split("-- PART 2:")[0].replace(/^--.*$/gm, "");
    expect(part1).not.toMatch(/s\.company_id|payment_reference|payment_date|deposit_slip|match_group|bank_reference/);
  });

  test("runs and finds each kind of problem it describes", async () => {
    const bank = await newBank("AUDIT");
    const off = await newBank("AUDITOFF");
    const nogl = (await q("INSERT INTO bank_codes (bank_code, bank_name, account_no, account_name, status) VALUES (?, 'R11', '1', 'R11', 'ACTIVE')", [`${P}NOGL`])).insertId;
    banks.push(nogl);

    const shared = await doc("or", { bank, amount: 21, company: "B" });
    const dangling = await doc("or", { bank, amount: 22, status: "Draft" });
    await q("UPDATE or_headers SET bank_account_id = 2147483000 WHERE id = ?", [dangling.id]);
    const onOff = await doc("or", { bank: off, amount: 23 });
    await setBankStatus(off, "INACTIVE");
    await doc("or", { bank: nogl, gl: acct.CASH, amount: 24 });
    const noLine = await doc("or", { bank, gl: acct.CASH, amount: 25, method: "Check" });
    const glOnly = await doc("or", { gl: bankCoa[bank], amount: 26 });
    const cashCheck = await doc("or", { amount: 27, receiptNo: "1002003" });
    const twice = await doc("or", { bank, amount: 28, method: "Check", checkNo: "990088", receiptNo: "990088" });
    const mangled = await doc("cv", { bank, amount: 29, method: "Check", checkNo: "123.0" });
    await doc("cv", { bank, amount: 30, method: "Check", checkNo: "0990088" });
    const noRef = await doc("or", { bank, amount: 31, method: "Bank Transfer" });
    await q("UPDATE or_headers SET payment_reference = NULL WHERE id = ?", [noRef.id]);
    const stale = await doc("or", { bank, amount: 32, method: "Bank Transfer" });
    await q("UPDATE or_headers SET check_no = '555' WHERE id = ?", [stale.id]);

    const slipBank = await newBank("AUDITSLIP");
    const leftSlip = await doc("or", { bank: slipBank, amount: 33 });
    const onHand = await doc("or", { bank: slipBank, gl: acct.CASH, amount: 34 });
    const s1 = await makeSlip(slipBank, DAY, [leftSlip, onHand]);
    await q("UPDATE or_headers SET status = 'Draft' WHERE id = ?", [leftSlip.id]);
    await q("UPDATE deposit_slips SET total_amount = 1 WHERE id = ?", [s1.id]);

    const matchBank = await newBank("AUDITMATCH");
    const voided = await doc("cv", { bank: matchBank, amount: 35, method: "Check", checkNo: "334455" });
    const sid = await newSession(matchBank);
    await importRows(sid, [`${DAY},Audit check,,334455,35.00,,`]);
    await run(sid);
    const [c] = await candidatesOf(sid, "Audit check");
    await api("acctA", "post", `/api/bank-recon/matches/${c.id}/confirm`);
    await q("UPDATE cv_headers SET status = 'Void' WHERE id = ?", [voided.id]);

    await doc("or", { bank, amount: 36 }); // second company on the shared bank

    const cashBank = await newBank("AUDITCASH");
    const reconciledCash = await doc("or", { bank: cashBank, gl: acct.CASH, amount: 37 });
    const cashSid = await newSession(cashBank);
    await importRows(cashSid, [`${DAY},Audit cash,,,,37.00,`]);
    await run(cashSid);
    const [cashMatch] = await candidatesOf(cashSid, "Audit cash");
    expect((await api("acctA", "post", `/api/bank-recon/matches/${cashMatch.id}/confirm`)).status).toBe(200);

    // a "bank" that is really a cash-on-hand GL, as Sync from COA creates it
    const coh = { id: (await q("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), 'R11 Petty Cash', 'ASSET')", [`${P}COH`])).insertId, code: `${P}COH`, title: "R11 Petty Cash" };
    await q("INSERT INTO coa_validations (coa_id, validation_name) VALUES (?, 'BANK / CASH')", [coh.id]);
    const cohBank = (await q("INSERT INTO bank_codes (bank_code, bank_name, account_no, account_name, coa_account_id, coa_code, status) VALUES (?, 'R11', '', 'R11', ?, ?, 'ACTIVE')", [`${P}COHB`, coh.id, coh.code])).insertId;
    banks.push(cohBank);
    const cashOnBankCode = await doc("or", { bank: cohBank, gl: coh, amount: 38 });
    const found = {};
    for (const s of statements()) {
      const rows = await q(s);
      const id = s.match(/^SELECT '(R11-\d+)'/)[1];
      found[id] = rows;
    }
    const has = (id, where) => expect([id, found[id].some(where)]).toEqual([id, true]);
    has("R11-00", (r) => r.part2_session_company === 1 && r.part3_r9_columns === 1 && r.part4_deposit_slips === 1);
    has("R11-01", (r) => r.bank_account_id === bank && r.companies_using === 2 && r.gl_code === bankCoa[bank].code && r.no_account_number === 0);
    has("R11-02", (r) => r.bank_account_id === bank && r.company_id === co.B && r.records >= 1 && shared.id);
    has("R11-03", (r) => r.doc === "OR" && r.id === dangling.id);
    has("R11-04", (r) => r.bank_account_id === off && r.posted_documents >= 1 && onOff.id);
    has("R11-05", (r) => r.bank_account_id === nogl);
    has("R11-06", (r) => r.doc === "OR" && r.id === noLine.id && r.status === "Posted" && r.payment_method === "Check" && r.header_bank_account_id === bank && r.company_id === co.A);
    has("R11-07", (r) => r.doc === "OR" && r.id === glOnly.id && r.status === "Posted" && r.payment_method === "Cash" && r.header_bank_account_id === null && r.gl_bank_account_id === bank && r.gl_bank_code === `${P}AUDIT`);
    has("R11-14", (r) => r.company_id === co.B && r.bank_account_id === bank && r.company_name === `${P}Co B` && Number(r.posted_or) >= 1);
    has("R11-15", (r) => r.doc === "OR" && r.id === shared.id && r.bank_account_id === bank && r.company_id === co.B);
    has("R11-16", (r) => r.company_id === co.A && r.doc === "OR" && r.status === "Posted"
      && Number(r.no_bank_account) >= 1 && Number(r.with_bank_account) >= 1 && Number(r.bank_linked_to_gl) >= 1 && Number(r.line_on_bank_gl) >= 1
      && Number(r.no_line_on_bank_gl) >= 1 && Number(r.no_line_amount) >= 34 && Number(r.confirmed_in_bank_recon) >= 1);
    has("R11-17", (r) => r.doc === "OR" && r.id === onHand.id && r.situation === "NO_LINE_ON_BANK_GL");
    has("R11-17", (r) => r.doc === "OR" && r.id === cashOnBankCode.id && r.situation === "BANK_CODE_WITHOUT_ACCOUNT_NO" && r.bank_cash_gl === `${P}COH`);
    has("R11-18", (r) => r.doc === "OR" && r.id === reconciledCash.id && r.match_status === "CONFIRMED" && r.session_id === cashSid);
    has("R11-19", (r) => r.bank_account_id === cashBank && r.payment_method === "Cash" && r.documents === 1 && Number(r.reconciled_amount) === 37);
    has("R11-22", (r) => r.company_id === co.A && r.bank_account_id === cashBank && r.recon_sessions === 1);
    has("R11-33", (r) => r.company_id === co.A && r.slip_status === "DEPOSITED" && Number(r.no_line_on_bank_gl) >= 1);
    has("R11-34", (r) => r.company_id === co.A && r.bank_account_id === slipBank && r.slip_status === "DEPOSITED" && r.slips === 1);
    has("R11-08", (r) => r.id === cashCheck.id);
    has("R11-09", (r) => r.id === twice.id);
    has("R11-10", (r) => r.doc === "CV" && r.id === mangled.id);
    has("R11-11", (r) => r.bank_account_id === bank && r.normalized_check_no === "990088" && r.documents === 2);
    has("R11-13", (r) => r.doc === "CV" && r.id === voided.id);
    has("R11-20", (r) => r.doc === "OR" && r.id === noRef.id);
    has("R11-21", (r) => r.doc === "OR" && r.id === stale.id);
    has("R11-30", (r) => r.slip_id === s1.id && r.document_id === leftSlip.id);
    has("R11-31", (r) => r.slip_id === s1.id);
    has("R11-32", (r) => r.slip_id === s1.id && r.document_id === onHand.id);
    expect(found["R11-12"]).toBeDefined();
  });
});
