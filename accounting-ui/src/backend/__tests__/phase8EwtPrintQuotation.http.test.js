// Batch 8 Commits 2 & 3: EWT Library traceability, ewt-audit Phase 7L
// parity, reversal print banner, quotation migration idempotency + workflow.

const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const CurrencyService = require("../services/currencyService");

jest.setTimeout(240000);

let CO, token, userId;
let expId, apId, ivatId, taxesRecoverableId, ewtPayId, cashId, arId, revId;
let suppId, custId;
const ATC_REF = "PH8-REF010"; // will be referenced by an APV
const ATC_FREE = "PH8-FREE20"; // never referenced
const D = "2026-08-15";
const authH = (t = token) => ({ Authorization: `Bearer ${t}` });
let seq = 0;

async function mkAcc(code, title, cls) {
  const [ex] = await pool.execute("SELECT id FROM chart_of_accounts WHERE code = ?", [code]);
  if (ex.length) return ex[0].id;
  const [r] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, cls]
  );
  return r.insertId;
}
async function tagValidation(coaId, name) {
  await pool.execute("INSERT INTO coa_validations (coa_id, validation_name) VALUES (?, ?)", [coaId, name]);
}
async function createEwt(atcCode, { rate = 10, status = "ACTIVE", taxType = "EWT" } = {}) {
  return request(app).post("/api/ewt-library").set(authH()).send({
    atcCode, description: `desc ${atcCode}`, taxType, rate, birForm: "1601-E", status,
  });
}
async function ewtRow(atcCode) {
  const [[r]] = await pool.query("SELECT * FROM ewt_library WHERE atc_code = ?", [atcCode]);
  return r;
}
async function ewtAuditRows(atcCode) {
  const [rows] = await pool.query(
    "SELECT * FROM audit_logs WHERE entity_type = 'EWT_LIBRARY' AND description LIKE ? ORDER BY id",
    [`%${atcCode}%`]
  );
  return rows;
}

// A modern APV with a validation-tagged, NON-standard-titled Input VAT
// account + an EWT line (Phase 7L structured path).
async function createApvWithVatEwt({ atcCode, ivatAccountId = ivatId, ivatTitle = "Input VAT Receivable", status = "Posted" } = {}) {
  const v = `PH8-APV-${++seq}`;
  return request(app).post("/api/apv").set(authH()).send({
    voucherNo: v, supplierId: suppId, supplierName: "PH8 Supplier",
    transactionDate: D, referenceNo: v, description: "purchase",
    status, atcCode, taxWithheldAmount: 1000,
    currency: { companyId: CO },
    lines: [
      { accountId: expId, accountCode: "PH8E-EXP", accountTitle: "Purchases", particulars: "p", genRef: "", genName: "", debit: 10000, credit: 0 },
      {
        accountId: ivatAccountId, accountCode: "PH8E-IVAT", accountTitle: ivatTitle, particulars: "Input VAT (12%)",
        genRef: "", genName: "", debit: 1200, credit: 0,
        taxEntry: {
          entryType: "INPUT_VAT", accountId: ivatAccountId, partyId: suppId, partyName: "PH8 Supplier",
          partyTin: "111-222-333-000", partyAddress: "M", transactionDate: D,
          grossAmount: 11200, netAmount: 10000, vatRate: 12, vatAmount: 1200,
          vatTreatment: "STANDARD", vatCode: null, vatEntryMode: "INCLUSIVE", purchaseClassification: "Services",
        },
      },
      {
        accountId: ewtPayId, accountCode: "PH8E-EWTP", accountTitle: "Withholding Tax Payable", particulars: `EWT - ${atcCode}`,
        genRef: "", genName: "", debit: 0, credit: 1000,
        taxEntry: {
          entryType: "EWT", accountId: ewtPayId, partyId: suppId, partyName: "PH8 Supplier",
          partyTin: "111-222-333-000", partyAddress: "M", transactionDate: D,
          atcCode, taxType: "EWT", taxableBase: 10000, withheldAmount: 1000,
        },
      },
      { accountId: apId, accountCode: "PH8E-AP", accountTitle: "Accounts Payable", particulars: "ap", genRef: "PH8E-S", genName: "PH8 Supplier", debit: 0, credit: 10200 },
    ],
    totalDebit: 11200, totalCredit: 11200,
  });
}

