// RFP (Request for Payment) R3: workflow actions over HTTP - the transition
// matrix, permissions (SUBMIT = requester side, APPROVE = decisions),
// maker-checker, company isolation, submit-time revalidation, status
// history, audit, and row-lock safety under concurrent requests.
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(180000);

const P = "rfpr3-";
const PASSWORD = "RfpR3Pass!1";
const UNKNOWN_ID = 2147483000;

const co = {};
const cur = {};
const sup = {};
const users = {};
const tokens = {};

async function makeUser(tag, roleCode, companyIds = [], overrides = {}) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const [u] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, (SELECT id FROM roles WHERE code = ?), 'ACTIVE')",
    [`${P}${tag}`, hash, roleCode]
  );
  for (const c of companyIds) await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  for (const [action, granted] of Object.entries(overrides)) {
    await pool.execute(
      `INSERT INTO user_permissions (user_id, permission_id, granted, reason)
       SELECT ?, id, ?, 'rfp r3 test' FROM permissions WHERE module_key = 'TRANSACTIONS.RFP' AND action = ?`,
      [u.insertId, granted, action]
    );
  }
  users[tag] = u.insertId;
  const res = await request(app).post("/api/login").send({ username: `${P}${tag}`, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login ${tag}: ${res.status}`);
  tokens[tag] = res.body.token;
}

const auth = (who) => ({ Authorization: `Bearer ${tokens[who]}` });
const act = (who, id, action, body) => request(app).post(`/api/rfp/${id}/${action}`).set(auth(who)).send(body);

function body(company = "A", overrides = {}) {
  return {
    companyId: co[company],
    rfpDate: "2097-04-01",
    supplierId: sup[company],
    purpose: "Workflow test",
    requestedPaymentDate: "2097-04-30",
    currencyId: cur[company],
    lines: [{ description: "Service fee", grossAmount: "500.00" }, { description: "Materials", grossAmount: "250.25" }],
    ...overrides,
  };
}

async function draft(who = "acctA", company = "A", overrides = {}) {
  const res = await request(app).post("/api/rfp").set(auth(who)).send(body(company, overrides));
  if (res.status !== 201) throw new Error(`create: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id;
}

async function submitted(who = "acctA", company = "A") {
  const id = await draft(who, company);
  const res = await act(who, id, "submit");
  if (res.status !== 200) throw new Error(`submit: ${res.status} ${JSON.stringify(res.body)}`);
  return id;
}

async function header(id) {
  const [[row]] = await pool.query(
    "SELECT status, submitted_by, submitted_at, decided_by, decided_at, decision_note, converted_apv_id, converted_by, converted_at FROM rfp_headers WHERE id = ?",
    [id]
  );
  return row;
}

async function history(id) {
  const [rows] = await pool.query("SELECT previous_status, new_status, action, user_id, note, created_at FROM rfp_status_history WHERE rfp_id = ? ORDER BY id", [id]);
  return rows;
}

async function workflowAudits(id) {
  const [rows] = await pool.query(
    `SELECT module, entity_type, action, company_id, user_id, username, before_data, after_data, description, created_at
     FROM audit_logs WHERE module = 'TRANSACTIONS.RFP' AND entity_id = ? AND action NOT IN ('CREATE', 'EDIT', 'DELETE') ORDER BY id`,
    [id]
  );
  return rows.map((r) => ({
    ...r,
    before_data: typeof r.before_data === "string" ? JSON.parse(r.before_data) : r.before_data,
    after_data: typeof r.after_data === "string" ? JSON.parse(r.after_data) : r.after_data,
  }));
}

async function setStatus(id, status) {
  await pool.execute(
    `UPDATE rfp_headers SET status = ?${status === "CONVERTED" ? ", converted_apv_id = ?" : ""} WHERE id = ?`,
    status === "CONVERTED" ? [status, 2147470000 + id, id] : [status, id]
  );
}

async function accountingCounts() {
  const [[row]] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM apv_headers WHERE company_id IN (?)) apv,
            (SELECT COUNT(*) FROM jv_headers WHERE company_id IN (?)) jv,
            (SELECT COUNT(*) FROM transaction_applications) app`,
    [Object.values(co), Object.values(co)]
  );
  return row;
}

beforeAll(async () => {
  assertNotProductionDatabase();
  for (const tag of ["A", "B"]) {
    const [c] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${P}Co ${tag}`]);
    co[tag] = c.insertId;
    const [k] = await pool.execute(
      "INSERT INTO currencies (company_id, currency_code, currency_name, currency_symbol) VALUES (?, 'PHP', 'Philippine Peso', 'P')",
      [co[tag]]
    );
    cur[tag] = k.insertId;
    const [s] = await pool.execute(
      "INSERT INTO general_libraries (company_id, code, party_type, name, tin, status) VALUES (?, ?, 'SUPPLIER', ?, '123', 'ACTIVE')",
      [co[tag], `${P}sup${tag}`, `Supplier ${tag}`]
    );
    sup[tag] = s.insertId;
  }
  const [s2] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, tin, status) VALUES (?, ?, 'SUPPLIER', 'Supplier A2', '456', 'ACTIVE')",
    [co.A, `${P}supA2`]
  );
  sup.A2 = s2.insertId;

  await makeUser("super", "SUPER_ADMIN");
  await makeUser("adminA", "ADMIN", [co.A]);
  await makeUser("adminA2", "ADMIN", [co.A]);
  await makeUser("acctA", "ACCOUNTANT", [co.A]);
  await makeUser("acctA2", "ACCOUNTANT", [co.A]);
  await makeUser("adminB", "ADMIN", [co.B]);
  await makeUser("acctB", "ACCOUNTANT", [co.B]);
  // VIEW / CREATE / EDIT but no SUBMIT and no APPROVE
  await makeUser("viewerA", "ACCOUNTANT", [co.A], { SUBMIT: 0 });
  // APPROVE but no SUBMIT
  await makeUser("approverOnlyA", "ADMIN", [co.A], { SUBMIT: 0 });
  // an Accountant explicitly granted APPROVE
  await makeUser("acctApproverA", "ACCOUNTANT", [co.A], { APPROVE: 1 });
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
    if (companies.length) await pool.query("DELETE FROM companies WHERE id IN (?)", [companies]);
  } finally {
    await pool.end();
  }
});

