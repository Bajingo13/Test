// General Libraries - branch-aware party code identity.
// Same code + same owner = duplicate; same code + different branches =
// allowed (same type); shared <-> branch reuse refused; companies isolated.
// Import preview / confirm, manual create / edit, transaction references,
// book party resolution and delete references follow ONE rule
// (services/genlibCodePolicy.js). Local test database only. Prefix UAT-GBI.
process.env.POSTING_SOD_TEST_BYPASS = "0";
const request = require("supertest");
const ExcelJS = require("exceljs");
const app = require("../server");
const pool = require("../db");
const { signSessionToken } = require("../lib/sessionPolicy");
const CurrencyService = require("../services/currencyService");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const Policy = require("../services/genlibCodePolicy");

jest.setTimeout(300000);

const P = "UAT-GBI";
const D = "2098-02-10";
const co = {};
const br = {};
const bcode = {};
const tok = {};
const usr = {};
const acc = {};
const userIds = [];
const C1 = `${P} AOC ALABANG`;
const C2 = `${P} AOC BULACAN`;
const C3 = `${P} AOC CAVITE`;
const SH = `${P} SHARED ONE`;

async function roleId(code) {
  return (await pool.query("SELECT id FROM roles WHERE code = ?", [code]))[0][0].id;
}
async function mkUser(tag, roleCode, companies, branches = []) {
  const [u] = await pool.query("INSERT INTO users (username, full_name, password, role_id, status) VALUES (?, ?, 'x', ?, 'ACTIVE')", [`${P}-${tag}`, `${P}-${tag}`, await roleId(roleCode)]);
  for (const c of companies) await pool.query("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  for (const b of branches) await pool.query("INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)", [u.insertId, b]);
  userIds.push(u.insertId);
  usr[tag] = { id: u.insertId, username: `${P}-${tag}`, role: roleCode, roleCode, token_version: 0 };
  tok[tag] = signSessionToken(usr[tag]);
}
const HEAD = ["Code", "Type", "Name", "Owning Branch"];
async function xlsx(rows, headers = HEAD) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("General Libraries");
  [headers, ...rows].forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const send = (who, path, buf, { companyKey = "A", active } = {}) => {
  const r = request(app).post(path).set("Authorization", `Bearer ${tok[who]}`);
  if (active !== undefined) r.set("X-Active-Branch", String(active));
  r.field("companyId", String(co[companyKey]));
  return r.attach("file", buf, "GENLIB_TEMPLATE.xlsx");
};
const call = (method, who, url, body, active) => {
  const r = request(app)[method](url).set({ Authorization: `Bearer ${tok[who]}` });
  if (active !== undefined) r.set("X-Active-Branch", String(active));
  return body === undefined ? r : r.send(body);
};
const rowsOf = async (code, companyKey = "A") =>
  (await pool.query("SELECT id, code, name, party_type, branch_id FROM general_libraries WHERE company_id = ? AND code = ? ORDER BY branch_id", [co[companyKey], code]))[0];
const reasons = (res) => Object.fromEntries((res.body.skipped || []).map((s) => [s.row, s.reason]));

beforeAll(async () => {
  assertNotProductionDatabase();
  const mkCo = async (tag, branches) => {
    const [c] = await pool.query("INSERT INTO companies (name, status) VALUES (?, 'Active')", [`${P}-${tag}`]);
    co[tag] = c.insertId;
    for (const [key, code] of branches) {
      const [b] = await pool.query("INSERT INTO branches (company_id, name, code, status) VALUES (?, ?, ?, 'ACTIVE')", [c.insertId, `${tag} ${key}`, code]);
      br[`${tag}.${key}`] = b.insertId;
      bcode[`${tag}.${key}`] = code;
    }
    await CurrencyService.createCurrency({ id: 0, roleCode: "SUPER_ADMIN" }, { currencyCode: "PHP", currencyName: "Peso", currencySymbol: "P", decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: c.insertId });
  };
  // branch codes like a real deployment: 000 / 001 / 002
  await mkCo("A", [["AUDIT", "GBI-000"], ["OUTSOURCE", "GBI-001"], ["TAX", "GBI-002"]]);
  await mkCo("B", [["AUDIT", "GBI-000"]]); // overlapping branch code, another company
  await mkUser("adminA", "ADMIN", [co.A]);
  await mkUser("adminA2", "ADMIN", [co.A]);
  await mkUser("adminB", "ADMIN", [co.B]);
  await pool.query("INSERT INTO general_libraries (company_id, code, party_type, name, status, branch_id) VALUES (?, ?, 'SUPPLIER', 'Shared one', 'ACTIVE', NULL)", [co.A, SH]);
  for (const [key, cls] of [["EXP", "EXPENSE"], ["AP", "LIABILITY"]]) {
    const [r] = await pool.query("INSERT INTO chart_of_accounts (code, account_date, title, account_class, branch_id) VALUES (?, '2098-01-01', ?, ?, NULL)", [`${P}-${key}`, `${P}-${key}`, cls]);
    acc[key] = { id: r.insertId, code: `${P}-${key}` };
  }
});

