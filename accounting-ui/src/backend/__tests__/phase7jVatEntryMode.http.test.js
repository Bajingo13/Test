const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const CurrencyService = require("../services/currencyService");
const PrintDataService = require("../services/transactionPrintDataService");

// Phase 7J: VAT Inclusive / Exclusive entry mode. A remembered-input
// snapshot (transaction_tax_entries.vat_entry_mode) that never alters a
// stored amount, report figure, or print value. INCLUSIVE (default / NULL)
// keeps the historical behavior; EXCLUSIVE lets the user type the pre-VAT
// base, the modal derives the gross, and the SAME payload flows to the
// unchanged backend path.

jest.setTimeout(200000);

let CO, userId, token;
let arId, revId, ovatId, ivatId, expId, apId, ewtRcvId, ewtPayId;
let custId;
const ATC = "PH7J-WC010"; // 10% EWT fixture

async function mkAcc(code, title, cls) {
  const [r] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, cls]
  );
  return r.insertId;
}

beforeAll(async () => {
  assertNotProductionDatabase();
  const [c] = await pool.execute("INSERT INTO companies (name, status) VALUES ('PH7J Co', 'Active')");
  CO = c.insertId;
  const hash = await bcrypt.hash("Ph7jPass!1", 10);
  const [u] = await pool.execute("INSERT INTO users (username, password, role_id, status) VALUES ('ph7j_admin', ?, 2, 'ACTIVE')", [hash]);
  userId = u.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, CO]);
  token = (await request(app).post("/api/login").send({ username: "ph7j_admin", password: "Ph7jPass!1" })).body.token;
  await CurrencyService.createCurrency({ id: userId, roleCode: "ADMIN" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "P",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: CO,
  });
  arId = await mkAcc("PH7J-AR", "Accounts Receivable", "ASSET");
  revId = await mkAcc("PH7J-REV", "Sales Revenue", "INCOME");
  ovatId = await mkAcc("PH7J-OVAT", "Output VAT Payable", "LIABILITY");
  ivatId = await mkAcc("PH7J-IVAT", "Input VAT Receivable", "ASSET");
  expId = await mkAcc("PH7J-EXP", "Purchases Expense", "EXPENSE");
  apId = await mkAcc("PH7J-AP", "Accounts Payable", "LIABILITY");
  ewtRcvId = await mkAcc("PH7J-EWTR", "Creditable Withholding Tax Receivable", "ASSET");
  ewtPayId = await mkAcc("PH7J-EWTP", "Withholding Tax Payable", "LIABILITY");
  const [p] = await pool.execute("INSERT INTO general_libraries (company_id, code, party_type, name, status, tin, address1) VALUES (?, 'PH7J-C', 'BOTH', 'PH7J Party', 'ACTIVE', '111-222-333-000', 'Manila')", [CO]);
  custId = p.insertId;
  await pool.execute("INSERT INTO ewt_library (atc_code, description, rate, tax_type, status) VALUES (?, 'PH7J fixture', 10, 'EWT', 'ACTIVE')", [ATC]);
});

afterAll(async () => {
  await pool.query("DELETE FROM transaction_tax_entries WHERE company_id = ?", [CO]);
  for (const t of ["invoice", "apv"]) {
    await pool.query(`DELETE ln FROM ${t}_lines ln JOIN ${t}_headers hd ON hd.id = ln.${t}_id WHERE hd.company_id = ?`, [CO]);
    await pool.query(`DELETE FROM ${t}_headers WHERE company_id = ?`, [CO]);
  }
  await pool.query("DELETE l FROM quotation_lines l JOIN quotation_headers h ON h.id = l.quotation_id WHERE h.company_id = ?", [CO]);
  await pool.query("DELETE FROM quotation_headers WHERE company_id = ?", [CO]);
  await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id = ?", [CO]);
  await pool.query("DELETE FROM general_libraries WHERE company_id = ?", [CO]);
  await pool.query("DELETE FROM currencies WHERE company_id = ?", [CO]);
  await pool.query("DELETE FROM user_companies WHERE user_id = ?", [userId]);
  await pool.query("DELETE FROM users WHERE id = ?", [userId]);
  await pool.query("DELETE FROM companies WHERE id = ?", [CO]);
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'PH7J-%'");
  await pool.query("DELETE FROM ewt_library WHERE atc_code = ?", [ATC]);
  await pool.end();
});

