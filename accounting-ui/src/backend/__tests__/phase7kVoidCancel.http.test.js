const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const CurrencyService = require("../services/currencyService");

// Phase 7K: explicit APV/CV Cancel (Draft -> Cancelled) and Void
// (Posted -> Void). Recognition is status-driven, so a Cancelled/Void
// header keeps every row/line/tax entry it had. CV cancel/void also unwinds
// its settlement (transaction_applications + APV/AP_BEGINNING balances).

jest.setTimeout(200000);

let CO, userId, token, noPermUserId, noPermToken;
let expId, apId, ivatId, ewtPayId, cashId, arId;
let suppId;
const ATC = "PH7K-WC010";

async function mkAcc(code, title, cls) {
  const [r] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, cls]
  );
  return r.insertId;
}

beforeAll(async () => {
  assertNotProductionDatabase();
  const [c] = await pool.execute("INSERT INTO companies (name, status) VALUES ('PH7K Co', 'Active')");
  CO = c.insertId;
  const hash = await bcrypt.hash("Ph7kPass!1", 10);
  const [u] = await pool.execute("INSERT INTO users (username, password, role_id, status) VALUES ('ph7k_admin', ?, 2, 'ACTIVE')", [hash]);
  userId = u.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, CO]);
  token = (await request(app).post("/api/login").send({ username: "ph7k_admin", password: "Ph7kPass!1" })).body.token;

  const [role] = await pool.execute("INSERT INTO roles (code, name, is_system) VALUES ('PH7K_NOPERM', 'PH7K No Perm', 0)");
  const [nu] = await pool.execute("INSERT INTO users (username, password, role_id, status) VALUES ('ph7k_noperm', ?, ?, 'ACTIVE')", [hash, role.insertId]);
  noPermUserId = nu.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [noPermUserId, CO]);
  // give the no-perm user VIEW-ish access is unnecessary; login is enough
  noPermToken = (await request(app).post("/api/login").send({ username: "ph7k_noperm", password: "Ph7kPass!1" })).body.token;

  await CurrencyService.createCurrency({ id: userId, roleCode: "ADMIN" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "P",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: CO,
  });
  expId = await mkAcc("PH7K-EXP", "Purchases Expense", "EXPENSE");
  apId = await mkAcc("PH7K-AP", "Accounts Payable", "LIABILITY");
  ivatId = await mkAcc("PH7K-IVAT", "Input VAT Receivable", "ASSET");
  ewtPayId = await mkAcc("PH7K-EWTP", "Withholding Tax Payable", "LIABILITY");
  cashId = await mkAcc("PH7K-CASH", "Cash in Bank", "ASSET");
  arId = await mkAcc("PH7K-AR", "Accounts Receivable", "ASSET");
  const [p] = await pool.execute("INSERT INTO general_libraries (company_id, code, party_type, name, status, tin) VALUES (?, 'PH7K-S', 'SUPPLIER', 'PH7K Supplier', 'ACTIVE', '111-222-333-000')", [CO]);
  suppId = p.insertId;
  await pool.execute("INSERT INTO ewt_library (atc_code, description, rate, tax_type, status) VALUES (?, 'PH7K fixture', 10, 'EWT', 'ACTIVE')", [ATC]);
});

afterAll(async () => {
  await pool.query("DELETE FROM transaction_tax_entries WHERE company_id = ?", [CO]);
  await pool.query("DELETE ln FROM apv_lines ln JOIN apv_headers h ON h.id = ln.apv_id WHERE h.company_id = ?", [CO]);
  await pool.query("DELETE ln FROM cv_lines ln JOIN cv_headers h ON h.id = ln.cv_id WHERE h.company_id = ?", [CO]);
  await pool.query("DELETE FROM transaction_applications WHERE applied_id IN (SELECT id FROM cv_headers WHERE company_id = ?)", [CO]);
  await pool.query("DELETE FROM apv_headers WHERE company_id = ?", [CO]);
  await pool.query("DELETE FROM cv_headers WHERE company_id = ?", [CO]);
  await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id = ?", [CO]);
  await pool.query("DELETE FROM accounting_periods WHERE company_id = ?", [CO]);
  await pool.query("DELETE FROM audit_logs WHERE entity_id IN (SELECT id FROM apv_headers WHERE company_id = ?)", [CO]);
  await pool.query("DELETE FROM general_libraries WHERE company_id = ?", [CO]);
  await pool.query("DELETE FROM currencies WHERE company_id = ?", [CO]);
  await pool.query("DELETE FROM user_companies WHERE user_id IN (?, ?)", [userId, noPermUserId]);
  await pool.query("DELETE FROM users WHERE id IN (?, ?)", [userId, noPermUserId]);
  await pool.query("DELETE FROM roles WHERE code = 'PH7K_NOPERM'");
  await pool.query("DELETE FROM companies WHERE id = ?", [CO]);
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'PH7K-%'");
  await pool.query("DELETE FROM ewt_library WHERE atc_code = ?", [ATC]);
  await pool.end();
});

const authH = (t = token) => ({ Authorization: `Bearer ${t}` });
const gl = (accountId, code, debit, credit) => ({
  accountId, accountCode: code, accountTitle: code, particulars: "x", genRef: "", genName: "", debit, credit,
});