afterAll(async () => {
  try {
    const cos = Object.values(co);
    await pool.query("DELETE l FROM jv_lines l JOIN jv_headers h ON h.id = l.jv_id WHERE h.company_id IN (?)", [cos]);
    await pool.query("DELETE FROM jv_headers WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM audit_logs WHERE company_id IN (?) OR user_id IN (?)", [cos, userIds]);
    await pool.query("DELETE FROM general_libraries WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE ?", [`${P}-%`]);
    await pool.query("DELETE FROM currency_rates WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM currencies WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM user_branches WHERE user_id IN (?)", [userIds]);
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [userIds]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [userIds]);
    await pool.query("DELETE FROM branches WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM companies WHERE id IN (?)", [cos]);
  } finally {
    await pool.end();
  }
});

describe("schema", () => {
  test("UNIQUE (company_id, code, branch_scope) replaces UNIQUE (company_id, code); branch_scope = IFNULL(branch_id, 0)", async () => {
    const [idx] = await pool.query(
      "SELECT index_name, GROUP_CONCAT(column_name ORDER BY seq_in_index) cols FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'general_libraries' AND non_unique = 0 GROUP BY index_name"
    );
    const map = Object.fromEntries(idx.map((r) => [r.index_name || r.INDEX_NAME, r.cols]));
    expect(map.uq_genlib_company_code_branch).toBe("company_id,code,branch_scope");
    expect(map.uq_genlib_company_code).toBeUndefined();
  });
});