const gl = (accountId, code, debit, credit) => ({
  accountId, accountCode: code, accountTitle: code, particulars: "x", genRef: "", genName: "", debit, credit,
});

// A modern OUTPUT_VAT journal line + taxEntry, exactly as the client modal
// builds it. `mode` and treatment drive the amounts.
function outputVatLine({ base, rate = 12, treatment = "STANDARD", mode }) {
  let gross, net, vat;
  if (treatment === "STANDARD") {
    if (mode === "EXCLUSIVE") { net = base; vat = Math.round(base * rate) / 100; gross = Math.round((base + vat) * 100) / 100; }
    else { gross = base; net = Math.round((base / (1 + rate / 100)) * 100) / 100; vat = Math.round((gross - net) * 100) / 100; }
  } else {
    gross = base; net = base; vat = 0; rate = 0;
  }
  return {
    line: {
      accountId: ovatId, accountCode: "PH7J-OVAT", accountTitle: "Output VAT Payable",
      particulars: "Output VAT", genRef: "", genName: "", debit: 0, credit: vat,
      taxEntry: {
        entryType: "OUTPUT_VAT", accountId: ovatId, partyId: custId, partyName: "PH7J Party",
        partyTin: "111-222-333-000", partyAddress: "Manila", transactionDate: "2026-11-22",
        grossAmount: gross, netAmount: net, vatRate: rate, vatAmount: vat,
        vatTreatment: treatment, vatCode: treatment === "ZERO_RATED" ? "VAT_ZERO_RATED" : treatment === "EXEMPT" ? "VAT_EXEMPT" : null,
        vatEntryMode: mode,
      },
    },
    gross, net, vat,
  };
}

async function createInvoice({ voucherNo, lines, totalDebit, totalCredit, status = "Draft", atcCode, taxWithheldAmount }) {
  return request(app).post("/api/invoices").set("Authorization", `Bearer ${token}`).send({
    voucherNo, transactionDate: "2026-11-22", referenceNo: "r", description: "ph7j", status,
    customerId: custId, customerName: "PH7J Party", totalDebit, totalCredit, currency: { companyId: CO },
    ...(atcCode ? { atcCode, taxWithheldAmount } : {}),
    lines,
  });
}

async function taxRows(type, id) {
  const [rows] = await pool.query(
    "SELECT entry_type, gross_amount, net_amount, vat_amount, vat_rate, vat_treatment, vat_entry_mode FROM transaction_tax_entries WHERE transaction_type = ? AND transaction_id = ? ORDER BY id",
    [type, id]
  );
  return rows;
}

// ---------------------------------------------------------------------------
describe("Phase 7J - INCLUSIVE mode: existing behavior unchanged", () => {
  test("INCLUSIVE 10,000 gross @ 12% -> net 8,928.57 / VAT 1,071.43 / gross 10,000; mode persisted INCLUSIVE", async () => {
    const v = outputVatLine({ base: 10000, mode: "INCLUSIVE" });
    const res = await createInvoice({
      voucherNo: "PH7J-INC-1", totalDebit: 10000, totalCredit: 10000,
      lines: [gl(arId, "PH7J-AR", 10000, 0), gl(revId, "PH7J-REV", 0, v.net), v.line],
    });
    expect(res.status).toBe(200);
    const rows = await taxRows("INV", res.body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].entry_type).toBe("OUTPUT_VAT");
    expect(Number(rows[0].net_amount)).toBeCloseTo(8928.57, 2);
    expect(Number(rows[0].vat_amount)).toBeCloseTo(1071.43, 2);
    expect(Number(rows[0].gross_amount)).toBe(10000);
    expect(rows[0].vat_entry_mode).toBe("INCLUSIVE");
    expect(rows[0].vat_treatment).toBe("STANDARD");
  });
});