beforeAll(async () => {
  assertNotProductionDatabase();
  const [c] = await pool.execute("INSERT INTO companies (name, status) VALUES ('PH8E Co', 'Active')");
  CO = c.insertId;
  const hash = await bcrypt.hash("Ph8ePass!1", 10);
  const [u] = await pool.execute("INSERT INTO users (username, password, role_id, status) VALUES ('ph8e_admin', ?, 2, 'ACTIVE')", [hash]);
  userId = u.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, CO]);
  token = (await request(app).post("/api/login").send({ username: "ph8e_admin", password: "Ph8ePass!1" })).body.token;

  const admin = { id: userId, roleCode: "ADMIN" };
  await CurrencyService.createCurrency(admin, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "P",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: CO,
  });

  expId = await mkAcc("PH8E-EXP", "Purchases", "EXPENSE");
  apId = await mkAcc("PH8E-AP", "Accounts Payable", "LIABILITY");
  ivatId = await mkAcc("PH8E-IVAT", "Input VAT Receivable", "ASSET");
  taxesRecoverableId = await mkAcc("PH8E-TXR", "Taxes Recoverable", "ASSET"); // non-standard title
  ewtPayId = await mkAcc("PH8E-EWTP", "Withholding Tax Payable", "LIABILITY");
  cashId = await mkAcc("PH8E-CASH", "Cash", "ASSET");
  arId = await mkAcc("PH8E-AR", "Accounts Receivable", "ASSET");
  revId = await mkAcc("PH8E-REV", "Sales Revenue", "INCOME");
  await tagValidation(ivatId, "INPUT VAT");
  await tagValidation(taxesRecoverableId, "INPUT VAT");
  await tagValidation(ewtPayId, "EXPANDED TAX");
  await tagValidation(apId, "AP");

  const [s] = await pool.execute("INSERT INTO general_libraries (company_id, code, party_type, name, status, tin) VALUES (?, 'PH8E-S', 'SUPPLIER', 'PH8 Supplier', 'ACTIVE', '111-222-333-000')", [CO]);
  suppId = s.insertId;
  const [cu] = await pool.execute("INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, 'PH8E-C', 'CUSTOMER', 'PH8 Customer', 'ACTIVE')", [CO]);
  custId = cu.insertId;

  await pool.execute(
    "INSERT INTO accounting_periods (company_id, year, period_month, start_date, end_date, status) VALUES (?, 2026, 8, '2026-08-01', '2026-08-31', 'OPEN')",
    [CO]
  );
});