describe("import: same code, different owning branches", () => {
  let outIds;
  test("1. OUTSOURCE owns the codes", async () => {
    const res = await send("adminA", "/api/genlib/import", await xlsx([[C1, "CUSTOMER", "Alabang (OUT)", bcode["A.OUTSOURCE"]], [C2, "CUSTOMER", "Bulacan (OUT)", bcode["A.OUTSOURCE"]], [C3, "CUSTOMER", "Cavite (OUT)", bcode["A.OUTSOURCE"]]]));
    expect([res.status, res.body.imported]).toEqual([200, 3]);
    outIds = (await rowsOf(C1)).map((r) => r.id);
  });
  test("2/8/9. TAX separately owns them: preview = confirm; the sidebar's active branch (AUDIT) never changes the file's owner", async () => {
    const file = await xlsx([[C1, "CUSTOMER", "Alabang (TAX)", bcode["A.TAX"]], [C2, "CUSTOMER", "Bulacan (TAX)", bcode["A.TAX"]], [C3, "CUSTOMER", "Cavite (TAX)", bcode["A.TAX"]]]);
    const preview = await send("adminA", "/api/genlib/import/preview", file, { active: br["A.AUDIT"] });
    expect([preview.status, preview.body.readyCount, preview.body.skipped.length]).toEqual([200, 3, 0]);
    expect(preview.body.ownership).toEqual([{ owner: bcode["A.TAX"], count: 3 }]);
    const confirm = await send("adminA", "/api/genlib/import", file, { active: br["A.AUDIT"] });
    expect([confirm.status, confirm.body.imported, confirm.body.skipped.length]).toEqual([200, preview.body.readyCount, 0]);
    const rows = await rowsOf(C1);
    expect(rows.map((r) => [r.branch_id, r.name])).toEqual([[br["A.OUTSOURCE"], "Alabang (OUT)"], [br["A.TAX"], "Alabang (TAX)"]].sort((a, b) => a[0] - b[0]));
  });
  test("3. re-importing into TAX: each code is a duplicate IN THIS BRANCH; nothing written", async () => {
    const before = (await pool.query("SELECT COUNT(*) n FROM general_libraries WHERE company_id = ?", [co.A]))[0][0].n;
    const file = await xlsx([[C1, "CUSTOMER", "changed", bcode["A.TAX"]], [C2, "CUSTOMER", "changed", bcode["A.TAX"]]]);
    const preview = await send("adminA", "/api/genlib/import/preview", file);
    const confirm = await send("adminA", "/api/genlib/import", file);
    for (const res of [preview, confirm]) {
      expect(reasons(res)).toEqual({ 2: `Code "${C1}" already exists in this branch`, 3: `Code "${C2}" already exists in this branch` });
    }
    expect(confirm.body.imported).toBe(0);
    expect((await pool.query("SELECT COUNT(*) n FROM general_libraries WHERE company_id = ?", [co.A]))[0][0].n).toBe(before);
    expect((await rowsOf(C1)).map((r) => r.name)).toEqual(["Alabang (OUT)", "Alabang (TAX)"]);
  });
  test("4. AUDIT follows the same policy (allowed once; then a duplicate in AUDIT)", async () => {
    const file = await xlsx([[C1, "CUSTOMER", "Alabang (AUD)", bcode["A.AUDIT"]]]);
    expect((await send("adminA", "/api/genlib/import", file)).body.imported).toBe(1);
    expect(reasons(await send("adminA", "/api/genlib/import/preview", file))).toEqual({ 2: `Code "${C1}" already exists in this branch` });
    expect((await rowsOf(C1)).length).toBe(3);
    expect((await rowsOf(C1)).map((r) => r.id)).toEqual(expect.arrayContaining(outIds));
  });
  test("12. shared <-> branch reuse is refused both ways, never shadowed; type conflicts refused", async () => {
    const res = await send("adminA", "/api/genlib/import/preview", await xlsx([
      [SH, "SUPPLIER", "x", bcode["A.TAX"]], // branch reusing a shared code
      [C2, "CUSTOMER", "x", "SHARED"], // shared reusing a branch code
      [C3, "SUPPLIER", "x", bcode["A.AUDIT"]], // other branches own C3 as CUSTOMER
      [SH, "SUPPLIER", "x", ""], // shared duplicate (legacy wording)
    ]));
    expect(reasons(res)).toEqual({
      2: `Code "${SH}" is a shared record; a branch-only record cannot reuse it`,
      3: `Code "${C2}" is already used by a branch-only record; a shared record cannot reuse it`,
      4: `Code "${C3}" is used by another branch as a CUSTOMER; branches sharing a code must use the same type`,
      5: `Code "${SH}" already exists`,
    });
    expect(res.body.readyCount).toBe(0);
  });
  test("10. partial import: exact ready / skipped counts with one reason per skipped row", async () => {
    const res = await send("adminA", "/api/genlib/import", await xlsx([
      [`${P} NEW-1`, "SUPPLIER", "n1", bcode["A.TAX"]],
      [`${P} NEW-1`, "SUPPLIER", "n1 again", bcode["A.TAX"]], // repeated in the file, same owner
      [`${P} NEW-1`, "SUPPLIER", "n1 out", bcode["A.OUTSOURCE"]], // same code, other branch -> allowed
      [C1, "CUSTOMER", "dup", bcode["A.OUTSOURCE"]], // exists in OUTSOURCE
      [`${P} NEW-2`, "SUPPLIER", "n2", ""],
      [`${P} NEW-2`, "SUPPLIER", "n2 tax", bcode["A.TAX"]], // shared row earlier in the file
    ]));
    expect(res.body.imported).toBe(3);
    expect(reasons(res)).toEqual({
      3: `Code "${P} NEW-1" is repeated in this file (first used on row 2)`,
      5: `Code "${C1}" already exists in this branch`,
      7: `Code "${P} NEW-2" is a shared record (row 6 of this file); a branch-only record cannot reuse it`,
    });
  });
});

