// R8.2 - bank statement import foundation: one deterministic parser for
// preview and import (CSV / XLSX), canonical fields, exact check-number
// text, integer-centavo money, blocking errors vs warnings, row
// fingerprints for duplicate protection per company + bank account, and
// company / bank-account isolation from the reconciliation session.
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const ExcelJS = require("exceljs");
const app = require("../server");
const pool = require("../db");
const Parser = require("../services/bankStatementParser");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(240000);

const P = "r82-";
const PW = "R82Pass!1";
const co = {};
const cur = {};
const acct = {};
const bank = {};
const tok = {};
const users = {};
const s = {};
const sessions = [];

const q = async (sql, params) => (await pool.query(sql, params))[0];
const one = async (sql, params) => (await q(sql, params))[0];
const api = (who, method, url, body) => {
  const r = request(app)[method](url).set({ Authorization: `Bearer ${tok[who]}` });
  return body === undefined ? r : r.send(body);
};

async function makeUser(tag, roleCode, companyIds = [], denies = []) {
  const [[role]] = await pool.query("SELECT id FROM roles WHERE code = ?", [roleCode]);
  const [u] = await pool.query("INSERT INTO users (username, password, role_id, status, email) VALUES (?, ?, ?, 'ACTIVE', ?)",
    [`${P}${tag}`, await bcrypt.hash(PW, 10), role.id, `${P}${tag}@example.test`]);
  for (const c of companyIds) await pool.query("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  for (const [m, a] of denies) {
    const [[perm]] = await pool.query("SELECT id FROM permissions WHERE module_key = ? AND action = ?", [m, a]);
    await pool.query("INSERT INTO user_permissions (user_id, permission_id, granted, reason) VALUES (?, ?, 0, 'r82')", [u.insertId, perm.id]);
  }
  users[tag] = u.insertId;
  const res = await request(app).post("/api/login").send({ username: `${P}${tag}`, password: PW });
  if (res.status !== 200) throw new Error(`login ${tag}`);
  tok[tag] = res.body.token;
}

async function newSession(who, bankKey, o = {}) {
  const res = await api(who, "post", "/api/bank-recon/sessions", {
    bankAccountId: bank[bankKey], periodStart: o.start || "2099-05-01", periodEnd: o.end || "2099-05-31",
    statementBeginningBalance: 0, statementEndingBalance: 0,
  });
  if (res.status !== 200) throw new Error(`session ${res.status}`);
  sessions.push(res.body.id);
  return res.body.id;
}

function upload(who, sessionId, kind, buffer, name, fields = {}) {
  const r = request(app).post(`/api/bank-recon/sessions/${sessionId}/import${kind === "preview" ? "/preview" : ""}`)
    .set({ Authorization: `Bearer ${tok[who]}` });
  for (const [k, v] of Object.entries(fields)) r.field(k, typeof v === "string" ? v : JSON.stringify(v));
  return r.attach("file", buffer, name);
}
const HEAD = "Date,Description,Reference,Check No,Debit,Credit,Balance";
const csv = (rows, head = HEAD) => Buffer.from([head, ...rows].join("\n"));
const preview = (who, sid, buf, name = "stmt.csv", fields) => upload(who, sid, "preview", buf, name, fields);
const importFile = (who, sid, buf, name = "stmt.csv", fields) => upload(who, sid, "import", buf, name, fields);
const lineCount = async (sid) => (await one("SELECT COUNT(*) n FROM bank_recon_statement_lines WHERE session_id = ?", [sid])).n;
const lines = (sid) => q(`SELECT DATE_FORMAT(txn_date, '%Y-%m-%d') d, description, reference_no AS ref, check_no AS chk, debit, credit, running_balance AS bal
                          FROM bank_recon_statement_lines WHERE session_id = ? ORDER BY id`, [sid]);

async function workbook(build) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Statement");
  build(ws);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

