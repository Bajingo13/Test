// RFP (Request for Payment) R2: draft CRUD over HTTP - permissions,
// strict company selection, supplier / branch / currency / line / total
// validation, server-side numbering, status rules and company-attributed
// audit. Schema + permission catalog are covered by
// rfpSchemaPermissions.test.js.
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(180000);

const P = "rfpr2-";
const PASSWORD = "RfpR2Pass!1";
const UNKNOWN_ID = 2147483000;

const co = {};
const cur = {};
const sup = {};
const br = {};
const users = {};
const tokens = {};
let accountId;

async function makeUser(tag, roleCode, companyIds = [], branchIds = []) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const [u] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, (SELECT id FROM roles WHERE code = ?), 'ACTIVE')",
    [`${P}${tag}`, hash, roleCode]
  );
  for (const c of companyIds) await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  for (const b of branchIds) await pool.execute("INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)", [u.insertId, b]);
  users[tag] = u.insertId;
  const res = await request(app).post("/api/login").send({ username: `${P}${tag}`, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login ${tag}: ${res.status}`);
  tokens[tag] = res.body.token;
}

async function supplier(tag, companyId, partyType = "SUPPLIER", status = "ACTIVE") {
  const [r] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, tin, status) VALUES (?, ?, ?, ?, ?, ?)",
    [companyId, `${P}${tag}`, partyType, `Supplier ${tag}`, `TIN-${tag}`, status]
  );
  return r.insertId;
}

const auth = (who) => ({ Authorization: `Bearer ${tokens[who]}` });
const api = {
  list: (who, query = {}) => request(app).get("/api/rfp").query(query).set(auth(who)),
  get: (who, id) => request(app).get(`/api/rfp/${id}`).set(auth(who)),
  create: (who, body) => request(app).post("/api/rfp").set(auth(who)).send(body),
  update: (who, id, body) => request(app).put(`/api/rfp/${id}`).set(auth(who)).send(body),
  remove: (who, id) => request(app).delete(`/api/rfp/${id}`).set(auth(who)),
};

// A valid Company A body; overrides replace whole keys.
function bodyA(overrides = {}) {
  return {
    companyId: co.A,
    rfpDate: "2096-03-15",
    supplierId: sup.A,
    purpose: "Office supplies replenishment",
    requestedPaymentDate: "2096-03-31",
    currencyId: cur.A,
    supportingReference: "SI-1001",
    remarks: "Urgent",
    lines: [
      { description: "Paper", grossAmount: "1000.50", accountId, vatTreatment: "STANDARD", reference: "L1" },
      { description: "Ink", grossAmount: 250, vatTreatment: "EXEMPT" },
    ],
    ...overrides,
  };
}

async function auditRows(rfpId) {
  const [rows] = await pool.query(
    "SELECT action, company_id, before_data, after_data, description FROM audit_logs WHERE module = 'TRANSACTIONS.RFP' AND entity_type = 'RFP' AND entity_id = ? ORDER BY id",
    [rfpId]
  );
  return rows;
}

async function setStatus(id, status, extra = "") {
  await pool.execute(`UPDATE rfp_headers SET status = ?${extra} WHERE id = ?`, [status, id]);
}

beforeAll(async () => {
  assertNotProductionDatabase();
  for (const tag of ["A", "B", "C"]) {
    const [c] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${P}Co ${tag}`]);
    co[tag] = c.insertId;
    const [k] = await pool.execute(
      "INSERT INTO currencies (company_id, currency_code, currency_name, currency_symbol) VALUES (?, 'PHP', 'Philippine Peso', 'P')",
      [co[tag]]
    );
    cur[tag] = k.insertId;
  }
  const [inactiveCur] = await pool.execute(
    "INSERT INTO currencies (company_id, currency_code, currency_name, currency_symbol, is_active) VALUES (?, 'USD', 'US Dollar', '$', 0)",
    [co.A]
  );
  cur.inactiveA = inactiveCur.insertId;

  sup.A = await supplier("supA", co.A);
  sup.A2 = await supplier("supA2", co.A);
  sup.customerA = await supplier("custA", co.A, "CUSTOMER");
  sup.inactiveA = await supplier("inactA", co.A, "SUPPLIER", "INACTIVE");
  sup.B = await supplier("supB", co.B);

  for (const [tag, company] of [["A1", co.A], ["A2", co.A], ["B1", co.B]]) {
    const [b] = await pool.execute("INSERT INTO branches (company_id, name) VALUES (?, ?)", [company, `${P}Branch ${tag}`]);
    br[tag] = b.insertId;
  }

  await pool.execute("DELETE FROM chart_of_accounts WHERE code = 'RFPR2EXP'");
  const [acct] = await pool.execute("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES ('RFPR2EXP', CURDATE(), 'RFP R2 Expense', 'EXPENSE')");
  accountId = acct.insertId;

  await makeUser("super", "SUPER_ADMIN");
  await makeUser("adminA", "ADMIN", [co.A], [br.A1]);
  await makeUser("acctA", "ACCOUNTANT", [co.A], [br.A1]);
  await makeUser("adminB", "ADMIN", [co.B], [br.B1]);
  await makeUser("multi", "ADMIN", [co.A, co.B], [br.A1, br.B1]);
  await makeUser("none", "ADMIN");
  await makeUser("viewer", "ACCOUNTANT", [co.A]);
  const [[createPerm]] = await pool.query("SELECT id FROM permissions WHERE module_key = 'TRANSACTIONS.RFP' AND action = 'CREATE'");
  await pool.execute("INSERT INTO user_permissions (user_id, permission_id, granted, reason) VALUES (?, ?, 0, 'rfp r2 test')", [users.viewer, createPerm.id]);
});