describe("Phase 7J - EXCLUSIVE mode", () => {
  test("EXCLUSIVE base 10,000 @ 12% -> net 10,000 / VAT 1,200 / gross 11,200; exactly 1 OUTPUT_VAT; mode EXCLUSIVE persisted", async () => {
    const v = outputVatLine({ base: 10000, mode: "EXCLUSIVE" });
    expect([v.gross, v.net, v.vat]).toEqual([11200, 10000, 1200]);
    const res = await createInvoice({
      voucherNo: "PH7J-EXC-1", totalDebit: 11200, totalCredit: 11200,
      lines: [gl(arId, "PH7J-AR", 11200, 0), gl(revId, "PH7J-REV", 0, 10000), v.line],
    });
    expect(res.status).toBe(200);
    const rows = await taxRows("INV", res.body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].entry_type).toBe("OUTPUT_VAT");
    expect(Number(rows[0].net_amount)).toBe(10000);
    expect(Number(rows[0].vat_amount)).toBe(1200);
    expect(Number(rows[0].gross_amount)).toBe(11200);
    expect(rows[0].vat_entry_mode).toBe("EXCLUSIVE");
    expect(rows[0].vat_treatment).toBe("STANDARD");
  });

  test("EXCLUSIVE rounding edge: base 333.33 @ 12% -> VAT 40.00 / gross 373.33, net+vat===gross", async () => {
    const v = outputVatLine({ base: 333.33, mode: "EXCLUSIVE" });
    expect([v.net, v.vat, v.gross]).toEqual([333.33, 40, 373.33]);
    const res = await createInvoice({
      voucherNo: "PH7J-EXC-RND", totalDebit: 373.33, totalCredit: 373.33,
      lines: [gl(arId, "PH7J-AR", 373.33, 0), gl(revId, "PH7J-REV", 0, 333.33), v.line],
    });
    expect(res.status).toBe(200);
    const rows = await taxRows("INV", res.body.id);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].net_amount) + Number(rows[0].vat_amount)).toBeCloseTo(Number(rows[0].gross_amount), 2);
    expect(rows[0].vat_entry_mode).toBe("EXCLUSIVE");
  });
});

