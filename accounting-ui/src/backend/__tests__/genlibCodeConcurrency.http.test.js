// General Libraries - concurrency of branch-aware code identity.
// The shared <-> branch and same-type rules are enforced by the DATABASE
// (genlib_code_registry_migration.sql: registry row lock + triggers), so two
// writers racing on one code can never both succeed - whichever path writes
// (raw SQL, manual create, import). Legitimate same-code, same-type records of
// different branches still both succeed. Local test database only. UAT-GCC.
process.env.POSTING_SOD_TEST_BYPASS = "0";
const request = require("supertest");
const ExcelJS = require("exceljs");
const app = require("../server");
const pool = require("../db");
const { signSessionToken } = require("../lib/sessionPolicy");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(300000);

const P = "UAT-GCC";
const co = {};
const br = {};
const tok = {};
const userIds = [];
let n = 0;
const code = () => `${P}-${++n}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function mkUser(tag) {
  const [[role]] = await pool.query("SELECT id FROM roles WHERE code = 'ADMIN'");
  const [u] = await pool.query("INSERT INTO users (username, full_name, password, role_id, status) VALUES (?, ?, 'x', ?, 'ACTIVE')", [`${P}-${tag}`, `${P}-${tag}`, role.id]);
  await pool.query("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, co.A]);
  userIds.push(u.insertId);
  tok[tag] = signSessionToken({ id: u.insertId, username: `${P}-${tag}`, role: "ADMIN", roleCode: "ADMIN", token_version: 0 });
}
const insertSql = "INSERT INTO general_libraries (company_id, code, party_type, name, status, branch_id) VALUES (?, ?, ?, 'x', 'ACTIVE', ?)";
const rows = async (c) => (await pool.query("SELECT branch_id, party_type FROM general_libraries WHERE company_id = ? AND code = ? ORDER BY branch_id", [co.A, c]))[0];
const registry = async (c) => (await pool.query("SELECT shared_count, branch_count, branch_party_type FROM general_library_code_registry WHERE company_id = ? AND code = ?", [co.A, c]))[0][0] || null;

// conn1 writes and holds its transaction open; conn2 writes the same code
// meanwhile (it must WAIT on the registry row lock), then conn1 commits.
async function race(first, second) {
  const c1 = await pool.getConnection();
  const c2 = await pool.getConnection();
  try {
    await c1.beginTransaction();
    await c2.beginTransaction();
    await c1.execute(insertSql, first);
    let settled = false;
    const p2 = c2.execute(insertSql, second).then(
      async () => { settled = true; await c2.commit(); return { ok: true }; },
      async (err) => { settled = true; await c2.rollback(); return { ok: false, errno: err.errno, message: err.sqlMessage || err.message }; }
    );
    await wait(400);
    const blockedWhileFirstOpen = !settled;
    await c1.commit();
    return { blockedWhileFirstOpen, second: await p2 };
  } finally {
    c1.release();
    c2.release();
  }
}

beforeAll(async () => {
  assertNotProductionDatabase();
  const [c] = await pool.query("INSERT INTO companies (name, status) VALUES (?, 'Active')", [`${P}-A`]);
  co.A = c.insertId;
  for (const k of ["AUD", "OUT", "TAX"]) br[k] = (await pool.query("INSERT INTO branches (company_id, name, code, status) VALUES (?, ?, ?, 'ACTIVE')", [co.A, `${P} ${k}`, `${P}-${k}`]))[0].insertId;
  await mkUser("a1");
  await mkUser("a2");
});

afterAll(async () => {
  try {
    await pool.query("DELETE FROM audit_logs WHERE company_id = ? OR user_id IN (?)", [co.A, userIds]);
    await pool.query("DELETE FROM general_libraries WHERE company_id = ?", [co.A]);
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [userIds]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [userIds]);
    await pool.query("DELETE FROM branches WHERE company_id = ?", [co.A]);
    await pool.query("DELETE FROM companies WHERE id = ?", [co.A]);
  } finally {
    await pool.end();
  }
});

describe("database-enforced: concurrent writers of one code", () => {
  test("shared first, branch second -> the branch insert waits for the lock, then is refused", async () => {
    const c1 = code();
    const r = await race([co.A, c1, "CUSTOMER", null], [co.A, c1, "CUSTOMER", br.TAX]);
    expect(r.blockedWhileFirstOpen).toBe(true);
    expect([r.second.ok, r.second.errno, r.second.message]).toEqual([false, 1644, "GENLIB_CODE_SHARED_BRANCH_CONFLICT"]);
    expect(await rows(c1)).toEqual([{ branch_id: null, party_type: "CUSTOMER" }]);
    expect(await registry(c1)).toEqual({ shared_count: 1, branch_count: 0, branch_party_type: null });
  });
  test("branch first, shared second -> refused the same way", async () => {
    const c1 = code();
    const r = await race([co.A, c1, "CUSTOMER", br.OUT], [co.A, c1, "CUSTOMER", null]);
    expect(r.blockedWhileFirstOpen).toBe(true);
    expect([r.second.ok, r.second.message]).toEqual([false, "GENLIB_CODE_SHARED_BRANCH_CONFLICT"]);
    expect(await rows(c1)).toEqual([{ branch_id: br.OUT, party_type: "CUSTOMER" }]);
  });
  test("two branches, same type -> BOTH succeed (the legitimate case)", async () => {
    const c1 = code();
    const r = await race([co.A, c1, "CUSTOMER", br.OUT], [co.A, c1, "CUSTOMER", br.TAX]);
    expect(r.second.ok).toBe(true);
    expect((await rows(c1)).map((x) => x.branch_id).sort()).toEqual([br.OUT, br.TAX].sort());
    expect(await registry(c1)).toEqual({ shared_count: 0, branch_count: 2, branch_party_type: "CUSTOMER" });
  });
  test("two branches, different types -> the second is refused", async () => {
    const c1 = code();
    const r = await race([co.A, c1, "CUSTOMER", br.OUT], [co.A, c1, "SUPPLIER", br.TAX]);
    expect([r.second.ok, r.second.message]).toEqual([false, "GENLIB_CODE_TYPE_CONFLICT"]);
    expect(await rows(c1)).toEqual([{ branch_id: br.OUT, party_type: "CUSTOMER" }]);
  });
  test("two shared inserts -> the unique key refuses the second (ER_DUP_ENTRY, as before)", async () => {
    const c1 = code();
    const r = await race([co.A, c1, "SUPPLIER", null], [co.A, c1, "SUPPLIER", null]);
    expect([r.second.ok, r.second.errno]).toEqual([false, 1062]);
  });
});

describe("database-enforced: edits and deletes keep the identity exact", () => {
  test("an UPDATE cannot make a code shared while a branch holds it, nor change one branch's type alone", async () => {
    const c1 = code();
    await pool.execute(insertSql, [co.A, c1, "CUSTOMER", br.OUT]);
    await pool.execute(insertSql, [co.A, c1, "CUSTOMER", br.TAX]);
    await expect(pool.execute("UPDATE general_libraries SET branch_id = NULL WHERE company_id = ? AND code = ? AND branch_id = ?", [co.A, c1, br.TAX])).rejects.toMatchObject({ errno: 1644 });
    await expect(pool.execute("UPDATE general_libraries SET party_type = 'SUPPLIER' WHERE company_id = ? AND code = ? AND branch_id = ?", [co.A, c1, br.TAX])).rejects.toMatchObject({ errno: 1644 });
    expect(await registry(c1)).toEqual({ shared_count: 0, branch_count: 2, branch_party_type: "CUSTOMER" });
    // the last branch record may change type / become shared
    await pool.execute("DELETE FROM general_libraries WHERE company_id = ? AND code = ? AND branch_id = ?", [co.A, c1, br.OUT]);
    await pool.execute("UPDATE general_libraries SET party_type = 'SUPPLIER' WHERE company_id = ? AND code = ?", [co.A, c1]);
    expect(await registry(c1)).toEqual({ shared_count: 0, branch_count: 1, branch_party_type: "SUPPLIER" });
    await pool.execute("UPDATE general_libraries SET branch_id = NULL WHERE company_id = ? AND code = ?", [co.A, c1]);
    expect(await registry(c1)).toEqual({ shared_count: 1, branch_count: 0, branch_party_type: null });
    await pool.execute("DELETE FROM general_libraries WHERE company_id = ? AND code = ?", [co.A, c1]);
    expect(await registry(c1)).toBeNull();
  });
  test("a case-only code edit is the same code (no registry churn); a real rename moves the identity", async () => {
    const c1 = code();
    await pool.execute(insertSql, [co.A, c1, "CUSTOMER", br.AUD]);
    await pool.execute("UPDATE general_libraries SET code = LOWER(code) WHERE company_id = ? AND code = ?", [co.A, c1]);
    expect(await registry(c1)).toEqual({ shared_count: 0, branch_count: 1, branch_party_type: "CUSTOMER" });
    await pool.execute("UPDATE general_libraries SET code = ? WHERE company_id = ? AND code = ?", [`${c1}-R`, co.A, c1]);
    expect(await registry(c1)).toBeNull();
    expect(await registry(`${c1}-R`)).toEqual({ shared_count: 0, branch_count: 1, branch_party_type: "CUSTOMER" });
  });
  test("the registry equals the records for this company", async () => {
    const [[m]] = await pool.query(
      `SELECT COUNT(*) AS n FROM (SELECT company_id, code, SUM(branch_id IS NULL) s, SUM(branch_id IS NOT NULL) b FROM general_libraries WHERE company_id = ? GROUP BY company_id, code) t
        LEFT JOIN general_library_code_registry r ON r.company_id = t.company_id AND r.code = t.code
       WHERE r.code IS NULL OR r.shared_count <> t.s OR r.branch_count <> t.b`, [co.A]);
    expect(m.n).toBe(0);
  });
});

describe("application paths racing", () => {
  const body = (c, branchId, type = "CUSTOMER") => ({ code: c, name: "x", type, status: "ACTIVE", companyId: co.A, branchId });
  test("10 races of shared vs branch manual creates: exactly one wins every time, never both", async () => {
    for (let i = 0; i < 10; i++) {
      const c1 = code();
      const [a, b] = await Promise.all([
        request(app).post("/api/genlib").set("Authorization", `Bearer ${tok.a1}`).send(body(c1, null)),
        request(app).post("/api/genlib").set("Authorization", `Bearer ${tok.a2}`).send(body(c1, br.TAX)),
      ]);
      expect([a.status, b.status].filter((s) => s === 200).length).toBe(1);
      expect([a.status, b.status].every((s) => s === 200 || s === 400 || s === 409)).toBe(true);
      expect((await rows(c1)).length).toBe(1);
    }
  });
  test("concurrent same-type creates in two branches both succeed", async () => {
    const c1 = code();
    const [a, b] = await Promise.all([
      request(app).post("/api/genlib").set("Authorization", `Bearer ${tok.a1}`).send(body(c1, br.OUT)),
      request(app).post("/api/genlib").set("Authorization", `Bearer ${tok.a2}`).send(body(c1, br.TAX)),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
  });
  test("an import confirm racing a shared manual create: never both; the loser writes nothing", async () => {
    for (let i = 0; i < 5; i++) {
      const c1 = code();
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("General Libraries");
      [["Code", "Type", "Name", "Owning Branch"], [c1, "CUSTOMER", "x", `${P}-TAX`], [`${c1}-other`, "CUSTOMER", "y", `${P}-TAX`]].forEach((r) => ws.addRow(r));
      const file = Buffer.from(await wb.xlsx.writeBuffer());
      const [imp, man] = await Promise.all([
        request(app).post("/api/genlib/import").set("Authorization", `Bearer ${tok.a1}`).field("companyId", String(co.A)).attach("file", file, "x.xlsx"),
        request(app).post("/api/genlib").set("Authorization", `Bearer ${tok.a2}`).send(body(c1, null)),
      ]);
      const have = await rows(c1);
      expect(have.length).toBe(1); // exactly one owner of the code
      if (man.status === 200) {
        // the import either skipped the code at validation or rolled back entirely (409)
        expect([200, 409]).toContain(imp.status);
        if (imp.status === 409) expect((await rows(`${c1}-other`)).length).toBe(0);
        else expect(imp.body.skipped.map((s) => s.code)).toContain(c1);
      } else {
        expect(imp.status).toBe(200);
        expect(have[0].branch_id).toBe(br.TAX);
      }
    }
  });
  test("preview then a competing write then confirm: confirm revalidates against the latest data", async () => {
    const c1 = code();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("General Libraries");
    [["Code", "Type", "Name", "Owning Branch"], [c1, "CUSTOMER", "x", `${P}-TAX`]].forEach((r) => ws.addRow(r));
    const file = Buffer.from(await wb.xlsx.writeBuffer());
    const preview = await request(app).post("/api/genlib/import/preview").set("Authorization", `Bearer ${tok.a1}`).field("companyId", String(co.A)).attach("file", file, "x.xlsx");
    expect(preview.body.readyCount).toBe(1);
    expect((await request(app).post("/api/genlib").set("Authorization", `Bearer ${tok.a2}`).send(body(c1, null))).status).toBe(200);
    const confirm = await request(app).post("/api/genlib/import").set("Authorization", `Bearer ${tok.a1}`).field("companyId", String(co.A)).attach("file", file, "x.xlsx");
    expect([confirm.body.imported, confirm.body.skipped[0].reason]).toEqual([0, `Code "${c1}" is a shared record; a branch-only record cannot reuse it`]);
  });
});