afterAll(async () => {
  const companies = Object.values(co);
  const userIds = Object.values(users);
  try {
    if (companies.length) {
      await pool.query("DELETE h FROM rfp_status_history h JOIN rfp_headers r ON r.id = h.rfp_id WHERE r.company_id IN (?)", [companies]);
      await pool.query("DELETE FROM rfp_headers WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM audit_logs WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM general_libraries WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM currencies WHERE company_id IN (?)", [companies]);
    }
    if (userIds.length) {
      await pool.query("DELETE FROM audit_logs WHERE user_id IN (?)", [userIds]);
      await pool.query("DELETE FROM users WHERE id IN (?)", [userIds]);
    }
    if (companies.length) {
      await pool.query("DELETE FROM branches WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM companies WHERE id IN (?)", [companies]);
    }
    await pool.execute("DELETE FROM chart_of_accounts WHERE code = 'RFPR2EXP'");
  } finally {
    await pool.end();
  }
});

describe("permissions", () => {
  test("every route requires authentication", async () => {
    expect((await request(app).get("/api/rfp")).status).toBe(401);
    expect((await request(app).post("/api/rfp").send(bodyA())).status).toBe(401);
  });

  test("a user without CREATE is refused server-side (403) and nothing is created", async () => {
    const res = await api.create("viewer", bodyA({ companyId: undefined }));
    expect(res.status).toBe(403);
    const [[{ n }]] = await pool.query("SELECT COUNT(*) n FROM rfp_headers WHERE requester_user_id = ?", [users.viewer]);
    expect(n).toBe(0);
    expect((await api.list("viewer")).status).toBe(200); // VIEW still granted
  });
});