describe("Phase 7J - invalid mode rejected", () => {
  test("unknown vat_entry_mode -> 400 INVALID_VAT_ENTRY_MODE, nothing persisted", async () => {
    const v = outputVatLine({ base: 10000, mode: "EXCLUSIVE" });
    v.line.taxEntry.vatEntryMode = "GROSS_ISH";
    const [[before]] = await pool.query("SELECT COUNT(*) n FROM invoice_headers WHERE company_id = ?", [CO]);
    const res = await createInvoice({
      voucherNo: "PH7J-BADMODE", totalDebit: 11200, totalCredit: 11200,
      lines: [gl(arId, "PH7J-AR", 11200, 0), gl(revId, "PH7J-REV", 0, 10000), v.line],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_VAT_ENTRY_MODE");
    expect(res.body.message).not.toMatch(/SQL|SELECT|INSERT|ER_/i);
    const [[after]] = await pool.query("SELECT COUNT(*) n FROM invoice_headers WHERE company_id = ?", [CO]);
    expect(after.n).toBe(before.n);
  });

  test("omitted mode is accepted (behaves as INCLUSIVE) and stores NULL", async () => {
    const v = outputVatLine({ base: 10000, mode: "INCLUSIVE" });
    delete v.line.taxEntry.vatEntryMode;
    const res = await createInvoice({
      voucherNo: "PH7J-NOMODE", totalDebit: 10000, totalCredit: 10000,
      lines: [gl(arId, "PH7J-AR", 10000, 0), gl(revId, "PH7J-REV", 0, v.net), v.line],
    });
    expect(res.status).toBe(200);
    const rows = await taxRows("INV", res.body.id);
    expect(rows[0].vat_entry_mode).toBeNull();
  });
});

describe("Phase 7J - historical NULL reads as INCLUSIVE", () => {
  test("a directly-inserted OUTPUT_VAT row with vat_entry_mode NULL loads with vatEntryMode null and reports correctly", async () => {
    const [h] = await pool.execute(
      `INSERT INTO invoice_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, reference_no, description, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
       VALUES (?, 'PH7J-HIST', ?, 'PH7J Party', '2026-11-22', 'r', 'hist', 11200, 11200, 0, 11200, 'Unpaid', 'Posted')`,
      [CO, custId]
    );
    const invId = h.insertId;
    const [l1] = await pool.execute(
      `INSERT INTO invoice_lines (invoice_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'PH7J-AR', 'Accounts Receivable', 'AR', 11200, 0)`, [invId, arId]
    );
    await pool.execute(`INSERT INTO invoice_lines (invoice_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'PH7J-REV', 'Sales Revenue', 'Rev', 0, 10000)`, [invId, revId]);
    const [lv] = await pool.execute(`INSERT INTO invoice_lines (invoice_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'PH7J-OVAT', 'Output VAT Payable', 'VAT', 0, 1200)`, [invId, ovatId]);
    await pool.execute(
      `INSERT INTO transaction_tax_entries (company_id, transaction_type, transaction_id, line_id, entry_type, transaction_date, gross_amount, net_amount, vat_rate, vat_amount, vat_treatment, account_id)
       VALUES (?, 'INV', ?, ?, 'OUTPUT_VAT', '2026-11-22', 11200, 10000, 12, 1200, 'STANDARD', ?)`,
      [CO, invId, lv.insertId, ovatId]
    );

    const detail = await request(app).get(`/api/invoices/${invId}`).set("Authorization", `Bearer ${token}`).query({ companyId: CO });
    expect(detail.status).toBe(200);
    const te = detail.body.taxEntries.find((e) => e.entryType === "OUTPUT_VAT");
    expect(te.vatEntryMode == null).toBe(true);

    const report = await request(app).get("/api/reports/output-vat").set("Authorization", `Bearer ${token}`)
      .query({ companyId: CO, from: "2026-11-01", to: "2026-11-30" });
    const row = report.body.rows.find((r) => r.docRef === "PH7J-HIST");
    expect(row).toBeTruthy();
    expect(Number(row.vatableSales)).toBe(10000);
    expect(Number(row.vatAmount)).toBe(1200);
  });
});

describe("Phase 7J - treatment x mode", () => {
  for (const treatment of ["ZERO_RATED", "EXEMPT"]) {
    for (const mode of ["INCLUSIVE", "EXCLUSIVE"]) {
      test(`${treatment} ${mode}: exactly 1 OUTPUT_VAT entry, VAT 0, treatment preserved, mode snapshot ${mode}`, async () => {
        const v = outputVatLine({ base: 5000, treatment, mode });
        const res = await createInvoice({
          voucherNo: `PH7J-${treatment}-${mode}`, totalDebit: 5000, totalCredit: 5000,
          lines: [gl(arId, "PH7J-AR", 5000, 0), gl(revId, "PH7J-REV", 0, 5000), v.line],
        });
        expect(res.status).toBe(200);
        const rows = await taxRows("INV", res.body.id);
        expect(rows).toHaveLength(1);
        expect(rows[0].vat_treatment).toBe(treatment);
        expect(Number(rows[0].vat_amount)).toBe(0);
        expect(rows[0].vat_entry_mode).toBe(mode);
      });
    }
  }
});

describe("Phase 7J - APV Input VAT Exclusive", () => {
  test("EXCLUSIVE base 10,000 -> 1 INPUT_VAT entry, net 10,000 / VAT 1,200 / gross 11,200, mode EXCLUSIVE", async () => {
    const res = await request(app).post("/api/apv").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7J-APV-EXC", supplierId: custId, supplierName: "PH7J Party",
      transactionDate: "2026-11-22", referenceNo: "r", description: "x", status: "Draft",
      totalDebit: 11200, totalCredit: 11200, currency: { companyId: CO },
      lines: [
        gl(expId, "PH7J-EXP", 10000, 0),
        {
          accountId: ivatId, accountCode: "PH7J-IVAT", accountTitle: "Input VAT Receivable", particulars: "Input VAT",
          genRef: "", genName: "", debit: 1200, credit: 0,
          taxEntry: {
            entryType: "INPUT_VAT", accountId: ivatId, partyId: custId, partyName: "PH7J Party", partyTin: "111-222-333-000",
            partyAddress: "Manila", transactionDate: "2026-11-22", grossAmount: 11200, netAmount: 10000, vatRate: 12,
            vatAmount: 1200, vatTreatment: "STANDARD", vatCode: null, purchaseClassification: "Services", vatEntryMode: "EXCLUSIVE",
          },
        },
        gl(apId, "PH7J-AP", 0, 11200),
      ],
    });
    expect(res.status).toBe(200);
    const rows = await taxRows("APV", res.body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].entry_type).toBe("INPUT_VAT");
    expect(Number(rows[0].net_amount)).toBe(10000);
    expect(Number(rows[0].vat_amount)).toBe(1200);
    expect(rows[0].vat_entry_mode).toBe("EXCLUSIVE");
  });
});

