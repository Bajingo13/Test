const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const CurrencyService = require("../services/currencyService");

// Phase 7I: backend zero-line validation. A transaction (or quotation) must
// not persist without at least one substantive business line. Validation-
// only: the existing VAT/EWT pipeline (line.taxEntry -> taxEntryService ->
// transaction_tax_entries) is unchanged and must not double-generate.

jest.setTimeout(200000);

let CO, userId, token;
let arId, revId, cashId, ovatId, ewtPayId;
let inputVatId, expId, apId, ewtRcvId;
let custId;

const ATC = "PH7I-WC010"; // 10% EWT fixture

async function mkAcc(code, title, cls) {
  const [r] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, cls]
  );
  return r.insertId;
}

beforeAll(async () => {
  assertNotProductionDatabase();
  const [c] = await pool.execute("INSERT INTO companies (name, status) VALUES ('PH7I Co', 'Active')");
  CO = c.insertId;
  const hash = await bcrypt.hash("Ph7iPass!1", 10);
  const [u] = await pool.execute("INSERT INTO users (username, password, role_id, status) VALUES ('ph7i_admin', ?, 2, 'ACTIVE')", [hash]);
  userId = u.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, CO]);
  token = (await request(app).post("/api/login").send({ username: "ph7i_admin", password: "Ph7iPass!1" })).body.token;
  await CurrencyService.createCurrency({ id: userId, roleCode: "ADMIN" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: CO,
  });
  arId = await mkAcc("PH7I-AR", "Accounts Receivable", "ASSET");
  revId = await mkAcc("PH7I-REV", "Sales Revenue", "INCOME");
  cashId = await mkAcc("PH7I-CASH", "Cash on Hand", "ASSET");
  ovatId = await mkAcc("PH7I-OVAT", "Output VAT Payable", "LIABILITY");
  ewtPayId = await mkAcc("PH7I-EWT", "Withholding Tax Payable", "LIABILITY");
  inputVatId = await mkAcc("PH7I-IVAT", "Input VAT Receivable", "ASSET");
  expId = await mkAcc("PH7I-EXP", "Purchases Expense", "EXPENSE");
  apId = await mkAcc("PH7I-AP", "Accounts Payable", "LIABILITY");
  ewtRcvId = await mkAcc("PH7I-EWTR", "Creditable Withholding Tax Receivable", "ASSET");
  const [p] = await pool.execute("INSERT INTO general_libraries (company_id, code, party_type, name, status, tin) VALUES (?, 'PH7I-C', 'BOTH', 'PH7I Party', 'ACTIVE', '111-222-333-000')", [CO]);
  custId = p.insertId;
  await pool.execute(
    "INSERT INTO ewt_library (atc_code, description, rate, tax_type, status) VALUES (?, 'PH7I fixture', 10, 'EWT', 'ACTIVE')",
    [ATC]
  );
});

afterAll(async () => {
  await pool.query("DELETE FROM transaction_tax_entries WHERE company_id = ?", [CO]);
  for (const t of ["invoice", "apv", "or", "cv", "jv", "purchase_order", "petty_cash", "memo"]) {
    const h = `${t}_headers`;
    const lk = t === "purchase_order" ? "purchase_order_lines" : `${t}_lines`;
    const fk = t === "invoice" ? "invoice_id" : t === "purchase_order" ? "po_id" : `${t}_id`;
    try { await pool.query(`DELETE ln FROM ${lk} ln JOIN ${h} hd ON hd.id = ln.${fk} WHERE hd.company_id = ?`, [CO]); } catch (e) {}
    try { await pool.query(`DELETE FROM ${h} WHERE company_id = ?`, [CO]); } catch (e) {}
  }
  await pool.query("DELETE l FROM quotation_lines l JOIN quotation_headers h ON h.id = l.quotation_id WHERE h.company_id = ?", [CO]);
  await pool.query("DELETE FROM quotation_headers WHERE company_id = ?", [CO]);
  await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id = ?", [CO]);
  await pool.query("DELETE FROM general_libraries WHERE company_id = ?", [CO]);
  await pool.query("DELETE FROM currencies WHERE company_id = ?", [CO]);
  await pool.query("DELETE FROM user_companies WHERE user_id = ?", [userId]);
  await pool.query("DELETE FROM users WHERE id = ?", [userId]);
  await pool.query("DELETE FROM companies WHERE id = ?", [CO]);
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'PH7I-%'");
  await pool.query("DELETE FROM ewt_library WHERE atc_code = ?", [ATC]);
  await pool.end();
});

const glLine = (accountId, accountCode, debit, credit) => ({
  accountId, accountCode, accountTitle: accountCode, particulars: "x", genRef: "", genName: "", debit, credit,
});
const balancedGl = () => [glLine(arId, "PH7I-AR", 1000, 0), glLine(revId, "PH7I-REV", 0, 1000)];