describe("submit", () => {
  test("DRAFT -> SUBMITTED with submitter metadata, one history row and one audit row", async () => {
    const id = await draft();
    const res = await act("acctA", id, "submit", { note: "Please review" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, previousStatus: "DRAFT", status: "SUBMITTED", companyId: co.A });

    const h = await header(id);
    expect(h).toMatchObject({ status: "SUBMITTED", submitted_by: users.acctA, decided_by: null, decision_note: null });
    expect(h.submitted_at).toBeInstanceOf(Date);

    const hist = await history(id);
    expect(hist).toEqual([
      expect.objectContaining({ previous_status: "DRAFT", new_status: "SUBMITTED", action: "SUBMIT", user_id: users.acctA, note: "Please review" }),
    ]);
    expect(hist[0].created_at).toBeInstanceOf(Date);

    const audits = await workflowAudits(id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ module: "TRANSACTIONS.RFP", entity_type: "RFP", action: "SUBMIT", company_id: co.A, user_id: users.acctA });
    expect(audits[0].before_data).toMatchObject({ status: "DRAFT" });
    expect(audits[0].after_data).toMatchObject({ previousStatus: "DRAFT", status: "SUBMITTED", submittedBy: users.acctA, note: "Please review" });
  });

  test("repeated submit -> 409 with no extra history or audit", async () => {
    const id = await submitted();
    const res = await act("acctA", id, "submit");
    expect(res.status).toBe(409);
    expect(await history(id)).toHaveLength(1);
    expect(await workflowAudits(id)).toHaveLength(1);
  });

  test.each([
    ["purpose removed", (id) => pool.execute("UPDATE rfp_headers SET purpose = NULL WHERE id = ?", [id])],
    ["requested payment date removed", (id) => pool.execute("UPDATE rfp_headers SET requested_payment_date = NULL WHERE id = ?", [id])],
    ["supplier deactivated", (id) => pool.execute("UPDATE rfp_headers SET supplier_id = ? WHERE id = ?", [sup.A2, id]).then(() =>
      pool.execute("UPDATE general_libraries SET status = 'INACTIVE' WHERE id = ?", [sup.A2]))],
    ["supplier of another company", (id) => pool.execute("UPDATE rfp_headers SET supplier_id = ? WHERE id = ?", [sup.B, id])],
    ["currency of another company", (id) => pool.execute("UPDATE rfp_headers SET currency_id = ? WHERE id = ?", [cur.B, id])],
    ["negative line amount", (id) => pool.execute("UPDATE rfp_lines SET gross_amount = -5 WHERE rfp_id = ?", [id])],
    ["blank line description", (id) => pool.execute("UPDATE rfp_lines SET description = '' WHERE rfp_id = ?", [id])],
    ["no lines", (id) => pool.execute("DELETE FROM rfp_lines WHERE rfp_id = ?", [id])],
    ["stored total differs from the lines", (id) => pool.execute("UPDATE rfp_headers SET total_amount = 1 WHERE id = ?", [id])],
  ])("the stored record is revalidated: %s -> 409, still DRAFT, nothing recorded", async (_label, corrupt) => {
    const id = await draft();
    await corrupt(id);
    const res = await act("acctA", id, "submit");
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/cannot be submitted/);
    expect((await header(id)).status).toBe("DRAFT");
    expect(await history(id)).toEqual([]);
    expect(await workflowAudits(id)).toEqual([]);
    await pool.execute("UPDATE general_libraries SET status = 'ACTIVE' WHERE id = ?", [sup.A2]);
  });
});