let seq = 0;
function apvBody({ status = "Draft", withVatEwt = false, gross = 11200 } = {}) {
  const v = `PH7K-APV-${++seq}`;
  const lines = withVatEwt
    ? [
        gl(expId, "PH7K-EXP", 10000, 0),
        {
          accountId: ivatId, accountCode: "PH7K-IVAT", accountTitle: "Input VAT Receivable", particulars: "Input VAT",
          genRef: "", genName: "", debit: 1200, credit: 0,
          taxEntry: {
            entryType: "INPUT_VAT", accountId: ivatId, partyId: suppId, partyName: "PH7K Supplier", partyTin: "111-222-333-000",
            partyAddress: "M", transactionDate: "2026-11-20", grossAmount: 11200, netAmount: 10000, vatRate: 12,
            vatAmount: 1200, vatTreatment: "STANDARD", vatCode: null, purchaseClassification: "Services", vatEntryMode: "EXCLUSIVE",
          },
        },
        {
          accountId: ewtPayId, accountCode: "PH7K-EWTP", accountTitle: "Withholding Tax Payable", particulars: `EWT - ${ATC}`,
          genRef: "", genName: "", debit: 0, credit: 1000,
          taxEntry: {
            entryType: "EWT", accountId: ewtPayId, partyId: suppId, partyName: "PH7K Supplier", partyTin: "111-222-333-000",
            partyAddress: "M", transactionDate: "2026-11-20", atcCode: ATC, taxType: "EWT", taxableBase: 10000, withheldAmount: 1000,
          },
        },
        gl(apId, "PH7K-AP", 0, 10200),
      ]
    : [gl(expId, "PH7K-EXP", gross, 0), gl(apId, "PH7K-AP", 0, gross)];
  return {
    voucherNo: v, supplierId: suppId, supplierName: "PH7K Supplier", transactionDate: "2026-11-20",
    referenceNo: v, description: "ph7k", status, totalDebit: withVatEwt ? 11200 : gross, totalCredit: withVatEwt ? 11200 : gross,
    currency: { companyId: CO }, lines,
    ...(withVatEwt ? { atcCode: ATC, taxWithheldAmount: 1000 } : {}),
  };
}

async function createApv(opts) {
  const body = apvBody(opts);
  const res = await request(app).post("/api/apv").set(authH()).send(body);
  return { res, body };
}

async function createCvSettling(apvId, apvBalance, { status = "Draft" } = {}) {
  const v = `PH7K-CV-${++seq}`;
  const res = await request(app).post("/api/cv").set(authH()).send({
    voucherNo: v, payeeId: suppId, payeeName: "PH7K Supplier", transactionDate: "2026-11-22",
    referenceNo: v, description: "pay", status, paymentMethod: "Cash",
    totalDebit: apvBalance, totalCredit: apvBalance, currency: { companyId: CO },
    lines: [gl(apId, "PH7K-AP", apvBalance, 0), gl(cashId, "PH7K-CASH", 0, apvBalance)],
    apvApplications: [{ sourceType: "APV", sourceId: apvId, amount: apvBalance }],
  });
  return { res, voucherNo: v };
}

async function apvRow(id) {
  const [[r]] = await pool.query("SELECT status, voucher_no, payment_status, balance_amount FROM apv_headers WHERE id = ?", [id]);
  return r;
}
async function taxCount(type, id) {
  const [[r]] = await pool.query("SELECT COUNT(*) n FROM transaction_tax_entries WHERE transaction_type = ? AND transaction_id = ?", [type, id]);
  return r.n;
}
const j = (v) => (typeof v === "string" ? JSON.parse(v) : v); // mysql2 auto-parses JSON columns
async function auditRows(entityType, entityId, action) {
  const [rows] = await pool.query(
    "SELECT action, before_data, after_data, user_id FROM audit_logs WHERE entity_type = ? AND entity_id = ?" + (action ? " AND action = ?" : ""),
    action ? [entityType, entityId, action] : [entityType, entityId]
  );
  return rows;
}