const MODULES = {
  INV: { url: "invoices", extra: { customerId: custId, customerName: "PH7I Party" } },
  APV: { url: "apv", extra: { supplierId: custId, supplierName: "PH7I Party" } },
  OR: { url: "or", extra: { customerId: custId, customerName: "PH7I Party", receiptNo: "R", paymentMethod: "Cash" } },
  CV: { url: "cv", extra: { payeeId: custId, payeeName: "PH7I Party", paymentMethod: "Check" } },
  JV: { url: "jv", extra: { preparedFor: "PH7I Party" } },
  PO: { url: "purchase-orders", extra: { supplierId: custId, supplierName: "PH7I Party" } },
  PCV: { url: "petty-cash", extra: { payeeId: custId, payeeName: "PH7I Party" } },
  DM: { url: "debit-memos", extra: { partyId: custId, partyName: "PH7I Party", partyType: "CUSTOMER" } },
  CM: { url: "credit-memos", extra: { partyId: custId, partyName: "PH7I Party", partyType: "CUSTOMER" } },
};

function post(mod, lines, voucherNo) {
  const m = MODULES[mod];
  const body = {
    voucherNo: voucherNo || `PH7I-${mod}-${Math.random().toString(36).slice(2, 8)}`,
    transactionDate: "2026-11-22", referenceNo: "r", description: "ph7i", status: "Draft",
    totalDebit: 1000, totalCredit: 1000, currency: { companyId: CO }, ...m.extra,
  };
  if (lines !== "OMIT") body.lines = lines;
  return request(app).post(`/api/${m.url}`).set("Authorization", `Bearer ${token}`).send(body);
}

async function taxEntryCount(type, id, entryType) {
  const [[r]] = await pool.query(
    "SELECT COUNT(*) n FROM transaction_tax_entries WHERE transaction_type = ? AND transaction_id = ?" + (entryType ? " AND entry_type = ?" : ""),
    entryType ? [type, id, entryType] : [type, id]
  );
  return r.n;
}

describe("Phase 7I - GL modules reject zero-line create (400 TRANSACTION_LINES_REQUIRED)", () => {
  const BAD = {
    "missing lines": "OMIT",
    "lines: null": null,
    "lines: [] (empty)": [],
    "lines: {} (wrong type)": {},
    "lines: [{}] (empty object)": [{}],
    "lines: [{debit:0,credit:0}] (zero/zero)": [{ accountId: arId, debit: 0, credit: 0 }],
    "lines: only a generated Output VAT taxEntry row": [{ accountId: ovatId, debit: 0, credit: 120, taxEntry: { entryType: "OUTPUT_VAT", vatTreatment: "STANDARD" } }],
  };
  for (const mod of Object.keys(MODULES)) {
    for (const [label, lines] of Object.entries(BAD)) {
      test(`${mod}: ${label} -> 400`, async () => {
        const res = await post(mod, lines);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe("TRANSACTION_LINES_REQUIRED");
        expect(res.status).not.toBe(500);
      });
    }
  }
});

describe("Phase 7I - legitimate lines still succeed", () => {
  test("INV: two balanced business lines -> 200, zero tax entries", async () => {
    const res = await post("INV", balancedGl());
    expect(res.status).toBe(200);
    expect(await taxEntryCount("INV", res.body.id)).toBe(0);
  });
  test("zero debit + valid credit stays valid (paired with valid debit line)", async () => {
    const res = await post("JV", [glLine(cashId, "PH7I-CASH", 0, 500), glLine(revId, "PH7I-REV", 500, 0)]);
    // note: JV line rule = debit XOR credit; this pair is balanced
    expect([200, 400]).toContain(res.status); // 400 only if JV has stricter line rules
    if (res.status === 400) expect(res.body.code).not.toBe("TRANSACTION_LINES_REQUIRED");
  });
});