describe("approve", () => {
  test("SUBMITTED -> APPROVED by an Admin; decision metadata, history, audit; no accounting records", async () => {
    const before = await accountingCounts();
    const id = await submitted();
    const res = await act("adminA", id, "approve", { note: "OK to pay" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("APPROVED");

    const h = await header(id);
    expect(h).toMatchObject({ status: "APPROVED", decided_by: users.adminA, decision_note: "OK to pay", submitted_by: users.acctA });
    expect(h.decided_at).toBeInstanceOf(Date);
    expect(h).toMatchObject({ converted_apv_id: null, converted_by: null, converted_at: null });

    const hist = await history(id);
    expect(hist.map((r) => [r.previous_status, r.new_status, r.action, r.user_id, r.note])).toEqual([
      ["DRAFT", "SUBMITTED", "SUBMIT", users.acctA, null],
      ["SUBMITTED", "APPROVED", "APPROVE", users.adminA, "OK to pay"],
    ]);
    const approve = (await workflowAudits(id)).find((a) => a.action === "APPROVE");
    expect(approve).toMatchObject({ company_id: co.A, user_id: users.adminA });
    expect(approve.after_data).toMatchObject({ previousStatus: "SUBMITTED", status: "APPROVED", decidedBy: users.adminA, decisionNote: "OK to pay" });

    expect(await accountingCounts()).toEqual(before);
  });

  test("the note is optional; repeated approval -> 409 with no duplicate rows", async () => {
    const id = await submitted();
    expect((await act("adminA", id, "approve")).status).toBe(200);
    expect((await header(id)).decision_note).toBeNull();
    expect((await act("adminA2", id, "approve")).status).toBe(409);
    expect((await history(id)).filter((r) => r.action === "APPROVE")).toHaveLength(1);
    expect((await workflowAudits(id)).filter((a) => a.action === "APPROVE")).toHaveLength(1);
  });

  test("Accountant without APPROVE is refused (403) and nothing changes", async () => {
    const id = await submitted("acctA2");
    expect((await act("acctA", id, "approve")).status).toBe(403);
    expect((await header(id)).status).toBe("SUBMITTED");
    expect(await history(id)).toHaveLength(1);
  });

  test("Super Admin may approve (permission bypass)", async () => {
    const id = await submitted();
    expect((await act("super", id, "approve")).status).toBe(200);
    expect((await header(id)).decided_by).toBe(users.super);
  });

  test("maker-checker: the requester or submitter cannot decide, even with APPROVE", async () => {
    const own = await submitted("adminA"); // adminA requested and submitted
    for (const action of ["approve", "return", "reject"]) {
      expect((await act("adminA", own, action, { note: "x" })).status).toBe(403);
    }
    const bySuper = await draft("super");
    expect((await act("super", bySuper, "submit")).status).toBe(200);
    expect((await act("super", bySuper, "approve")).status).toBe(403);
    expect((await header(own)).status).toBe("SUBMITTED");
    expect(await history(own)).toHaveLength(1);
  });
});

describe("return / reject", () => {
  test.each([["return", "RETURNED", "RETURN"], ["reject", "REJECTED", "REJECT"]])(
    "%s: SUBMITTED -> %s with the reason recorded; repeated -> 409",
    async (route, status, action) => {
      const id = await submitted();
      const res = await act("adminA", id, route, { note: "  Missing supporting invoice  " });
      expect(res.status).toBe(200);
      expect(await header(id)).toMatchObject({ status, decided_by: users.adminA, decision_note: "Missing supporting invoice" });
      const hist = await history(id);
      expect(hist[1]).toMatchObject({ previous_status: "SUBMITTED", new_status: status, action, user_id: users.adminA, note: "Missing supporting invoice" });
      const audit = (await workflowAudits(id)).find((a) => a.action === action);
      expect(audit.company_id).toBe(co.A);
      expect(audit.after_data).toMatchObject({ previousStatus: "SUBMITTED", status, decisionNote: "Missing supporting invoice" });

      expect((await act("adminA2", id, route, { note: "again" })).status).toBe(409);
      expect(await history(id)).toHaveLength(2);
    }
  );

  test.each(["return", "reject"])("%s requires a non-blank reason (400) and changes nothing", async (route) => {
    const id = await submitted();
    for (const b of [undefined, {}, { note: "" }, { note: "   " }, { note: null }]) {
      expect((await act("adminA", id, route, b)).status).toBe(400);
    }
    expect((await header(id)).status).toBe("SUBMITTED");
    expect(await history(id)).toHaveLength(1);
  });

  // RETURNED -> SUBMITTED (resubmission) is covered by rfpResubmission.http.test.js.
  test("returned and rejected RFPs cannot be approved, rejected, returned or cancelled; rejected cannot be resubmitted", async () => {
    for (const route of ["return", "reject"]) {
      const id = await submitted();
      expect((await act("adminA", id, route, { note: "no" })).status).toBe(200);
      expect((await act("adminA2", id, "approve")).status).toBe(409);
      expect((await act("adminA2", id, "reject", { note: "x" })).status).toBe(409);
      expect((await act("adminA2", id, "return", { note: "x" })).status).toBe(409);
      expect((await act("acctA", id, "cancel")).status).toBe(409);
      if (route === "reject") expect((await act("acctA", id, "submit")).status).toBe(409);
      expect(await history(id)).toHaveLength(2);
    }
  });
});

describe("cancel", () => {
  test("DRAFT -> CANCELLED and SUBMITTED -> CANCELLED; history + audit; repeated -> 409", async () => {
    const d = await draft();
    const res = await act("acctA", d, "cancel", { note: "No longer needed" });
    expect(res.status).toBe(200);
    expect(await header(d)).toMatchObject({ status: "CANCELLED", decided_by: null, decision_note: null });
    expect(await history(d)).toEqual([expect.objectContaining({ previous_status: "DRAFT", new_status: "CANCELLED", action: "CANCEL", user_id: users.acctA, note: "No longer needed" })]);
    expect((await workflowAudits(d))[0]).toMatchObject({ action: "CANCEL", company_id: co.A });
    expect((await act("acctA", d, "cancel")).status).toBe(409);
    expect(await history(d)).toHaveLength(1);

    const s = await submitted();
    expect((await act("acctA", s, "cancel")).status).toBe(200);
    expect(await header(s)).toMatchObject({ status: "CANCELLED", submitted_by: users.acctA });
    expect((await history(s)).map((r) => r.action)).toEqual(["SUBMIT", "CANCEL"]);
  });

  test.each(["APPROVED", "CONVERTED", "RETURNED", "REJECTED"])("%s cannot be cancelled (409) and is unchanged", async (status) => {
    const id = await draft();
    await setStatus(id, status);
    expect((await act("acctA", id, "cancel")).status).toBe(409);
    expect((await header(id)).status).toBe(status);
    expect(await history(id)).toEqual([]);
  });

  test("a cancelled draft cannot be edited or deleted", async () => {
    const id = await draft();
    await act("acctA", id, "cancel");
    expect((await request(app).put(`/api/rfp/${id}`).set(auth("acctA")).send(body())).status).toBe(409);
    expect((await request(app).delete(`/api/rfp/${id}`).set(auth("acctA"))).status).toBe(409);
  });
});

describe("transition matrix", () => {
  const ROUTES = ["submit", "approve", "return", "reject", "cancel"];
  const ALLOWED = {
    DRAFT: ["submit", "cancel"],
    SUBMITTED: ["approve", "return", "reject", "cancel"],
    APPROVED: [],
    CONVERTED: [],
    RETURNED: ["submit"],
    REJECTED: [],
    CANCELLED: [],
  };

  test.each(Object.keys(ALLOWED))("from %s, every action outside the matrix is refused with 409", async (status) => {
    for (const route of ROUTES.filter((r) => !ALLOWED[status].includes(r))) {
      const id = await draft();
      await setStatus(id, status);
      const who = ["submit", "cancel"].includes(route) ? "acctA" : "adminA";
      const res = await act(who, id, route, { note: "matrix" });
      expect([route, res.status]).toEqual([route, 409]);
      expect((await header(id)).status).toBe(status);
      expect(await history(id)).toEqual([]);
    }
  });

  // R5 adds POST /:id/convert (covered by rfpConversion.http.test.js); a
  // bare request without the conversion inputs changes nothing.
  test("convert without its inputs is refused and leaves the RFP APPROVED", async () => {
    const id = await submitted();
    await act("adminA", id, "approve");
    expect((await act("adminA", id, "convert")).status).toBe(400);
    expect((await header(id)).status).toBe("APPROVED");
    expect((await header(id)).converted_apv_id).toBeNull();
  });
});

describe("request body", () => {
  test("only a note is accepted - target status, actor and company fields are refused", async () => {
    const id = await submitted();
    for (const b of [{ status: "APPROVED" }, { decidedBy: users.super }, { companyId: co.B }, { note: "x", convertedApvId: 1 }, ["note"]]) {
      expect((await act("adminA", id, "approve", b)).status).toBe(400);
    }
    expect((await act("adminA", id, "approve", { note: 5 })).status).toBe(400);
    expect((await act("adminA", id, "approve", { note: "x".repeat(501) })).status).toBe(400);
    expect((await header(id)).status).toBe("SUBMITTED");
  });

  test.each(["abc", "0", "-3", "1.5"])("malformed id %p -> 400", async (bad) => {
    expect((await act("acctA", bad, "submit")).status).toBe(400);
  });
});

describe("permissions", () => {
  test("VIEW / CREATE / EDIT without SUBMIT or APPROVE cannot perform any workflow action", async () => {
    const d = await draft("viewerA");
    expect((await act("viewerA", d, "submit")).status).toBe(403);
    expect((await act("viewerA", d, "cancel")).status).toBe(403);
    const s = await submitted();
    for (const route of ["approve", "return", "reject"]) {
      expect((await act("viewerA", s, route, { note: "x" })).status).toBe(403);
    }
    expect((await header(d)).status).toBe("DRAFT");
    expect((await header(s)).status).toBe("SUBMITTED");
  });

  test("SUBMIT controls submission: an approver without SUBMIT cannot submit", async () => {
    const d = await draft("approverOnlyA");
    expect((await act("approverOnlyA", d, "submit")).status).toBe(403);
    expect((await act("acctA", d, "submit")).status).toBe(200);
    // approverOnlyA requested it, so maker-checker still blocks their decision
    expect((await act("approverOnlyA", d, "approve")).status).toBe(403);
    expect((await act("adminA", d, "approve")).status).toBe(200);
  });

  test("APPROVE controls decisions: an Accountant granted APPROVE may approve", async () => {
    const id = await submitted();
    expect((await act("acctApproverA", id, "approve")).status).toBe(200);
  });
});

describe("company isolation", () => {
  test.each([["adminB", "approve"], ["acctB", "submit"], ["acctB", "cancel"], ["adminB", "reject"]])(
    "%s %s on Company A's RFP: same 404 as unknown, nothing mutated",
    async (who, route) => {
      const id = route === "submit" || route === "cancel" ? await draft() : await submitted();
      const before = await header(id);
      const cross = await act(who, id, route, { note: "x" });
      const unknown = await act(who, UNKNOWN_ID, route, { note: "x" });
      expect(cross.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(cross.body).toEqual(unknown.body);
      expect(await header(id)).toEqual(before);
      expect(await workflowAudits(id)).toHaveLength(route === "submit" || route === "cancel" ? 0 : 1);
    }
  );

  test("own company works for Admin and Accountant of Company B", async () => {
    const id = await submitted("acctB", "B");
    expect((await act("adminB", id, "approve")).status).toBe(200);
    expect((await workflowAudits(id)).every((a) => a.company_id === co.B)).toBe(true);
  });

  test("history endpoint is company-scoped", async () => {
    const id = await submitted();
    const own = await request(app).get(`/api/rfp/${id}/history`).set(auth("adminA"));
    expect(own.status).toBe(200);
    expect(own.body).toEqual([expect.objectContaining({ previousStatus: "DRAFT", newStatus: "SUBMITTED", action: "SUBMIT", userId: users.acctA, username: `${P}acctA` })]);
    expect((await request(app).get(`/api/rfp/${id}/history`).set(auth("adminB"))).status).toBe(404);
  });
});

describe("concurrency", () => {
  test("two simultaneous approvals: exactly one succeeds; one history and one audit row", async () => {
    const id = await submitted();
    const results = await Promise.all([act("adminA", id, "approve"), act("adminA2", id, "approve")]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await history(id)).filter((r) => r.action === "APPROVE")).toHaveLength(1);
    expect((await workflowAudits(id)).filter((a) => a.action === "APPROVE")).toHaveLength(1);
  });

  test("simultaneous submits: exactly one transition", async () => {
    const id = await draft();
    const results = await Promise.all([act("acctA", id, "submit"), act("acctA", id, "submit"), act("acctA2", id, "submit")]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(await history(id)).toHaveLength(1);
    expect(await workflowAudits(id)).toHaveLength(1);
  });

  test("simultaneous approve and reject: exactly one decision wins and the record matches it", async () => {
    const id = await submitted();
    const [approve, reject] = await Promise.all([act("adminA", id, "approve"), act("adminA2", id, "reject", { note: "no" })]);
    expect([approve.status, reject.status].sort()).toEqual([200, 409]);
    const expected = approve.status === 200 ? "APPROVED" : "REJECTED";
    expect((await header(id)).status).toBe(expected);
    const decisions = (await history(id)).filter((r) => r.action !== "SUBMIT");
    expect(decisions).toHaveLength(1);
    expect(decisions[0].new_status).toBe(expected);
    expect((await workflowAudits(id)).filter((a) => a.action !== "SUBMIT")).toHaveLength(1);
  });
});

describe("audit hygiene", () => {
  test("workflow audit rows carry no password, hash or token", async () => {
    const [rows] = await pool.query(
      "SELECT before_data, after_data, description FROM audit_logs WHERE module = 'TRANSACTIONS.RFP' AND action IN ('SUBMIT','APPROVE','RETURN','REJECT','CANCEL') AND company_id IN (?)",
      [Object.values(co)]
    );
    expect(rows.length).toBeGreaterThan(10);
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/password|token|secret|credential|authorization|bearer/i);
    expect(text).not.toContain(PASSWORD);
    for (const t of Object.values(tokens)) expect(text).not.toContain(t);
    const [hashes] = await pool.query("SELECT password FROM users WHERE id IN (?)", [Object.values(users)]);
    for (const h of hashes) expect(text).not.toContain(h.password);
  });
});