describe("Phase 7J - EWT compatibility with EXCLUSIVE VAT", () => {
  test("Invoice EXCLUSIVE VAT + EWT: EWT base 10,000; exactly 1 OUTPUT_VAT + 1 EWT, no duplication", async () => {
    const v = outputVatLine({ base: 10000, mode: "EXCLUSIVE" }); // gross 11200, vat 1200
    // EWT 10% on the VAT-exclusive base 10,000 = 1,000.
    const res = await createInvoice({
      voucherNo: "PH7J-EXC-EWT", totalDebit: 11200, totalCredit: 11200, atcCode: ATC, taxWithheldAmount: 1000,
      lines: [
        gl(arId, "PH7J-AR", 10200, 0), // 11200 gross - 1000 withheld
        gl(revId, "PH7J-REV", 0, 10000),
        v.line,
        {
          accountId: ewtRcvId, accountCode: "PH7J-EWTR", accountTitle: "Creditable Withholding Tax Receivable", particulars: `EWT - ${ATC}`,
          genRef: "", genName: "", debit: 1000, credit: 0,
          taxEntry: {
            entryType: "EWT", accountId: ewtRcvId, partyId: custId, partyName: "PH7J Party", partyTin: "111-222-333-000",
            partyAddress: "Manila", transactionDate: "2026-11-22", atcCode: ATC, taxType: "EWT", taxableBase: 10000, withheldAmount: 1000,
          },
        },
      ],
    });
    expect(res.status).toBe(200);
    const rows = await taxRows("INV", res.body.id);
    expect(rows.filter((r) => r.entry_type === "OUTPUT_VAT")).toHaveLength(1);
    expect(rows.filter((r) => r.entry_type === "EWT")).toHaveLength(1);
    expect(rows).toHaveLength(2);
    const [[hdr]] = await pool.query("SELECT taxable_base FROM invoice_headers WHERE id = ?", [res.body.id]);
    expect(Number(hdr.taxable_base)).toBe(10000);
  });

  test("APV EXCLUSIVE VAT + EWT: exactly 1 INPUT_VAT + 1 EWT, no duplication", async () => {
    const res = await request(app).post("/api/apv").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7J-APV-EXC-EWT", supplierId: custId, supplierName: "PH7J Party",
      transactionDate: "2026-11-22", referenceNo: "r", description: "x", status: "Draft",
      atcCode: ATC, taxWithheldAmount: 1000, totalDebit: 11200, totalCredit: 11200, currency: { companyId: CO },
      lines: [
        gl(expId, "PH7J-EXP", 10000, 0),
        {
          accountId: ivatId, accountCode: "PH7J-IVAT", accountTitle: "Input VAT Receivable", particulars: "Input VAT",
          genRef: "", genName: "", debit: 1200, credit: 0,
          taxEntry: {
            entryType: "INPUT_VAT", accountId: ivatId, partyId: custId, partyName: "PH7J Party", partyTin: "111-222-333-000",
            partyAddress: "Manila", transactionDate: "2026-11-22", grossAmount: 11200, netAmount: 10000, vatRate: 12,
            vatAmount: 1200, vatTreatment: "STANDARD", purchaseClassification: "Services", vatEntryMode: "EXCLUSIVE",
          },
        },
        {
          accountId: ewtPayId, accountCode: "PH7J-EWTP", accountTitle: "Withholding Tax Payable", particulars: `EWT - ${ATC}`,
          genRef: "", genName: "", debit: 0, credit: 1000,
          taxEntry: {
            entryType: "EWT", accountId: ewtPayId, partyId: custId, partyName: "PH7J Party", partyTin: "111-222-333-000",
            partyAddress: "Manila", transactionDate: "2026-11-22", atcCode: ATC, taxType: "EWT", taxableBase: 10000, withheldAmount: 1000,
          },
        },
        gl(apId, "PH7J-AP", 0, 10200),
      ],
    });
    expect(res.status).toBe(200);
    const rows = await taxRows("APV", res.body.id);
    expect(rows.filter((r) => r.entry_type === "INPUT_VAT")).toHaveLength(1);
    expect(rows.filter((r) => r.entry_type === "EWT")).toHaveLength(1);
    expect(rows).toHaveLength(2);
  });
});