describe("5/6. shared records, other companies", () => {
  test("shared records stay visible to every authorized branch", async () => {
    for (const b of ["A.AUDIT", "A.OUTSOURCE", "A.TAX"]) {
      const r = await call("get", "adminA", `/api/genlib?companyId=${co.A}`, undefined, br[b]);
      expect(r.body.map((x) => x.code)).toContain(SH);
    }
  });
  test("another company may use the same codes; nothing collides or leaks", async () => {
    const res = await send("adminB", "/api/genlib/import", await xlsx([[C1, "SUPPLIER", "B shared", ""], [SH, "SUPPLIER", "B shared 2", bcode["B.AUDIT"]]]), { companyKey: "B" });
    expect([res.status, res.body.imported]).toEqual([200, 2]);
    expect((await rowsOf(C1, "B")).length).toBe(1);
    const aList = (await call("get", "adminA", `/api/genlib?companyId=${co.A}`)).body;
    expect(aList.some((x) => x.name === "B shared")).toBe(false);
    expect((await call("get", "adminB", `/api/genlib?companyId=${co.A}`)).status).toBe(403);
  });
});

describe("manual create / edit use the same rule", () => {
  const body = (code, type, branchKey, name = "manual") => ({ code, type, name, status: "ACTIVE", companyId: co.A, branchId: branchKey ? br[branchKey] : null });
  test("same code in another branch is allowed; same branch / shared conflicts / type conflicts refused (400, as before)", async () => {
    expect((await call("post", "adminA", "/api/genlib", body(C2, "CUSTOMER", "A.AUDIT"))).status).toBe(200);
    const dup = await call("post", "adminA", "/api/genlib", body(C2, "CUSTOMER", "A.TAX"));
    expect([dup.status, dup.body.code]).toEqual([400, "GENLIB_CODE_EXISTS"]);
    const sharedOverBranch = await call("post", "adminA", "/api/genlib", body(C3, "CUSTOMER", null));
    expect([sharedOverBranch.status, sharedOverBranch.body.code]).toEqual([400, "GENLIB_CODE_USED_BY_BRANCH"]);
    const branchOverShared = await call("post", "adminA", "/api/genlib", body(SH, "SUPPLIER", "A.AUDIT"));
    expect([branchOverShared.status, branchOverShared.body.code]).toEqual([400, "GENLIB_CODE_SHARED_CONFLICT"]);
    const type = await call("post", "adminA", "/api/genlib", body(C3, "SUPPLIER", "A.AUDIT"));
    expect([type.status, type.body.code]).toEqual([400, "GENLIB_CODE_TYPE_CONFLICT"]);
  });
  test("12. an edit can never move a record onto another branch's identical code or make it shared silently", async () => {
    const [tax] = (await rowsOf(C1)).filter((r) => r.branch_id === br["A.TAX"]);
    const moved = await call("put", "adminA", `/api/genlib/${tax.id}`, { ...body(C1, "CUSTOMER", "A.OUTSOURCE", "Alabang (TAX)") });
    expect([moved.status, moved.body.code]).toEqual([400, "GENLIB_CODE_EXISTS"]);
    const shared = await call("put", "adminA", `/api/genlib/${tax.id}`, { ...body(C1, "CUSTOMER", null, "Alabang (TAX)") });
    expect([shared.status, shared.body.code]).toEqual([400, "GENLIB_CODE_USED_BY_BRANCH"]);
    const rename = await call("put", "adminA", `/api/genlib/${tax.id}`, { ...body(C1, "CUSTOMER", "A.TAX", "Alabang (TAX) renamed") });
    expect(rename.status).toBe(200);
    const after = await rowsOf(C1);
    expect(after.find((r) => r.id === tax.id)).toMatchObject({ branch_id: br["A.TAX"], name: "Alabang (TAX) renamed" });
    expect(after.find((r) => r.branch_id === br["A.OUTSOURCE"]).name).toBe("Alabang (OUT)");
  });
});