afterAll(async () => {
  await pool.query("DELETE FROM transaction_tax_entries WHERE company_id = ?", [CO]);
  await pool.query("DELETE FROM transaction_applications WHERE source_id IN (SELECT id FROM invoice_headers WHERE company_id = ?) OR applied_id IN (SELECT id FROM invoice_headers WHERE company_id = ?)", [CO, CO]);
  for (const t of ["apv", "cv", "jv", "invoice", "quotation"]) {
    await pool.query(`DELETE ln FROM ${t}_lines ln JOIN ${t}_headers h ON h.id = ln.${t}_id WHERE h.company_id = ?`, [CO]);
  }
  await pool.query("DELETE FROM apv_headers WHERE company_id = ?", [CO]);
  await pool.query("DELETE FROM cv_headers WHERE company_id = ?", [CO]);
  await pool.query("DELETE FROM jv_headers WHERE company_id = ?", [CO]);
  await pool.query("DELETE FROM invoice_headers WHERE company_id = ?", [CO]);
  await pool.query("DELETE FROM quotation_headers WHERE company_id = ?", [CO]);
  await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id = ?", [CO]);
  await pool.query("DELETE FROM accounting_periods WHERE company_id = ?", [CO]);
  await pool.query("DELETE FROM audit_logs WHERE entity_type = 'EWT_LIBRARY' OR entity_id IN (SELECT id FROM apv_headers WHERE company_id = ?)", [CO]);
  await pool.query("DELETE FROM ewt_library WHERE atc_code LIKE 'PH8-%'");
  await pool.query("DELETE FROM general_libraries WHERE company_id = ?", [CO]);
  await pool.query("DELETE FROM currencies WHERE company_id = ?", [CO]);
  await pool.query("DELETE FROM user_companies WHERE user_id = ?", [userId]);
  await pool.query("DELETE FROM users WHERE id = ?", [userId]);
  await pool.query("DELETE FROM companies WHERE id = ?", [CO]);
  await pool.query("DELETE FROM coa_validations WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE 'PH8E-%')");
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'PH8E-%'");
  await pool.end();
});

describe("Batch 8 - EWT Library traceability", () => {
  test("DELETE deactivates (status INACTIVE), row stays, audit DEACTIVATE written", async () => {
    await createEwt(ATC_FREE);
    const before = await ewtRow(ATC_FREE);
    expect(before.status).toBe("ACTIVE");

    const del = await request(app).delete(`/api/ewt-library/${before.id}`).set(authH());
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ success: true, status: "INACTIVE" });

    const after = await ewtRow(ATC_FREE);
    expect(after).toBeTruthy(); // NOT physically deleted
    expect(after.status).toBe("INACTIVE");

    const audits = await ewtAuditRows(ATC_FREE);
    expect(audits.map((a) => a.action).sort()).toEqual(["CREATE", "DEACTIVATE"]);
  });

  test("GET /api/ewt-library still returns the INACTIVE row", async () => {
    const res = await request(app).get("/api/ewt-library").set(authH());
    expect(res.status).toBe(200);
    const row = res.body.find((r) => r.atcCode === ATC_FREE);
    expect(row).toBeTruthy();
    expect(row.status).toBe("INACTIVE");
  });

  test("a REFERENCED ATC: hard delete blocked with 409 EWT_CODE_IN_USE; row + transaction intact", async () => {
    await createEwt(ATC_REF);
    const created = await createApvWithVatEwt({ atcCode: ATC_REF, status: "Posted" });
    expect(created.status).toBe(200);
    const apvId = created.body.id;

    const row = await ewtRow(ATC_REF);
    const hard = await request(app).delete(`/api/ewt-library/${row.id}?hard=true`).set(authH());
    expect(hard.status).toBe(409);
    expect(hard.body.code).toBe("EWT_CODE_IN_USE");

    expect(await ewtRow(ATC_REF)).toBeTruthy();
    const [[apv]] = await pool.query("SELECT atc_code, tax_withheld_amount FROM apv_headers WHERE id = ?", [apvId]);
    expect(apv.atc_code).toBe(ATC_REF);
    expect(Number(apv.tax_withheld_amount)).toBe(1000);

    // soft delete (deactivate) is still allowed on a referenced code
    const soft = await request(app).delete(`/api/ewt-library/${row.id}`).set(authH());
    expect(soft.status).toBe(200);
    expect((await ewtRow(ATC_REF)).status).toBe("INACTIVE");
  });

  test("re-saving a transaction that references a now-INACTIVE ATC preserves its EWT snapshot", async () => {
    // fresh Draft APV on its own ATC, then deactivate that ATC, then PUT
    // the APV back with its own reloaded lines/taxEntries (what the
    // frontend re-sends).
    const RESAVE_ATC = "PH8-RESAVE1";
    await createEwt(RESAVE_ATC);
    const draft = await createApvWithVatEwt({ atcCode: RESAVE_ATC, status: "Draft" });
    expect(draft.status).toBe(200);
    const draftId = draft.body.id;
    const [[atcRow]] = await pool.query("SELECT id FROM ewt_library WHERE atc_code = ?", [RESAVE_ATC]);
    await request(app).delete(`/api/ewt-library/${atcRow.id}`).set(authH());
    expect((await ewtRow(RESAVE_ATC)).status).toBe("INACTIVE");

    const get = await request(app).get(`/api/apv/${draftId}`).set(authH());
    expect(get.status).toBe(200);
    const b = get.body;
    const teByLine = new Map((b.taxEntries || []).map((t) => [t.lineId, t]));

    const put = await request(app).put(`/api/apv/${draftId}`).set(authH()).send({
      voucherNo: b.voucherNo, supplierId: suppId, supplierName: "PH8 Supplier",
      transactionDate: D, referenceNo: "re", description: "purchase re-saved",
      status: "Draft", atcCode: RESAVE_ATC, taxWithheldAmount: 1000,
      currency: { companyId: CO },
      lines: b.lines.map((l) => {
        const te = teByLine.get(l.id);
        return {
          accountId: l.accountId, accountCode: l.accountCode, accountTitle: l.accountTitle,
          particulars: l.particulars, genRef: l.genRef || "", genName: l.genName || "",
          debit: Number(l.debit) || 0, credit: Number(l.credit) || 0,
          ...(te ? { taxEntry: { entryType: te.entryType, ...te } } : {}),
        };
      }),
      totalDebit: b.totalDebit, totalCredit: b.totalCredit,
    });
    expect(put.status).toBe(200);

    const [[after]] = await pool.query("SELECT atc_code, tax_withheld_amount, taxable_base FROM apv_headers WHERE id = ?", [draftId]);
    expect(after.atc_code).toBe(RESAVE_ATC); // NOT silently cleared
    expect(Number(after.tax_withheld_amount)).toBe(1000);
    expect(Number(after.taxable_base)).toBe(10000);
  });

  test("alphalist for the referenced ATC's history is unchanged after deactivation", async () => {
    const res = await request(app)
      .get(`/api/reports/alphalist?taxType=EWT&month=2026-08&companyId=${CO}`)
      .set(authH());
    expect(res.status).toBe(200);
    const row = (res.body || []).find((r) => r.atcCode === ATC_REF);
    expect(row).toBeTruthy();
    expect(Number(row.taxWithheld)).toBeGreaterThan(0);
  });
});

