// Public invoice QR verification - end-to-end through the REAL issuance flow
// (POST /api/invoices / PUT /api/invoices/:id mint and re-sign the signature;
// nothing in this file signs database-read values itself, except QR-008,
// which reproduces a PRE-FIX legacy signature on purpose).
// Local test database only. Fixture prefix UAT-QR-.
const crypto = require("crypto");
const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const InvoiceVerificationService = require("../services/invoiceVerificationService");

jest.setTimeout(180000);

const P = "UAT-QR-";
const COMPANY_NAME = "UAT-QR- Verification Co";
const USER = "uat-qr-admin";
const PASS = "UatQrPass!2026";
let companyId, userId, token, arId, revId, custId;

const auth = () => ({ Authorization: `Bearer ${token}` });

async function cleanup() {
  const [cos] = await pool.query("SELECT id FROM companies WHERE name = ?", [COMPANY_NAME]);
  const ids = cos.map((c) => c.id);
  const [us] = await pool.query("SELECT id FROM users WHERE username = ?", [USER]);
  const uids = us.map((u) => u.id);
  if (ids.length) {
    const [cur] = await pool.query("SELECT id FROM currencies WHERE company_id IN (?)", [ids]);
    const curIds = cur.map((c) => c.id);
    await pool.query("DELETE FROM audit_logs WHERE company_id IN (?)", [ids]);
    await pool.query("DELETE FROM audit_logs WHERE module = 'PUBLIC.INVOICE_VERIFICATION' AND entity_id IN (SELECT id FROM invoice_headers WHERE company_id IN (?))", [ids]);
    await pool.query("DELETE FROM transaction_tax_entries WHERE transaction_type = 'INV' AND transaction_id IN (SELECT id FROM invoice_headers WHERE company_id IN (?))", [ids]);
    if (curIds.length) await pool.query("DELETE FROM transaction_currency_snapshots WHERE currency_id IN (?) OR base_currency_id IN (?)", [curIds, curIds]);
    await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id IN (?)", [ids]);
    await pool.query("DELETE FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoice_headers WHERE company_id IN (?))", [ids]);
    await pool.query("DELETE FROM invoice_headers WHERE company_id IN (?)", [ids]);
    await pool.query("DELETE FROM currencies WHERE company_id IN (?)", [ids]);
    await pool.query("DELETE FROM general_libraries WHERE company_id IN (?)", [ids]);
  }
  if (uids.length) {
    await pool.query("DELETE FROM audit_logs WHERE user_id IN (?)", [uids]);
    await pool.query("DELETE FROM user_permissions WHERE user_id IN (?)", [uids]);
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [uids]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [uids]);
  }
  if (ids.length) await pool.query("DELETE FROM companies WHERE id IN (?)", [ids]);
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'UAT-QR-%'");
}

beforeAll(async () => {
  assertNotProductionDatabase();
  await cleanup();
  const [c] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [COMPANY_NAME]);
  companyId = c.insertId;
  const [u] = await pool.execute("INSERT INTO users (username, password, role_id, status) VALUES (?, ?, 2, 'ACTIVE')", [USER, await bcrypt.hash(PASS, 10)]);
  userId = u.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, companyId]);
  const login = await request(app).post("/api/login").send({ username: USER, password: PASS });
  if (login.status !== 200) throw new Error(`login failed ${login.status}`);
  token = login.body.token;
  const acct = async (code, title, cls) => (await pool.execute("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)", [code, title, cls]))[0].insertId;
  arId = await acct(`${P}AR`, "UAT-QR AR", "ASSET");
  revId = await acct(`${P}REV`, "UAT-QR Revenue", "INCOME");
  custId = (await pool.execute("INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, ?, 'CUSTOMER', 'UAT-QR Customer', 'ACTIVE')", [companyId, `${P}CUST`]))[0].insertId;
  await require("../services/currencyService").createCurrency({ id: userId, roleCode: "ADMIN" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId,
  });
});

afterAll(async () => {
  try { await cleanup(); } finally { await pool.end(); }
});

