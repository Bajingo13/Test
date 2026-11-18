// RFP ownership (approved Option B): requester-side management actions -
// edit, delete, submit / resubmit, cancel, attachment upload / remove - are
// limited to the RFP's requester, a user holding TRANSACTIONS.RFP.APPROVE,
// or Super Admin. Another same-company user keeps read access (view,
// history, attachment download) but gets 403 on every mutation, and a
// refused attempt changes nothing. Order: route permission -> company scope
// (404) -> ownership (403) -> status (409) -> maker-checker (decisions).
// Decisions and convert are NOT ownership-limited.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const STORE = fs.mkdtempSync(path.join(os.tmpdir(), "rfp-owner-test-"));
process.env.ATTACHMENT_STORAGE_DIR = STORE;

const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(180000);

const P = "rfpown-";
const PASSWORD = "RfpOwn!Pass1";
const DENIED = "You can only change a Request for Payment you requested.";
const co = {};
const cur = {};
const sup = {};
const users = {};
const tokens = {};

const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from("IHDR"), crypto.randomBytes(24)]);

async function makeUser(tag, roleCode, companyIds = []) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const [u] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, (SELECT id FROM roles WHERE code = ?), 'ACTIVE')",
    [`${P}${tag}`, hash, roleCode]
  );
  for (const c of companyIds) await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  users[tag] = u.insertId;
  const res = await request(app).post("/api/login").send({ username: `${P}${tag}`, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login ${tag}: ${res.status}`);
  tokens[tag] = res.body.token;
}

const auth = (who) => ({ Authorization: `Bearer ${tokens[who]}` });
const body = (company = "A", over = {}) => ({
  companyId: co[company], rfpDate: "2096-03-02", requestedPaymentDate: "2096-03-30", supplierId: sup[company], currencyId: cur[company],
  purpose: "Original purpose", lines: [{ description: "Supplies", grossAmount: "100.00" }], ...over,
});
const edit = (who, id, over = {}) => request(app).put(`/api/rfp/${id}`).set(auth(who)).send({ ...body("A", over), companyId: undefined });
const del = (who, id) => request(app).delete(`/api/rfp/${id}`).set(auth(who));
const act = (who, id, action, b = {}) => request(app).post(`/api/rfp/${id}/${action}`).set(auth(who)).send(b);
const upload = (who, id) => request(app).post(`/api/rfp/${id}/attachments`).set(auth(who)).attach("file", png(), "receipt.png");
const removeAtt = (who, id, attId) => request(app).delete(`/api/rfp/${id}/attachments/${attId}`).set(auth(who));
const view = (who, id) => request(app).get(`/api/rfp/${id}`).set(auth(who));
const history = (who, id) => request(app).get(`/api/rfp/${id}/history`).set(auth(who));
const binary = (res, cb) => { const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => cb(null, Buffer.concat(c))); };
const download = (who, id, attId) => request(app).get(`/api/rfp/${id}/attachments/${attId}/download`).set(auth(who)).buffer(true).parse(binary);

async function create(who, company = "A", over = {}) {
  const res = await request(app).post("/api/rfp").set(auth(who)).send(body(company, over));
  if (res.status !== 201) throw new Error(`create ${who}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id;
}
async function submitted(who) { const id = await create(who); expect((await act(who, id, "submit")).status).toBe(200); return id; }
async function returned(who) { const id = await submitted(who); expect((await act("adminA", id, "return", { note: "Fix it" })).status).toBe(200); return id; }
async function withAttachment(who) { const id = await create(who); const up = await upload(who, id); expect(up.status).toBe(201); return { id, attId: up.body.id }; }

// Everything a refused attempt must leave untouched.
async function snapshot(id) {
  const [[h]] = await pool.query("SELECT * FROM rfp_headers WHERE id = ?", [id]);
  const [lines] = await pool.query("SELECT id, description, gross_amount FROM rfp_lines WHERE rfp_id = ? ORDER BY id", [id]);
  const [hist] = await pool.query("SELECT id, action FROM rfp_status_history WHERE rfp_id = ? ORDER BY id", [id]);
  const [atts] = await pool.query("SELECT id, deleted_at, storage_key FROM rfp_attachments WHERE rfp_id = ? ORDER BY id", [id]);
  const [[{ audits }]] = await pool.query("SELECT COUNT(*) audits FROM audit_logs WHERE module = 'TRANSACTIONS.RFP' AND entity_id = ?", [id]);
  const files = atts.map((a) => fs.existsSync(path.join(STORE, ...a.storage_key.split("/"))));
  return { h: h ? { ...h, updated_at: undefined } : null, lines, hist, atts, audits: Number(audits), files };
}
async function expectDenied(promise, id, before) {
  const res = await promise;
  expect(res.status).toBe(403);
  expect(res.body.message).toBe(DENIED);
  expect(await snapshot(id)).toEqual(before);
}

beforeAll(async () => {
  assertNotProductionDatabase();
  for (const tag of ["A", "B"]) {
    const [c] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${P}Co ${tag}`]);
    co[tag] = c.insertId;
    const [k] = await pool.execute(
      "INSERT INTO currencies (company_id, currency_code, currency_name, currency_symbol, is_base_currency, is_active) VALUES (?, 'PHP', 'Philippine Peso', 'P', 1, 1)",
      [co[tag]]
    );
    cur[tag] = k.insertId;
    const [s] = await pool.execute(
      "INSERT INTO general_libraries (company_id, code, party_type, name, tin, status) VALUES (?, ?, 'SUPPLIER', ?, '123-456-789-000', 'ACTIVE')",
      [co[tag], `${P}sup${tag}`, `Supplier ${tag}`]
    );
    sup[tag] = s.insertId;
  }
  await makeUser("super", "SUPER_ADMIN");
  await makeUser("adminA", "ADMIN", [co.A]);
  await makeUser("adminA2", "ADMIN", [co.A]);
  await makeUser("acct1", "ACCOUNTANT", [co.A]);
  await makeUser("acct2", "ACCOUNTANT", [co.A]);
  await makeUser("acctB", "ACCOUNTANT", [co.B]);
});

afterAll(async () => {
  const companies = Object.values(co);
  const userIds = Object.values(users);
  try {
    if (companies.length) {
      await pool.query("DELETE FROM rfp_attachments WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE h FROM rfp_status_history h JOIN rfp_headers r ON r.id = h.rfp_id WHERE r.company_id IN (?)", [companies]);
      await pool.query("DELETE FROM rfp_headers WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM audit_logs WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM general_libraries WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM currencies WHERE company_id IN (?)", [companies]);
    }
    if (userIds.length) {
      await pool.query("DELETE FROM audit_logs WHERE user_id IN (?)", [userIds]);
      await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [userIds]);
      await pool.query("DELETE FROM users WHERE id IN (?)", [userIds]);
    }
    if (companies.length) await pool.query("DELETE FROM companies WHERE id IN (?)", [companies]);
  } finally {
    await pool.end();
    fs.rmSync(STORE, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
describe.each([["acct1", "acct2"], ["acct2", "acct1"]])("%s owns the RFP", (owner, other) => {
  describe(`${owner} manages their own RFP (subject to the status rules)`, () => {
    test("edit DRAFT", async () => {
      const id = await create(owner);
      expect((await edit(owner, id, { purpose: "Own edit" })).status).toBe(200);
      expect((await view(owner, id)).body.purpose).toBe("Own edit");
    });
    test("delete DRAFT", async () => {
      const id = await create(owner);
      expect((await del(owner, id)).status).toBe(200);
      expect((await view(owner, id)).status).toBe(404);
    });
    test("submit DRAFT", async () => {
      const id = await create(owner);
      expect((await act(owner, id, "submit")).status).toBe(200);
      expect((await view(owner, id)).body).toMatchObject({ status: "SUBMITTED", submittedBy: users[owner], requesterUserId: users[owner] });
    });
    test("edit + resubmit RETURNED", async () => {
      const id = await returned(owner);
      expect((await edit(owner, id, { purpose: "Corrected" })).status).toBe(200);
      expect((await act(owner, id, "submit")).status).toBe(200);
      expect((await view(owner, id)).body.status).toBe("SUBMITTED");
    });
    test("cancel DRAFT and SUBMITTED", async () => {
      const d = await create(owner);
      expect((await act(owner, d, "cancel")).status).toBe(200);
      const s = await submitted(owner);
      expect((await act(owner, s, "cancel")).status).toBe(200);
      expect((await view(owner, s)).body.status).toBe("CANCELLED");
    });
    test("upload + remove attachment", async () => {
      const { id, attId } = await withAttachment(owner);
      expect((await removeAtt(owner, id, attId)).status).toBe(200);
    });
  });

  describe(`${other} (ACCOUNTANT, no APPROVE) cannot manage ${owner}'s RFP: 403 and nothing changes`, () => {
    test("edit DRAFT", async () => { const id = await create(owner); await expectDenied(edit(other, id, { purpose: "Hijack" }), id, await snapshot(id)); });
    test("edit RETURNED", async () => { const id = await returned(owner); await expectDenied(edit(other, id, { purpose: "Hijack" }), id, await snapshot(id)); });
    test("delete DRAFT", async () => { const id = await create(owner); await expectDenied(del(other, id), id, await snapshot(id)); });
    test("submit DRAFT", async () => { const id = await create(owner); await expectDenied(act(other, id, "submit"), id, await snapshot(id)); });
    test("resubmit RETURNED", async () => { const id = await returned(owner); await expectDenied(act(other, id, "submit"), id, await snapshot(id)); });
    test("cancel DRAFT", async () => { const id = await create(owner); await expectDenied(act(other, id, "cancel"), id, await snapshot(id)); });
    test("cancel SUBMITTED", async () => { const id = await submitted(owner); await expectDenied(act(other, id, "cancel"), id, await snapshot(id)); });
    test("upload attachment", async () => { const id = await create(owner); await expectDenied(upload(other, id), id, await snapshot(id)); });
    test("remove attachment (row and stored file kept)", async () => {
      const { id, attId } = await withAttachment(owner);
      const before = await snapshot(id);
      expect(before.files).toEqual([true]);
      await expectDenied(removeAtt(other, id, attId), id, before);
    });
  });

  test(`${other} can still VIEW ${owner}'s RFP, its history and download its attachment`, async () => {
    const { id, attId } = await withAttachment(owner);
    expect((await act(owner, id, "submit")).status).toBe(200);
    expect((await view(other, id)).status).toBe(200);
    const h = await history(other, id);
    expect(h.status).toBe(200);
    const dl = await download(other, id, attId);
    expect(dl.status).toBe(200);
    expect(dl.body.length).toBeGreaterThan(0);
    expect((await request(app).get(`/api/rfp/${id}/attachments`).set(auth(other))).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe("an approver (ADMIN - holds TRANSACTIONS.RFP.APPROVE) keeps managing other users' RFPs", () => {
  test("edit, delete, cancel, submit and attachments on an accountant's RFP", async () => {
    const d = await create("acct1");
    expect((await edit("adminA", d, { purpose: "Admin edit" })).status).toBe(200);
    expect((await view("adminA", d)).body).toMatchObject({ purpose: "Admin edit", requesterUserId: users.acct1 });
    expect((await del("adminA", d)).status).toBe(200);

    const c = await submitted("acct1");
    expect((await act("adminA", c, "cancel")).status).toBe(200);

    const { id, attId } = await withAttachment("acct1");
    expect((await upload("adminA", id)).status).toBe(201);
    expect((await removeAtt("adminA", id, attId)).status).toBe(200);
    expect((await act("adminA", id, "submit")).status).toBe(200);
    expect((await view("adminA", id)).body).toMatchObject({ status: "SUBMITTED", submittedBy: users.adminA, requesterUserId: users.acct1 });
  });
  test("approve / return / reject an accountant's RFP", async () => {
    const a = await submitted("acct1");
    expect((await act("adminA", a, "approve")).status).toBe(200);
    const r = await submitted("acct1");
    expect((await act("adminA", r, "return", { note: "Fix" })).status).toBe(200);
    const j = await submitted("acct2");
    expect((await act("adminA", j, "reject", { note: "No" })).status).toBe(200);
  });
  test("maker-checker unchanged: Admin cannot decide on an RFP they requested or submitted", async () => {
    const own = await submitted("adminA");
    for (const route of ["approve", "return", "reject"]) expect((await act("adminA", own, route, { note: "self" })).status).toBe(403);
    const onBehalf = await create("acct1");
    expect((await act("adminA", onBehalf, "submit")).status).toBe(200);
    expect((await act("adminA", onBehalf, "approve")).status).toBe(403);
    expect((await act("adminA2", onBehalf, "approve")).status).toBe(200);
  });
});

describe("Super Admin", () => {
  test("may manage another user's RFP (existing bypass)", async () => {
    const id = await create("acct1");
    expect((await edit("super", id, { purpose: "Super edit" })).status).toBe(200);
    expect((await act("super", id, "submit")).status).toBe(200);
    expect((await act("super", id, "cancel")).status).toBe(200);
    const d = await create("acct2");
    expect((await del("super", d)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe("authorization order", () => {
  test("another company's RFP is still the same 404 as an unknown id - never 403", async () => {
    const { id, attId } = await withAttachment("acct1");
    for (const res of [await edit("acctB", id), await del("acctB", id), await act("acctB", id, "submit"), await act("acctB", id, "cancel"),
      await upload("acctB", id), await removeAtt("acctB", id, attId), await view("acctB", id)]) {
      expect(res.status).toBe(404);
    }
    expect((await edit("acctB", 999999999)).status).toBe(404);
  });
  test("non-owner -> ownership denial (403) even where the status would also refuse", async () => {
    const approved = await submitted("acct1");
    expect((await act("adminA", approved, "approve")).status).toBe(200);
    const before = await snapshot(approved);
    for (const p of [edit("acct2", approved), del("acct2", approved), act("acct2", approved, "submit"), act("acct2", approved, "cancel"), upload("acct2", approved)]) {
      const res = await p;
      expect(res.status).toBe(403);
      expect(res.body.message).toBe(DENIED);
    }
    expect(await snapshot(approved)).toEqual(before);
  });
  test("owner -> existing status validation (409) on final / non-editable states", async () => {
    const approved = await submitted("acct1");
    expect((await act("adminA", approved, "approve")).status).toBe(200);
    expect((await edit("acct1", approved)).status).toBe(409);
    expect((await del("acct1", approved)).status).toBe(409);
    expect((await act("acct1", approved, "cancel")).status).toBe(409);
    expect((await act("acct1", approved, "submit")).status).toBe(409);
    expect((await upload("acct1", approved)).status).toBe(409);
    const s = await submitted("acct1");
    expect((await edit("acct1", s)).status).toBe(409);
    expect((await del("acct1", s)).status).toBe(409);
    const rejected = await submitted("acct1");
    expect((await act("adminA", rejected, "reject", { note: "No" })).status).toBe(200);
    expect((await act("acct1", rejected, "cancel")).status).toBe(409);
    expect((await edit("acct1", rejected)).status).toBe(409);
    const cancelled = await create("acct1");
    expect((await act("acct1", cancelled, "cancel")).status).toBe(200);
    expect((await edit("acct1", cancelled)).status).toBe(409);
    expect((await del("acct1", cancelled)).status).toBe(409);
  });
  test("decisions are not ownership-limited: accountants still get the APPROVE 403, approvers decide", async () => {
    const id = await submitted("acct1");
    for (const who of ["acct1", "acct2"]) {
      for (const route of ["approve", "return", "reject"]) {
        const res = await act(who, id, route, { note: "x" });
        expect(res.status).toBe(403);
        expect(res.body.message).not.toBe(DENIED);
      }
    }
    expect((await act("adminA", id, "approve")).status).toBe(200);
  });
  test("convert is untouched (no ownership check added): a non-owner accountant is never refused with the ownership 403", async () => {
    const id = await submitted("acct1");
    expect((await act("adminA", id, "approve")).status).toBe(200);
    const res = await act("acct2", id, "convert", {});
    expect(res.status).not.toBe(403);
    expect(res.body.message).not.toBe(DENIED);
    expect((await view("acct1", id)).body.status).toBe("APPROVED");
  });
});