describe("Batch 8 - ewt-audit Phase 7L parity", () => {
  test("modern APV on a validation-tagged non-standard-title Input VAT account is NOT false-flagged", async () => {
    await createEwt("PH8-AUD10", { rate: 10 });
    const created = await createApvWithVatEwt({
      atcCode: "PH8-AUD10",
      ivatAccountId: taxesRecoverableId,
      ivatTitle: "Taxes Recoverable",
    });
    expect(created.status).toBe(200);
    const apvId = created.body.id;

    const res = await request(app).get("/api/reports/ewt-audit").set(authH());
    expect(res.status).toBe(200);
    const flagged = res.body.flagged.find((f) => f.id === apvId && f.module === "apv");
    expect(flagged).toBeUndefined(); // structured net = 10,000 matches stored taxable_base
  });

  test("a genuinely tampered stored base is still flagged", async () => {
    await createEwt("PH8-AUD11", { rate: 10 });
    const created = await createApvWithVatEwt({ atcCode: "PH8-AUD11" });
    const apvId = created.body.id;
    await pool.query("UPDATE apv_headers SET taxable_base = 777 WHERE id = ?", [apvId]);

    const res = await request(app).get("/api/reports/ewt-audit").set(authH());
    const flagged = res.body.flagged.find((f) => f.id === apvId && f.module === "apv");
    expect(flagged).toBeTruthy();
    expect(flagged.storedTaxableBase).toBe(777);
    expect(flagged.computedTaxableBase).toBe(10000);
  });
});