// Exactly the payload shape the Invoice form sends (numeric JS totals).
function invoiceBody(voucherNo, amount, status = "Posted", date = "2026-11-20") {
  return {
    voucherNo, customerId: custId, customerName: "UAT-QR Customer", transactionDate: date, dueDate: date,
    status, totalDebit: amount, totalCredit: amount, currency: { companyId },
    lines: [
      { accountId: arId, accountCode: `${P}AR`, accountTitle: "AR", particulars: "qr", debit: amount, credit: 0, genRef: "", genName: "" },
      { accountId: revId, accountCode: `${P}REV`, accountTitle: "Revenue", particulars: "qr", debit: 0, credit: amount, genRef: "", genName: "" },
    ],
  };
}
async function createInvoice(voucherNo, amount, status) {
  const res = await request(app).post("/api/invoices").set(auth()).send(invoiceBody(voucherNo, amount, status));
  if (res.status !== 200) throw new Error(`create ${voucherNo} failed ${res.status} ${JSON.stringify(res.body)}`);
  const [[row]] = await pool.query("SELECT id, verification_token t, verification_signature s, total_debit td, status FROM invoice_headers WHERE id = ?", [res.body.id]);
  return row;
}
const verify = (t) => request(app).get(`/api/verify/${t}`); // never sets Authorization
async function withRow(id, sqlSet, params, fn) {
  // Simulates out-of-band tampering of the persisted row, then restores it.
  const [[orig]] = await pool.query("SELECT voucher_no, transaction_date, customer_id, customer_name, total_debit, total_credit, currency_id, company_id, verification_signature FROM invoice_headers WHERE id = ?", [id]);
  await pool.query(`UPDATE invoice_headers SET ${sqlSet} WHERE id = ?`, [...params, id]);
  try { await fn(); } finally {
    await pool.query(
      "UPDATE invoice_headers SET voucher_no=?, transaction_date=?, customer_id=?, customer_name=?, total_debit=?, total_credit=?, currency_id=?, company_id=?, verification_signature=? WHERE id = ?",
      [orig.voucher_no, orig.transaction_date, orig.customer_id, orig.customer_name, orig.total_debit, orig.total_credit, orig.currency_id, orig.company_id, orig.verification_signature, id]
    );
  }
}