// ---------------------------------------------------------------------------
describe("Phase 7K - Draft APV Cancel", () => {
  test("success -> status Cancelled, header + lines + INPUT_VAT + EWT + vat_entry_mode retained, voucher consumed", async () => {
    const { res, body } = await createApv({ withVatEwt: true });
    expect(res.status).toBe(200);
    const id = res.body.id;
    const beforeTax = await taxCount("APV", id);
    expect(beforeTax).toBe(2);
    const [[lb]] = await pool.query("SELECT COUNT(*) n FROM apv_lines WHERE apv_id = ?", [id]);

    const c = await request(app).post(`/api/apv/${id}/cancel`).set(authH()).send({ reason: "duplicate entry", companyId: CO });
    expect(c.status).toBe(200);
    expect(c.body.status).toBe("Cancelled");

    const row = await apvRow(id);
    expect(row.status).toBe("Cancelled");
    const [[la]] = await pool.query("SELECT COUNT(*) n FROM apv_lines WHERE apv_id = ?", [id]);
    expect(la.n).toBe(lb.n);
    expect(await taxCount("APV", id)).toBe(2);
    const [[iv]] = await pool.query("SELECT vat_code, vat_treatment, vat_entry_mode, gross_amount, net_amount, vat_amount FROM transaction_tax_entries WHERE transaction_id = ? AND entry_type = 'INPUT_VAT'", [id]);
    expect(iv.vat_treatment).toBe("STANDARD");
    expect(iv.vat_entry_mode).toBe("EXCLUSIVE");
    expect(Number(iv.gross_amount)).toBe(11200);
    expect(Number(iv.net_amount)).toBe(10000);
    expect(Number(iv.vat_amount)).toBe(1200);
    expect(await taxCount("APV", id)).toBe(2);

    // voucher consumed - recreating with the same number is a 409
    const dup = await request(app).post("/api/apv").set(authH()).send({ ...apvBody(), voucherNo: body.voucherNo });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("DUPLICATE_VOUCHER_NO");
  });

  test("reason required -> 400 REASON_REQUIRED (missing and blank)", async () => {
    const { res } = await createApv({});
    for (const payload of [{ companyId: CO }, { reason: "   ", companyId: CO }]) {
      const c = await request(app).post(`/api/apv/${res.body.id}/cancel`).set(authH()).send(payload);
      expect(c.status).toBe(400);
      expect(c.body.code).toBe("REASON_REQUIRED");
    }
    expect((await apvRow(res.body.id)).status).toBe("Draft");
  });

  test("reason over 500 chars -> 400 REASON_TOO_LONG", async () => {
    const { res } = await createApv({});
    const c = await request(app).post(`/api/apv/${res.body.id}/cancel`).set(authH()).send({ reason: "x".repeat(501), companyId: CO });
    expect(c.status).toBe(400);
    expect(c.body.code).toBe("REASON_TOO_LONG");
  });

  test("exactly-500-char reason succeeds; audit description is truncated but after_data.reason is the full text", async () => {
    const { res } = await createApv({});
    const reason = "R".repeat(500);
    const c = await request(app).post(`/api/apv/${res.body.id}/cancel`).set(authH()).send({ reason, companyId: CO });
    expect(c.status).toBe(200);
    const [a] = await auditRows("APV", res.body.id, "CANCEL");
    const [[full]] = await pool.query("SELECT description FROM audit_logs WHERE id = (SELECT MAX(id) FROM audit_logs WHERE entity_type='APV' AND entity_id=? AND action='CANCEL')", [res.body.id]);
    expect(full.description.length).toBeLessThanOrEqual(500);
    expect(j(a.after_data).reason).toBe(reason);
  });

  test("Posted APV cannot be cancelled -> 409 TRANSACTION_ALREADY_POSTED", async () => {
    const { res } = await createApv({ status: "Posted" });
    const c = await request(app).post(`/api/apv/${res.body.id}/cancel`).set(authH()).send({ reason: "nope", companyId: CO });
    expect(c.status).toBe(409);
    expect(c.body.code).toBe("TRANSACTION_ALREADY_POSTED");
    expect((await apvRow(res.body.id)).status).toBe("Posted");
  });

  test("second Cancel -> 409 TRANSACTION_ALREADY_CANCELLED, no second audit row", async () => {
    const { res } = await createApv({});
    const id = res.body.id;
    await request(app).post(`/api/apv/${id}/cancel`).set(authH()).send({ reason: "first", companyId: CO });
    const c2 = await request(app).post(`/api/apv/${id}/cancel`).set(authH()).send({ reason: "second", companyId: CO });
    expect(c2.status).toBe(409);
    expect(c2.body.code).toBe("TRANSACTION_ALREADY_CANCELLED");
    expect((await auditRows("APV", id, "CANCEL")).length).toBe(1);
  });

  test("cancel allowed even when the original period is CLOSED (no ledger effect)", async () => {
    await pool.query(
      "INSERT INTO accounting_periods (company_id, year, period_month, start_date, end_date, status) VALUES (?, 2026, 11, '2026-11-01', '2026-11-30', 'CLOSED')",
      [CO]
    );
    try {
      const { res } = await createApv({}); // create fails? create is CREATE op -> exempt when NOT_CONFIGURED; here period exists+CLOSED
      // A Draft create into a CLOSED period is itself blocked, so seed the row directly instead.
      let apvId = res.body.id;
      if (res.status !== 200) {
        const [ins] = await pool.query(
          "INSERT INTO apv_headers (company_id, voucher_no, supplier_id, supplier_name, transaction_date, total_debit, total_credit, status) VALUES (?, ?, ?, 'PH7K Supplier', '2026-11-20', 100, 100, 'Draft')",
          [CO, `PH7K-APV-CLOSED-${++seq}`, suppId]
        );
        apvId = ins.insertId;
      }
      const c = await request(app).post(`/api/apv/${apvId}/cancel`).set(authH()).send({ reason: "closed-period draft cancel", companyId: CO });
      expect(c.status).toBe(200);
      expect(c.body.status).toBe("Cancelled");
    } finally {
      await pool.query("DELETE FROM accounting_periods WHERE company_id = ?", [CO]);
    }
  });

  test("unauthorized user (no DELETE) -> 403", async () => {
    const { res } = await createApv({});
    const c = await request(app).post(`/api/apv/${res.body.id}/cancel`).set(authH(noPermToken)).send({ reason: "x", companyId: CO });
    expect(c.status).toBe(403);
  });

  test("audit CANCEL row created with before/after status + user", async () => {
    const { res } = await createApv({});
    const id = res.body.id;
    await request(app).post(`/api/apv/${id}/cancel`).set(authH()).send({ reason: "audit check", companyId: CO });
    const [a] = await auditRows("APV", id, "CANCEL");
    expect(a).toBeTruthy();
    expect(a.user_id).toBe(userId);
    const before = typeof a.before_data === "string" ? JSON.parse(a.before_data) : a.before_data;
    const after = typeof a.after_data === "string" ? JSON.parse(a.after_data) : a.after_data;
    expect(before.status).toBe("Draft");
    expect(after.status).toBe("Cancelled");
    expect(after.reason).toBe("audit check");
  });
});