describe("Batch 8 - reversal print banner", () => {
  async function reversedApv() {
    await createEwt(`PH8-REVATC-${++seq}`);
    // APV with NO ewt to keep the reversal simple; VAT only.
    const v = `PH8-APV-REV-${seq}`;
    const cr = await request(app).post("/api/apv").set(authH()).send({
      voucherNo: v, supplierId: suppId, supplierName: "PH8 Supplier",
      transactionDate: D, referenceNo: v, description: "rev-me", status: "Posted",
      currency: { companyId: CO },
      lines: [
        { accountId: expId, accountCode: "PH8E-EXP", accountTitle: "Purchases", particulars: "p", genRef: "", genName: "", debit: 5000, credit: 0 },
        { accountId: apId, accountCode: "PH8E-AP", accountTitle: "Accounts Payable", particulars: "ap", genRef: "PH8E-S", genName: "PH8 Supplier", debit: 0, credit: 5000 },
      ],
      totalDebit: 5000, totalCredit: 5000,
    });
    const apvId = cr.body.id;
    // close Aug so Void -> REVERSAL_REQUIRED, open the current month for the reversal date
    const now = new Date();
    const ry = now.getFullYear();
    const rm = now.getMonth() + 1;
    await pool.query(
      "INSERT INTO accounting_periods (company_id, year, period_month, start_date, end_date, status) VALUES (?, 2026, 8, '2026-08-01', '2026-08-31', 'CLOSED'), (?, ?, ?, ?, LAST_DAY(?), 'OPEN') ON DUPLICATE KEY UPDATE status = VALUES(status)",
      [CO, CO, ry, rm, `${ry}-${String(rm).padStart(2, "0")}-01`, `${ry}-${String(rm).padStart(2, "0")}-01`]
    );
    const rev = await request(app).post(`/api/apv/${apvId}/reverse`).set(authH()).send({ reason: "batch8 test", companyId: CO });
    await pool.query("DELETE FROM accounting_periods WHERE company_id = ? AND NOT (year = 2026 AND period_month = 8 AND status = 'OPEN')", [CO]);
    await pool.query("INSERT INTO accounting_periods (company_id, year, period_month, start_date, end_date, status) VALUES (?, 2026, 8, '2026-08-01', '2026-08-31', 'OPEN') ON DUPLICATE KEY UPDATE status = 'OPEN'", [CO]);
    return { apvId, rev };
  }

  test("print DATA for a reversed APV carries reversal metadata (reversedByVoucher + date)", async () => {
    const { apvId, rev } = await reversedApv();
    expect(rev.status).toBe(200);

    const res = await request(app).get(`/api/print/apv/${apvId}?mode=without_entries&companyId=${CO}`).set(authH());
    expect(res.status).toBe(200);
    expect(res.body.reversal).toMatchObject({ reversed: true });
    expect(res.body.reversal.reversedByVoucher).toBeTruthy();
    expect(res.body.reversal.reversalDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("print DATA for a normal APV: reversal.reversed === false", async () => {
    const cr = await request(app).post("/api/apv").set(authH()).send({
      voucherNo: `PH8-APV-NOREV-${++seq}`, supplierId: suppId, supplierName: "PH8 Supplier",
      transactionDate: D, referenceNo: "nr", description: "plain", status: "Posted",
      currency: { companyId: CO },
      lines: [
        { accountId: expId, accountCode: "PH8E-EXP", accountTitle: "Purchases", particulars: "p", genRef: "", genName: "", debit: 3000, credit: 0 },
        { accountId: apId, accountCode: "PH8E-AP", accountTitle: "Accounts Payable", particulars: "ap", genRef: "PH8E-S", genName: "PH8 Supplier", debit: 0, credit: 3000 },
      ],
      totalDebit: 3000, totalCredit: 3000,
    });
    const res = await request(app).get(`/api/print/apv/${cr.body.id}?mode=without_entries&companyId=${CO}`).set(authH());
    expect(res.body.reversal).toMatchObject({ reversed: false });
  });

  // The browser renderer (src/print/pdf/documentPdfBuilder.js) is an ES
  // module in a "type": "module" dir that imports ../copyTypes across the
  // package boundary - it cannot be require()'d or import()'d from the CJS
  // Jest runtime (no existing test loads it either). Assert the reversal
  // wiring at source level, and prove the actual banner/watermark RENDER
  // via the CJS OrPdfService which carries the identical logic.
  test("documentPdfBuilder.js wires `reversal` through to a banner + REVERSED watermark", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "..", "print", "pdf", "documentPdfBuilder.js"),
      "utf8"
    );
    expect(src).toMatch(/reversal\s*=\s*null,/); // destructured param
    expect(src).toMatch(/reversal && reversal\.reversed/);
    expect(src).toMatch(/"Reversed By"/);
    expect(src).toMatch(/REVERSED_WATERMARK/); // Batch 9: shared JSON constant
  });

  test("watermark/banner logic: REVERSED for a reversed-Posted doc; explicit status wins; none otherwise", () => {
    const { resolveWatermark, reversalNote } = require("../services/orPdfService");

    expect(resolveWatermark("Posted", { reversed: true, reversedByVoucher: "JV-1" })).toBe("REVERSED");
    expect(resolveWatermark("Void", { reversed: true })).toBe("VOID"); // explicit status wins
    expect(resolveWatermark("Cancelled", null)).toBe("CANCELLED");
    expect(resolveWatermark("Draft", null)).toBe("DRAFT");
    expect(resolveWatermark("Posted", null)).toBeNull();
    expect(resolveWatermark("Posted", { reversed: false })).toBeNull();

    expect(reversalNote({ reversed: true, reversedByVoucher: "JV-REV-APV-OR-1", reversalDate: "2026-09-04" }))
      .toBe("JV-REV-APV-OR-1 on 2026-09-04");
    expect(reversalNote({ reversed: false })).toBeNull();
    expect(reversalNote(null)).toBeNull();
  });

  test("OrPdfService.buildOrPdf produces a valid, non-trivial PDF for a reversed and a plain doc (no throw)", async () => {
    const { buildOrPdf } = require("../services/orPdfService");
    for (const reversal of [{ reversed: true, reversedByVoucher: "JV-REV-APV-OR-1", reversalDate: "2026-09-04" }, { reversed: false }]) {
      const bytes = await buildOrPdf({
        doc: { voucherNo: "OR-1", status: "Posted", transactionDate: "2026-09-03", totalDebit: 100, totalCredit: 100 },
        lines: [{ particulars: "Payment", debit: 100, credit: 0 }],
        party: { name: "Cust" }, company: { name: "Co", tin: "000", address: "Addr" },
        reversal,
      });
      const buf = Buffer.from(bytes);
      expect(buf.slice(0, 4).toString()).toBe("%PDF");
      expect(buf.length).toBeGreaterThan(800);
    }
  });

  test("DRAFT/CANCELLED/VOID watermark constants are shared via documentStampConstants.json (no drift)", () => {
    const fs = require("fs");
    const path = require("path");
    const stamp = require("../../print/documentStampConstants.json");
    expect(stamp.statusWatermarks).toEqual({ DRAFT: "DRAFT", CANCELLED: "CANCELLED", VOID: "VOID" });
    expect(stamp.reversedWatermark).toBe("REVERSED");
    // both renderers read the shared JSON, not a local literal
    const builder = fs.readFileSync(path.join(__dirname, "..", "..", "print", "pdf", "documentPdfBuilder.js"), "utf8");
    const orpdf = fs.readFileSync(path.join(__dirname, "..", "services", "orPdfService.js"), "utf8");
    expect(builder).toMatch(/documentStampConstants\.json/);
    expect(builder).toMatch(/STATUS_WATERMARKS = STAMP\.statusWatermarks/);
    expect(orpdf).toMatch(/documentStampConstants\.json/);
    expect(orpdf).toMatch(/STATUS_WATERMARKS = STAMP\.statusWatermarks/);
  });
});