let inv; // the 9000 posted invoice
describe("QR public verification via the real issuance flow", () => {
  test("QR-001 a normally posted invoice (9000, numeric request totals) verifies VALID with matching totals", async () => {
    inv = await createInvoice(`${P}INV-0001`, 9000, "Posted");
    expect(inv.status).toBe("Posted");
    expect(inv.td).toBe("9000.00"); // stored value unchanged
    expect(inv.t).toMatch(/^[a-f0-9]{32}$/);
    expect(inv.s).toMatch(/^[a-f0-9]{64}$/);
    const v = await verify(inv.t);
    expect(v.status).toBe(200);
    expect(v.body).toEqual({ status: "valid", issuerName: COMPANY_NAME, invoiceDate: "2026-11-20", totalAmount: 9000 });
    const detail = await request(app).get(`/api/invoices/${inv.id}`).set(auth());
    expect(Number(detail.body.totalDebit ?? detail.body.header?.totalDebit ?? detail.body.total_debit)).toBe(9000);
  });

  test("QR-002 / QR-007 other amount shapes issued through the form all verify", async () => {
    for (const [n, amt] of [["0002", 100.5], ["0003", 1000.1], ["0004", 1000000], ["0005", 0.01]]) {
      const row = await createInvoice(`${P}INV-${n}`, amt, "Posted");
      const v = await verify(row.t);
      expect(v.body.status).toBe("valid");
      expect(v.body.totalAmount).toBe(amt);
    }
  });

  test("a Draft invoice edited (PUT re-sign) and then posted still verifies", async () => {
    const draft = await createInvoice(`${P}INV-0006`, 500, "Draft");
    const put = await request(app).put(`/api/invoices/${draft.id}`).set(auth()).send(invoiceBody(`${P}INV-0006`, 750.25, "Posted"));
    expect(put.status).toBe(200);
    const [[after]] = await pool.query("SELECT verification_token t, total_debit td, status FROM invoice_headers WHERE id = ?", [draft.id]);
    expect(after.t).toBe(draft.t); // same token, re-signed
    expect(after.td).toBe("750.25");
    const v = await verify(after.t);
    expect(v.body).toMatchObject({ status: "valid", totalAmount: 750.25 });
  });

  test("QR-003 a different amount fails", async () => {
    await withRow(inv.id, "total_debit = ?, total_credit = ?", ["9000.01", "9000.01"], async () => {
      expect((await verify(inv.t)).body).toEqual({ status: "invalid" });
    });
    await withRow(inv.id, "total_debit = ?", ["90000.00"], async () => {
      expect((await verify(inv.t)).body).toEqual({ status: "invalid" });
    });
  });

  test("QR-004 a different invoice number fails", async () => {
    await withRow(inv.id, "voucher_no = ?", [`${P}INV-9999`], async () => {
      expect((await verify(inv.t)).body).toEqual({ status: "invalid" });
    });
  });

  test("QR-005 a tampered signature fails", async () => {
    const flipped = inv.s.slice(0, -1) + (inv.s.endsWith("0") ? "1" : "0");
    await withRow(inv.id, "verification_signature = ?", [flipped], async () => {
      expect((await verify(inv.t)).body).toEqual({ status: "invalid" });
    });
    // and a tampered token (different random token) is simply unknown
    expect((await verify(crypto.randomBytes(16).toString("hex"))).body).toEqual({ status: "invalid" });
  });

  test("QR-006 tampered date / customer / name / currency / company fail", async () => {
    const [[other]] = await pool.query("SELECT id FROM companies WHERE id <> ? ORDER BY id LIMIT 1", [companyId]);
    const cases = [
      ["transaction_date = ?", ["2026-11-21"]],
      ["customer_id = ?", [custId + 100000]],
      ["customer_name = ?", ["UAT-QR Customer."]],
      ["currency_id = NULL", []],
      ...(other ? [["company_id = ?", [other.id]]] : []),
    ];
    for (const [set, params] of cases) {
      await withRow(inv.id, set, params, async () => {
        expect((await verify(inv.t)).body).toEqual({ status: "invalid" });
      });
    }
    // and restored -> valid again (restoration proves nothing else changed)
    expect((await verify(inv.t)).body.status).toBe("valid");
  });

  test("volatile fields (payment status / balance / remarks) do not invalidate", async () => {
    const [[orig]] = await pool.query("SELECT paid_amount, balance_amount, remarks FROM invoice_headers WHERE id = ?", [inv.id]);
    await pool.query("UPDATE invoice_headers SET paid_amount = 1000, balance_amount = 8000, remarks = 'qr volatile' WHERE id = ?", [inv.id]);
    try {
      expect((await verify(inv.t)).body.status).toBe("valid");
    } finally {
      await pool.query("UPDATE invoice_headers SET paid_amount = ?, balance_amount = ?, remarks = ? WHERE id = ?", [orig.paid_amount, orig.balance_amount, orig.remarks, inv.id]);
    }
  });

  test("QR-008 an invoice signed by the PRE-FIX issuance (legacy v1) still verifies; tampering still fails", async () => {
    const legacy = await createInvoice(`${P}INV-0008`, 1000.1, "Posted");
    const [[h]] = await pool.query("SELECT voucher_no, DATE_FORMAT(transaction_date,'%Y-%m-%d') d, customer_id, customer_name, currency_id, company_id FROM invoice_headers WHERE id = ?", [legacy.id]);
    // Byte-for-byte what the pre-fix POST /api/invoices signed: request-derived
    // values with the totals as the JS number currencyResult produced.
    const preFix = { voucherNo: h.voucher_no, transactionDate: h.d, customerId: h.customer_id, customerName: h.customer_name,
      totalDebit: 1000.1, totalCredit: 1000.1, currencyId: h.currency_id, companyId: h.company_id, verificationToken: legacy.t };
    const ordered = {};
    for (const k of InvoiceVerificationService.PROTECTED_FIELDS) ordered[k] = preFix[k] ?? null;
    const legacySig = crypto.createHmac("sha256", process.env.HMAC_SECRET).update(JSON.stringify(ordered)).digest("hex");
    await pool.query("UPDATE invoice_headers SET verification_signature = ? WHERE id = ?", [legacySig, legacy.id]);

    expect((await verify(legacy.t)).body).toMatchObject({ status: "valid", totalAmount: 1000.1 });
    expect(InvoiceVerificationService.classifyInvoice(await InvoiceVerificationService.findByToken(legacy.t))).toEqual({ valid: true, reason: "valid_legacy" });
    await withRow(legacy.id, "total_debit = ?", ["1000.11"], async () => {
      expect((await verify(legacy.t)).body).toEqual({ status: "invalid" });
    });
    // the legacy signature was never silently rewritten
    const [[still]] = await pool.query("SELECT verification_signature s FROM invoice_headers WHERE id = ?", [legacy.id]);
    expect(still.s).toBe(legacySig);
  });

  test("QR-009 verification is unauthenticated; voided invoices are invalid", async () => {
    const res = await request(app).get(`/api/verify/${inv.t}`); // no Authorization, no cookie
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("valid");
    const [[o]] = await pool.query("SELECT status FROM invoice_headers WHERE id = ?", [inv.id]);
    await pool.query("UPDATE invoice_headers SET status = 'Void' WHERE id = ?", [inv.id]);
    try {
      expect((await verify(inv.t)).body).toEqual({ status: "invalid" });
    } finally {
      await pool.query("UPDATE invoice_headers SET status = ? WHERE id = ?", [o.status, inv.id]);
    }
    expect((await verify("not-a-token")).body).toEqual({ status: "invalid" });
  });

  test("QR-010 no sensitive data leaks in the public response or the audit trail", async () => {
    const ok = await verify(inv.t);
    expect(Object.keys(ok.body).sort()).toEqual(["invoiceDate", "issuerName", "status", "totalAmount"]);
    const text = JSON.stringify(ok.body);
    for (const secret of [inv.s, inv.t, String(inv.id), "UAT-QR Customer", `${P}INV-0001`, process.env.HMAC_SECRET]) {
      expect(text).not.toContain(secret);
    }
    let bad;
    await withRow(inv.id, "total_debit = ?", ["1.00"], async () => { bad = await verify(inv.t); });
    expect(bad.body).toEqual({ status: "invalid" }); // altered looks identical to unknown
    const [audit] = await pool.query("SELECT CONCAT_WS(' ', description, IFNULL(CAST(before_data AS CHAR),''), IFNULL(CAST(after_data AS CHAR),'')) x FROM audit_logs WHERE module = 'PUBLIC.INVOICE_VERIFICATION' AND entity_id = ?", [inv.id]);
    expect(audit.length).toBeGreaterThan(0);
    const all = audit.map((a) => a.x).join("\n");
    expect(all).toMatch(/result=valid/);
    expect(all).toMatch(/result=altered/);
    expect(all).not.toContain(inv.s);
    expect(all).not.toContain(inv.t);
    expect(all).not.toContain(process.env.HMAC_SECRET);
  });
});