describe("7/11. code-based lookups pick the document branch's record; history unchanged", () => {
  const jv = (branchKey, code, n) => ({
    voucherNo: `${P}-JV-${n}`, transactionDate: D, dueDate: D, totalDebit: 100, totalCredit: 100, status: "Draft", companyId: co.A, currency: { companyId: co.A }, branchId: br[branchKey],
    lines: [
      { accountId: acc.EXP.id, accountCode: acc.EXP.code, accountTitle: "EXP", particulars: "x", debit: 100, credit: 0, genRef: code, genName: "" },
      { accountId: acc.AP.id, accountCode: acc.AP.code, accountTitle: "AP", particulars: "x", debit: 0, credit: 100 },
    ],
  });
  const ids = {};
  test("a TAX and an OUTSOURCE document may both reference the code; a branch without it is refused", async () => {
    for (const [k, n] of [["A.TAX", 1], ["A.OUTSOURCE", 2]]) {
      const r = await call("post", "adminA", "/api/jv", jv(k, C1, n));
      expect(r.status).toBe(200);
      ids[k] = r.body.id;
      expect((await call("put", "adminA2", `/api/jv/${r.body.id}`, { ...jv(k, C1, n), status: "Posted" })).status).toBe(200);
    }
    const audit = await call("post", "adminA", "/api/jv", jv("A.AUDIT", `${P} NEW-1`, 3)); // NEW-1: TAX + OUTSOURCE only
    expect([audit.status, audit.body.code]).toEqual([400, "PARTY_BRANCH_MISMATCH"]);
    expect((await call("post", "adminA", "/api/jv", jv("A.AUDIT", SH, 4))).status).toBe(200); // shared: any branch
  });
  test("the Journal Book names each line's party from ITS branch's record (never the other branch's)", async () => {
    const book = await call("get", "adminA", `/api/reports/books/journal?companyId=${co.A}&from=2098-02-01&to=2098-02-28&branch=ALL`);
    expect(book.status).toBe(200);
    const name = (voucher) => (book.body.find((r) => r.reference_no === voucher && r.general_reference === C1) || {}).party_name;
    expect(name(`${P}-JV-1`)).toBe("Alabang (TAX) renamed");
    expect(name(`${P}-JV-2`)).toBe("Alabang (OUT)");
  });
  test("delete references are counted per owning branch (TAX lines never block another branch's record, and vice versa)", async () => {
    const [aud] = (await rowsOf(C1)).filter((r) => r.branch_id === br["A.AUDIT"]);
    const [out] = (await rowsOf(C1)).filter((r) => r.branch_id === br["A.OUTSOURCE"]);
    const delAud = await call("delete", "adminA", `/api/genlib/${aud.id}?companyId=${co.A}`);
    expect(delAud.status).toBe(200); // C1 is used only by TAX / OUTSOURCE documents
    const delOut = await call("delete", "adminA", `/api/genlib/${out.id}?companyId=${co.A}`);
    expect([delOut.status, delOut.body.code]).toEqual([409, "GENLIB_IN_USE"]);
    const [[jvRow]] = await pool.query("SELECT gen_ref FROM jv_lines WHERE jv_id = ? AND gen_ref <> ''", [ids["A.OUTSOURCE"]]);
    expect(jvRow.gen_ref).toBe(C1); // history untouched
  });
});

describe("policy unit rules", () => {
  test("resolvePartyForBranch: own branch, else shared, else a lone record; never another branch's when the code is reused", () => {
    const rows = [{ id: 1, branch_id: 11 }, { id: 2, branch_id: 12 }];
    expect(Policy.resolvePartyForBranch(rows, 12).id).toBe(2);
    expect(Policy.resolvePartyForBranch(rows, 13)).toBeNull();
    expect(Policy.resolvePartyForBranch([{ id: 3, branch_id: null }, ...rows], 13).id).toBe(3);
    expect(Policy.resolvePartyForBranch([{ id: 4, branch_id: 11 }], 12).id).toBe(4); // moved record keeps its history
  });
});
