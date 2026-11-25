// Release safety - Beginning Balance (GL / AR / AP) import templates must not
// let their example row become a real opening balance.
//   new templates : import sheet = headers only; example on an "Example" sheet;
//                   CSV = headers only; the importer reads the "Import Template"
//                   sheet by name
//   old templates : a row carrying the example's fixed markers is an ERROR
//                   (never created, never silently dropped)
//   real records  : same account / party / amount as the example still import
// Existing account, branch, duplicate, preview/confirm and balance rules are
// unchanged. Local test database only. Prefix UAT-BBX-.
const request = require("supertest");
const ExcelJS = require("exceljs");
const app = require("../server");
const pool = require("../db");
const { signSessionToken } = require("../lib/sessionPolicy");
const CurrencyService = require("../services/currencyService");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(240000);

const P = "UAT-BBX-";
const D = "2096-03-31";
let co, br, user, tok;
const acc = {};
const party = {};

const auth = () => ({ Authorization: `Bearer ${tok}` });
async function xlsx(sheets) {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of sheets) {
    const ws = wb.addWorksheet(name);
    rows.forEach((r) => ws.addRow(r));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const preview = (module, buf, mode = "REJECT", name = "bb.xlsx") =>
  request(app).post(`/api/beginning-balances/${module}/import/preview`).set(auth()).field("duplicateMode", mode).attach("file", buf, name);
const commit = (module, batchId) => request(app).post(`/api/beginning-balances/${module}/import/commit`).set(auth()).send({ batchId });
const template = (module, format) => request(app).get(`/api/beginning-balances/${module}/template?format=${format}&companyId=${co}`).set(auth())
  .buffer(true).parse((res, cb) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); });
const loadWb = async (buf) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); return wb; };
const rowsWithValues = (ws) => { let n = 0; ws.eachRow({ includeEmpty: false }, () => { n += 1; }); return n; };
const errorsOf = (res, rowNumber) => (res.body.rows.find((r) => r.rowNumber === rowNumber) || {}).errors || [];
const statusOf = (res, rowNumber) => (res.body.rows.find((r) => r.rowNumber === rowNumber) || {}).status;
const ledger = async () => ({
  gl: Number((await pool.query("SELECT COUNT(*) c FROM gl_beginning_balance_lines l JOIN gl_beginning_balance_headers h ON h.id = l.header_id WHERE h.company_id = ?", [co]))[0][0].c),
  arap: Number((await pool.query("SELECT COUNT(*) c FROM arap_beginning_balance_lines l JOIN arap_beginning_balance_headers h ON h.id = l.header_id WHERE h.company_id = ?", [co]))[0][0].c),
});

const GL_H = ["Account Code", "Account Title", "Beginning Balance Date", "Currency Code", "Foreign Debit", "Foreign Credit", "Opening Exchange Rate", "Rate Date", "Reference Number", "Description"];
const AR_H = ["Customer Code", "Customer Name", "Account Code", "Document Number", "Beginning Balance Date", "Document Date", "Due Date", "Currency Code", "Original Foreign Amount", "Foreign Paid Amount", "Foreign Balance Amount", "Opening Exchange Rate"];
const AP_H = AR_H.map((h) => h.replace("Customer", "Supplier"));
// exactly what the OLD templates generated as row 2 (real codes, today, PHP)
const oldGlExample = () => [acc.CASH.code, acc.CASH.code, D, "PHP", "10000.00", "", "1", "", "GL-BEG-0001", "Opening balance"];
const oldArExample = () => [party.CUS.code, party.CUS.code, acc.AR.code, "AR-BEG-0001", D, D, D, "PHP", "10000.00", "0.00", "10000.00", "1"];
const oldApExample = () => [party.SUP.code, party.SUP.code, acc.AP.code, "AP-BEG-0001", D, D, D, "PHP", "10000.00", "0.00", "10000.00", "1"];