describe("Phase 7K - Posted APV Void", () => {
  test("open-period success -> Void, lines + INPUT_VAT + EWT retained, cannot Void twice", async () => {
    const { res } = await createApv({ status: "Posted", withVatEwt: true });
    expect(res.status).toBe(200);
    const id = res.body.id;
    expect(await taxCount("APV", id)).toBe(2);

    const v = await request(app).post(`/api/apv/${id}/void`).set(authH()).send({ reason: "wrong supplier", companyId: CO });
    expect(v.status).toBe(200);
    expect(v.body.status).toBe("Void");
    expect((await apvRow(id)).status).toBe("Void");
    expect(await taxCount("APV", id)).toBe(2);
    const [[lb]] = await pool.query("SELECT COUNT(*) n FROM apv_lines WHERE apv_id = ?", [id]);
    expect(lb.n).toBeGreaterThan(0);

    const v2 = await request(app).post(`/api/apv/${id}/void`).set(authH()).send({ reason: "again", companyId: CO });
    expect(v2.status).toBe(409);
    expect(v2.body.code).toBe("TRANSACTION_ALREADY_VOIDED");
    expect((await auditRows("APV", id, "VOID")).length).toBe(1);
  });

  test("reason required -> 400", async () => {
    const { res } = await createApv({ status: "Posted" });
    const v = await request(app).post(`/api/apv/${res.body.id}/void`).set(authH()).send({ companyId: CO });
    expect(v.status).toBe(400);
    expect(v.body.code).toBe("REASON_REQUIRED");
    expect((await apvRow(res.body.id)).status).toBe("Posted");
  });

  test("Draft APV cannot be voided -> 409 TRANSACTION_NOT_POSTED", async () => {
    const { res } = await createApv({});
    const v = await request(app).post(`/api/apv/${res.body.id}/void`).set(authH()).send({ reason: "x", companyId: CO });
    expect(v.status).toBe(409);
    expect(v.body.code).toBe("TRANSACTION_NOT_POSTED");
  });

  test("APV with an active Posted CV application cannot be voided -> 409 APV_HAS_ACTIVE_PAYMENTS", async () => {
    const { res } = await createApv({ status: "Posted", gross: 5000 });
    const apvId = res.body.id;
    const { res: cvRes } = await createCvSettling(apvId, 5000, { status: "Posted" });
    expect(cvRes.status).toBe(200);
    const v = await request(app).post(`/api/apv/${apvId}/void`).set(authH()).send({ reason: "blocked", companyId: CO });
    expect(v.status).toBe(409);
    expect(v.body.code).toBe("APV_HAS_ACTIVE_PAYMENTS");
    expect(v.body.message).not.toMatch(/SELECT|JOIN|transaction_applications/i);
    expect((await apvRow(apvId)).status).toBe("Posted");
  });

  test("after the settling CV is voided, the APV can then be voided", async () => {
    const { res } = await createApv({ status: "Posted", gross: 4000 });
    const apvId = res.body.id;
    const { res: cvRes } = await createCvSettling(apvId, 4000, { status: "Posted" });
    const cvId = cvRes.body.id;
    const vc = await request(app).post(`/api/cv/${cvId}/void`).set(authH()).send({ reason: "unwind", companyId: CO });
    expect(vc.status).toBe(200);
    const va = await request(app).post(`/api/apv/${apvId}/void`).set(authH()).send({ reason: "now allowed", companyId: CO });
    expect(va.status).toBe(200);
    expect((await apvRow(apvId)).status).toBe("Void");
  });

  test("CLOSED original period -> 409 REVERSAL_REQUIRED, APV stays Posted", async () => {
    const { res } = await createApv({ status: "Posted", gross: 700 });
    const id = res.body.id;
    await pool.query(
      "INSERT INTO accounting_periods (company_id, year, period_month, start_date, end_date, status) VALUES (?, 2026, 11, '2026-11-01', '2026-11-30', 'CLOSED')",
      [CO]
    );
    try {
      const v = await request(app).post(`/api/apv/${id}/void`).set(authH()).send({ reason: "closed", companyId: CO });
      expect(v.status).toBe(409);
      expect(v.body.code).toBe("REVERSAL_REQUIRED");
      expect((await apvRow(id)).status).toBe("Posted");
    } finally {
      await pool.query("DELETE FROM accounting_periods WHERE company_id = ?", [CO]);
    }
  });

  test("unauthorized user (no VOID) -> 403", async () => {
    const { res } = await createApv({ status: "Posted" });
    const v = await request(app).post(`/api/apv/${res.body.id}/void`).set(authH(noPermToken)).send({ reason: "x", companyId: CO });
    expect(v.status).toBe(403);
  });

  test("company isolation - cannot void another company's APV", async () => {
    const [other] = await pool.execute("INSERT INTO companies (name, status) VALUES ('PH7K Other', 'Active')");
    const [ins] = await pool.query(
      "INSERT INTO apv_headers (company_id, voucher_no, supplier_id, supplier_name, transaction_date, total_debit, total_credit, status) VALUES (?, ?, ?, 'x', '2026-11-20', 10, 10, 'Posted')",
      [other.insertId, `PH7K-OTHER-${++seq}`, suppId]
    );
    const v = await request(app).post(`/api/apv/${ins.insertId}/void`).set(authH()).send({ reason: "x", companyId: CO });
    expect([403, 404]).toContain(v.status);
    await pool.query("DELETE FROM apv_headers WHERE id = ?", [ins.insertId]);
    await pool.query("DELETE FROM companies WHERE id = ?", [other.insertId]);
  });

  test("audit VOID row created", async () => {
    const { res } = await createApv({ status: "Posted", gross: 333 });
    const id = res.body.id;
    await request(app).post(`/api/apv/${id}/void`).set(authH()).send({ reason: "audit void", companyId: CO });
    const [a] = await auditRows("APV", id, "VOID");
    expect(a).toBeTruthy();
    expect(j(a.before_data).status).toBe("Posted");
    expect(j(a.after_data).status).toBe("Void");
  });
});

