// RFP (Request for Payment) R4.1: a RETURNED request is corrected in place
// (same id / number / company, stays RETURNED) and resubmitted through the
// existing SUBMIT action with full revalidation of the stored record.
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(180000);

const P = "rfpr41-";
const PASSWORD = "RfpR41Pass!1";
const UNKNOWN_ID = 2147483000;

const co = {};
const cur = {};
const sup = {};
const br = {};
const users = {};
const tokens = {};

async function makeUser(tag, roleCode, companyIds = [], branchIds = [], overrides = {}) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const [u] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, (SELECT id FROM roles WHERE code = ?), 'ACTIVE')",
    [`${P}${tag}`, hash, roleCode]
  );
  for (const c of companyIds) await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  for (const b of branchIds) await pool.execute("INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)", [u.insertId, b]);
  for (const [action, granted] of Object.entries(overrides)) {
    await pool.execute(
      `INSERT INTO user_permissions (user_id, permission_id, granted, reason)
       SELECT ?, id, ?, 'rfp r4.1 test' FROM permissions WHERE module_key = 'TRANSACTIONS.RFP' AND action = ?`,
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
const edit = (who, id, body) => request(app).put(`/api/rfp/${id}`).set(auth(who)).send(body);

function body(company = "A", overrides = {}) {
  return {
    companyId: co[company],
    branchId: br[company],
    rfpDate: "2098-05-01",
    supplierId: sup[company],
    purpose: "Original purpose",
    requestedPaymentDate: "2098-05-31",
    currencyId: cur[company],
    lines: [{ description: "Service", grossAmount: "400.00" }, { description: "Parts", grossAmount: "100.50" }],
    ...overrides,
  };
}
// The edit body: the form never sends a company on edit.
const correction = (overrides = {}) => {
  const b = body("A", { purpose: "Corrected purpose", lines: [{ description: "Service (corrected)", grossAmount: "450.00" }], ...overrides });
  delete b.companyId;
  return b;
};

async function returned(who = "acctA", company = "A") {
  const res = await request(app).post("/api/rfp").set(auth(who)).send(body(company));
  if (res.status !== 201) throw new Error(`create: ${res.status} ${JSON.stringify(res.body)}`);
  const id = res.body.id;
  if ((await act(who, id, "submit")).status !== 200) throw new Error("submit");
  const approver = company === "A" ? "adminA" : "adminB";
  if ((await act(approver, id, "return", { note: "Attach the supplier invoice" })).status !== 200) throw new Error("return");
  return { id, rfpNo: res.body.rfpNo };
}

async function header(id) {
  const [[row]] = await pool.query(
    `SELECT id, rfp_no, company_id, requester_user_id, status, purpose, total_amount, branch_id, supplier_id, currency_id,
            submitted_by, submitted_at, decided_by, decided_at, decision_note, converted_apv_id, converted_by, converted_at
     FROM rfp_headers WHERE id = ?`,
    [id]
  );
  return row;
}
const history = async (id) =>
  (await pool.query("SELECT previous_status, new_status, action, user_id, note, created_at FROM rfp_status_history WHERE rfp_id = ? ORDER BY id", [id]))[0];
async function audits(id, action) {
  const [rows] = await pool.query(
    "SELECT action, company_id, user_id, entity_id, before_data, after_data, description FROM audit_logs WHERE module = 'TRANSACTIONS.RFP' AND entity_id = ? AND action = ? ORDER BY id",
    [id, action]
  );
  return rows.map((r) => ({
    ...r,
    before_data: typeof r.before_data === "string" ? JSON.parse(r.before_data) : r.before_data,
    after_data: typeof r.after_data === "string" ? JSON.parse(r.after_data) : r.after_data,
  }));
}

beforeAll(async () => {
  assertNotProductionDatabase();
  for (const tag of ["A", "B"]) {
    const [c] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${P}Co ${tag}`]);
    co[tag] = c.insertId;
    const [k] = await pool.execute("INSERT INTO currencies (company_id, currency_code, currency_name, currency_symbol) VALUES (?, 'PHP', 'Peso', 'P')", [co[tag]]);
    cur[tag] = k.insertId;
    const [s] = await pool.execute(
      "INSERT INTO general_libraries (company_id, code, party_type, name, tin, status) VALUES (?, ?, 'SUPPLIER', ?, '123', 'ACTIVE')",
      [co[tag], `${P}sup${tag}`, `Supplier ${tag}`]
    );
    sup[tag] = s.insertId;
    const [b] = await pool.execute("INSERT INTO branches (company_id, name) VALUES (?, ?)", [co[tag], `${P}Branch ${tag}`]);
    br[tag] = b.insertId;
  }
  const [s2] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, tin, status) VALUES (?, ?, 'SUPPLIER', 'Supplier A2', '456', 'ACTIVE')",
    [co.A, `${P}supA2`]
  );
  sup.A2 = s2.insertId;

  await makeUser("super", "SUPER_ADMIN");
  await makeUser("adminA", "ADMIN", [co.A], [br.A]);
  await makeUser("adminA2", "ADMIN", [co.A], [br.A]);
  await makeUser("acctA", "ACCOUNTANT", [co.A], [br.A]);
  await makeUser("acctA2", "ACCOUNTANT", [co.A], [br.A]);
  await makeUser("adminB", "ADMIN", [co.B], [br.B]);
  await makeUser("acctB", "ACCOUNTANT", [co.B], [br.B]);
  await makeUser("noSubmitA", "ACCOUNTANT", [co.A], [br.A], { SUBMIT: 0 });
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
  } finally {
    await pool.end();
  }
});

describe("edit", () => {
  test("1. DRAFT can be edited", async () => {
    const res = await request(app).post("/api/rfp").set(auth("acctA")).send(body());
    const e = await edit("acctA", res.body.id, correction());
    expect(e.status).toBe(200);
    expect(e.body.status).toBe("DRAFT");
  });

  test("2. RETURNED can be edited in place and stays RETURNED (same id, number, company, requester)", async () => {
    const { id, rfpNo } = await returned();
    const before = await header(id);
    const res = await edit("acctA", id, correction({ supplierId: sup.A2 }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, rfpNo, companyId: co.A, status: "RETURNED", totalAmount: "450.00" });
    const after = await header(id);
    expect(after).toMatchObject({
      id, rfp_no: rfpNo, company_id: co.A, requester_user_id: users.acctA, status: "RETURNED",
      purpose: "Corrected purpose", total_amount: "450.00", supplier_id: sup.A2,
      // workflow metadata is untouched by an edit
      submitted_by: before.submitted_by, decided_by: before.decided_by, decision_note: "Attach the supplier invoice",
      converted_apv_id: null, converted_by: null, converted_at: null,
    });
    expect(after.decided_at).toEqual(before.decided_at);
    // an edit is not a workflow transition
    expect((await history(id)).map((h) => h.action)).toEqual(["SUBMIT", "RETURN"]);
    const editAudit = (await audits(id, "EDIT"))[0];
    expect(editAudit.company_id).toBe(co.A);
    expect(editAudit.after_data).toMatchObject({ status: "RETURNED", purpose: "Corrected purpose" });
  });

  test.each(["SUBMITTED", "APPROVED", "REJECTED", "CANCELLED", "CONVERTED"])("3-7. %s cannot be edited (409, unchanged)", async (status) => {
    const res = await request(app).post("/api/rfp").set(auth("acctA")).send(body());
    const id = res.body.id;
    await pool.execute(
      `UPDATE rfp_headers SET status = ?${status === "CONVERTED" ? ", converted_apv_id = ?" : ""} WHERE id = ?`,
      status === "CONVERTED" ? [status, 2147460000 + id, id] : [status, id]
    );
    const e = await edit("acctA", id, correction());
    expect(e.status).toBe(409);
    expect(await header(id)).toMatchObject({ status, purpose: "Original purpose" });
  });

  test("8-9. company and status cannot be changed through edit of a RETURNED RFP", async () => {
    const { id } = await returned();
    expect((await edit("acctA", id, { ...correction(), companyId: co.B })).status).toBe(400);
    for (const forced of [{ status: "DRAFT" }, { status: "SUBMITTED" }, { submittedBy: users.adminA }, { decidedAt: "2098-01-01" }, { decisionNote: "x" }, { convertedApvId: 9 }, { requesterUserId: users.adminA }]) {
      expect((await edit("acctA", id, { ...correction(), ...forced })).status).toBe(400);
    }
    expect(await header(id)).toMatchObject({ company_id: co.A, status: "RETURNED", purpose: "Original purpose", requester_user_id: users.acctA });
  });

  test("a RETURNED edit is revalidated against the RFP's own company", async () => {
    const { id } = await returned();
    expect((await edit("acctA", id, correction({ supplierId: sup.B }))).status).toBe(400);
    expect((await edit("acctA", id, correction({ branchId: br.B }))).status).toBe(400);
    expect((await edit("acctA", id, correction({ currencyId: cur.B }))).status).toBe(400);
    expect((await header(id)).status).toBe("RETURNED");
  });

  test("a RETURNED RFP still cannot be deleted (it has workflow history)", async () => {
    const { id } = await returned();
    expect((await request(app).delete(`/api/rfp/${id}`).set(auth("acctA"))).status).toBe(409);
  });
});

describe("resubmit", () => {
  test("10-15. RETURNED -> SUBMITTED after correction: one history row, one SUBMIT audit, same id/number/company", async () => {
    const { id, rfpNo } = await returned();
    await edit("acctA", id, correction());
    const res = await act("acctA", id, "submit", { note: "Invoice attached" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id, rfpNo, companyId: co.A, previousStatus: "RETURNED", status: "SUBMITTED" });

    const h = await header(id);
    expect(h).toMatchObject({ id, rfp_no: rfpNo, company_id: co.A, requester_user_id: users.acctA, status: "SUBMITTED", submitted_by: users.acctA, purpose: "Corrected purpose" });
    // the last decision is kept (history is authoritative; not cleared)
    expect(h).toMatchObject({ decided_by: users.adminA, decision_note: "Attach the supplier invoice" });

    const hist = await history(id);
    expect(hist.map((x) => [x.previous_status, x.new_status, x.action, x.user_id, x.note])).toEqual([
      ["DRAFT", "SUBMITTED", "SUBMIT", users.acctA, null],
      ["SUBMITTED", "RETURNED", "RETURN", users.adminA, "Attach the supplier invoice"],
      ["RETURNED", "SUBMITTED", "SUBMIT", users.acctA, "Invoice attached"],
    ]);
    expect(hist.filter((x) => x.previous_status === "RETURNED" && x.new_status === "SUBMITTED")).toHaveLength(1);
    expect(hist[2].created_at).toBeInstanceOf(Date);

    const submits = await audits(id, "SUBMIT");
    expect(submits).toHaveLength(2);
    expect(submits[1]).toMatchObject({ company_id: co.A, user_id: users.acctA, entity_id: id });
    expect(submits[1].before_data).toMatchObject({ rfpNo, companyId: co.A, status: "RETURNED" });
    expect(submits[1].after_data).toMatchObject({ rfpNo, companyId: co.A, previousStatus: "RETURNED", status: "SUBMITTED", submittedBy: users.acctA, note: "Invoice attached" });
    expect(JSON.stringify(submits)).not.toMatch(/password|token|secret|authorization/i);
  });

  test("another user of the company with SUBMIT may resubmit; submitted_by becomes them, requester unchanged", async () => {
    const { id } = await returned();
    expect((await act("acctA2", id, "submit")).status).toBe(200);
    expect(await header(id)).toMatchObject({ submitted_by: users.acctA2, requester_user_id: users.acctA });
  });

  test.each([
    ["17. supplier deactivated", (id) => pool.execute("UPDATE rfp_headers SET supplier_id = ? WHERE id = ?", [sup.A2, id])
      .then(() => pool.execute("UPDATE general_libraries SET status = 'INACTIVE' WHERE id = ?", [sup.A2]))],
    ["17. supplier of another company", (id) => pool.execute("UPDATE rfp_headers SET supplier_id = ? WHERE id = ?", [sup.B, id])],
    ["17. supplier no longer a SUPPLIER", (id) => pool.execute("UPDATE rfp_headers SET supplier_id = ? WHERE id = ?", [sup.A2, id])
      .then(() => pool.execute("UPDATE general_libraries SET party_type = 'CUSTOMER' WHERE id = ?", [sup.A2]))],
    ["18. branch of another company", (id) => pool.execute("UPDATE rfp_headers SET branch_id = ? WHERE id = ?", [br.B, id])],
    ["19. currency of another company", (id) => pool.execute("UPDATE rfp_headers SET currency_id = ? WHERE id = ?", [cur.B, id])],
    ["20. negative line", (id) => pool.execute("UPDATE rfp_lines SET gross_amount = -1 WHERE rfp_id = ?", [id])],
    ["20. blank line description", (id) => pool.execute("UPDATE rfp_lines SET description = '  ' WHERE rfp_id = ?", [id])],
    ["20. invalid VAT treatment", (id) => pool.execute("UPDATE rfp_lines SET vat_treatment = 'ZERO' WHERE rfp_id = ?", [id])],
    ["20. unknown account", (id) => pool.execute("UPDATE rfp_lines SET account_id = 2147483000 WHERE rfp_id = ?", [id])],
    ["20. no lines", (id) => pool.execute("DELETE FROM rfp_lines WHERE rfp_id = ?", [id])],
    ["21. total differs from the lines", (id) => pool.execute("UPDATE rfp_headers SET total_amount = 1 WHERE id = ?", [id])],
    ["missing purpose", (id) => pool.execute("UPDATE rfp_headers SET purpose = NULL WHERE id = ?", [id])],
    ["missing requested payment date", (id) => pool.execute("UPDATE rfp_headers SET requested_payment_date = NULL WHERE id = ?", [id])],
  ])("16, 22-24. full revalidation on resubmit: %s -> 409, still RETURNED, no history, no audit", async (_label, corrupt) => {
    const { id } = await returned();
    await corrupt(id);
    const before = await header(id);
    const res = await act("acctA", id, "submit");
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/cannot be submitted/);
    expect(await header(id)).toEqual(before);
    expect(await history(id)).toHaveLength(2);
    expect(await audits(id, "SUBMIT")).toHaveLength(1);
    await pool.execute("UPDATE general_libraries SET status = 'ACTIVE', party_type = 'SUPPLIER' WHERE id = ?", [sup.A2]);
  });

  test("a resubmitted RFP goes through the normal decision flow again", async () => {
    const { id } = await returned();
    await act("acctA", id, "submit");
    expect((await act("adminA2", id, "approve", { note: "Now OK" })).status).toBe(200);
    expect(await header(id)).toMatchObject({ status: "APPROVED", decided_by: users.adminA2, decision_note: "Now OK" });
    expect((await history(id)).map((x) => x.action)).toEqual(["SUBMIT", "RETURN", "SUBMIT", "APPROVE"]);
  });

  test("RETURNED still cannot be approved, rejected, returned or cancelled", async () => {
    const { id } = await returned();
    expect((await act("adminA2", id, "approve")).status).toBe(409);
    expect((await act("adminA2", id, "reject", { note: "x" })).status).toBe(409);
    expect((await act("adminA2", id, "return", { note: "x" })).status).toBe(409);
    expect((await act("acctA", id, "cancel")).status).toBe(409);
    expect(await history(id)).toHaveLength(2);
  });
});

describe("security", () => {
  test("25-26. another company's RETURNED RFP: edit and resubmit are the same 404 as unknown, nothing changes", async () => {
    const { id } = await returned();
    const before = await header(id);
    const crossEdit = await edit("acctB", id, { ...correction(), branchId: null, supplierId: sup.B, currencyId: cur.B });
    const unknownEdit = await edit("acctB", UNKNOWN_ID, { ...correction(), branchId: null, supplierId: sup.B, currencyId: cur.B });
    expect(crossEdit.status).toBe(404);
    expect(crossEdit.body).toEqual(unknownEdit.body);
    const crossSubmit = await act("acctB", id, "submit");
    const unknownSubmit = await act("acctB", UNKNOWN_ID, "submit");
    expect(crossSubmit.status).toBe(404);
    expect(crossSubmit.body).toEqual(unknownSubmit.body);
    expect(await header(id)).toEqual(before);
    expect(await history(id)).toHaveLength(2);
  });

  test("27. without SUBMIT a user cannot resubmit (403), but may still correct with EDIT", async () => {
    const { id } = await returned();
    expect((await edit("noSubmitA", id, correction())).status).toBe(200);
    expect((await act("noSubmitA", id, "submit")).status).toBe(403);
    expect((await header(id)).status).toBe("RETURNED");
  });

  test("28. after resubmission the requester / resubmitter still cannot approve, return or reject", async () => {
    // An Admin requester holds APPROVE, so only maker-checker can stop them.
    const { id } = await returned("adminA2");
    await edit("adminA2", id, correction());
    expect((await act("adminA2", id, "submit")).status).toBe(200);
    for (const route of ["approve", "return", "reject"]) {
      expect((await act("adminA2", id, route, { note: "self" })).status).toBe(403);
    }
    expect((await act("adminA", id, "approve")).status).toBe(200);
  });

  test("29. Super Admin is subject to the same rule after resubmitting their own RFP", async () => {
    const created = await request(app).post("/api/rfp").set(auth("super")).send(body());
    const id = created.body.id;
    await act("super", id, "submit");
    expect((await act("adminA", id, "return", { note: "Fix it" })).status).toBe(200);
    expect((await edit("super", id, correction())).status).toBe(200);
    expect((await act("super", id, "submit")).status).toBe(200);
    expect((await act("super", id, "approve")).status).toBe(403);
    expect((await header(id)).status).toBe("SUBMITTED");
  });
});

describe("concurrency", () => {
  test("30. two simultaneous resubmissions: exactly one transition, one history row, one audit row", async () => {
    const { id } = await returned();
    const results = await Promise.all([act("acctA", id, "submit"), act("acctA2", id, "submit")]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await history(id)).filter((x) => x.previous_status === "RETURNED")).toHaveLength(1);
    expect(await audits(id, "SUBMIT")).toHaveLength(2);
    expect((await header(id)).status).toBe("SUBMITTED");
  });

  test("an edit racing a resubmission never corrupts the record", async () => {
    const { id } = await returned();
    const [e, s] = await Promise.all([edit("acctA", id, correction({ purpose: "Raced edit" })), act("acctA2", id, "submit")]);
    const h = await header(id);
    expect(s.status).toBe(200);
    expect(h.status).toBe("SUBMITTED");
    // the edit either landed before the submit (200) or was refused because the RFP was already SUBMITTED (409)
    expect([200, 409]).toContain(e.status);
    expect(h.purpose).toBe(e.status === 200 ? "Raced edit" : "Original purpose");
    const [[{ n }]] = await pool.query("SELECT COUNT(*) n FROM rfp_lines WHERE rfp_id = ?", [id]);
    expect(n).toBe(e.status === 200 ? 1 : 2);
    expect((await history(id)).filter((x) => x.action === "SUBMIT")).toHaveLength(2);
  });

  test("31. a decision racing a resubmission cannot produce an invalid state", async () => {
    const { id } = await returned();
    // approve can only act on SUBMITTED: whichever order the locks resolve
    // in, the end state is a valid SUBMITTED or APPROVED with matching history.
    const [submit, approve] = await Promise.all([act("acctA", id, "submit"), act("adminA2", id, "approve")]);
    expect(submit.status).toBe(200);
    const h = await header(id);
    const hist = await history(id);
    if (approve.status === 200) {
      expect(h.status).toBe("APPROVED");
      expect(hist.map((x) => x.action)).toEqual(["SUBMIT", "RETURN", "SUBMIT", "APPROVE"]);
    } else {
      expect(approve.status).toBe(409);
      expect(h.status).toBe("SUBMITTED");
      expect(hist.map((x) => x.action)).toEqual(["SUBMIT", "RETURN", "SUBMIT"]);
    }
  });
});