describe("create", () => {
  test("Admin creates a DRAFT with a server-calculated total and server snapshots", async () => {
    const res = await api.create("adminA", bodyA());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ companyId: co.A, status: "DRAFT", totalAmount: "1250.50" });
    expect(res.body.rfpNo).toMatch(/^RFP96-\d{5}$/);

    const detail = await api.get("adminA", res.body.id);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      rfpNo: res.body.rfpNo,
      companyId: co.A,
      branchId: null,
      rfpDate: "2096-03-15",
      requestedPaymentDate: "2096-03-31",
      requesterUserId: users.adminA,
      supplierId: sup.A,
      supplierName: "Supplier supA",
      supplierTin: "TIN-supA",
      currencyId: cur.A,
      currencyCode: "PHP",
      totalAmount: "1250.50",
      status: "DRAFT",
      supportingReference: "SI-1001",
      remarks: "Urgent",
      submittedBy: null,
      decidedBy: null,
      convertedApvId: null,
    });
    expect(detail.body.lines).toEqual([
      expect.objectContaining({ description: "Paper", grossAmount: "1000.50", accountId, vatTreatment: "STANDARD", reference: "L1" }),
      expect.objectContaining({ description: "Ink", grossAmount: "250.00", accountId: null, vatTreatment: "EXEMPT", reference: null }),
    ]);
    // no internal column names leak through
    expect(Object.keys(detail.body).some((k) => k.includes("_"))).toBe(false);
  });

  test("Accountant creates; the company is inferred only because they have exactly one", async () => {
    const res = await api.create("acctA", bodyA({ companyId: undefined, branchId: br.A1 }));
    expect(res.status).toBe(201);
    expect(res.body.companyId).toBe(co.A);
    const [[row]] = await pool.query("SELECT requester_user_id, branch_id FROM rfp_headers WHERE id = ?", [res.body.id]);
    expect(row).toEqual({ requester_user_id: users.acctA, branch_id: br.A1 });
  });

  test("Super Admin must name the company; with it, the RFP belongs to that company", async () => {
    const none = await api.create("super", bodyA({ companyId: undefined }));
    expect(none.status).toBe(400);
    expect(none.body.message).toBe("Select a company to continue.");
    const ok = await api.create("super", bodyA({ companyId: co.B, supplierId: sup.B, currencyId: cur.B }));
    expect(ok.status).toBe(201);
    expect(ok.body.companyId).toBe(co.B);
  });

  test("multi-company user must select; unauthorized 403; unknown 400; no company 403", async () => {
    expect((await api.create("multi", bodyA({ companyId: undefined }))).status).toBe(400);
    expect((await api.create("multi", bodyA())).status).toBe(201);
    expect((await api.create("adminA", bodyA({ companyId: co.C }))).status).toBe(403);
    expect((await api.create("super", bodyA({ companyId: UNKNOWN_ID }))).status).toBe(400);
    expect((await api.create("super", bodyA({ companyId: "abc" }))).status).toBe(400);
    expect((await api.create("none", bodyA({ companyId: undefined }))).status).toBe(403);
  });

  test("supplier must be an active SUPPLIER of the selected company", async () => {
    const cross = await api.create("adminA", bodyA({ supplierId: sup.B }));
    const unknown = await api.create("adminA", bodyA({ supplierId: UNKNOWN_ID }));
    expect(cross.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(cross.body.message).toBe(unknown.body.message); // another company's supplier isn't confirmed
    expect((await api.create("adminA", bodyA({ supplierId: sup.customerA }))).status).toBe(400);
    expect((await api.create("adminA", bodyA({ supplierId: sup.inactiveA }))).status).toBe(400);
  });

  test("client supplier name / TIN are refused; the snapshot always comes from the supplier record", async () => {
    const res = await api.create("adminA", bodyA({ supplierName: "Forged", supplierTin: "000" }));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/supplierName, supplierTin/);
  });

  test("branch: optional; must belong to the company and to the user's branches", async () => {
    expect((await api.create("adminA", bodyA({ branchId: br.A1 }))).status).toBe(201);
    expect((await api.create("adminA", bodyA({ branchId: br.B1 }))).status).toBe(400);
    expect((await api.create("adminA", bodyA({ branchId: UNKNOWN_ID }))).status).toBe(400);
    expect((await api.create("adminA", bodyA({ branchId: br.A2 }))).status).toBe(403); // A's branch, not assigned
    expect((await api.create("super", bodyA({ branchId: br.A2 }))).status).toBe(201); // Super Admin: any branch of the company
    const none = await api.create("adminA", bodyA({ branchId: null }));
    expect(none.status).toBe(201);
    const [[row]] = await pool.query("SELECT branch_id FROM rfp_headers WHERE id = ?", [none.body.id]);
    expect(row.branch_id).toBeNull();
  });

  test("currency: required, of the selected company, active", async () => {
    expect((await api.create("adminA", bodyA({ currencyId: undefined }))).status).toBe(400);
    expect((await api.create("adminA", bodyA({ currencyId: cur.B }))).status).toBe(400);
    expect((await api.create("adminA", bodyA({ currencyId: UNKNOWN_ID }))).status).toBe(400);
    expect((await api.create("adminA", bodyA({ currencyId: cur.inactiveA }))).status).toBe(400);
  });

  test.each([
    ["rfpDate", undefined],
    ["rfpDate", "2096-02-30"],
    ["rfpDate", "15/03/2096"],
    ["requestedPaymentDate", undefined],
    ["supplierId", undefined],
    ["purpose", undefined],
    ["purpose", "   "],
    ["lines", undefined],
    ["lines", []],
    ["lines", "x"],
  ])("missing / invalid %s (%p) is rejected with 400", async (key, value) => {
    const res = await api.create("adminA", bodyA({ [key]: value }));
    expect(res.status).toBe(400);
  });

  test("the RFP date is never defaulted to today", async () => {
    const body = bodyA();
    delete body.rfpDate;
    const res = await api.create("adminA", body);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/RFP date/);
  });

  test.each([["-5"], ["abc"], ["1.234"], ["Infinity"], ["NaN"], [1e21], [null], [""], ["1e3"], [{}]])(
    "invalid gross amount %p is rejected",
    async (amount) => {
      const res = await api.create("adminA", bodyA({ lines: [{ description: "x", grossAmount: amount }] }));
      expect(res.status).toBe(400);
    }
  );

  test("line rules: description required, VAT treatment from the approved list, account must exist", async () => {
    expect((await api.create("adminA", bodyA({ lines: [{ grossAmount: 1 }] }))).status).toBe(400);
    expect((await api.create("adminA", bodyA({ lines: [{ description: "x", grossAmount: 1, vatTreatment: "ZERO" }] }))).status).toBe(400);
    expect((await api.create("adminA", bodyA({ lines: [{ description: "x", grossAmount: 1, accountId: UNKNOWN_ID }] }))).status).toBe(400);
    const ok = await api.create("adminA", bodyA({ lines: [{ description: "x", grossAmount: "0", vatTreatment: "zero_rated" }] }));
    expect(ok.status).toBe(201);
    expect(ok.body.totalAmount).toBe("0.00");
  });

  test("a matching client total is accepted; a mismatched one is rejected", async () => {
    expect((await api.create("adminA", bodyA({ totalAmount: "1250.50" }))).status).toBe(201);
    const bad = await api.create("adminA", bodyA({ totalAmount: 99 }));
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/does not match/);
  });

  test("client status / requester / number / workflow / conversion fields are refused", async () => {
    for (const forced of [
      { status: "APPROVED" },
      { status: "DRAFT" },
      { requesterUserId: users.super },
      { rfpNo: "RFP96-99999" },
      { submittedBy: users.adminA },
      { decidedAt: "2096-01-01" },
      { convertedApvId: 1 },
    ]) {
      const res = await api.create("adminA", bodyA(forced));
      expect(res.status).toBe(400);
    }
    const [[{ n }]] = await pool.query("SELECT COUNT(*) n FROM rfp_headers WHERE rfp_no = 'RFP96-99999' OR status <> 'DRAFT'");
    expect(n).toBe(0);
  });

  test("a rejected create writes nothing (no header, lines or audit)", async () => {
    const [[before]] = await pool.query(
      "SELECT (SELECT COUNT(*) FROM rfp_headers) h, (SELECT COUNT(*) FROM rfp_lines) l, (SELECT COUNT(*) FROM audit_logs WHERE module = 'TRANSACTIONS.RFP') a"
    );
    await api.create("adminA", bodyA({ lines: [{ description: "ok", grossAmount: 1 }, { description: "bad", grossAmount: -1 }] }));
    await api.create("adminA", bodyA({ supplierId: sup.B }));
    const [[after]] = await pool.query(
      "SELECT (SELECT COUNT(*) FROM rfp_headers) h, (SELECT COUNT(*) FROM rfp_lines) l, (SELECT COUNT(*) FROM audit_logs WHERE module = 'TRANSACTIONS.RFP') a"
    );
    expect(after).toEqual(before);
  });

  test("creating an RFP creates no APV, journal or payment record", async () => {
    const counts = async () =>
      (await pool.query(
        `SELECT (SELECT COUNT(*) FROM apv_headers WHERE company_id = ?) apv,
                (SELECT COUNT(*) FROM jv_headers WHERE company_id = ?) jv,
                (SELECT COUNT(*) FROM transaction_applications) app`,
        [co.A, co.A]
      ))[0][0];
    const before = await counts();
    expect((await api.create("adminA", bodyA())).status).toBe(201);
    expect(await counts()).toEqual(before);
    expect(before).toMatchObject({ apv: 0, jv: 0 });
  });
});