describe("Phase 7J - Output VAT report + Invoice print for EXCLUSIVE", () => {
  let invId;
  beforeAll(async () => {
    const v = outputVatLine({ base: 10000, mode: "EXCLUSIVE" });
    const res = await createInvoice({
      voucherNo: "PH7J-RPT-EXC", totalDebit: 11200, totalCredit: 11200, status: "Posted",
      lines: [gl(arId, "PH7J-AR", 11200, 0), gl(revId, "PH7J-REV", 0, 10000), v.line],
    });
    expect(res.status).toBe(200);
    invId = res.body.id;
  });

  test("Output VAT report: VATable Sales 10,000 / VAT 1,200 / gross 11,200", async () => {
    const report = await request(app).get("/api/reports/output-vat").set("Authorization", `Bearer ${token}`)
      .query({ companyId: CO, from: "2026-11-01", to: "2026-11-30" });
    expect(report.status).toBe(200);
    const row = report.body.rows.find((r) => r.docRef === "PH7J-RPT-EXC");
    expect(row).toBeTruthy();
    expect(Number(row.vatableSales)).toBe(10000);
    expect(Number(row.vatAmount)).toBe(1200);
    expect(Number(row.grossAmount)).toBe(11200);
  });

  test("Invoice print VAT summary: VATable 10,000 / VAT 1,200 / gross 11,200", async () => {
    const doc = await PrintDataService.getTransactionDocument("invoice", invId, { withEntries: true, companyId: CO });
    expect(doc.outputVat).toBeTruthy();
    expect(Number(doc.outputVat.vatableSales)).toBe(10000);
    expect(Number(doc.outputVat.vatAmount)).toBe(1200);
    expect(Number(doc.outputVat.grossTaxable)).toBe(11200);
  });
});