beforeAll(async () => {
  assertNotProductionDatabase();
  const [c] = await pool.query("INSERT INTO companies (name, status) VALUES (?, 'Active')", [`${P}Co`]);
  co = c.insertId;
  br = (await pool.query("INSERT INTO branches (company_id, name, code, status) VALUES (?, ?, ?, 'ACTIVE')", [co, `${P}MAIN`, `${P}MAIN`]))[0].insertId;
  await CurrencyService.createCurrency({ id: 0, roleCode: "SUPER_ADMIN" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "P", decimalPlaces: 2,
    symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: co,
  });
  const [[role]] = await pool.query("SELECT id FROM roles WHERE code = 'ADMIN'");
  const [u] = await pool.query("INSERT INTO users (username, full_name, password, role_id, status) VALUES (?, ?, 'x', ?, 'ACTIVE')", [`${P}admin`, `${P}admin`, role.id]);
  await pool.query("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, co]);
  user = { id: u.insertId, username: `${P}admin`, role: "ADMIN", roleCode: "ADMIN", token_version: 0 };
  tok = signSessionToken(user);
  for (const [key, cls, flag] of [["CASH", "ASSET"], ["EQ", "EQUITY"], ["AR", "ASSET", "AR CODE"], ["AP", "LIABILITY", "AP CODE"]]) {
    const [r] = await pool.query("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, '2096-01-01', ?, ?)", [`${P}${key}`, `${P}${key}`, cls]);
    acc[key] = { id: r.insertId, code: `${P}${key}` };
    if (flag) await pool.query("INSERT INTO coa_validations (coa_id, validation_name) VALUES (?, ?)", [r.insertId, flag]);
  }
  for (const [key, type] of [["CUS", "CUSTOMER"], ["SUP", "SUPPLIER"]]) {
    const [r] = await pool.query("INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, ?, ?, ?, 'ACTIVE')", [co, `${P}${key}`, type, `${P}${key}`]);
    party[key] = { id: r.insertId, code: `${P}${key}` };
  }
});

afterAll(async () => {
  try {
    await pool.query("DELETE l FROM gl_beginning_balance_lines l JOIN gl_beginning_balance_headers h ON h.id = l.header_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM gl_beginning_balance_headers WHERE company_id = ?", [co]);
    await pool.query("DELETE FROM arap_payment_schedules WHERE line_id IN (SELECT l.id FROM arap_beginning_balance_lines l JOIN arap_beginning_balance_headers h ON h.id = l.header_id WHERE h.company_id = ?)", [co]).catch(() => {});
    await pool.query("DELETE l FROM arap_beginning_balance_lines l JOIN arap_beginning_balance_headers h ON h.id = l.header_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM arap_beginning_balance_headers WHERE company_id = ?", [co]);
    await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id = ?", [co]).catch(() => {});
    await pool.query("DELETE r FROM import_batch_rows r JOIN import_batches b ON b.id = r.batch_id WHERE b.created_by = ?", [user.id]);
    await pool.query("DELETE FROM import_batches WHERE created_by = ?", [user.id]);
    await pool.query("DELETE FROM audit_logs WHERE user_id = ? OR company_id = ?", [user.id, co]);
    await pool.query("DELETE FROM coa_validations WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE ?)", [`${P}%`]);
    await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE ?", [`${P}%`]);
    await pool.query("DELETE FROM general_libraries WHERE company_id = ?", [co]);
    await pool.query("DELETE FROM currency_rates WHERE company_id = ?", [co]);
    await pool.query("DELETE FROM currencies WHERE company_id = ?", [co]);
    await pool.query("DELETE FROM user_companies WHERE user_id = ?", [user.id]);
    await pool.query("DELETE FROM users WHERE id = ?", [user.id]);
    await pool.query("DELETE FROM branches WHERE company_id = ?", [co]);
    await pool.query("DELETE FROM companies WHERE id = ?", [co]);
  } finally {
    await pool.end();
  }
});

describe("new templates", () => {
  test.each([["gl", "GL-BEG-0001"], ["ar", "AR-BEG-0001"], ["ap", "AP-BEG-0001"]])(
    "%s .xlsx: 'Import Template' first with headers only; the example is on the 'Example' sheet",
    async (module, marker) => {
      const res = await template(module, "xlsx");
      expect(res.status).toBe(200);
      const wb = await loadWb(res.body);
      expect(wb.worksheets[0].name).toBe("Import Template");
      expect(rowsWithValues(wb.worksheets[0])).toBe(1);
      const example = wb.getWorksheet("Example");
      expect(example.getRow(1).values.slice(1)).toEqual(wb.worksheets[0].getRow(1).values.slice(1)); // same columns / formats
      expect(JSON.stringify(example.getRow(2).values)).toContain(marker);
      const instructions = [];
      wb.getWorksheet("Instructions").eachRow((r) => instructions.push(String(r.getCell(1).value)));
      expect(instructions.join("\n")).toMatch(/'Example' sheet shows one filled-in row for reference and is never imported/);
      expect(instructions.join("\n")).toMatch(/Required Columns/); // existing instructions preserved
    }
  );
  test.each([["gl"], ["ar"], ["ap"]])("%s .csv: header row only", async (module) => {
    const res = await template(module, "csv");
    expect(res.status).toBe(200);
    expect(String(res.body).trim().split("\n")).toHaveLength(1);
  });
});

describe("older templates - the example row is refused, never created", () => {
  test("GL: the old example alone -> INVALID with the reason; confirm is blocked; no ledger change", async () => {
    const before = await ledger();
    const p = await preview("gl", await xlsx([["Import Template", [GL_H, oldGlExample()]]]));
    expect(p.status).toBe(200);
    expect(statusOf(p, 2)).toBe("INVALID");
    expect(errorsOf(p, 2).map((e) => e.message).join(" ")).toMatch(/example from the import template \(Reference Number GL-BEG-0001, 10,000\.00\), so it was not imported/);
    const c = await commit("gl", p.body.batchId);
    expect(c.status).not.toBe(200);
    expect(await ledger()).toEqual(before);
  });
  test("AR and AP: the old example rows are refused with the reason", async () => {
    for (const [module, H, row, doc] of [["ar", AR_H, oldArExample(), "AR-BEG-0001"], ["ap", AP_H, oldApExample(), "AP-BEG-0001"]]) {
      const p = await preview(module, await xlsx([["Import Template", [H, row]]]));
      expect([module, statusOf(p, 2)]).toEqual([module, "INVALID"]);
      expect(errorsOf(p, 2).map((e) => e.message).join(" ")).toContain(`Document Number ${doc}`);
    }
  });
  test("old CSV template (example on line 2) is refused the same way", async () => {
    const csv = Buffer.from([GL_H, oldGlExample()].map((r) => r.join(",")).join("\n"));
    const p = await preview("gl", csv, "REJECT", "old.csv");
    expect(statusOf(p, 2)).toBe("INVALID");
  });
  test("example left in a file with real rows: REJECT blocks everything; SKIP_EXISTING imports only the real rows", async () => {
    const rows = [GL_H, oldGlExample(), [acc.CASH.code, "", D, "PHP", "700", "", "1", "", "OB-REAL-1", "Opening cash"], [acc.EQ.code, "", D, "PHP", "", "700", "1", "", "OB-REAL-2", "Opening capital"]];
    const before = await ledger();
    const strict = await preview("gl", await xlsx([["Import Template", rows]]));
    expect(statusOf(strict, 2)).toBe("INVALID");
    expect((await commit("gl", strict.body.batchId)).status).not.toBe(200);
    expect(await ledger()).toEqual(before);
    const lenient = await preview("gl", await xlsx([["Import Template", rows]]), "SKIP_EXISTING");
    const c = await commit("gl", lenient.body.batchId);
    expect(c.status).toBe(200);
    expect(c.body.imported).toBe(2);
    expect((await ledger()).gl).toBe(before.gl + 2);
    const [[sum]] = await pool.query("SELECT SUM(l.othrdebit) d, SUM(l.othrcredit) c FROM gl_beginning_balance_lines l JOIN gl_beginning_balance_headers h ON h.id = l.header_id WHERE h.company_id = ?", [co]);
    expect([Number(sum.d), Number(sum.c)]).toEqual([700, 700]); // never the 10,000 example
  });
});

describe("legitimate records that resemble the example are imported normally", () => {
  test("GL: the example's account and 10,000.00 with a real reference -> valid and committed", async () => {
    const date = "2096-04-30";
    const p = await preview("gl", await xlsx([["Import Template", [GL_H,
      [acc.CASH.code, "", date, "PHP", "10000.00", "", "1", "", "OB-2096-001", "Opening balance"],
      [acc.EQ.code, "", date, "PHP", "", "10000.00", "1", "", "OB-2096-002", "Opening balance"],
    ]]]));
    expect([statusOf(p, 2), statusOf(p, 3)]).toEqual(["VALID", "VALID"]);
    const c = await commit("gl", p.body.batchId);
    expect([c.status, c.body.imported]).toEqual([200, 2]);
  });
  test("GL: reference GL-BEG-0001 with a different amount is not the example", async () => {
    const p = await preview("gl", await xlsx([["Import Template", [GL_H, [acc.CASH.code, "", "2096-05-31", "PHP", "12345", "", "1", "", "GL-BEG-0001", "Opening balance"]]]]));
    expect(errorsOf(p, 2).filter((e) => /example/.test(e.message))).toEqual([]);
  });
  test("AR: the example's customer, account and 10,000.00 with a real document number -> valid and committed", async () => {
    const before = await ledger();
    const p = await preview("ar", await xlsx([["Import Template", [AR_H, [party.CUS.code, "", acc.AR.code, "INV-2095-77", D, D, D, "PHP", "10000.00", "0", "10000.00", "1"]]]]));
    expect(statusOf(p, 2)).toBe("VALID");
    const c = await commit("ar", p.body.batchId);
    expect([c.status, c.body.imported]).toEqual([200, 1]);
    expect((await ledger()).arap).toBe(before.arap + 1);
  });
  test("AP: valid supplier balance is committed", async () => {
    const p = await preview("ap", await xlsx([["Import Template", [AP_H, [party.SUP.code, "", acc.AP.code, "BILL-2095-9", D, D, D, "PHP", "4500", "500", "4000", "1"]]]]));
    expect(statusOf(p, 2)).toBe("VALID");
    expect((await commit("ap", p.body.batchId)).status).toBe(200);
  });
});

describe("the importer reads only the designated import sheet", () => {
  test("an 'Example' sheet moved in front of 'Import Template' is never read", async () => {
    const p = await preview("gl", await xlsx([
      ["Example", [GL_H, oldGlExample()]],
      ["Import Template", [GL_H, [acc.CASH.code, "", "2096-06-30", "PHP", "50", "", "1", "", "OB-S1", "x"], [acc.EQ.code, "", "2096-06-30", "PHP", "", "50", "1", "", "OB-S2", "x"]]],
    ]));
    expect(p.body.summary.totalRows).toBe(2);
    expect(p.body.rows.map((r) => r.status)).toEqual(["VALID", "VALID"]);
  });
  test("a workbook without an 'Import Template' sheet still reads its first sheet (backward compatible)", async () => {
    const p = await preview("gl", await xlsx([["My balances", [GL_H, [acc.CASH.code, "", "2096-07-31", "PHP", "5", "", "1", "", "OB-F1", "x"], [acc.EQ.code, "", "2096-07-31", "PHP", "", "5", "1", "", "OB-F2", "x"]]]]));
    expect(p.body.summary.validRows).toBe(2);
  });
});

describe("existing validation is unchanged", () => {
  test("unknown account and a wrong Branch Code are refused", async () => {
    const p = await preview("gl", await xlsx([["Import Template", [[...GL_H, "Branch Code"],
      ["NO-SUCH-ACCOUNT", "", "2096-08-31", "PHP", "1", "", "1", "", "X1", "x", ""],
      [acc.EQ.code, "", "2096-08-31", "PHP", "", "1", "1", "", "X2", "x", "OTHER-BRANCH"],
    ]]]));
    expect(statusOf(p, 2)).toBe("INVALID");
    expect(errorsOf(p, 3).map((e) => e.message).join(" ")).toMatch(/does not match the selected branch/);
  });
  test("duplicates are flagged (same account + date in the file) and block a REJECT commit", async () => {
    const before = await ledger();
    const row = [acc.CASH.code, "", "2096-09-30", "PHP", "3", "", "1", "", "D1", "x"];
    const p = await preview("gl", await xlsx([["Import Template", [GL_H, row, [...row.slice(0, 8), "D2", "x"], [acc.EQ.code, "", "2096-09-30", "PHP", "", "6", "1", "", "D3", "x"]]]]));
    expect(p.body.rows.filter((r) => r.status === "DUPLICATE").length).toBeGreaterThanOrEqual(1);
    expect((await commit("gl", p.body.batchId)).status).not.toBe(200);
    expect(await ledger()).toEqual(before);
  });
  test("preview alone writes no balances", async () => {
    const before = await ledger();
    await preview("gl", await xlsx([["Import Template", [GL_H, [acc.CASH.code, "", "2096-10-31", "PHP", "9", "", "1", "", "P1", "x"], [acc.EQ.code, "", "2096-10-31", "PHP", "", "9", "1", "", "P2", "x"]]]]));
    expect(await ledger()).toEqual(before);
  });
});