describe("numbering", () => {
  const numbersOf = async (companyId, year) => {
    const [rows] = await pool.query("SELECT rfp_no FROM rfp_headers WHERE company_id = ? AND rfp_no LIKE ? ORDER BY rfp_no", [companyId, `RFP${year}-%`]);
    return rows.map((r) => r.rfp_no);
  };

  test("sequential per company and year (year from the RFP date); same number allowed in another company", async () => {
    const a1 = await api.create("multi", bodyA({ rfpDate: "2094-01-10" }));
    const a2 = await api.create("multi", bodyA({ rfpDate: "2094-12-31" }));
    const b1 = await api.create("multi", bodyA({ companyId: co.B, supplierId: sup.B, currencyId: cur.B, rfpDate: "2094-06-01" }));
    const a3 = await api.create("multi", bodyA({ rfpDate: "2095-01-01" }));
    expect([a1.body.rfpNo, a2.body.rfpNo, b1.body.rfpNo, a3.body.rfpNo]).toEqual(["RFP94-00001", "RFP94-00002", "RFP94-00001", "RFP95-00001"]);
  });

  test("continues after the highest well-formed number; ignores malformed ones", async () => {
    await pool.execute(
      "INSERT INTO rfp_headers (company_id, rfp_no, rfp_date, requester_user_id) VALUES (?, 'RFP93-00041', '2093-01-01', ?), (?, 'RFP93-LEGACY', '2093-01-01', ?)",
      [co.A, users.adminA, co.A, users.adminA]
    );
    const res = await api.create("adminA", bodyA({ rfpDate: "2093-05-05" }));
    expect(res.body.rfpNo).toBe("RFP93-00042");
  });

  test("concurrent creates in one company get distinct consecutive numbers", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => api.create("adminA", bodyA({ rfpDate: "2092-07-07" }))));
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(201));
    expect(await numbersOf(co.A, 92)).toEqual(Array.from({ length: 8 }, (_, i) => `RFP92-${String(i + 1).padStart(5, "0")}`));
  });

  test("while another session holds the company's number lock, a create waits and then fails 409 with nothing written", async () => {
    const holder = await pool.getConnection();
    try {
      const [[got]] = await holder.query("SELECT GET_LOCK(?, 1) AS got", [`astrea_rfp_no_${co.A}`]);
      expect(got.got).toBe(1);
      const res = await api.create("adminA", bodyA({ rfpDate: "2091-01-01" }));
      expect(res.status).toBe(409);
      expect(await numbersOf(co.A, 91)).toEqual([]);
    } finally {
      await holder.query("SELECT RELEASE_LOCK(?)", [`astrea_rfp_no_${co.A}`]);
      holder.release();
    }
    expect((await api.create("adminA", bodyA({ rfpDate: "2091-01-01" }))).body.rfpNo).toBe("RFP91-00001");
  });
});

