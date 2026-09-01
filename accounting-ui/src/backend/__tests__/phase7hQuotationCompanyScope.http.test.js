const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Phase 7H: the Quotation module is now company-scoped - company_id on
// quotation_headers, UNIQUE(company_id, quotation_no), company-scoped list/
// detail/create/update/delete/convert, and per-company number generation.

jest.setTimeout(180000);

let A, B, userId, token;
let arAccId, salesAccId;
let custA, custB;

async function mkCompany(name) {
  const [r] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [name]);
  return r.insertId;
}

beforeAll(async () => {
  assertNotProductionDatabase();
  A = await mkCompany("PH7H Company A");
  B = await mkCompany("PH7H Company B");

  const hash = await bcrypt.hash("Ph7hPass!1", 10);
  const [u] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('ph7h_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  userId = u.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, A]);
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, B]);
  token = (await request(app).post("/api/login").send({ username: "ph7h_admin", password: "Ph7hPass!1" })).body.token;

  // convert-to-invoice needs a %receivable% and a %sales%/%revenue% account (global COA)
  const [ar] = await pool.execute("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES ('PH7H-AR', CURDATE(), 'PH7H Accounts Receivable', 'ASSET')");
  arAccId = ar.insertId;
  const [sl] = await pool.execute("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES ('PH7H-SALES', CURDATE(), 'PH7H Sales Revenue', 'INCOME')");
  salesAccId = sl.insertId;

  const [ca] = await pool.execute("INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, 'PH7H-CA', 'CUSTOMER', 'PH7H Cust A', 'ACTIVE')", [A]);
  custA = ca.insertId;
  const [cb] = await pool.execute("INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, 'PH7H-CB', 'CUSTOMER', 'PH7H Cust B', 'ACTIVE')", [B]);
  custB = cb.insertId;
});

afterAll(async () => {
  for (const co of [A, B]) {
    await pool.query("DELETE l FROM invoice_lines l JOIN invoice_headers h ON h.id = l.invoice_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM invoice_headers WHERE company_id = ?", [co]);
    await pool.query("DELETE l FROM quotation_lines l JOIN quotation_headers h ON h.id = l.quotation_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM quotation_headers WHERE company_id = ?", [co]);
    await pool.query("DELETE FROM general_libraries WHERE company_id = ?", [co]);
  }
  await pool.query("DELETE FROM user_companies WHERE user_id = ?", [userId]);
  await pool.query("DELETE FROM users WHERE id = ?", [userId]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [A, B]);
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'PH7H-%'");
  await pool.end();
});

function qBody(companyId, { customer, amount = 1000 }) {
  return {
    companyId,
    customerId: customer,
    customerName: companyId === A ? "PH7H Cust A" : "PH7H Cust B",
    quotationDate: "2026-11-20",
    status: "Draft",
    totalAmount: amount,
    lines: [
      { lineType: "item", description: "svc", quantity: 1, unitLabel: "Units", unitPrice: amount, taxRate: 0, amount, accountId: salesAccId, accountCode: "PH7H-SALES", accountTitle: "PH7H Sales Revenue" },
    ],
  };
}
const createQ = (companyId, opts = {}) =>
  request(app).post("/api/quotations").set("Authorization", `Bearer ${token}`).send(qBody(companyId, { customer: companyId === A ? custA : custB, ...opts }));
const listQ = (companyId) =>
  request(app).get("/api/quotations").set("Authorization", `Bearer ${token}`).query({ companyId });
const getQ = (id, companyId) =>
  request(app).get(`/api/quotations/${id}`).set("Authorization", `Bearer ${token}`).query({ companyId });

describe("Phase 7H - quotation number is per-company", () => {
  let qA, qB;
  test("Company A and Company B both create a quotation and both get SQ..-00001", async () => {
    qA = await createQ(A);
    qB = await createQ(B);
    expect(qA.status).toBe(200);
    expect(qB.status).toBe(200);
    expect(qA.body.quotationNo).toMatch(/^SQ\d\d-00001$/);
    expect(qB.body.quotationNo).toBe(qA.body.quotationNo); // same visible number, different companies
  });

  test("per-company sequence: A's next is 00002 while B stays independent", async () => {
    const qA2 = await createQ(A);
    expect(qA2.body.quotationNo).toMatch(/^SQ\d\d-00002$/);
    const qB2 = await createQ(B);
    expect(qB2.body.quotationNo).toMatch(/^SQ\d\d-00002$/); // B's own sequence, not global
  });

  test("the DB composite UNIQUE(company_id, quotation_no) blocks a same-company duplicate", async () => {
    // numbers are auto-generated so this can only happen via a race; prove the index directly
    await expect(
      pool.query(
        "INSERT INTO quotation_headers (company_id, quotation_no, customer_name, quotation_date, status, total_amount) VALUES (?, ?, 'x', CURDATE(), 'Draft', 0)",
        [A, qA.body.quotationNo]
      )
    ).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
  });
});