describe("Phase 7J - duplicate & draft round-trip", () => {
  test("re-POST of an EXCLUSIVE invoice's own taxEntry (duplicate flow) persists EXCLUSIVE on the fresh rows", async () => {
    const v = outputVatLine({ base: 10000, mode: "EXCLUSIVE" });
    const orig = await createInvoice({
      voucherNo: "PH7J-DUP-SRC", totalDebit: 11200, totalCredit: 11200,
      lines: [gl(arId, "PH7J-AR", 11200, 0), gl(revId, "PH7J-REV", 0, 10000), v.line],
    });
    expect(orig.status).toBe(200);
    const detail = await request(app).get(`/api/invoices/${orig.body.id}`).set("Authorization", `Bearer ${token}`).query({ companyId: CO });
    const srcTe = detail.body.taxEntries.find((e) => e.entryType === "OUTPUT_VAT");
    expect(srcTe.vatEntryMode).toBe("EXCLUSIVE");
    // duplicate: strip DB identity, keep the rest (mirrors handleDuplicate)
    const { id: _i, lineId: _l, ...teRest } = srcTe;
    const dup = await createInvoice({
      voucherNo: "PH7J-DUP-COPY", totalDebit: 11200, totalCredit: 11200,
      lines: [
        gl(arId, "PH7J-AR", 11200, 0), gl(revId, "PH7J-REV", 0, 10000),
        { accountId: ovatId, accountCode: "PH7J-OVAT", accountTitle: "Output VAT Payable", particulars: "Output VAT", genRef: "", genName: "", debit: 0, credit: 1200, taxEntry: { entryType: "OUTPUT_VAT", ...teRest } },
      ],
    });
    expect(dup.status).toBe(200);
    const rows = await taxRows("INV", dup.body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].vat_entry_mode).toBe("EXCLUSIVE");
  });

  test("edit a Draft EXCLUSIVE invoice (PUT same payload) -> still 1 entry, mode EXCLUSIVE, values unchanged", async () => {
    const v = outputVatLine({ base: 10000, mode: "EXCLUSIVE" });
    const c = await createInvoice({
      voucherNo: "PH7J-RT-EXC", totalDebit: 11200, totalCredit: 11200,
      lines: [gl(arId, "PH7J-AR", 11200, 0), gl(revId, "PH7J-REV", 0, 10000), v.line],
    });
    expect(c.status).toBe(200);
    const upd = await request(app).put(`/api/invoices/${c.body.id}`).set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7J-RT-EXC", transactionDate: "2026-11-22", referenceNo: "r", description: "x", status: "Draft",
      customerId: custId, customerName: "PH7J Party", totalDebit: 11200, totalCredit: 11200, currency: { companyId: CO },
      lines: [gl(arId, "PH7J-AR", 11200, 0), gl(revId, "PH7J-REV", 0, 10000), v.line],
    });
    expect(upd.status).toBe(200);
    const rows = await taxRows("INV", c.body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].vat_entry_mode).toBe("EXCLUSIVE");
    expect(Number(rows[0].net_amount)).toBe(10000);
    expect(Number(rows[0].vat_amount)).toBe(1200);
  });

  test("Draft INCLUSIVE -> EXCLUSIVE switch on PUT persists EXCLUSIVE with recalculated amounts", async () => {
    const inc = outputVatLine({ base: 11200, mode: "INCLUSIVE" }); // gross 11200 -> net 10000, vat 1200
    const c = await createInvoice({
      voucherNo: "PH7J-SWITCH-1", totalDebit: 11200, totalCredit: 11200,
      lines: [gl(arId, "PH7J-AR", 11200, 0), gl(revId, "PH7J-REV", 0, 10000), inc.line],
    });
    expect(c.status).toBe(200);
    let rows = await taxRows("INV", c.body.id);
    expect(rows[0].vat_entry_mode).toBe("INCLUSIVE");

    const exc = outputVatLine({ base: 10000, mode: "EXCLUSIVE" }); // same economic result, mode flips
    const upd = await request(app).put(`/api/invoices/${c.body.id}`).set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7J-SWITCH-1", transactionDate: "2026-11-22", referenceNo: "r", description: "x", status: "Draft",
      customerId: custId, customerName: "PH7J Party", totalDebit: 11200, totalCredit: 11200, currency: { companyId: CO },
      lines: [gl(arId, "PH7J-AR", 11200, 0), gl(revId, "PH7J-REV", 0, 10000), exc.line],
    });
    expect(upd.status).toBe(200);
    rows = await taxRows("INV", c.body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].vat_entry_mode).toBe("EXCLUSIVE");
    expect(Number(rows[0].vat_amount)).toBe(1200);
  });

  test("Draft EXCLUSIVE -> INCLUSIVE switch on PUT persists INCLUSIVE", async () => {
    const exc = outputVatLine({ base: 10000, mode: "EXCLUSIVE" });
    const c = await createInvoice({
      voucherNo: "PH7J-SWITCH-2", totalDebit: 11200, totalCredit: 11200,
      lines: [gl(arId, "PH7J-AR", 11200, 0), gl(revId, "PH7J-REV", 0, 10000), exc.line],
    });
    expect(c.status).toBe(200);
    const inc = outputVatLine({ base: 11200, mode: "INCLUSIVE" });
    const upd = await request(app).put(`/api/invoices/${c.body.id}`).set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7J-SWITCH-2", transactionDate: "2026-11-22", referenceNo: "r", description: "x", status: "Draft",
      customerId: custId, customerName: "PH7J Party", totalDebit: 11200, totalCredit: 11200, currency: { companyId: CO },
      lines: [gl(arId, "PH7J-AR", 11200, 0), gl(revId, "PH7J-REV", 0, 10000), inc.line],
    });
    expect(upd.status).toBe(200);
    const rows = await taxRows("INV", c.body.id);
    expect(rows[0].vat_entry_mode).toBe("INCLUSIVE");
  });
});