describe("Phase 7K - Draft CV Cancel", () => {
  test("success -> Cancelled, unwinds applications, recomputes APV payment status", async () => {
    const { res: apvRes } = await createApv({ status: "Posted", gross: 6000 });
    const apvId = apvRes.body.id;
    const { res: cvRes } = await createCvSettling(apvId, 6000, { status: "Draft" });
    const cvId = cvRes.body.id;
    let a = await apvRow(apvId);
    expect(a.payment_status).toBe("Paid");
    const [[appsBefore]] = await pool.query("SELECT COUNT(*) n FROM transaction_applications WHERE applied_type='CV' AND applied_id = ?", [cvId]);
    expect(appsBefore.n).toBe(1);

    const c = await request(app).post(`/api/cv/${cvId}/cancel`).set(authH()).send({ reason: "wrong bank", companyId: CO });
    expect(c.status).toBe(200);
    expect(c.body.status).toBe("Cancelled");

    const [[cvR]] = await pool.query("SELECT status FROM cv_headers WHERE id = ?", [cvId]);
    expect(cvR.status).toBe("Cancelled");
    const [[appsAfter]] = await pool.query("SELECT COUNT(*) n FROM transaction_applications WHERE applied_type='CV' AND applied_id = ?", [cvId]);
    expect(appsAfter.n).toBe(0);
    a = await apvRow(apvId);
    expect(a.payment_status).toBe("Unpaid");
    expect(Number(a.balance_amount)).toBeCloseTo(6000, 2);
    const [[lc]] = await pool.query("SELECT COUNT(*) n FROM cv_lines WHERE cv_id = ?", [cvId]);
    expect(lc.n).toBeGreaterThan(0);
  });

  test("restores AP_BEGINNING line balance", async () => {
    const [bh] = await pool.query(
      "INSERT INTO arap_beginning_balance_headers (company_id, balance_type, balance_date, status) VALUES (?, 'AP', '2026-01-01', 'Posted')",
      [CO]
    );
    const [bl] = await pool.query(
      "INSERT INTO arap_beginning_balance_lines (header_id, party_id, party_name, reference_no, credit, paid_amount, balance_amount, status) VALUES (?, ?, 'PH7K Supplier', 'PH7K-BB-1', 3000, 0, 3000, 'Unpaid')",
      [bh.insertId, suppId]
    );
    const blId = bl.insertId;
    const v = `PH7K-CV-BB-${++seq}`;
    const cvRes = await request(app).post("/api/cv").set(authH()).send({
      voucherNo: v, payeeId: suppId, payeeName: "PH7K Supplier", transactionDate: "2026-11-22", referenceNo: v,
      description: "pay bb", status: "Draft", paymentMethod: "Cash", totalDebit: 3000, totalCredit: 3000,
      currency: { companyId: CO },
      lines: [gl(apId, "PH7K-AP", 3000, 0), gl(cashId, "PH7K-CASH", 0, 3000)],
      apvApplications: [{ sourceType: "AP_BEGINNING", sourceId: blId, amount: 3000 }],
    });
    expect(cvRes.status).toBe(200);
    let [[blRow]] = await pool.query("SELECT paid_amount, balance_amount, status FROM arap_beginning_balance_lines WHERE id = ?", [blId]);
    expect(Number(blRow.paid_amount)).toBeCloseTo(3000, 2);

    const c = await request(app).post(`/api/cv/${cvRes.body.id}/cancel`).set(authH()).send({ reason: "revert bb", companyId: CO });
    expect(c.status).toBe(200);
    [[blRow]] = await pool.query("SELECT paid_amount, balance_amount, status FROM arap_beginning_balance_lines WHERE id = ?", [blId]);
    expect(Number(blRow.paid_amount)).toBeCloseTo(0, 2);
    expect(Number(blRow.balance_amount)).toBeCloseTo(3000, 2);
    expect(blRow.status).toBe("Unpaid");

    await pool.query("DELETE FROM arap_beginning_balance_lines WHERE id = ?", [blId]);
    await pool.query("DELETE FROM arap_beginning_balance_headers WHERE id = ?", [bh.insertId]);
  });

  test("reason required -> 400; second cancel -> 409 TRANSACTION_ALREADY_CANCELLED", async () => {
    const { res: apvRes } = await createApv({ status: "Posted", gross: 500 });
    const { res: cvRes } = await createCvSettling(apvRes.body.id, 500, { status: "Draft" });
    const cvId = cvRes.body.id;
    const noReason = await request(app).post(`/api/cv/${cvId}/cancel`).set(authH()).send({ companyId: CO });
    expect(noReason.status).toBe(400);
    await request(app).post(`/api/cv/${cvId}/cancel`).set(authH()).send({ reason: "one", companyId: CO });
    const c2 = await request(app).post(`/api/cv/${cvId}/cancel`).set(authH()).send({ reason: "two", companyId: CO });
    expect(c2.status).toBe(409);
    expect(c2.body.code).toBe("TRANSACTION_ALREADY_CANCELLED");
  });

  test("unauthorized (no DELETE) -> 403", async () => {
    const { res: apvRes } = await createApv({ status: "Posted", gross: 250 });
    const { res: cvRes } = await createCvSettling(apvRes.body.id, 250, { status: "Draft" });
    const c = await request(app).post(`/api/cv/${cvRes.body.id}/cancel`).set(authH(noPermToken)).send({ reason: "x", companyId: CO });
    expect(c.status).toBe(403);
  });
});