describe("list", () => {
  const companiesIn = (rows) => [...new Set(rows.map((r) => r.companyId))].sort((a, b) => a - b);

  test("single-company user sees only their company", async () => {
    const res = await api.list("adminA");
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(companiesIn(res.body)).toEqual([co.A]);
    expect(companiesIn((await api.list("adminB")).body)).toEqual([co.B]);
  });

  test("multi-company user: union without a filter; one company with a filter", async () => {
    expect(companiesIn((await api.list("multi")).body)).toEqual([co.A, co.B].sort((a, b) => a - b));
    expect(companiesIn((await api.list("multi", { companyId: co.B })).body)).toEqual([co.B]);
  });

  test("an inaccessible / unknown / malformed company filter is rejected", async () => {
    const cross = await api.list("adminA", { companyId: co.B });
    expect(cross.status).toBe(403);
    expect(JSON.stringify(cross.body)).not.toMatch(/RFP\d/);
    expect((await api.list("adminA", { companyId: UNKNOWN_ID })).status).toBe(400);
    expect((await api.list("adminA", { companyId: "x" })).status).toBe(400);
  });

  test("Super Admin: all companies without a filter (no lowest-company fallback), one with", async () => {
    const all = companiesIn((await api.list("super")).body);
    expect(all).toEqual(expect.arrayContaining([co.A, co.B]));
    expect(companiesIn((await api.list("super", { companyId: co.B })).body)).toEqual([co.B]);
  });

  test("status filter is validated", async () => {
    expect((await api.list("adminA", { status: "draft" })).status).toBe(200);
    expect((await api.list("adminA", { status: "PAID" })).status).toBe(400);
  });

  test("a user with no company sees an empty list (never a fallback company)", async () => {
    const res = await api.list("none");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("get", () => {
  let idB;
  beforeAll(async () => {
    idB = (await api.create("adminB", bodyA({ companyId: co.B, supplierId: sup.B, currencyId: cur.B }))).body.id;
  });

  test("own company 200; another company's RFP is the same 404 as an unknown id", async () => {
    expect((await api.get("adminB", idB)).status).toBe(200);
    const cross = await api.get("adminA", idB);
    const unknown = await api.get("adminA", UNKNOWN_ID);
    expect(cross.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(cross.body).toEqual(unknown.body);
    expect((await api.get("super", idB)).status).toBe(200);
  });

  test.each(["abc", "0", "-1", "1.5", "99999999999"])("malformed id %p -> 400", async (id) => {
    expect((await api.get("adminA", id)).status).toBe(400);
  });
});

describe("edit", () => {
  const create = async () => (await api.create("adminA", bodyA())).body.id;

  test("DRAFT is editable; total recalculated; audit has before / after / changed fields with company", async () => {
    const id = await create();
    const res = await api.update("adminA", id, bodyA({ purpose: "Revised", supplierId: sup.A2, lines: [{ description: "Only", grossAmount: "75.25" }] }));
    expect(res.status).toBe(200);
    expect(res.body.totalAmount).toBe("75.25");
    expect(res.body.changedFields).toEqual(expect.arrayContaining(["purpose", "supplierId", "supplierName", "supplierTin", "totalAmount", "lines"]));

    const detail = (await api.get("adminA", id)).body;
    expect(detail).toMatchObject({ purpose: "Revised", supplierName: "Supplier supA2", totalAmount: "75.25", requesterUserId: users.adminA, status: "DRAFT" });
    expect(detail.lines).toHaveLength(1);

    const edit = (await auditRows(id)).find((r) => r.action === "EDIT");
    expect(edit.company_id).toBe(co.A);
    const before = typeof edit.before_data === "string" ? JSON.parse(edit.before_data) : edit.before_data;
    const after = typeof edit.after_data === "string" ? JSON.parse(edit.after_data) : edit.after_data;
    expect(before).toMatchObject({ purpose: "Office supplies replenishment", totalAmount: "1250.50" });
    expect(before.lines).toHaveLength(2);
    expect(after).toMatchObject({ purpose: "Revised", totalAmount: "75.25" });
    expect(after.changedFields).toContain("purpose");
  });

  test("another user of the same company may edit it, but the requester never changes", async () => {
    const id = await create();
    expect((await api.update("acctA", id, bodyA({ companyId: undefined }))).status).toBe(200);
    const [[row]] = await pool.query("SELECT requester_user_id FROM rfp_headers WHERE id = ?", [id]);
    expect(row.requester_user_id).toBe(users.adminA);
  });

  test.each(["SUBMITTED", "APPROVED", "CONVERTED", "REJECTED", "CANCELLED"])("%s is not editable (409, unchanged; RETURNED is editable - see rfpResubmission)", async (status) => {
    const id = await create();
    await setStatus(id, status, status === "CONVERTED" ? `, converted_apv_id = ${2147482000 + id % 1000}` : "");
    const res = await api.update("adminA", id, bodyA({ purpose: "Changed" }));
    expect(res.status).toBe(409);
    const [[row]] = await pool.query("SELECT purpose, status FROM rfp_headers WHERE id = ?", [id]);
    expect(row).toEqual({ purpose: "Office supplies replenishment", status });
  });

  test("the company cannot be changed; server fields are refused", async () => {
    const id = await create();
    expect((await api.update("multi", id, bodyA({ companyId: co.B, supplierId: sup.B, currencyId: cur.B }))).status).toBe(400);
    expect((await api.update("multi", id, bodyA({ status: "APPROVED" }))).status).toBe(400);
    expect((await api.update("multi", id, bodyA({ requesterUserId: users.multi }))).status).toBe(400);
    expect((await api.update("multi", id, bodyA({ convertedApvId: 5 }))).status).toBe(400);
    const [[row]] = await pool.query("SELECT company_id, requester_user_id, status FROM rfp_headers WHERE id = ?", [id]);
    expect(row).toEqual({ company_id: co.A, requester_user_id: users.adminA, status: "DRAFT" });
  });

  test("supplier, branch, currency and lines are revalidated against the RFP's own company", async () => {
    const id = await create();
    expect((await api.update("adminA", id, bodyA({ supplierId: sup.B }))).status).toBe(400);
    expect((await api.update("adminA", id, bodyA({ branchId: br.B1 }))).status).toBe(400);
    expect((await api.update("adminA", id, bodyA({ branchId: br.A2 }))).status).toBe(403);
    expect((await api.update("adminA", id, bodyA({ currencyId: cur.B }))).status).toBe(400);
    expect((await api.update("adminA", id, bodyA({ lines: [] }))).status).toBe(400);
    expect((await api.update("adminA", id, bodyA({ totalAmount: "1" }))).status).toBe(400);
  });

  test("another company's RFP: same 404 as unknown; malformed id 400", async () => {
    const id = await create();
    const cross = await api.update("adminB", id, bodyA({ companyId: undefined }));
    const unknown = await api.update("adminB", UNKNOWN_ID, bodyA({ companyId: undefined }));
    expect(cross.status).toBe(404);
    expect(cross.body).toEqual(unknown.body);
    expect((await api.update("adminA", "abc", bodyA())).status).toBe(400);
  });
});

describe("delete", () => {
  const create = async () => (await api.create("adminA", bodyA())).body.id;

  test("a DRAFT is deleted with its lines; DELETE audit carries company and previous state", async () => {
    const id = await create();
    const res = await api.remove("adminA", id);
    expect(res.status).toBe(200);
    const [[left]] = await pool.query("SELECT (SELECT COUNT(*) FROM rfp_headers WHERE id = ?) h, (SELECT COUNT(*) FROM rfp_lines WHERE rfp_id = ?) l", [id, id]);
    expect(left).toEqual({ h: 0, l: 0 });
    const del = (await auditRows(id)).find((r) => r.action === "DELETE");
    expect(del.company_id).toBe(co.A);
    const before = typeof del.before_data === "string" ? JSON.parse(del.before_data) : del.before_data;
    expect(before).toMatchObject({ companyId: co.A, totalAmount: "1250.50", status: "DRAFT" });
    expect(before.lines).toHaveLength(2);
    expect((await api.get("adminA", id)).status).toBe(404);
  });

  test.each(["SUBMITTED", "APPROVED", "CONVERTED", "REJECTED", "CANCELLED", "RETURNED"])("%s cannot be deleted (409)", async (status) => {
    const id = await create();
    await setStatus(id, status, status === "CONVERTED" ? `, converted_apv_id = ${2147481000 + id % 1000}` : "");
    expect((await api.remove("adminA", id)).status).toBe(409);
    const [[row]] = await pool.query("SELECT COUNT(*) n FROM rfp_headers WHERE id = ?", [id]);
    expect(row.n).toBe(1);
  });

  test("a DRAFT with workflow history is kept (409)", async () => {
    const id = await create();
    await pool.execute("INSERT INTO rfp_status_history (rfp_id, previous_status, new_status, action, user_id) VALUES (?, 'RETURNED', 'DRAFT', 'RETURN', ?)", [id, users.adminA]);
    expect((await api.remove("adminA", id)).status).toBe(409);
  });

  test("another company's RFP: same 404 as unknown, and it survives", async () => {
    const id = await create();
    const cross = await api.remove("adminB", id);
    const unknown = await api.remove("adminB", UNKNOWN_ID);
    expect(cross.status).toBe(404);
    expect(cross.body).toEqual(unknown.body);
    expect((await api.get("adminA", id)).status).toBe(200);
  });
});

describe("audit", () => {
  test("CREATE is attributed to the RFP's company with number and state; no secrets recorded", async () => {
    const res = await api.create("multi", bodyA({ companyId: co.B, supplierId: sup.B, currencyId: cur.B }));
    const [created] = await auditRows(res.body.id);
    expect(created.action).toBe("CREATE");
    expect(created.company_id).toBe(co.B);
    expect(created.description).toContain(res.body.rfpNo);
    const after = typeof created.after_data === "string" ? JSON.parse(created.after_data) : created.after_data;
    expect(after).toMatchObject({ rfpNo: res.body.rfpNo, companyId: co.B, status: "DRAFT", totalAmount: "1250.50" });
  });

  test("no RFP audit row contains a password, hash or token", async () => {
    const [rows] = await pool.query(
      "SELECT before_data, after_data, description FROM audit_logs WHERE module = 'TRANSACTIONS.RFP' AND company_id IN (?)",
      [Object.values(co)]
    );
    expect(rows.length).toBeGreaterThan(0);
    const [hashes] = await pool.query("SELECT password FROM users WHERE id IN (?)", [Object.values(users)]);
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/password|token|secret|credential/i);
    expect(text).not.toContain(PASSWORD);
    for (const t of Object.values(tokens)) expect(text).not.toContain(t);
    for (const h of hashes) expect(text).not.toContain(h.password);
  });
});