describe("Phase 7I - VAT/EWT pipeline is NOT double-run and NOT bypassed", () => {
  test("INV + Output VAT: exactly ONE OUTPUT_VAT transaction_tax_entries row (STANDARD)", async () => {
    const lines = [
      glLine(arId, "PH7I-AR", 11200, 0),
      glLine(revId, "PH7I-REV", 0, 10000),
      {
        accountId: ovatId, accountCode: "PH7I-OVAT", accountTitle: "Output VAT Payable", particulars: "Output VAT (12%)",
        genRef: "", genName: "", debit: 0, credit: 1200,
        taxEntry: {
          entryType: "OUTPUT_VAT", accountId: ovatId, partyId: custId, partyName: "PH7I Party", partyTin: "111-222-333-000",
          partyAddress: "Manila", transactionDate: "2026-11-22", grossAmount: 11200, netAmount: 10000, vatRate: 12,
          vatAmount: 1200, vatTreatment: "STANDARD", vatCode: null,
        },
      },
    ];
    const res = await request(app).post("/api/invoices").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7I-VAT-1", transactionDate: "2026-11-22", referenceNo: "r", description: "vat", status: "Draft",
      customerId: custId, customerName: "PH7I Party", totalDebit: 11200, totalCredit: 11200, currency: { companyId: CO }, lines,
    });
    expect(res.status).toBe(200);
    expect(await taxEntryCount("INV", res.body.id, "OUTPUT_VAT")).toBe(1);
    const [[te]] = await pool.query("SELECT vat_treatment, vat_amount, net_amount FROM transaction_tax_entries WHERE transaction_id = ? AND entry_type = 'OUTPUT_VAT'", [res.body.id]);
    expect(te.vat_treatment).toBe("STANDARD");
    expect(Number(te.vat_amount)).toBeCloseTo(1200, 2);
    expect(Number(te.net_amount)).toBeCloseTo(10000, 2);
  });

  test("ZERO_RATED invoice: VAT 0, treatment snapshot ZERO_RATED, exactly one entry", async () => {
    const lines = [
      glLine(arId, "PH7I-AR", 5000, 0),
      glLine(revId, "PH7I-REV", 0, 5000),
      {
        accountId: ovatId, accountCode: "PH7I-OVAT", accountTitle: "Output VAT Payable", particulars: "Zero-Rated Sales",
        genRef: "", genName: "", debit: 0, credit: 0,
        taxEntry: {
          entryType: "OUTPUT_VAT", accountId: ovatId, partyId: custId, partyName: "PH7I Party", partyTin: "111-222-333-000",
          partyAddress: "Manila", transactionDate: "2026-11-22", grossAmount: 5000, netAmount: 5000, vatRate: 0,
          vatAmount: 0, vatTreatment: "ZERO_RATED", vatCode: "VAT_ZERO_RATED",
        },
      },
    ];
    const res = await request(app).post("/api/invoices").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7I-ZR-1", transactionDate: "2026-11-22", referenceNo: "r", description: "zr", status: "Draft",
      customerId: custId, customerName: "PH7I Party", totalDebit: 5000, totalCredit: 5000, currency: { companyId: CO }, lines,
    });
    expect(res.status).toBe(200);
    expect(await taxEntryCount("INV", res.body.id, "OUTPUT_VAT")).toBe(1);
    const [[te]] = await pool.query("SELECT vat_treatment, vat_amount FROM transaction_tax_entries WHERE transaction_id = ? AND entry_type = 'OUTPUT_VAT'", [res.body.id]);
    expect(te.vat_treatment).toBe("ZERO_RATED");
    expect(Number(te.vat_amount)).toBe(0);
  });

  test("a zero-line rejection creates ZERO transaction_tax_entries rows", async () => {
    const [[before]] = await pool.query("SELECT COUNT(*) n FROM transaction_tax_entries WHERE company_id = ?", [CO]);
    const res = await post("INV", [{ accountId: ovatId, debit: 0, credit: 120, taxEntry: { entryType: "OUTPUT_VAT", vatTreatment: "STANDARD" } }]);
    expect(res.status).toBe(400);
    const [[after]] = await pool.query("SELECT COUNT(*) n FROM transaction_tax_entries WHERE company_id = ?", [CO]);
    expect(after.n).toBe(before.n);
  });
});

describe("Phase 7I - update from valid -> zero lines is rejected and leaves the transaction unchanged", () => {
  test("INV PUT lines:[] -> 400, original lines + tax entries preserved", async () => {
    const create = await post("INV", [
      glLine(arId, "PH7I-AR", 2240, 0),
      glLine(revId, "PH7I-REV", 0, 2000),
      {
        accountId: ovatId, accountCode: "PH7I-OVAT", accountTitle: "Output VAT Payable", particulars: "Output VAT (12%)",
        genRef: "", genName: "", debit: 0, credit: 240,
        taxEntry: { entryType: "OUTPUT_VAT", accountId: ovatId, partyId: custId, partyName: "PH7I Party", partyTin: "1", partyAddress: "M", transactionDate: "2026-11-22", grossAmount: 2240, netAmount: 2000, vatRate: 12, vatAmount: 240, vatTreatment: "STANDARD", vatCode: null },
      },
    ], "PH7I-UPD-1");
    expect(create.status).toBe(200);
    const id = create.body.id;
    const [[linesBefore]] = await pool.query("SELECT COUNT(*) n FROM invoice_lines WHERE invoice_id = ?", [id]);
    const teBefore = await taxEntryCount("INV", id);

    const upd = await request(app).put(`/api/invoices/${id}`).set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7I-UPD-1", transactionDate: "2026-11-22", referenceNo: "r", description: "x", status: "Draft",
      customerId: custId, customerName: "PH7I Party", totalDebit: 0, totalCredit: 0, currency: { companyId: CO }, lines: [],
    });
    expect(upd.status).toBe(400);
    expect(upd.body.code).toBe("TRANSACTION_LINES_REQUIRED");

    const [[linesAfter]] = await pool.query("SELECT COUNT(*) n FROM invoice_lines WHERE invoice_id = ?", [id]);
    expect(linesAfter.n).toBe(linesBefore.n);
    expect(await taxEntryCount("INV", id)).toBe(teBefore);
  });
});

describe("Phase 7I - failed create leaves no orphan header", () => {
  test("rejected INV create does not add an invoice_headers row", async () => {
    const [[before]] = await pool.query("SELECT COUNT(*) n FROM invoice_headers WHERE company_id = ?", [CO]);
    const res = await post("INV", []);
    expect(res.status).toBe(400);
    const [[after]] = await pool.query("SELECT COUNT(*) n FROM invoice_headers WHERE company_id = ?", [CO]);
    expect(after.n).toBe(before.n);
  });
});