describe("Phase 7H - list / detail isolation", () => {
  test("Company A list contains only A's quotations", async () => {
    const rA = await listQ(A);
    expect(rA.status).toBe(200);
    expect(rA.body.length).toBeGreaterThan(0);
    // every row belongs to A (verified via DB since the payload has no company_id)
    const ids = rA.body.map((q) => q.id);
    const [rows] = await pool.query(`SELECT DISTINCT company_id FROM quotation_headers WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
    expect(rows).toEqual([{ company_id: A }]);
  });

  test("Company B list excludes Company A's quotations and vice versa", async () => {
    const rA = await listQ(A);
    const rB = await listQ(B);
    const aIds = new Set(rA.body.map((q) => q.id));
    const bIds = new Set(rB.body.map((q) => q.id));
    expect([...aIds].some((id) => bIds.has(id))).toBe(false);
  });

  test("Company A cannot fetch Company B's quotation by id (404)", async () => {
    const qB = await createQ(B);
    const asA = await getQ(qB.body.id, A);
    expect(asA.status).toBe(404);
    const asB = await getQ(qB.body.id, B);
    expect(asB.status).toBe(200);
  });
});

describe("Phase 7H - update / delete isolation", () => {
  test("Company A cannot update Company B's quotation (404); ownership cannot be changed via body", async () => {
    const qB = await createQ(B);
    const upd = await request(app).put(`/api/quotations/${qB.body.id}`).set("Authorization", `Bearer ${token}`)
      .send({ ...qBody(A, { customer: custA }), companyId: A });
    expect(upd.status).toBe(404); // A cannot reach B's row even while claiming companyId A
    const [[row]] = await pool.query("SELECT company_id FROM quotation_headers WHERE id = ?", [qB.body.id]);
    expect(row.company_id).toBe(B); // unchanged
  });

  test("Company A cannot delete Company B's quotation (404)", async () => {
    const qB = await createQ(B);
    const del = await request(app).delete(`/api/quotations/${qB.body.id}`).set("Authorization", `Bearer ${token}`).query({ companyId: A });
    expect(del.status).toBe(404);
    const [[cnt]] = await pool.query("SELECT COUNT(*) n FROM quotation_headers WHERE id = ?", [qB.body.id]);
    expect(cnt.n).toBe(1); // still there
    const delOwn = await request(app).delete(`/api/quotations/${qB.body.id}`).set("Authorization", `Bearer ${token}`).query({ companyId: B });
    expect(delOwn.status).toBe(200);
  });
});

describe("Phase 7H - create authorization", () => {
  test("a user cannot create a quotation for a company they don't belong to", async () => {
    const outHash = await bcrypt.hash("Ph7hOut!1", 10);
    const [o] = await pool.execute("INSERT INTO users (username, password, role_id, status) VALUES ('ph7h_out', ?, 2, 'ACTIVE')", [outHash]);
    await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [o.insertId, A]);
    const outToken = (await request(app).post("/api/login").send({ username: "ph7h_out", password: "Ph7hOut!1" })).body.token;

    const res = await request(app).post("/api/quotations").set("Authorization", `Bearer ${outToken}`).send(qBody(B, { customer: custB }));
    expect(res.status).toBe(403);

    await pool.query("DELETE FROM user_companies WHERE user_id = ?", [o.insertId]);
    await pool.query("DELETE FROM users WHERE id = ?", [o.insertId]);
  });
});

describe("Phase 7H - convert-to-invoice isolation", () => {
  test("Company A cannot convert Company B's quotation (404)", async () => {
    const qB = await createQ(B);
    const conv = await request(app).post(`/api/quotations/${qB.body.id}/convert-to-invoice`).set("Authorization", `Bearer ${token}`).send({ companyId: A });
    expect(conv.status).toBe(404);
    const [[q]] = await pool.query("SELECT status FROM quotation_headers WHERE id = ?", [qB.body.id]);
    expect(q.status).not.toBe("Converted");
  });

  test("converting keeps the same company; the generated invoice belongs to that company", async () => {
    const qA = await createQ(A, { amount: 2500 });
    const conv = await request(app).post(`/api/quotations/${qA.body.id}/convert-to-invoice`).set("Authorization", `Bearer ${token}`).send({ companyId: A });
    expect(conv.status).toBe(200);
    const [[inv]] = await pool.query("SELECT company_id, voucher_no, source_quotation_id FROM invoice_headers WHERE id = ?", [conv.body.invoiceId]);
    expect(inv.company_id).toBe(A);
    expect(inv.voucher_no).toBe(`INV-${qA.body.quotationNo}`);
    expect(inv.source_quotation_id).toBe(qA.body.id);
    const [[q]] = await pool.query("SELECT status, converted_invoice_id FROM quotation_headers WHERE id = ?", [qA.body.id]);
    expect(q.status).toBe("Converted");
    expect(q.converted_invoice_id).toBe(conv.body.invoiceId);
  });

  test("Phase 7G voucher protection still applies during conversion: colliding INV- voucher -> 409 (not raw ER_DUP / 500)", async () => {
    const q = await createQ(A, { amount: 400 });
    expect(q.status).toBe(200);
    // Pre-create the invoice voucher the conversion would generate, for the
    // SAME company -> the Phase 7G assertVoucherNoUnique pre-check must
    // reject the conversion with a clean 409, never a raw ER_DUP or 500.
    await pool.query(
      "INSERT INTO invoice_headers (company_id, voucher_no, customer_name, transaction_date, total_debit, total_credit, balance_amount, payment_status, status) VALUES (?, ?, 'x', CURDATE(), 400, 400, 400, 'Unpaid', 'Draft')",
      [A, `INV-${q.body.quotationNo}`]
    );
    const clash = await request(app).post(`/api/quotations/${q.body.id}/convert-to-invoice`).set("Authorization", `Bearer ${token}`).send({ companyId: A });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe("DUPLICATE_VOUCHER_NO");
    expect(clash.status).not.toBe(500);
    // the quotation stays un-converted since the conversion rolled back
    const [[qr]] = await pool.query("SELECT status FROM quotation_headers WHERE id = ?", [q.body.id]);
    expect(qr.status).not.toBe("Converted");
  });
});

describe("Phase 7H - unresolved legacy quotation (company_id IS NULL) is not accessible to any company", () => {
  let nullQ;
  beforeAll(async () => {
    // The migration deliberately leaves ownership NULL for ambiguous
    // historical rows (>1 company). Such a row must not be reachable via
    // any company-scoped route until ownership is explicitly remediated.
    const [r] = await pool.query(
      "INSERT INTO quotation_headers (company_id, quotation_no, customer_name, quotation_date, status, total_amount) VALUES (NULL, 'SQ26-ORPHAN', 'legacy', CURDATE(), 'Draft', 500)"
    );
    nullQ = r.insertId;
  });
  afterAll(async () => {
    await pool.query("DELETE FROM quotation_headers WHERE id = ?", [nullQ]);
  });

  test("it does not appear in Company A's or Company B's list", async () => {
    const rA = await listQ(A);
    const rB = await listQ(B);
    expect(rA.body.some((q) => q.id === nullQ)).toBe(false);
    expect(rB.body.some((q) => q.id === nullQ)).toBe(false);
  });

  test("GET / PUT / DELETE / convert all return 404 for both companies (no existence leak)", async () => {
    for (const co of [A, B]) {
      expect((await getQ(nullQ, co)).status).toBe(404);
      const upd = await request(app).put(`/api/quotations/${nullQ}`).set("Authorization", `Bearer ${token}`).send(qBody(co, { customer: co === A ? custA : custB }));
      expect(upd.status).toBe(404);
      const del = await request(app).delete(`/api/quotations/${nullQ}`).set("Authorization", `Bearer ${token}`).query({ companyId: co });
      expect(del.status).toBe(404);
      const conv = await request(app).post(`/api/quotations/${nullQ}/convert-to-invoice`).set("Authorization", `Bearer ${token}`).send({ companyId: co });
      expect(conv.status).toBe(404);
    }
    // still present and still unowned
    const [[row]] = await pool.query("SELECT company_id, status FROM quotation_headers WHERE id = ?", [nullQ]);
    expect(row.company_id).toBeNull();
    expect(row.status).toBe("Draft");
  });
});

describe("Phase 7H - existing behavior unchanged (happy path)", () => {
  test("create -> get -> update -> list -> delete all work for the owning company", async () => {
    const c = await createQ(A, { amount: 777 });
    expect(c.status).toBe(200);
    const g = await getQ(c.body.id, A);
    expect(g.status).toBe(200);
    expect(Number(g.body.totalAmount)).toBe(777);
    expect(g.body.lines.length).toBe(1);
    const u = await request(app).put(`/api/quotations/${c.body.id}`).set("Authorization", `Bearer ${token}`)
      .send({ ...qBody(A, { customer: custA, amount: 888 }) });
    expect(u.status).toBe(200);
    const g2 = await getQ(c.body.id, A);
    expect(Number(g2.body.totalAmount)).toBe(888);
    const l = await listQ(A);
    expect(l.body.some((q) => q.id === c.body.id)).toBe(true);
    const d = await request(app).delete(`/api/quotations/${c.body.id}`).set("Authorization", `Bearer ${token}`).query({ companyId: A });
    expect(d.status).toBe(200);
  });
});