describe("Phase 7J - Posted lock still applies to an EXCLUSIVE invoice", () => {
  test("post an EXCLUSIVE invoice, then PUT -> 409 TRANSACTION_ALREADY_POSTED, tax entry untouched", async () => {
    const v = outputVatLine({ base: 10000, mode: "EXCLUSIVE" });
    const c = await createInvoice({
      voucherNo: "PH7J-POSTED", totalDebit: 11200, totalCredit: 11200, status: "Posted",
      lines: [gl(arId, "PH7J-AR", 11200, 0), gl(revId, "PH7J-REV", 0, 10000), v.line],
    });
    expect(c.status).toBe(200);
    const upd = await request(app).put(`/api/invoices/${c.body.id}`).set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7J-POSTED", transactionDate: "2026-11-22", referenceNo: "r", description: "changed", status: "Draft",
      customerId: custId, customerName: "PH7J Party", totalDebit: 11200, totalCredit: 11200, currency: { companyId: CO },
      lines: [gl(arId, "PH7J-AR", 11200, 0), gl(revId, "PH7J-REV", 0, 10000), outputVatLine({ base: 9000, mode: "EXCLUSIVE" }).line],
    });
    expect(upd.status).toBe(409);
    expect(upd.body.code).toBe("TRANSACTION_ALREADY_POSTED");
    const rows = await taxRows("INV", c.body.id);
    expect(rows[0].vat_entry_mode).toBe("EXCLUSIVE");
    expect(Number(rows[0].vat_amount)).toBe(1200);
  });
});

describe("Phase 7J - prior-phase guards unaffected", () => {
  test("Phase 7I: a payload of only a generated OUTPUT_VAT line (no business line) still -> 400 TRANSACTION_LINES_REQUIRED", async () => {
    const v = outputVatLine({ base: 10000, mode: "EXCLUSIVE" });
    const res = await createInvoice({
      voucherNo: "PH7J-7I", totalDebit: 1200, totalCredit: 1200,
      lines: [v.line],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TRANSACTION_LINES_REQUIRED");
  });

  test("Phase 7G: duplicate voucher (same company) still -> 409 DUPLICATE_VOUCHER_NO", async () => {
    const mk = () => {
      const v = outputVatLine({ base: 10000, mode: "EXCLUSIVE" });
      return createInvoice({
        voucherNo: "PH7J-7G-DUP", totalDebit: 11200, totalCredit: 11200,
        lines: [gl(arId, "PH7J-AR", 11200, 0), gl(revId, "PH7J-REV", 0, 10000), v.line],
      });
    };
    expect((await mk()).status).toBe(200);
    const b = await mk();
    expect(b.status).toBe(409);
    expect(b.body.code).toBe("DUPLICATE_VOUCHER_NO");
  });

  test("company isolation: an EXCLUSIVE invoice for an inaccessible company still -> 403", async () => {
    const [other] = await pool.execute("INSERT INTO companies (name, status) VALUES ('PH7J Other', 'Active')");
    const v = outputVatLine({ base: 10000, mode: "EXCLUSIVE" });
    const res = await request(app).post("/api/invoices").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7J-ISO", transactionDate: "2026-11-22", referenceNo: "r", description: "x", status: "Draft",
      customerId: custId, customerName: "PH7J Party", totalDebit: 11200, totalCredit: 11200,
      currency: { companyId: other.insertId },
      lines: [gl(arId, "PH7J-AR", 11200, 0), gl(revId, "PH7J-REV", 0, 10000), v.line],
    });
    expect(res.status).toBe(403);
    await pool.query("DELETE FROM companies WHERE id = ?", [other.insertId]);
  });

  test("Phase 7H quotation -> invoice conversion is unchanged (GL-only, no structured tax entries)", async () => {
    const q = await request(app).post("/api/quotations").set("Authorization", `Bearer ${token}`).send({
      companyId: CO, customerId: custId, customerName: "PH7J Party", quotationDate: "2026-11-22", status: "Draft", totalAmount: 11200,
      lines: [{ lineType: "item", description: "svc", quantity: 1, unitPrice: 10000, taxRate: 12, amount: 10000, accountId: revId, accountCode: "PH7J-REV", accountTitle: "Sales Revenue" }],
    });
    expect(q.status).toBe(200);
    const conv = await request(app).post(`/api/quotations/${q.body.id}/convert-to-invoice`).set("Authorization", `Bearer ${token}`).send({ companyId: CO });
    expect(conv.status).toBe(200);
    const rows = await taxRows("INV", conv.body.invoiceId);
    expect(rows).toHaveLength(0); // conversion still writes GL lines only, no transaction_tax_entries
  });
});