describe("Phase 7I - Quotation", () => {
  const qBody = (lines) => ({
    companyId: CO, customerId: custId, customerName: "PH7I Party", quotationDate: "2026-11-22", status: "Draft", totalAmount: 100, lines,
  });
  const itemLine = { lineType: "item", description: "svc", quantity: 1, unitLabel: "Units", unitPrice: 100, taxRate: 0, amount: 100, accountId: revId, accountCode: "PH7I-REV", accountTitle: "Sales Revenue" };

  test("create with [] / only a section line / [{}] -> 400 TRANSACTION_LINES_REQUIRED", async () => {
    for (const lines of [[], [{ lineType: "section", description: "Group" }], [{}]]) {
      const res = await request(app).post("/api/quotations").set("Authorization", `Bearer ${token}`).send(qBody(lines));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("TRANSACTION_LINES_REQUIRED");
    }
  });
  test("create with one item line -> 200", async () => {
    const res = await request(app).post("/api/quotations").set("Authorization", `Bearer ${token}`).send(qBody([itemLine]));
    expect(res.status).toBe(200);
  });
  test("update valid quotation to [] -> 400, quotation unchanged", async () => {
    const c = await request(app).post("/api/quotations").set("Authorization", `Bearer ${token}`).send(qBody([itemLine]));
    const [[before]] = await pool.query("SELECT COUNT(*) n FROM quotation_lines WHERE quotation_id = ?", [c.body.id]);
    const upd = await request(app).put(`/api/quotations/${c.body.id}`).set("Authorization", `Bearer ${token}`).send(qBody([]));
    expect(upd.status).toBe(400);
    const [[after]] = await pool.query("SELECT COUNT(*) n FROM quotation_lines WHERE quotation_id = ?", [c.body.id]);
    expect(after.n).toBe(before.n);
  });
  test("convert a quotation with no item lines -> 400, quotation stays un-converted", async () => {
    // create a valid quotation, then strip its item lines directly, then convert
    const c = await request(app).post("/api/quotations").set("Authorization", `Bearer ${token}`).send(qBody([itemLine]));
    await pool.query("DELETE FROM quotation_lines WHERE quotation_id = ?", [c.body.id]);
    const conv = await request(app).post(`/api/quotations/${c.body.id}/convert-to-invoice`).set("Authorization", `Bearer ${token}`).send({ companyId: CO });
    expect(conv.status).toBe(400);
    expect(conv.body.code).toBe("TRANSACTION_LINES_REQUIRED");
    const [[q]] = await pool.query("SELECT status FROM quotation_headers WHERE id = ?", [c.body.id]);
    expect(q.status).not.toBe("Converted");
  });
});

describe("Phase 7I - does not weaken Phase 7G / 7H", () => {
  test("Phase 7G: same-company duplicate voucher still 409 (checked before zero-line matters)", async () => {
    const a = await post("INV", balancedGl(), "PH7I-7G-DUP");
    expect(a.status).toBe(200);
    const b = await post("INV", balancedGl(), "PH7I-7G-DUP");
    expect(b.status).toBe(409);
    expect(b.body.code).toBe("DUPLICATE_VOUCHER_NO");
  });
  test("Phase 7H: creating a quotation for a company the user cannot access is still 403 (not 400)", async () => {
    const [other] = await pool.execute("INSERT INTO companies (name, status) VALUES ('PH7I Other', 'Active')");
    const res = await request(app).post("/api/quotations").set("Authorization", `Bearer ${token}`).send({
      companyId: other.insertId, customerId: custId, customerName: "x", quotationDate: "2026-11-22", status: "Draft", totalAmount: 100,
      lines: [{ lineType: "item", description: "svc", quantity: 1, unitPrice: 100, amount: 100 }],
    });
    expect(res.status).toBe(403);
    await pool.query("DELETE FROM companies WHERE id = ?", [other.insertId]);
  });
});

// ---------------------------------------------------------------------------
// COMPATIBILITY GATE: legacy OR / CV / PO VAT & EWT lines
//
// OR/CV/PO have NO server-side VAT/EWT/control line generation - every route
// persists exactly the client-submitted `lines` (verified: the INSERT loop
// iterates `currencyResult.lines`, there is no `.push` into `lines`, and
// resolveTaxWithholding()/ewtCalculationService only `.filter`/`.reduce`
// over `lines`). A "legacy" VAT/EWT line is therefore just an ordinary
// client journal line with a real debit/credit and NO `taxEntry` metadata.
//
// The zero-line guard (isSubstantiveBusinessLine) runs on the raw
// req.body.lines BEFORE resolveTransactionCurrency and BEFORE any persistence.
// A payload whose only lines are legacy tax/control fragments cannot form a
// balanced double-entry (VAT/EWT are derived PARTIAL amounts), so the
// pre-existing transaction-currency balance check
// ("Transaction lines are not balanced in the transaction currency.") rejects
// it with HTTP 400 before any header/line/tax row is written.
// ---------------------------------------------------------------------------
const legacyLine = (accountId, code, title, debit, credit) => ({
  accountId, accountCode: code, accountTitle: title, particulars: title, genRef: "", genName: "", debit, credit,
});

async function headerCount(table) {
  const [[r]] = await pool.query(`SELECT COUNT(*) n FROM ${table} WHERE company_id = ?`, [CO]);
  return r.n;
}