describe("Batch 8 - quotation migration idempotency + workflow", () => {
  test("the two quotation migrations are safe to re-run against an already-migrated DB (no reset)", async () => {
    const fs = require("fs");
    const path = require("path");
    const mysql = require("mysql2/promise");
    const { resolveDatabaseConfig } = require("../config/database");
    const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");
    const files = ["quotation_migration.sql", "quotation_account_migration.sql"];
    const { environment, ...connCfg } = resolveDatabaseConfig();
    const multiConn = await mysql.createConnection({ ...connCfg, multipleStatements: true });

    // capture the column set BEFORE (db:test:reset already applied these once)
    async function colCount(table, col) {
      const [[row]] = await pool.query(
        "SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
        [table, col]
      );
      return row.n;
    }
    const targets = [
      ["invoice_headers", "source_quotation_id"],
      ["invoice_headers", "invoice_type"],
      ["invoice_headers", "recurrence_frequency"],
      ["quotation_lines", "account_id"],
      ["quotation_lines", "account_code"],
      ["quotation_lines", "account_title"],
    ];
    for (const [t, c] of targets) expect(await colCount(t, c)).toBe(1);

    const [[{ rowsBefore }]] = await pool.query("SELECT COUNT(*) rowsBefore FROM quotation_headers");

    // re-apply BOTH files TWICE more - must not throw (ER_DUP_FIELDNAME gone)
    try {
      for (let pass = 0; pass < 2; pass += 1) {
        for (const f of files) {
          const sql = fs.readFileSync(path.join(REPO_ROOT, f), "utf8");
          await multiConn.query(sql);
        }
      }
    } finally {
      await multiConn.end();
    }

    // still exactly one of each column, no data touched
    for (const [t, c] of targets) expect(await colCount(t, c)).toBe(1);
    const [[{ rowsAfter }]] = await pool.query("SELECT COUNT(*) rowsAfter FROM quotation_headers");
    expect(rowsAfter).toBe(rowsBefore);
  });

  test("quotation workflow still works: create -> company-scoped number -> convert -> Converted -> duplicate convert blocked", async () => {
    const create = await request(app).post("/api/quotations").set(authH()).send({
      customerId: custId, customerName: "PH8 Customer", quotationDate: "2026-09-03",
      lines: [{ lineType: "item", description: "Consulting", quantity: 1, unitPrice: 1000, taxRate: 12, amount: 1000 }],
    });
    expect(create.status).toBe(200);
    const qId = create.body.id;
    expect(create.body.quotationNo).toBeTruthy();

    const conv = await request(app).post(`/api/quotations/${qId}/convert-to-invoice`).set(authH()).send({});
    expect(conv.status).toBe(200);
    const [[q]] = await pool.query("SELECT status, converted_invoice_id FROM quotation_headers WHERE id = ?", [qId]);
    expect(q.status).toBe("Converted");
    expect(q.converted_invoice_id).toBeTruthy();

    const conv2 = await request(app).post(`/api/quotations/${qId}/convert-to-invoice`).set(authH()).send({});
    expect(conv2.status).toBe(400);
    expect(conv2.body.message).toMatch(/already been converted/i);

    // zero-line guard preserved
    const badLine = await request(app).post("/api/quotations").set(authH()).send({
      customerId: custId, customerName: "PH8 Customer", quotationDate: "2026-09-03", lines: [],
    });
    expect(badLine.status).toBe(400);
  });
});