beforeAll(async () => {
  assertNotProductionDatabase();
  for (const t of ["A", "B"]) {
    co[t] = (await q("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${P}Co ${t}`])).insertId;
    cur[t] = (await q("INSERT INTO currencies (company_id, currency_code, currency_name, currency_symbol, is_base_currency, is_active) VALUES (?, 'PHP', 'Philippine Peso', 'P', 1, 1)", [co[t]])).insertId;
  }
  for (const [k, t, c] of [["BANK", "R82 Cash in Bank", "ASSET"], ["BANK2", "R82 Cash in Bank 2", "ASSET"], ["EXP", "R82 Expense", "EXPENSE"]]) {
    acct[k] = { id: (await q("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)", [`${P}${k}`, t, c])).insertId, code: `${P}${k}`, title: t };
  }
  for (const [k, coa] of [["BK", "BANK"], ["BK2", "BANK2"]]) {
    bank[k] = (await q("INSERT INTO bank_codes (bank_code, bank_name, account_no, account_name, coa_account_id, coa_code, status) VALUES (?, ?, ?, 'R82', ?, ?, 'ACTIVE')",
      [`${P}${k}`, `R82 ${k}`, `000-${k}`, acct[coa].id, acct[coa].code])).insertId;
  }
  await makeUser("super", "SUPER_ADMIN");
  await makeUser("acctA", "ACCOUNTANT", [co.A]);
  await makeUser("acctB", "ACCOUNTANT", [co.B]);
  await makeUser("viewA", "ACCOUNTANT", [co.A], [["REPORTS.BANK_RECONCILIATION", "CREATE"]]);
  s.A = await newSession("acctA", "BK");
  s.A2 = await newSession("acctA", "BK2");
  s.B = await newSession("acctB", "BK");
  s.legacy = (await q("INSERT INTO bank_recon_sessions (bank_account_id, period_start, period_end, status) VALUES (?, '2099-05-01', '2099-05-31', 'IN_PROGRESS')", [bank.BK])).insertId;
  sessions.push(s.legacy);
});

afterAll(async () => {
  try {
    const cos = Object.values(co);
    const us = Object.values(users);
    for (const t of ["bank_recon_adjustments", "bank_recon_matches", "bank_recon_statement_lines", "bank_recon_import_batches"]) {
      await pool.query(`DELETE FROM ${t} WHERE session_id IN (?)`, [sessions]);
    }
    await pool.query("DELETE FROM bank_recon_sessions WHERE id IN (?)", [sessions]);
    const cvs = (await q("SELECT id FROM cv_headers WHERE company_id IN (?)", [cos])).map((r) => r.id);
    if (cvs.length) await pool.query("DELETE FROM transaction_applications WHERE applied_type = 'CV' AND applied_id IN (?)", [cvs]);
    for (const t of ["cv_headers", "transaction_currency_snapshots", "audit_logs", "currencies"]) await pool.query(`DELETE FROM ${t} WHERE company_id IN (?)`, [cos]);
    await pool.query("DELETE FROM audit_logs WHERE user_id IN (?)", [us]);
    await pool.query("DELETE FROM user_permissions WHERE user_id IN (?)", [us]);
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [us]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [us]);
    await pool.query("DELETE FROM bank_codes WHERE id IN (?)", [Object.values(bank)]);
    await pool.query("DELETE FROM companies WHERE id IN (?)", [cos]);
    await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE ?", [`${P}%`]);
  } finally {
    await pool.end();
  }
});

// ---------------------------------------------------------------------------
describe("parser units", () => {
  test.each([
    ["1,000.00", 100000, false, null], ["(1,234.50)", 123450, true, null], ["₱ 980.10", 98010, false, null],
    ["-45", 4500, true, null], ["45-", 4500, true, null], ["500 DR", 50000, false, "DR"], ["500CR", 50000, false, "CR"],
    ["PHP 1,000", 100000, false, null], ["0.07", 7, false, null], ["9999999999999.99", 999999999999999, false, null],
  ])("money %s -> %i centavos", (text, cents, negative, marker) => {
    expect(Parser.parseMoney({ text, kind: "text" })).toEqual({ cents, negative, marker });
  });

  test.each(["12.345", "1,00", "abc", "1.2.3", "10000000000000.00", "₱"])("money %s is invalid", (text) => {
    expect(Parser.parseMoney({ text, kind: "text" }).invalid).toBe(true);
  });

  test("centavos print without floating point", () => {
    expect(Parser.centsToString(7)).toBe("0.07");
    expect(Parser.centsToString(999999999999999)).toBe("9999999999999.99");
  });

  test("row fingerprints v2: deterministic, exact stored values, ordinal for identical rows", () => {
    const row = () => ({ txnDate: "2099-05-02", direction: "IN", amountCents: 60000, checkNo: "", referenceNo: "", description: "Cash deposit" });
    const [a1, a2] = Parser.fingerprintRows([row(), row()]);
    const [b1] = Parser.fingerprintRows([row()]);
    expect(a1.fingerprint).not.toBe(a2.fingerprint);
    expect(b1.fingerprint).toBe(a1.fingerprint);
    expect([a1.occurrence, a2.occurrence]).toEqual([1, 2]);
    // documented formula: sha256("v2" US date US dir US cents US check US ref US desc "#" n)
    const expected = require("crypto").createHash("sha256")
      .update(["v2", "2099-05-02", "IN", "60000", "", "", "Cash deposit"].join("\u001f") + "#1", "utf8").digest("hex");
    expect(a1.fingerprint).toBe(expected);
    // every stored field is part of the identity, exactly as written
    const fp = (patch) => Parser.fingerprintRows([{ ...row(), ...patch }])[0].fingerprint;
    for (const patch of [{ txnDate: "2099-05-03" }, { direction: "OUT" }, { amountCents: 60001 }, { checkNo: "001234" }, { referenceNo: "R1" }, { description: "CASH DEPOSIT" }]) {
      expect(fp(patch)).not.toBe(a1.fingerprint);
    }
    expect(fp({ checkNo: "001234" })).not.toBe(fp({ checkNo: "1234" }));
  });
});

// ---------------------------------------------------------------------------
describe("import formats and file validation", () => {
  test("1. valid CSV: preview writes nothing, then import stores normalized rows and the audit records the file hash", async () => {
    const buf = csv([
      "2099-05-02,Opening balance,,,,,5000.00",
      "2099-05-02,Check paid,,001234,980.00,,4020.00",
      "2099-05-03,Cash deposit,DEP-77,,,1500.50,5520.50",
    ]);
    const before = await lineCount(s.A);
    const pv = await preview("acctA", s.A, buf);
    expect(pv.status).toBe(200);
    expect(pv.body).toMatchObject({ canImport: true, dateFormat: "YYYY-MM-DD", missingRequired: [] });
    expect(pv.body.summary).toMatchObject({ rowsDetected: 2, valid: 2, invalid: 0, duplicates: 0, toImport: 2, blockingErrors: 0 });
    expect(pv.body.warnings.map((w) => w.message)).toContain("Ignored - balance-only row (no debit, credit or amount).");
    expect(pv.body.fields.find((f) => f.key === "txnDate")).toMatchObject({ required: true, column: "Date" });
    expect(pv.body.sample[0]).toMatchObject({ row: 3, status: "NEW", direction: "OUT", amount: "980.00", checkNo: "001234", checkNoNormalized: "1234", balance: "4020.00" });
    expect(await lineCount(s.A)).toBe(before);

    const imp = await importFile("acctA", s.A, buf);
    expect(imp.status).toBe(200);
    expect(imp.body).toMatchObject({ rowCount: 2, duplicatesSkipped: 0 });
    expect((await lines(s.A)).slice(-2)).toEqual([
      { d: "2099-05-02", description: "Check paid", ref: "", chk: "001234", debit: "980.00", credit: "0.00", bal: "4020.00" },
      { d: "2099-05-03", description: "Cash deposit", ref: "DEP-77", chk: "", debit: "0.00", credit: "1500.50", bal: "5520.50" },
    ]);
    const audit = await one("SELECT after_data, company_id FROM audit_logs WHERE module = 'BANK_RECON' AND action = 'IMPORT' AND entity_id = ?", [imp.body.batchId]);
    const after = typeof audit.after_data === "string" ? JSON.parse(audit.after_data) : audit.after_data;
    expect(audit.company_id).toBe(co.A);
    expect(after).toMatchObject({ rowCount: 2, duplicatesSkipped: 0, parserVersion: Parser.PARSER_VERSION, fileSha256: pv.body.file.sha256 });
  });

  test("2. valid XLSX: date cells, zero-padded and alphanumeric check numbers, signed / DR-CR amounts", async () => {
    const buf = await workbook((ws) => {
      ws.addRow(["Posting Date", "Particulars", "Cheque No", "Amount"]);
      const r1 = ws.addRow([new Date(Date.UTC(2099, 4, 6)), "Check 1234", 1234, -250]);
      r1.getCell(3).numFmt = "000000";
      ws.addRow([new Date(Date.UTC(2099, 4, 7)), "Check A1", "CHK-00A1", "300.00 DR"]);
      ws.addRow([new Date(Date.UTC(2099, 4, 8)), "Credit memo", "", "(75.25)"]);
      ws.addRow([new Date(Date.UTC(2099, 4, 9)), "Deposit", "", "1,000.00 CR"]);
    });
    const pv = await preview("acctA", s.A, buf, "stmt.xlsx");
    expect(pv.status).toBe(200);
    expect(pv.body.sample.map((r) => [r.txnDate, r.checkNo, r.direction, r.amount])).toEqual([
      ["2099-05-06", "001234", "OUT", "250.00"],
      ["2099-05-07", "CHK-00A1", "OUT", "300.00"],
      ["2099-05-08", "", "OUT", "75.25"],
      ["2099-05-09", "", "IN", "1000.00"],
    ]);
    expect(pv.body.warnings.some((w) => /stored as numbers in the workbook/.test(w.message))).toBe(true);
    const imp = await importFile("acctA", s.A, buf, "stmt.xlsx");
    expect(imp.status).toBe(200);
    expect((await lines(s.A)).slice(-4).map((l) => [l.chk, l.debit, l.credit])).toEqual([
      ["001234", "250.00", "0.00"], ["CHK-00A1", "300.00", "0.00"], ["", "75.25", "0.00"], ["", "0.00", "1000.00"],
    ]);
  });

  test.each([
    ["3. empty CSV", Buffer.alloc(0), "e.csv", "STATEMENT_FILE_EMPTY"],
    ["3b. CSV with a header but no rows", csv([]), "h.csv", "STATEMENT_NO_ROWS"],
    ["5. corrupted workbook", Buffer.from("PK\u0003\u0004 not really a workbook"), "bad.xlsx", "STATEMENT_FILE_UNREADABLE"],
    ["6. unsupported extension", Buffer.from("x"), "stmt.txt", "UNSUPPORTED_STATEMENT_FILE"],
    ["6b. legacy .xls", Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), "stmt.xls", "UNSUPPORTED_STATEMENT_FILE"],
  ])("%s is refused with 400 (preview and import), nothing written", async (_n, buf, name, code) => {
    const before = await lineCount(s.A);
    for (const call of [preview, importFile]) {
      const res = await call("acctA", s.A, buf, name);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(code);
      expect(res.body.message).not.toMatch(/zip|central directory|ER_|SQL/i);
    }
    expect(await lineCount(s.A)).toBe(before);
  });

  test("4. empty workbook is refused", async () => {
    const buf = await workbook(() => {});
    const res = await preview("acctA", s.A, buf, "empty.xlsx");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("STATEMENT_WORKBOOK_EMPTY");
  });

  test("7. missing required column: preview asks for a mapping, import refuses; an explicit mapping resolves it", async () => {
    const buf = csv(["2099-05-10,Mapped,M-1,,12.00,"], "When,Description,Reference,Check No,Debit,Credit");
    const pv = await preview("acctA", s.A, buf);
    expect(pv.status).toBe(200);
    expect(pv.body).toMatchObject({ canImport: false, missingRequired: ["Transaction Date"] });
    expect(pv.body.detectedColumns).toContain("When");
    const imp = await importFile("acctA", s.A, buf);
    expect(imp.status).toBe(400);
    expect(imp.body).toMatchObject({ code: "STATEMENT_MAPPING_REQUIRED", headers: expect.arrayContaining(["When"]) });
    const mapped = await preview("acctA", s.A, buf, "stmt.csv", { columnMapping: { txnDate: "When" } });
    expect(mapped.body).toMatchObject({ canImport: true, missingRequired: [] });
    const badMap = await preview("acctA", s.A, buf, "stmt.csv", { columnMapping: { txnDate: "Nope" } });
    expect(badMap.status).toBe(400);
    expect(badMap.body.code).toBe("STATEMENT_MAPPING_INVALID");
  });
});