describe("Phase 7K - Posted CV Void", () => {
  test("success -> Void, unwinds settlement, reopens the APV payable, cannot Void twice", async () => {
    const { res: apvRes } = await createApv({ status: "Posted", gross: 8000 });
    const apvId = apvRes.body.id;
    const { res: cvRes } = await createCvSettling(apvId, 8000, { status: "Posted" });
    const cvId = cvRes.body.id;
    expect((await apvRow(apvId)).payment_status).toBe("Paid");

    const v = await request(app).post(`/api/cv/${cvId}/void`).set(authH()).send({ reason: "bounced cheque", companyId: CO });
    expect(v.status).toBe(200);
    expect(v.body.status).toBe("Void");
    const [[cvR]] = await pool.query("SELECT status FROM cv_headers WHERE id = ?", [cvId]);
    expect(cvR.status).toBe("Void");
    const [[apps]] = await pool.query("SELECT COUNT(*) n FROM transaction_applications WHERE applied_type='CV' AND applied_id = ?", [cvId]);
    expect(apps.n).toBe(0);
    const a = await apvRow(apvId);
    expect(a.payment_status).toBe("Unpaid");
    expect(Number(a.balance_amount)).toBeCloseTo(8000, 2);

    const v2 = await request(app).post(`/api/cv/${cvId}/void`).set(authH()).send({ reason: "again", companyId: CO });
    expect(v2.status).toBe(409);
    expect(v2.body.code).toBe("TRANSACTION_ALREADY_VOIDED");
  });

  test("Draft CV cannot be voided -> 409 TRANSACTION_NOT_POSTED", async () => {
    const { res: apvRes } = await createApv({ status: "Posted", gross: 100 });
    const { res: cvRes } = await createCvSettling(apvRes.body.id, 100, { status: "Draft" });
    const v = await request(app).post(`/api/cv/${cvRes.body.id}/void`).set(authH()).send({ reason: "x", companyId: CO });
    expect(v.status).toBe(409);
    expect(v.body.code).toBe("TRANSACTION_NOT_POSTED");
  });

  test("CLOSED original period -> 409 REVERSAL_REQUIRED, CV stays Posted, applications intact", async () => {
    const { res: apvRes } = await createApv({ status: "Posted", gross: 900 });
    const { res: cvRes } = await createCvSettling(apvRes.body.id, 900, { status: "Posted" });
    const cvId = cvRes.body.id;
    await pool.query(
      "INSERT INTO accounting_periods (company_id, year, period_month, start_date, end_date, status) VALUES (?, 2026, 11, '2026-11-01', '2026-11-30', 'CLOSED')",
      [CO]
    );
    try {
      const v = await request(app).post(`/api/cv/${cvId}/void`).set(authH()).send({ reason: "closed", companyId: CO });
      expect(v.status).toBe(409);
      expect(v.body.code).toBe("REVERSAL_REQUIRED");
      const [[cvR]] = await pool.query("SELECT status FROM cv_headers WHERE id = ?", [cvId]);
      expect(cvR.status).toBe("Posted");
      const [[apps]] = await pool.query("SELECT COUNT(*) n FROM transaction_applications WHERE applied_type='CV' AND applied_id = ?", [cvId]);
      expect(apps.n).toBe(1);
    } finally {
      await pool.query("DELETE FROM accounting_periods WHERE company_id = ?", [CO]);
    }
  });

  test("audit VOID row created for CV", async () => {
    const { res: apvRes } = await createApv({ status: "Posted", gross: 120 });
    const { res: cvRes } = await createCvSettling(apvRes.body.id, 120, { status: "Posted" });
    const cvId = cvRes.body.id;
    await request(app).post(`/api/cv/${cvId}/void`).set(authH()).send({ reason: "cv audit void", companyId: CO });
    const [a] = await auditRows("CV", cvId, "VOID");
    expect(a).toBeTruthy();
    expect(j(a.after_data).status).toBe("Void");
  });
});