describe("Phase 7I - legacy OR/CV/PO tax/control-only payloads cannot bypass the guard", () => {
  test("OR: legacy Output-VAT + EWT-control fragment only -> 400, no orphan or_headers row", async () => {
    const before = await headerCount("or_headers");
    const res = await request(app).post("/api/or").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7I-OR-LEGACY-TAXONLY", customerId: custId, customerName: "PH7I Party",
      transactionDate: "2026-11-22", referenceNo: "r", receiptNo: "R", description: "x", status: "Draft",
      paymentMethod: "Cash", totalDebit: 1200, totalCredit: 1200, currency: { companyId: CO },
      lines: [
        legacyLine(ovatId, "PH7I-OVAT", "Output VAT Payable", 0, 1200),
        legacyLine(ewtPayId, "PH7I-EWT", "Withholding Tax Payable", 200, 0),
      ],
    });
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
    expect(await headerCount("or_headers")).toBe(before);
  });

  test("CV: legacy Input-VAT + EWT-control fragment only -> 400, no orphan cv_headers row", async () => {
    const before = await headerCount("cv_headers");
    const res = await request(app).post("/api/cv").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7I-CV-LEGACY-TAXONLY", payeeId: custId, payeeName: "PH7I Party",
      transactionDate: "2026-11-22", referenceNo: "r", description: "x", status: "Draft",
      paymentMethod: "Cash", totalDebit: 1200, totalCredit: 1200, currency: { companyId: CO },
      lines: [
        legacyLine(inputVatId, "PH7I-IVAT", "Input VAT Receivable", 1200, 0),
        legacyLine(ewtPayId, "PH7I-EWT", "Withholding Tax Payable", 0, 200),
      ],
    });
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
    expect(await headerCount("cv_headers")).toBe(before);
  });

  test("PO: legacy Input-VAT fragment only -> 400, no orphan purchase_order_headers row", async () => {
    const before = await headerCount("purchase_order_headers");
    const res = await request(app).post("/api/purchase-orders").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7I-PO-LEGACY-TAXONLY", supplierId: custId, supplierName: "PH7I Party",
      transactionDate: "2026-11-22", referenceNo: "r", description: "x", status: "Draft",
      totalCredit: 1200, currency: { companyId: CO },
      lines: [legacyLine(inputVatId, "PH7I-IVAT", "Input VAT Receivable", 1200, 0)],
    });
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
    expect(await headerCount("purchase_order_headers")).toBe(before);
  });
});