// ---------------------------------------------------------------------------
describe("row validation: blocking errors vs warnings", () => {
  const blocked = async (rows, code = "STATEMENT_HAS_BLOCKING_ERRORS") => {
    const before = await lineCount(s.A);
    const pv = await preview("acctA", s.A, csv(rows));
    expect(pv.status).toBe(200);
    expect(pv.body.canImport).toBe(false);
    expect(pv.body.summary.blockingErrors).toBeGreaterThan(0);
    const imp = await importFile("acctA", s.A, csv(rows));
    expect(imp.status).toBe(400);
    expect(imp.body.code).toBe(code);
    expect(await lineCount(s.A)).toBe(before);
    return pv.body;
  };

  test("8. invalid date blocks", async () => {
    const body = await blocked(["2099-02-30,Bad date,,,5.00,"], "INVALID_STATEMENT_DATES");
    expect(body.blockingErrors[0]).toMatchObject({ row: 2, field: "txnDate" });
  });

  test("8b. missing date on a row with an amount blocks", async () => {
    await blocked([",No date,,,5.00,"], "INVALID_STATEMENT_DATES");
  });

  test("9. invalid amount blocks", async () => {
    const body = await blocked(["2099-05-11,Bad amount,,,12.345,"]);
    expect(body.blockingErrors[0].message).toMatch(/more than two decimal places/);
  });

  test("10. debit/credit: both filled, negative in a column, or neither all block", async () => {
    await blocked(["2099-05-11,Both,,,5.00,6.00"]);
    await blocked(["2099-05-11,Negative,,,-5.00,"]);
    await blocked(["2099-05-11,Zero,,,0.00,"]);
  });

  test("a row with nothing to identify it blocks", async () => {
    await blocked(["2099-05-11,,,,5.00,"]);
  });

  test("16. one bad row in an otherwise good file: nothing is imported", async () => {
    await blocked(["2099-05-12,Good one,,,10.00,", "2099-05-12,Good two,,,,20.00", "2099-05-12,Bad,,,ten,"]);
  });

  test("warnings do not block: outside the period, summary rows, missing check number", async () => {
    const pv = await preview("acctA", s.A, csv(["2099-06-15,Next month,,,1.00,", ",TOTAL,,,1.00,"]));
    expect(pv.body.canImport).toBe(true);
    expect(pv.body.warnings.map((w) => w.message).join(" ")).toMatch(/outside this reconciliation period.*Ignored - "TOTAL" summary row/s);
  });
});