describe("Phase 7K - status allow-list + plain edit guards", () => {
  test("plain PUT with an arbitrary status -> 400 INVALID_TRANSACTION_STATUS", async () => {
    const { res } = await createApv({});
    const p = await request(app).put(`/api/apv/${res.body.id}`).set(authH()).send({
      ...apvBody(), voucherNo: res.body.voucherNo || `PH7K-APV-X`, status: "Frozen",
    });
    expect(p.status).toBe(400);
    expect(p.body.code).toBe("INVALID_TRANSACTION_STATUS");
  });

  test("plain PUT of a Cancelled APV -> 409 TRANSACTION_NOT_EDITABLE", async () => {
    const { res, body } = await createApv({});
    await request(app).post(`/api/apv/${res.body.id}/cancel`).set(authH()).send({ reason: "x", companyId: CO });
    const p = await request(app).put(`/api/apv/${res.body.id}`).set(authH()).send({ ...apvBody(), voucherNo: body.voucherNo });
    expect(p.status).toBe(409);
    expect(p.body.code).toBe("TRANSACTION_NOT_EDITABLE");
  });

  test("plain PUT of a Void APV -> 409 TRANSACTION_NOT_EDITABLE; DELETE of Posted still 409 TRANSACTION_ALREADY_POSTED", async () => {
    const { res, body } = await createApv({ status: "Posted", gross: 222 });
    const del = await request(app).delete(`/api/apv/${res.body.id}`).set(authH()).query({ companyId: CO });
    expect(del.status).toBe(409);
    expect(del.body.code).toBe("TRANSACTION_ALREADY_POSTED");
    await request(app).post(`/api/apv/${res.body.id}/void`).set(authH()).send({ reason: "x", companyId: CO });
    const p = await request(app).put(`/api/apv/${res.body.id}`).set(authH()).send({ ...apvBody(), voucherNo: body.voucherNo });
    expect(p.status).toBe(409);
    expect(p.body.code).toBe("TRANSACTION_NOT_EDITABLE");
  });

  test("ordinary PUT cannot INJECT status Void or Cancelled (bypasses reason/perm/period/settlement/audit)", async () => {
    for (const inject of ["Void", "VOID", "Cancelled", "cancelled"]) {
      const { res, body } = await createApv({});
      const p = await request(app).put(`/api/apv/${res.body.id}`).set(authH()).send({ ...apvBody(), voucherNo: body.voucherNo, status: inject });
      expect(p.status).toBe(400);
      expect(p.body.code).toBe("INVALID_TRANSACTION_STATUS");
      expect((await apvRow(res.body.id)).status).toBe("Draft"); // never mutated
      expect((await auditRows("APV", res.body.id, "VOID")).length).toBe(0);
      expect((await auditRows("APV", res.body.id, "CANCEL")).length).toBe(0);
    }
    // and on CV
    const { res: apvRes } = await createApv({ status: "Posted", gross: 400 });
    const { res: cvRes } = await createCvSettling(apvRes.body.id, 400, { status: "Draft" });
    const p = await request(app).put(`/api/cv/${cvRes.body.id}`).set(authH()).send({
      voucherNo: `PH7K-CV-INJ-${++seq}`, payeeId: suppId, payeeName: "PH7K Supplier", transactionDate: "2026-11-22",
      referenceNo: "r", description: "x", status: "Void", paymentMethod: "Cash", totalDebit: 400, totalCredit: 400,
      currency: { companyId: CO }, lines: [gl(apId, "PH7K-AP", 400, 0), gl(cashId, "PH7K-CASH", 0, 400)],
    });
    expect(p.status).toBe(400);
    expect(p.body.code).toBe("INVALID_TRANSACTION_STATUS");
  });

  test("ordinary POST cannot create an APV/CV directly as Void/Cancelled -> 400", async () => {
    const b = apvBody(); b.status = "Void";
    const r = await request(app).post("/api/apv").set(authH()).send(b);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("INVALID_TRANSACTION_STATUS");
  });

  test("physical DELETE /api/apv/:id: Draft-only. Cancelled -> 409, Void -> 409, Draft -> 200", async () => {
    // Cancelled cannot be physically deleted
    const { res: c1 } = await createApv({});
    await request(app).post(`/api/apv/${c1.body.id}/cancel`).set(authH()).send({ reason: "x", companyId: CO });
    const delC = await request(app).delete(`/api/apv/${c1.body.id}`).set(authH()).query({ companyId: CO });
    expect(delC.status).toBe(409);
    expect(delC.body.code).toBe("TRANSACTION_NOT_EDITABLE");
    const [[stillC]] = await pool.query("SELECT COUNT(*) n FROM apv_headers WHERE id = ?", [c1.body.id]);
    expect(stillC.n).toBe(1);

    // Void cannot be physically deleted
    const { res: v1 } = await createApv({ status: "Posted", gross: 55 });
    await request(app).post(`/api/apv/${v1.body.id}/void`).set(authH()).send({ reason: "x", companyId: CO });
    const delV = await request(app).delete(`/api/apv/${v1.body.id}`).set(authH()).query({ companyId: CO });
    expect(delV.status).toBe(409);
    expect(delV.body.code).toBe("TRANSACTION_NOT_EDITABLE");

    // Draft can still be physically deleted via the retained legacy route
    const { res: d1 } = await createApv({});
    const delD = await request(app).delete(`/api/apv/${d1.body.id}`).set(authH()).query({ companyId: CO });
    expect(delD.status).toBe(200);
    const [[goneD]] = await pool.query("SELECT COUNT(*) n FROM apv_headers WHERE id = ?", [d1.body.id]);
    expect(goneD.n).toBe(0);
  });
});