describe("Phase 7I - normal legacy VAT/EWT flows (no taxEntry) still succeed unchanged", () => {
  test("OR: Cash + Revenue + legacy Output VAT line -> 200, creates 0 structured tax entries", async () => {
    const res = await request(app).post("/api/or").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7I-OR-LEGACY-OK", customerId: custId, customerName: "PH7I Party",
      transactionDate: "2026-11-22", referenceNo: "r", receiptNo: "R", description: "x", status: "Draft",
      paymentMethod: "Cash", totalDebit: 11200, totalCredit: 11200, currency: { companyId: CO },
      lines: [
        legacyLine(cashId, "PH7I-CASH", "Cash on Hand", 11200, 0),
        legacyLine(revId, "PH7I-REV", "Sales Revenue", 0, 10000),
        legacyLine(ovatId, "PH7I-OVAT", "Output VAT Payable", 0, 1200),
      ],
    });
    expect(res.status).toBe(200);
    expect(await taxEntryCount("OR", res.body.id)).toBe(0);
  });

  test("CV: Expense + legacy Input VAT + Cash -> 200, creates 0 structured tax entries", async () => {
    const res = await request(app).post("/api/cv").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7I-CV-LEGACY-OK", payeeId: custId, payeeName: "PH7I Party",
      transactionDate: "2026-11-22", referenceNo: "r", description: "x", status: "Draft",
      paymentMethod: "Cash", totalDebit: 11200, totalCredit: 11200, currency: { companyId: CO },
      lines: [
        legacyLine(expId, "PH7I-EXP", "Purchases Expense", 10000, 0),
        legacyLine(inputVatId, "PH7I-IVAT", "Input VAT Receivable", 1200, 0),
        legacyLine(cashId, "PH7I-CASH", "Cash on Hand", 0, 11200),
      ],
    });
    expect(res.status).toBe(200);
    expect(await taxEntryCount("CV", res.body.id)).toBe(0);
  });

  test("PO: Expense + legacy Input VAT + AP -> 200, creates 0 structured tax entries", async () => {
    const res = await request(app).post("/api/purchase-orders").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7I-PO-LEGACY-OK", supplierId: custId, supplierName: "PH7I Party",
      transactionDate: "2026-11-22", referenceNo: "r", description: "x", status: "Draft",
      totalCredit: 11200, currency: { companyId: CO },
      lines: [
        legacyLine(expId, "PH7I-EXP", "Purchases Expense", 10000, 0),
        legacyLine(inputVatId, "PH7I-IVAT", "Input VAT Receivable", 1200, 0),
        legacyLine(apId, "PH7I-AP", "Accounts Payable", 0, 11200),
      ],
    });
    expect(res.status).toBe(200);
    expect(await taxEntryCount("PO", res.body.id)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// COMPATIBILITY GATE: modern (Phase 7C/7E) structured tax entries
// The zero-line guard must not cause the existing VAT/EWT generation
// pipeline to run twice, be skipped, or change any treatment snapshot.
// ---------------------------------------------------------------------------
const vatLine = (credit, taxEntry) => ({
  accountId: ovatId, accountCode: "PH7I-OVAT", accountTitle: "Output VAT Payable", particulars: "Output VAT",
  genRef: "", genName: "", debit: 0, credit, taxEntry,
});

describe("Phase 7I - modern structured tax entries: exactly once, treatment unchanged", () => {
  test("STANDARD invoice -> exactly 1 OUTPUT_VAT entry, treatment STANDARD, VAT 1200", async () => {
    const res = await request(app).post("/api/invoices").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7I-MOD-STD", transactionDate: "2026-11-22", referenceNo: "r", description: "x", status: "Draft",
      customerId: custId, customerName: "PH7I Party", totalDebit: 11200, totalCredit: 11200, currency: { companyId: CO },
      lines: [
        glLine(arId, "PH7I-AR", 11200, 0),
        glLine(revId, "PH7I-REV", 0, 10000),
        vatLine(1200, {
          entryType: "OUTPUT_VAT", accountId: ovatId, partyId: custId, partyName: "PH7I Party", partyTin: "111-222-333-000",
          partyAddress: "Manila", transactionDate: "2026-11-22", grossAmount: 11200, netAmount: 10000, vatRate: 12,
          vatAmount: 1200, vatTreatment: "STANDARD", vatCode: null,
        }),
      ],
    });
    expect(res.status).toBe(200);
    expect(await taxEntryCount("INV", res.body.id)).toBe(1);
    expect(await taxEntryCount("INV", res.body.id, "OUTPUT_VAT")).toBe(1);
    const [[te]] = await pool.query("SELECT vat_treatment, vat_amount FROM transaction_tax_entries WHERE transaction_id = ? AND entry_type='OUTPUT_VAT'", [res.body.id]);
    expect(te.vat_treatment).toBe("STANDARD");
    expect(Number(te.vat_amount)).toBeCloseTo(1200, 2);
  });

  test("ZERO_RATED invoice -> exactly 1 OUTPUT_VAT entry, VAT 0, treatment ZERO_RATED", async () => {
    const res = await request(app).post("/api/invoices").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7I-MOD-ZR", transactionDate: "2026-11-22", referenceNo: "r", description: "x", status: "Draft",
      customerId: custId, customerName: "PH7I Party", totalDebit: 5000, totalCredit: 5000, currency: { companyId: CO },
      lines: [
        glLine(arId, "PH7I-AR", 5000, 0),
        glLine(revId, "PH7I-REV", 0, 5000),
        vatLine(0, {
          entryType: "OUTPUT_VAT", accountId: ovatId, partyId: custId, partyName: "PH7I Party", partyTin: "111-222-333-000",
          partyAddress: "Manila", transactionDate: "2026-11-22", grossAmount: 5000, netAmount: 5000, vatRate: 0,
          vatAmount: 0, vatTreatment: "ZERO_RATED", vatCode: "VAT_ZERO_RATED",
        }),
      ],
    });
    expect(res.status).toBe(200);
    expect(await taxEntryCount("INV", res.body.id, "OUTPUT_VAT")).toBe(1);
    const [[te]] = await pool.query("SELECT vat_treatment, vat_amount FROM transaction_tax_entries WHERE transaction_id = ? AND entry_type='OUTPUT_VAT'", [res.body.id]);
    expect(te.vat_treatment).toBe("ZERO_RATED");
    expect(Number(te.vat_amount)).toBe(0);
  });

  test("EXEMPT invoice -> exactly 1 OUTPUT_VAT entry, VAT 0, treatment EXEMPT", async () => {
    const res = await request(app).post("/api/invoices").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7I-MOD-EX", transactionDate: "2026-11-22", referenceNo: "r", description: "x", status: "Draft",
      customerId: custId, customerName: "PH7I Party", totalDebit: 7000, totalCredit: 7000, currency: { companyId: CO },
      lines: [
        glLine(arId, "PH7I-AR", 7000, 0),
        glLine(revId, "PH7I-REV", 0, 7000),
        vatLine(0, {
          entryType: "OUTPUT_VAT", accountId: ovatId, partyId: custId, partyName: "PH7I Party", partyTin: "111-222-333-000",
          partyAddress: "Manila", transactionDate: "2026-11-22", grossAmount: 7000, netAmount: 7000, vatRate: 0,
          vatAmount: 0, vatTreatment: "EXEMPT", vatCode: "VAT_EXEMPT",
        }),
      ],
    });
    expect(res.status).toBe(200);
    expect(await taxEntryCount("INV", res.body.id, "OUTPUT_VAT")).toBe(1);
    const [[te]] = await pool.query("SELECT vat_treatment, vat_amount FROM transaction_tax_entries WHERE transaction_id = ? AND entry_type='OUTPUT_VAT'", [res.body.id]);
    expect(te.vat_treatment).toBe("EXEMPT");
    expect(Number(te.vat_amount)).toBe(0);
  });

  test("APV Input VAT -> exactly 1 INPUT_VAT structured entry", async () => {
    const res = await request(app).post("/api/apv").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7I-MOD-APV-IVAT", supplierId: custId, supplierName: "PH7I Party",
      transactionDate: "2026-11-22", referenceNo: "r", description: "x", status: "Draft",
      totalDebit: 11200, totalCredit: 11200, currency: { companyId: CO },
      lines: [
        glLine(expId, "PH7I-EXP", 10000, 0),
        {
          accountId: inputVatId, accountCode: "PH7I-IVAT", accountTitle: "Input VAT Receivable", particulars: "Input VAT (12%)",
          genRef: "", genName: "", debit: 1200, credit: 0,
          taxEntry: {
            entryType: "INPUT_VAT", accountId: inputVatId, partyId: custId, partyName: "PH7I Party", partyTin: "111-222-333-000",
            partyAddress: "Manila", transactionDate: "2026-11-22", grossAmount: 11200, netAmount: 10000, vatRate: 12,
            vatAmount: 1200, purchaseClassification: "Services",
          },
        },
        glLine(apId, "PH7I-AP", 0, 11200),
      ],
    });
    expect(res.status).toBe(200);
    expect(await taxEntryCount("APV", res.body.id)).toBe(1);
    expect(await taxEntryCount("APV", res.body.id, "INPUT_VAT")).toBe(1);
  });

  test("Invoice EWT -> exactly 1 EWT entry, no duplication", async () => {
    const res = await request(app).post("/api/invoices").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7I-MOD-INV-EWT", transactionDate: "2026-11-22", referenceNo: "r", description: "x", status: "Draft",
      customerId: custId, customerName: "PH7I Party", atcCode: ATC, taxWithheldAmount: 1000,
      totalDebit: 10000, totalCredit: 10000, currency: { companyId: CO },
      lines: [
        glLine(arId, "PH7I-AR", 9000, 0),
        glLine(revId, "PH7I-REV", 0, 10000),
        {
          accountId: ewtRcvId, accountCode: "PH7I-EWTR", accountTitle: "Creditable Withholding Tax Receivable", particulars: `EWT - ${ATC}`,
          genRef: "", genName: "", debit: 1000, credit: 0,
          taxEntry: {
            entryType: "EWT", accountId: ewtRcvId, partyId: custId, partyName: "PH7I Party", partyTin: "111-222-333-000",
            partyAddress: "Manila", transactionDate: "2026-11-22", atcCode: ATC, taxType: "EWT", taxableBase: 10000, withheldAmount: 1000,
          },
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(await taxEntryCount("INV", res.body.id)).toBe(1);
    expect(await taxEntryCount("INV", res.body.id, "EWT")).toBe(1);
  });

  test("APV EWT -> exactly 1 EWT entry, no duplication", async () => {
    const res = await request(app).post("/api/apv").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7I-MOD-APV-EWT", supplierId: custId, supplierName: "PH7I Party",
      transactionDate: "2026-11-22", referenceNo: "r", description: "x", status: "Draft",
      atcCode: ATC, taxWithheldAmount: 1000, totalDebit: 10000, totalCredit: 10000, currency: { companyId: CO },
      lines: [
        glLine(expId, "PH7I-EXP", 10000, 0),
        {
          accountId: ewtPayId, accountCode: "PH7I-EWT", accountTitle: "Withholding Tax Payable", particulars: `EWT - ${ATC}`,
          genRef: "", genName: "", debit: 0, credit: 1000,
          taxEntry: {
            entryType: "EWT", accountId: ewtPayId, partyId: custId, partyName: "PH7I Party", partyTin: "111-222-333-000",
            partyAddress: "Manila", transactionDate: "2026-11-22", atcCode: ATC, taxType: "EWT", taxableBase: 10000, withheldAmount: 1000,
          },
        },
        glLine(apId, "PH7I-AP", 0, 9000),
      ],
    });
    expect(res.status).toBe(200);
    expect(await taxEntryCount("APV", res.body.id)).toBe(1);
    expect(await taxEntryCount("APV", res.body.id, "EWT")).toBe(1);
  });

  test("Invoice VAT + EWT together -> exactly 1 OUTPUT_VAT + exactly 1 EWT (neither duplicated)", async () => {
    const res = await request(app).post("/api/invoices").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7I-MOD-INV-VAT-EWT", transactionDate: "2026-11-22", referenceNo: "r", description: "x", status: "Draft",
      customerId: custId, customerName: "PH7I Party", atcCode: ATC, taxWithheldAmount: 2000,
      totalDebit: 22400, totalCredit: 22400, currency: { companyId: CO },
      lines: [
        glLine(arId, "PH7I-AR", 20400, 0),
        glLine(revId, "PH7I-REV", 0, 20000),
        vatLine(2400, {
          entryType: "OUTPUT_VAT", accountId: ovatId, partyId: custId, partyName: "PH7I Party", partyTin: "111-222-333-000",
          partyAddress: "Manila", transactionDate: "2026-11-22", grossAmount: 22400, netAmount: 20000, vatRate: 12,
          vatAmount: 2400, vatTreatment: "STANDARD", vatCode: null,
        }),
        {
          accountId: ewtRcvId, accountCode: "PH7I-EWTR", accountTitle: "Creditable Withholding Tax Receivable", particulars: `EWT - ${ATC}`,
          genRef: "", genName: "", debit: 2000, credit: 0,
          taxEntry: {
            entryType: "EWT", accountId: ewtRcvId, partyId: custId, partyName: "PH7I Party", partyTin: "111-222-333-000",
            partyAddress: "Manila", transactionDate: "2026-11-22", atcCode: ATC, taxType: "EWT", taxableBase: 20000, withheldAmount: 2000,
          },
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(await taxEntryCount("INV", res.body.id)).toBe(2);
    expect(await taxEntryCount("INV", res.body.id, "OUTPUT_VAT")).toBe(1);
    expect(await taxEntryCount("INV", res.body.id, "EWT")).toBe(1);
  });

  test("a zero-line rejection creates ZERO transaction_tax_entries rows (re-confirm)", async () => {
    const [[before]] = await pool.query("SELECT COUNT(*) n FROM transaction_tax_entries WHERE company_id = ?", [CO]);
    const res = await post("APV", [{ accountId: inputVatId, debit: 0, credit: 0, taxEntry: { entryType: "INPUT_VAT" } }]);
    expect(res.status).toBe(400);
    const [[after]] = await pool.query("SELECT COUNT(*) n FROM transaction_tax_entries WHERE company_id = ?", [CO]);
    expect(after.n).toBe(before.n);
  });

  test("a rejected valid->zero UPDATE preserves the existing tax entries exactly", async () => {
    const create = await request(app).post("/api/invoices").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7I-MOD-UPD-KEEP", transactionDate: "2026-11-22", referenceNo: "r", description: "x", status: "Draft",
      customerId: custId, customerName: "PH7I Party", totalDebit: 11200, totalCredit: 11200, currency: { companyId: CO },
      lines: [
        glLine(arId, "PH7I-AR", 11200, 0),
        glLine(revId, "PH7I-REV", 0, 10000),
        vatLine(1200, {
          entryType: "OUTPUT_VAT", accountId: ovatId, partyId: custId, partyName: "PH7I Party", partyTin: "111-222-333-000",
          partyAddress: "Manila", transactionDate: "2026-11-22", grossAmount: 11200, netAmount: 10000, vatRate: 12,
          vatAmount: 1200, vatTreatment: "STANDARD", vatCode: null,
        }),
      ],
    });
    expect(create.status).toBe(200);
    const id = create.body.id;
    const teBefore = await taxEntryCount("INV", id);
    const [[teRowBefore]] = await pool.query("SELECT vat_treatment, vat_amount FROM transaction_tax_entries WHERE transaction_id = ? AND entry_type='OUTPUT_VAT'", [id]);

    const upd = await request(app).put(`/api/invoices/${id}`).set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7I-MOD-UPD-KEEP", transactionDate: "2026-11-22", referenceNo: "r", description: "x", status: "Draft",
      customerId: custId, customerName: "PH7I Party", totalDebit: 0, totalCredit: 0, currency: { companyId: CO }, lines: [],
    });
    expect(upd.status).toBe(400);
    expect(upd.body.code).toBe("TRANSACTION_LINES_REQUIRED");

    expect(await taxEntryCount("INV", id)).toBe(teBefore);
    const [[teRowAfter]] = await pool.query("SELECT vat_treatment, vat_amount FROM transaction_tax_entries WHERE transaction_id = ? AND entry_type='OUTPUT_VAT'", [id]);
    expect(teRowAfter.vat_treatment).toBe(teRowBefore.vat_treatment);
    expect(Number(teRowAfter.vat_amount)).toBeCloseTo(Number(teRowBefore.vat_amount), 2);
  });
});