// ---------------------------------------------------------------------------
describe("identifiers are preserved exactly", () => {
  test("12-14. leading zeros, alphanumeric and long references survive CSV import", async () => {
    const long = "1234567890123456789012";
    const imp = await importFile("acctA", s.A, csv([`2099-05-13,Ids,${long},000987,7.00,`, "2099-05-13,Ids2,REF-0A9,AB-0001,8.00,"]));
    expect(imp.status).toBe(200);
    expect((await lines(s.A)).slice(-2).map((l) => [l.ref, l.chk])).toEqual([[long, "000987"], ["REF-0A9", "AB-0001"]]);
  });

  test("14b. an XLSX reference Excel already rounded (more than 15 digits) is refused, not stored wrong", async () => {
    const buf = await workbook((ws) => {
      ws.addRow(["Date", "Description", "Reference", "Debit"]);
      ws.addRow(["2099-05-14", "Long", 1234567890123456789, 9]);
    });
    const pv = await preview("acctA", s.A, buf, "long.xlsx");
    expect(pv.body.canImport).toBe(false);
    expect(pv.body.blockingErrors[0].message).toMatch(/Format that column as Text/);
  });
});

// ---------------------------------------------------------------------------
describe("duplicate protection (per company + bank account)", () => {
  const rows = ["2099-05-20,Dup deposit,,,,600.00", "2099-05-20,Dup deposit,,,,600.00", "2099-05-21,Dup check,,000555,99.00,"];

  test("15. identical rows in one file are kept; re-importing the statement creates nothing", async () => {
    const first = await importFile("acctA", s.A, csv(rows));
    expect(first.status).toBe(200);
    expect(first.body.rowCount).toBe(3);
    const pv = await preview("acctA", s.A, csv(rows));
    expect(pv.body.summary).toMatchObject({ duplicates: 3, toImport: 0 });
    expect(pv.body.canImport).toBe(false);
    expect(pv.body.sample.every((r) => r.status === "DUPLICATE")).toBe(true);
    const again = await importFile("acctA", s.A, csv(rows));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("DUPLICATE_STATEMENT_IMPORT");
  });

  test("15b. a later statement overlapping an earlier one imports only the new rows; existing rows are untouched", async () => {
    const before = await lines(s.A);
    const res = await importFile("acctA", s.A, csv([...rows, "2099-05-22,New after overlap,,,,10.00"]));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rowCount: 1, duplicatesSkipped: 3 });
    const after = await lines(s.A);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(-1)[0].description).toBe("New after overlap");
  });

  test("15c. the same statement in another session of the same bank account is refused", async () => {
    // R8.4-A: May already has its session; a June session importing May rows
    const s3 = await newSession("acctA", "BK", { start: "2099-06-01", end: "2099-06-30" });
    expect((await importFile("acctA", s3, csv(rows))).status).toBe(409);
  });

  test("18. the same rows for another bank account or another company are not duplicates", async () => {
    expect((await importFile("acctA", s.A2, csv(rows))).status).toBe(200);
    expect((await importFile("acctB", s.B, csv(rows))).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe("company and bank-account isolation", () => {
  const buf = () => csv(["2099-05-25,Isolation,,,1.00,"]);

  test("17. another company's session answers 404 for preview and import", async () => {
    const before = await lineCount(s.B);
    for (const call of [preview, importFile]) expect((await call("acctA", s.B, buf())).status).toBe(404);
    expect(await lineCount(s.B)).toBe(before);
  });

  test("18b. a different bank account than the session's is refused", async () => {
    for (const call of [preview, importFile]) {
      const res = await call("acctA", s.A, buf(), "stmt.csv", { bankAccountId: String(bank.BK2) });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("STATEMENT_CONTEXT_MISMATCH");
    }
    expect((await preview("acctA", s.A, buf(), "stmt.csv", { bankAccountId: String(bank.BK) })).status).toBe(200);
  });

  test("19. malformed or foreign company id is refused", async () => {
    for (const companyId of ["abc", "-1", "1.5"]) {
      const res = await preview("acctA", s.A, buf(), "stmt.csv", { companyId });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("STATEMENT_CONTEXT_INVALID");
    }
    const foreign = await importFile("acctA", s.A, buf(), "stmt.csv", { companyId: String(co.B) });
    expect(foreign.status).toBe(400);
    expect(foreign.body.code).toBe("STATEMENT_CONTEXT_MISMATCH");
  });

  test("20. no company context or no permission: refused", async () => {
    const legacy = await importFile("super", s.legacy, buf());
    expect(legacy.status).toBe(400);
    expect(legacy.body.code).toBe("STATEMENT_COMPANY_REQUIRED");
    expect((await importFile("viewA", s.A, buf())).status).toBe(403);
    expect((await preview("viewA", s.A, buf())).status).toBe(403);
    expect(await lineCount(s.legacy)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("persisted provenance and the database duplicate guard", () => {
  test("import stores ownership, provenance, normalized identifiers and fingerprints", async () => {
    const buf = csv(["2099-05-28,Persist,REF-007,000777,77.00,,500.00", "2099-05-28,Persist,REF-007,000777,77.00,,423.00", ",heading,,,,,"],
      HEAD);
    const pv = await preview("acctA", s.A, buf, "persist.csv");
    const imp = await importFile("acctA", s.A, buf, "persist.csv");
    expect(imp.status).toBe(200);
    const batch = await one("SELECT company_id, bank_account_id, file_sha256, duplicate_count, ignored_count, parser_version, row_count FROM bank_recon_import_batches WHERE id = ?", [imp.body.batchId]);
    expect(batch).toEqual({ company_id: co.A, bank_account_id: bank.BK, file_sha256: pv.body.file.sha256, duplicate_count: 0, ignored_count: 1, parser_version: Parser.PARSER_VERSION, row_count: 2 });
    const rows = await q(`SELECT company_id, bank_account_id, source_row, check_no, check_no_normalized, reference_no, reference_no_normalized, row_fingerprint
                          FROM bank_recon_statement_lines WHERE batch_id = ? ORDER BY id`, [imp.body.batchId]);
    expect(rows.map((r) => [r.company_id, r.bank_account_id, r.source_row, r.check_no, r.check_no_normalized, r.reference_no, r.reference_no_normalized])).toEqual([
      [co.A, bank.BK, 2, "000777", "777", "REF-007", "ref-007"],
      [co.A, bank.BK, 3, "000777", "777", "REF-007", "ref-007"],
    ]);
    const expected = Parser.fingerprintRows([1, 2].map(() => ({ txnDate: "2099-05-28", direction: "OUT", amountCents: 7700, checkNo: "000777", referenceNo: "REF-007", description: "Persist" })));
    expect(rows.map((r) => r.row_fingerprint)).toEqual(expected.map((e) => e.fingerprint));
  });

  test("value date and bank reference are stored when mapped", async () => {
    const buf = csv(["2099-05-29,2099-05-30,Value dated,BR-000123,5.00,"], "Date,Value Date,Description,Bank Reference,Debit,Credit");
    const imp = await importFile("acctA", s.A, buf, "vd.csv");
    expect(imp.status).toBe(200);
    expect(await one("SELECT DATE_FORMAT(value_date, '%Y-%m-%d') vd, bank_reference br FROM bank_recon_statement_lines WHERE batch_id = ?", [imp.body.batchId]))
      .toEqual({ vd: "2099-05-30", br: "BR-000123" });
  });

  test("the database refuses a second row with the same fingerprint for the same company + bank account", async () => {
    const [row] = await q("SELECT * FROM bank_recon_statement_lines WHERE session_id = ? AND row_fingerprint IS NOT NULL LIMIT 1", [s.A]);
    await expect(pool.query(
      `INSERT INTO bank_recon_statement_lines (batch_id, session_id, company_id, bank_account_id, txn_date, debit, credit, row_fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.batch_id, row.session_id, row.company_id, row.bank_account_id, row.txn_date, row.debit, row.credit, row.row_fingerprint]
    )).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
  });

  test("a row cannot claim a company or bank account other than its session's", async () => {
    const [row] = await q("SELECT * FROM bank_recon_statement_lines WHERE session_id = ? LIMIT 1", [s.A]);
    for (const [companyId, bankId] of [[co.B, bank.BK], [co.A, bank.BK2]]) {
      await expect(pool.query(
        `INSERT INTO bank_recon_statement_lines (batch_id, session_id, company_id, bank_account_id, txn_date, debit, credit)
         VALUES (?, ?, ?, ?, '2099-05-30', 1, 0)`,
        [row.batch_id, row.session_id, companyId, bankId]
      )).rejects.toMatchObject({ code: "ER_NO_REFERENCED_ROW_2" });
    }
  });

  test("assigning a company to a legacy session assigns its statement rows; already-held fingerprints are released, not duplicated", async () => {
    // July: May already belongs to Company A's session (R8.4-A overlap rule)
    const legacy = (await q("INSERT INTO bank_recon_sessions (bank_account_id, period_start, period_end, status) VALUES (?, '2099-07-01', '2099-07-31', 'IN_PROGRESS')", [bank.BK])).insertId;
    sessions.push(legacy);
    const [b] = await pool.query("INSERT INTO bank_recon_import_batches (session_id, company_id, bank_account_id, file_name, file_type, row_count) VALUES (?, NULL, ?, 'legacy.csv', 'CSV', 2)", [legacy, bank.BK]);
    const held = await one("SELECT row_fingerprint fp, txn_date, debit, credit FROM bank_recon_statement_lines WHERE session_id = ? AND company_id = ? AND row_fingerprint IS NOT NULL LIMIT 1", [s.A, co.A]);
    await pool.query(
      `INSERT INTO bank_recon_statement_lines (batch_id, session_id, company_id, bank_account_id, txn_date, debit, credit, row_fingerprint)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?), (?, ?, NULL, ?, '2099-05-31', 3, 0, ?)`,
      [b.insertId, legacy, bank.BK, held.txn_date, held.debit, held.credit, held.fp, b.insertId, legacy, bank.BK, "f".repeat(64)]
    );
    const res = await api("super", "patch", `/api/bank-recon/sessions/${legacy}`, { companyId: co.A });
    expect([res.status, res.body.message]).toEqual([200, "Reconciliation session updated"]);
    expect(await one("SELECT company_id FROM bank_recon_import_batches WHERE id = ?", [b.insertId])).toEqual({ company_id: co.A });
    const rows = await q("SELECT company_id, row_fingerprint FROM bank_recon_statement_lines WHERE session_id = ? ORDER BY id", [legacy]);
    expect(rows).toEqual([{ company_id: co.A, row_fingerprint: null }, { company_id: co.A, row_fingerprint: "f".repeat(64) }]);
  });
});

// ---------------------------------------------------------------------------
describe("ready for matching; AI stays outside the import", () => {
  test("an imported leading-zero check number matches the CV's check number EXACT through the R8.1 engine", async () => {
    const cv = await api("acctA", "post", "/api/cv", {
      voucherNo: `${P}CV-1`, payeeName: "R82 Supplier", transactionDate: "2099-05-27", status: "Posted", paymentMethod: "Check",
      bankAccountId: bank.BK, checkNo: "4321", checkDate: "2099-05-27", totalDebit: 321, totalCredit: 321,
      lines: [
        { accountId: acct.EXP.id, accountCode: acct.EXP.code, accountTitle: acct.EXP.title, particulars: "", debit: 321, credit: 0 },
        { accountId: acct.BANK.id, accountCode: acct.BANK.code, accountTitle: acct.BANK.title, particulars: "", debit: 0, credit: 321 },
      ],
      currency: { companyId: co.A, currencyId: cur.A, exchangeRate: 1, rateDate: "2099-05-27" },
    });
    expect(cv.status).toBe(200);
    expect((await importFile("acctA", s.A, csv(["2099-05-27,Cheque cleared,,0004321,321.00,"]))).status).toBe(200);
    expect((await api("acctA", "post", `/api/bank-recon/sessions/${s.A}/run-matching`)).status).toBe(200);
    const line = await one("SELECT id, check_no FROM bank_recon_statement_lines WHERE session_id = ? AND description = 'Cheque cleared'", [s.A]);
    expect(line.check_no).toBe("0004321");
    const cands = await api("acctA", "get", `/api/bank-recon/statement-lines/${line.id}/candidates`);
    expect(cands.body[0]).toMatchObject({ bookSourceType: "CV", bookSourceId: cv.body.id, matchType: "EXACT", matchLevel: "CHECK_NO" });
  });

  test("the assistant has no statement parsing or import action", () => {
    const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
    const agent = require("../services/BankReconAgentActions");
    expect(Object.keys(agent).filter((k) => /import|parse|statement/i.test(k))).toEqual([]);
    for (const src of [read("services", "BankReconAgentActions.js"), read("services", "ai", "AnthropicProvider.js"), read("services", "ai", "MockProvider.js")]) {
      expect(src).not.toMatch(/bankStatementParser|INSERT INTO bank_recon_statement_lines|import_batches/);
    }
  });
});