describe("Phase 7K - reports exclude Cancelled/Void", () => {
  test("EWT alphalist excludes a Cancelled APV and a Void APV", async () => {
    const { res: draftApv } = await createApv({ withVatEwt: true }); // Draft w/ EWT
    const { res: postedApv } = await createApv({ status: "Posted", withVatEwt: true });
    await request(app).post(`/api/apv/${draftApv.body.id}/cancel`).set(authH()).send({ reason: "x", companyId: CO });
    await request(app).post(`/api/apv/${postedApv.body.id}/void`).set(authH()).send({ reason: "x", companyId: CO });

    const alpha = await request(app).get("/api/reports/alphalist").set(authH()).query({ taxType: "EWT", month: "2026-11", companyId: CO });
    expect(alpha.status).toBe(200);
    // Neither the cancelled nor the voided APV's withholding should be summed
    const total = (alpha.body || []).reduce((s, r) => s + Number(r.taxWithheld || 0), 0);
    expect(total).toBe(0);
  });

  test("EWT alphalist status matrix: Draft excluded, Posted included, Cancelled excluded, Void excluded", async () => {
    const posted = await createApv({ status: "Posted", withVatEwt: true }); // reports withheld 1000
    const draft = await createApv({ withVatEwt: true });
    const toCancel = await createApv({ withVatEwt: true });
    const toVoid = await createApv({ status: "Posted", withVatEwt: true });
    await request(app).post(`/api/apv/${toCancel.res.body.id}/cancel`).set(authH()).send({ reason: "x", companyId: CO });
    await request(app).post(`/api/apv/${toVoid.res.body.id}/void`).set(authH()).send({ reason: "x", companyId: CO });

    const alpha = await request(app).get("/api/reports/alphalist").set(authH()).query({ taxType: "EWT", month: "2026-11", companyId: CO });
    expect(alpha.status).toBe(200);
    const total = (alpha.body || []).reduce((s, r) => s + Number(r.taxWithheld || 0), 0);
    // only the one still-Posted APV's withholding (1000) is reportable
    expect(total).toBe(1000);
  });

  test("AP aging excludes a Void APV", async () => {
    const { res, body } = await createApv({ status: "Posted", gross: 15000 });
    const id = res.body.id;
    const vno = body.voucherNo;
    let aging = await request(app).get("/api/reports/ap-aging").set(authH()).query({ companyId: CO, asOf: "2026-12-01" });
    expect((aging.body.rows || []).some((r) => r.referenceNo === vno)).toBe(true);
    const v = await request(app).post(`/api/apv/${id}/void`).set(authH()).send({ reason: "x", companyId: CO });
    expect(v.status).toBe(200);
    aging = await request(app).get("/api/reports/ap-aging").set(authH()).query({ companyId: CO, asOf: "2026-12-01" });
    expect((aging.body.rows || []).some((r) => r.referenceNo === vno)).toBe(false);
  });

  test("General Ledger excludes a Void APV and a Void CV", async () => {
    const { res: apvRes, body: apvB } = await createApv({ status: "Posted", gross: 9500 });
    const { res: cvRes, voucherNo: cvVno } = await createCvSettling(apvRes.body.id, 9500, { status: "Posted" });
    expect(cvRes.status).toBe(200);
    const vc = await request(app).post(`/api/cv/${cvRes.body.id}/void`).set(authH()).send({ reason: "x", companyId: CO });
    expect(vc.status).toBe(200);
    const va = await request(app).post(`/api/apv/${apvRes.body.id}/void`).set(authH()).send({ reason: "x", companyId: CO });
    expect(va.status).toBe(200);

    const gl = await request(app).get("/api/reports/general-ledger").set(authH())
      .query({ companyId: CO, from: "2026-11-01", to: "2026-11-30" });
    expect(gl.status).toBe(200);
    const flat = JSON.stringify(gl.body);
    expect(flat).not.toContain(apvB.voucherNo);
    expect(flat).not.toContain(cvVno);
  });
});

describe("Phase 7K - prior-phase regressions", () => {
  test("Phase 7I zero-line still rejects an empty APV create", async () => {
    const b = apvBody();
    b.lines = [];
    const res = await request(app).post("/api/apv").set(authH()).send(b);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TRANSACTION_LINES_REQUIRED");
  });

  test("Phase 7J vat_entry_mode still persisted on a normal APV create (no regression)", async () => {
    const { res } = await createApv({ status: "Posted", withVatEwt: true });
    const [[iv]] = await pool.query("SELECT vat_entry_mode FROM transaction_tax_entries WHERE transaction_id = ? AND entry_type='INPUT_VAT'", [res.body.id]);
    expect(iv.vat_entry_mode).toBe("EXCLUSIVE");
  });

  test("Phase 7G duplicate voucher still 409 on APV create", async () => {
    const { res, body } = await createApv({});
    expect(res.status).toBe(200);
    const dup = await request(app).post("/api/apv").set(authH()).send({ ...apvBody(), voucherNo: body.voucherNo });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("DUPLICATE_VOUCHER_NO");
  });

  test("Posted APV edit guard unchanged -> 409 TRANSACTION_ALREADY_POSTED", async () => {
    const { res, body } = await createApv({ status: "Posted", gross: 77 });
    const p = await request(app).put(`/api/apv/${res.body.id}`).set(authH()).send({ ...apvBody(), voucherNo: body.voucherNo, status: "Draft" });
    expect(p.status).toBe(409);
    expect(p.body.code).toBe("TRANSACTION_ALREADY_POSTED");
  });

  test("Cancel/Void atomicity - a failed CV void leaves the CV Posted and applications intact", async () => {
    const { res: apvRes } = await createApv({ status: "Posted", gross: 640 });
    const { res: cvRes } = await createCvSettling(apvRes.body.id, 640, { status: "Posted" });
    const cvId = cvRes.body.id;
    // no reason -> validated before any mutation
    const v = await request(app).post(`/api/cv/${cvId}/void`).set(authH()).send({ companyId: CO });
    expect(v.status).toBe(400);
    const [[cvR]] = await pool.query("SELECT status FROM cv_headers WHERE id = ?", [cvId]);
    expect(cvR.status).toBe("Posted");
    const [[apps]] = await pool.query("SELECT COUNT(*) n FROM transaction_applications WHERE applied_type='CV' AND applied_id = ?", [cvId]);
    expect(apps.n).toBe(1);
  });
});