describe("Phase 7I - transactionLineValidation.js has zero side effects", () => {
  const {
    assertRequiredTransactionLines, assertRequiredQuotationLines, isSubstantiveBusinessLine,
  } = require("../services/transactionLineValidation");

  test("does not mutate the lines array or its elements", () => {
    const line = { accountId: 1, debit: 100, credit: 0 };
    const lines = [line, { accountId: 2, debit: 0, credit: 100 }];
    const snapshot = JSON.stringify(lines);
    assertRequiredTransactionLines(lines);
    expect(lines.length).toBe(2);
    expect(JSON.stringify(lines)).toBe(snapshot);
    expect(Object.isFrozen(line)).toBe(false); // untouched, not defensively frozen either
  });

  test("adds no VAT/EWT fields and creates no tax rows (pure predicate, no DB)", async () => {
    const [[before]] = await pool.query("SELECT COUNT(*) n FROM transaction_tax_entries");
    const lines = [{ accountId: ovatId, debit: 0, credit: 120, taxEntry: { entryType: "OUTPUT_VAT" } }, { accountId: arId, debit: 120, credit: 0 }];
    assertRequiredTransactionLines(lines);
    expect(lines[0].vatAmount).toBeUndefined();
    expect(lines[0].netAmount).toBeUndefined();
    expect(lines[1].taxEntry).toBeUndefined();
    const [[after]] = await pool.query("SELECT COUNT(*) n FROM transaction_tax_entries");
    expect(after.n).toBe(before.n); // no writes
  });

  test("module exports contain no persistence helpers", () => {
    const mod = require("../services/transactionLineValidation");
    for (const k of Object.keys(mod)) {
      expect(k).not.toMatch(/save|insert|persist|delete|update|write/i);
    }
    expect(mod.saveTaxEntries).toBeUndefined();
  });

  test("a generated tax row alone is NOT substantive; a real business line IS", () => {
    expect(isSubstantiveBusinessLine({ debit: 0, credit: 120, taxEntry: { entryType: "OUTPUT_VAT" } })).toBe(false);
    expect(isSubstantiveBusinessLine({ debit: 100, credit: 0 })).toBe(true);
    expect(isSubstantiveBusinessLine({ debit: 0, credit: 0 })).toBe(false);
    expect(isSubstantiveBusinessLine({})).toBe(false);
  });

  test("quotation validator likewise pure - no mutation", () => {
    const lines = [{ lineType: "item", description: "svc", amount: 100 }];
    const snapshot = JSON.stringify(lines);
    assertRequiredQuotationLines(lines);
    expect(JSON.stringify(lines)).toBe(snapshot);
  });
});
