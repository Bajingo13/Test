// RFP supporting documents (receipt images / PDFs) over HTTP: real uploads
// into the private attachment store (a temp directory for this suite),
// content-based type checks, size limit, filename sanitizing, company and
// permission isolation, the DRAFT/RETURNED edit rule, soft removal with
// audit, draft deletion, and access through the converted APV.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const STORE = fs.mkdtempSync(path.join(os.tmpdir(), "rfp-attach-test-"));
process.env.ATTACHMENT_STORAGE_DIR = STORE;

const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(180000);

const P = "rfpatt-";
const ACC = "RFPATT-";
const PASSWORD = "RfpAtt!Pass1";
const co = {};
const cur = {};
const sup = {};
const acc = {};
const users = {};
const tokens = {};

// --- files -------------------------------------------------------------------
const png = (extra = crypto.randomBytes(24)) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from("IHDR"), extra]);
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from("JFIF\0"), crypto.randomBytes(40), Buffer.from([0xff, 0xd9])]);
const webp = () => Buffer.concat([Buffer.from("RIFF"), Buffer.from([40, 0, 0, 0]), Buffer.from("WEBPVP8 "), crypto.randomBytes(32)]);
const pdf = (body = "") =>
  Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n${body}\n% ${crypto.randomBytes(8).toString("hex")}\ntrailer << /Root 1 0 R >>\n%%EOF\n`, "latin1");
const exe = () => Buffer.concat([Buffer.from("MZ"), Buffer.alloc(80, 0x90), crypto.randomBytes(16)]);
const zip = () => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), crypto.randomBytes(40)]);
const html = () => Buffer.from(`<html><script>alert(1)</script>${crypto.randomBytes(4).toString("hex")}</html>`);
const svg = () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

// --- fixtures ------------------------------------------------------------------
async function makeUser(tag, roleCode, companyIds = [], overrides = []) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const [u] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, (SELECT id FROM roles WHERE code = ?), 'ACTIVE')",
    [`${P}${tag}`, hash, roleCode]
  );
  for (const c of companyIds) await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  for (const [moduleKey, action, granted] of overrides) {
    await pool.execute(
      `INSERT INTO user_permissions (user_id, permission_id, granted, reason)
       SELECT ?, id, ?, 'rfp attachment test' FROM permissions WHERE module_key = ? AND action = ?`,
      [u.insertId, granted, moduleKey, action]
    );
  }
  users[tag] = u.insertId;
  const res = await request(app).post("/api/login").send({ username: `${P}${tag}`, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login ${tag}: ${res.status}`);
  tokens[tag] = res.body.token;
}

async function mkAccount(key, title, cls, validations = []) {
  const [r] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [`${ACC}${key}`, title, cls]
  );
  for (const v of validations) await pool.execute("INSERT INTO coa_validations (coa_id, validation_name) VALUES (?, ?)", [r.insertId, v]);
  acc[key] = r.insertId;
}

const auth = (who) => ({ Authorization: `Bearer ${tokens[who]}` });
const upload = (who, id, buffer, filename, fields = {}) => {
  const req = request(app).post(`/api/rfp/${id}/attachments`).set(auth(who));
  for (const [k, v] of Object.entries(fields)) req.field(k, v);
  return req.attach("file", buffer, filename);
};
const list = (who, id) => request(app).get(`/api/rfp/${id}/attachments`).set(auth(who));
const binary = (res, cb) => {
  const chunks = [];
  res.on("data", (c) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};
const download = (who, id, attId) => request(app).get(`/api/rfp/${id}/attachments/${attId}/download`).set(auth(who)).buffer(true).parse(binary);
const remove = (who, id, attId) => request(app).delete(`/api/rfp/${id}/attachments/${attId}`).set(auth(who));
const apvList = (who, apvId) => request(app).get(`/api/apv/${apvId}/attachments`).set(auth(who));
const apvDownload = (who, apvId, attId) => request(app).get(`/api/apv/${apvId}/attachments/${attId}/download`).set(auth(who)).buffer(true).parse(binary);
const act = (who, id, action, body = {}) => request(app).post(`/api/rfp/${id}/${action}`).set(auth(who)).send(body);

async function draft(who = "acctA", company = "A") {
  const res = await request(app).post("/api/rfp").set(auth(who)).send({
    companyId: co[company],
    rfpDate: "2097-06-01",
    supplierId: sup[company],
    purpose: "Office supplies with receipt",
    requestedPaymentDate: "2097-06-30",
    currencyId: cur[company],
    lines: [{ description: "Supplies", grossAmount: "500.00", accountId: acc.SUPPLIES, vatTreatment: "EXEMPT" }],
  });
  if (res.status !== 201) throw new Error(`create: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id;
}

async function stored(attachmentId) {
  const [[row]] = await pool.query("SELECT * FROM rfp_attachments WHERE id = ?", [attachmentId]);
  return row;
}
const storedPath = (row) => path.join(STORE, ...row.storage_key.split("/"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

async function audits(rfpId, action) {
  const [rows] = await pool.query(
    "SELECT action, company_id, user_id, before_data, after_data FROM audit_logs WHERE module = 'TRANSACTIONS.RFP' AND entity_id = ? AND action = ? ORDER BY id",
    [rfpId, action]
  );
  const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);
  return rows.map((r) => ({ ...r, before_data: parse(r.before_data), after_data: parse(r.after_data) }));
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
  await mkAccount("SUPPLIES", "Office Supplies Expense", "EXPENSE");
  await mkAccount("AP", "Accounts Payable - Trade", "LIABILITY", ["AP CODE"]);

  await makeUser("super", "SUPER_ADMIN");
  await makeUser("adminA", "ADMIN", [co.A]);
  await makeUser("acctA", "ACCOUNTANT", [co.A]);
  await makeUser("acctB", "ACCOUNTANT", [co.B]);
  await makeUser("noViewA", "ACCOUNTANT", [co.A], [["TRANSACTIONS.RFP", "VIEW", 0]]);
  await makeUser("noEditA", "ACCOUNTANT", [co.A], [["TRANSACTIONS.RFP", "EDIT", 0]]);
  await makeUser("noApvViewA", "ACCOUNTANT", [co.A], [["TRANSACTIONS.APV", "VIEW", 0]]);
});

afterAll(async () => {
  const companies = Object.values(co);
  const userIds = Object.values(users);
  try {
    if (companies.length) {
      await pool.query("DELETE FROM rfp_attachments WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE h FROM rfp_status_history h JOIN rfp_headers r ON r.id = h.rfp_id WHERE r.company_id IN (?)", [companies]);
      await pool.query("DELETE FROM rfp_headers WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM transaction_tax_entries WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE ln FROM apv_lines ln JOIN apv_headers h ON h.id = ln.apv_id WHERE h.company_id IN (?)", [companies]);
      await pool.query("DELETE FROM apv_headers WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM accounting_periods WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM audit_logs WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM general_libraries WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM currencies WHERE company_id IN (?)", [companies]);
    }
    if (userIds.length) {
      await pool.query("DELETE FROM audit_logs WHERE user_id IN (?)", [userIds]);
      await pool.query("DELETE FROM user_permissions WHERE user_id IN (?)", [userIds]);
      await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [userIds]);
      await pool.query("DELETE FROM users WHERE id IN (?)", [userIds]);
    }
    if (companies.length) await pool.query("DELETE FROM companies WHERE id IN (?)", [companies]);
    await pool.query(`DELETE FROM coa_validations WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE '${ACC}%')`);
    await pool.query(`DELETE FROM chart_of_accounts WHERE code LIKE '${ACC}%'`);
  } finally {
    await pool.end();
    fs.rmSync(STORE, { recursive: true, force: true });
  }
});

describe("valid uploads are stored privately and come back byte-for-byte", () => {
  test.each([
    ["PNG", png, "receipt.png", "image/png"],
    ["JPG", jpeg, "receipt.jpg", "image/jpeg"],
    ["JPEG", jpeg, "Receipt Photo.JPEG", "image/jpeg"],
    ["WebP", webp, "receipt.webp", "image/webp"],
    ["PDF", pdf, "Official Receipt.pdf", "application/pdf"],
  ])("%s", async (_label, make, filename, mime) => {
    const id = await draft();
    const bytes = make();
    const res = await upload("acctA", id, bytes, filename);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ rfpId: id, category: "RECEIPT", originalFilename: filename, mimeType: mime, fileSize: bytes.length, sha256: sha(bytes), uploadedBy: users.acctA });
    expect(res.body).not.toHaveProperty("storageKey");
    expect(res.body).not.toHaveProperty("storage_key");

    const row = await stored(res.body.id);
    expect(row.company_id).toBe(co.A);
    // The key is server-generated: company + UUID, nothing from the filename.
    expect(row.storage_key).toMatch(new RegExp(`^rfp/${co.A}/[0-9a-f-]{36}$`));
    expect(fs.readFileSync(storedPath(row)).equals(bytes)).toBe(true);

    const dl = await download("acctA", id, res.body.id);
    expect(dl.status).toBe(200);
    expect(dl.body.equals(bytes)).toBe(true);
    expect(dl.headers["content-type"]).toBe(mime);
    expect(dl.headers["x-content-type-options"]).toBe("nosniff");
    expect(dl.headers["content-disposition"]).toMatch(/^attachment; filename="/);
    expect(dl.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(dl.headers["cache-control"]).toBe("private, no-store");
  });

  test("the list shows metadata only and the upload is audited with its hash", async () => {
    const id = await draft();
    const bytes = pdf();
    const up = await upload("acctA", id, bytes, "or-123.pdf", { category: "SUPPORTING_DOCUMENT" });
    expect(up.status).toBe(201);
    const res = await list("acctA", id);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: up.body.id, category: "SUPPORTING_DOCUMENT", originalFilename: "or-123.pdf", uploadedByUsername: `${P}acctA` });
    expect(JSON.stringify(res.body)).not.toMatch(/storage|rfp\/\d+\//);
    const [a] = await audits(id, "ATTACHMENT_UPLOAD");
    expect(a).toMatchObject({ company_id: co.A, user_id: users.acctA });
    expect(a.after_data).toMatchObject({ attachmentId: up.body.id, originalFilename: "or-123.pdf", mimeType: "application/pdf", sha256: sha(bytes), fileSize: bytes.length });
    expect(JSON.stringify(a.after_data)).not.toMatch(/storage/i);
  });
});

describe("rejected files", () => {
  let id;
  beforeAll(async () => {
    id = await draft();
  });

  test.each([
    ["Windows executable", exe, "setup.exe"],
    ["ZIP archive", zip, "receipts.zip"],
    ["HTML", html, "receipt.html"],
    ["SVG (can carry script)", svg, "receipt.svg"],
    ["plain text", () => Buffer.from("hello"), "notes.txt"],
    ["no extension", png, "receipt"],
    ["double extension ending in .exe", png, "receipt.pdf.exe"],
  ])("unsupported type: %s -> 415", async (_l, make, filename) => {
    const res = await upload("acctA", id, make(), filename);
    expect(res.status).toBe(415);
    expect(res.body.message).toMatch(/JPG, JPEG, PNG, WebP or PDF/);
  });

  test.each([
    ["a PDF renamed .png", pdf, "receipt.png", /PDF.*\.png/],
    ["a PNG renamed .pdf", png, "receipt.pdf", /PNG.*\.pdf/],
    ["a JPEG renamed .webp", jpeg, "receipt.webp", /JPEG.*\.webp/],
    ["an .exe renamed .pdf", exe, "invoice.pdf", /not a valid/],
    ["an .exe renamed .jpg", exe, "photo.jpg", /not a valid/],
    ["a ZIP renamed .png", zip, "receipt.png", /not a valid/],
    ["HTML renamed .jpg", html, "receipt.jpg", /not a valid/],
    ["SVG renamed .png", svg, "receipt.png", /not a valid/],
  ])("misleading extension: %s -> 415", async (_l, make, filename, message) => {
    const res = await upload("acctA", id, make(), filename);
    expect(res.status).toBe(415);
    expect(res.body.message).toMatch(message);
  });

  test.each([
    ["JavaScript", "<< /S /JavaScript /JS (app.alert(1)) >>"],
    ["a launch action", "<< /S /Launch /F (cmd.exe) >>"],
    ["an embedded file", "<< /Type /EmbeddedFile /Length 10 >>"],
  ])("a PDF with %s -> 415", async (_l, body) => {
    const res = await upload("acctA", id, pdf(body), "receipt.pdf");
    expect(res.status).toBe(415);
    expect(res.body.message).toMatch(/scripts, launch actions or embedded files/);
  });

  test("a truncated PDF -> 415", async () => {
    const res = await upload("acctA", id, Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\n"), "receipt.pdf");
    expect(res.status).toBe(415);
    expect(res.body.message).toMatch(/incomplete or damaged/);
  });

  test("a file over 10 MB -> 413, nothing stored", async () => {
    const big = Buffer.concat([png(Buffer.alloc(0)), Buffer.alloc(10 * 1024 * 1024 + 1 - 16)]);
    expect(big.length).toBe(10 * 1024 * 1024 + 1);
    const res = await upload("acctA", id, big, "huge.png");
    expect(res.status).toBe(413);
    expect(res.body.message).toMatch(/10 MB/);
  });

  test("exactly 10 MB is accepted", async () => {
    const other = await draft();
    const max = Buffer.concat([png(Buffer.alloc(0)), crypto.randomBytes(10 * 1024 * 1024 - 16)]);
    const res = await upload("acctA", other, max, "max.png");
    expect(res.status).toBe(201);
    expect(res.body.fileSize).toBe(10 * 1024 * 1024);
  });

  test("no file, an empty file, two files -> 400", async () => {
    expect((await request(app).post(`/api/rfp/${id}/attachments`).set(auth("acctA")).field("category", "RECEIPT")).status).toBe(400);
    expect((await upload("acctA", id, Buffer.alloc(0), "empty.png")).status).toBe(400);
    const two = await request(app).post(`/api/rfp/${id}/attachments`).set(auth("acctA")).attach("file", png(), "a.png").attach("file", png(), "b.png");
    expect(two.status).toBe(400);
  });

  test("an unknown category -> 400", async () => {
    const res = await upload("acctA", id, png(), "receipt.png", { category: "MALWARE" });
    expect(res.status).toBe(400);
  });

  test("nothing from any rejected upload reached the database or the store", async () => {
    const [[n]] = await pool.query("SELECT COUNT(*) AS n FROM rfp_attachments WHERE rfp_id = ?", [id]);
    expect(n.n).toBe(0);
    const companyDir = path.join(STORE, "rfp", String(co.A));
    const files = fs.existsSync(companyDir) ? fs.readdirSync(companyDir) : [];
    const [rows] = await pool.query("SELECT storage_key FROM rfp_attachments WHERE company_id = ?", [co.A]);
    // Every file on disk belongs to a metadata row (no orphans, no temp files).
    expect(files.sort()).toEqual(rows.map((r) => r.storage_key.split("/").pop()).sort());
  });
});

describe("filenames and storage keys", () => {
  test("path traversal and unsafe characters never reach the filesystem", async () => {
    const id = await draft();
    for (const [name, expected] of [
      ["../../../etc/passwd.png", "passwd.png"],
      ["..\\..\\Windows\\win.ini.png", "win.ini.png"],
      // (a browser sends a double quote in a filename as %22, so it is not tested here)
      ["re<ce>ipt:|?*.png", "receipt.png"],
      ["  ..hidden.png ", "hidden.png"],
      ["evil.exe.png", "evil.exe.png"],
    ]) {
      const res = await upload("acctA", id, png(), name);
      expect(res.status).toBe(201);
      expect(res.body.originalFilename).toBe(expected);
      const row = await stored(res.body.id);
      expect(row.storage_key).toMatch(new RegExp(`^rfp/${co.A}/[0-9a-f-]{36}$`));
      expect(path.resolve(storedPath(row)).startsWith(STORE)).toBe(true);
    }
  });

  test("a non-ASCII name downloads with an RFC 6266 header", async () => {
    const id = await draft();
    const up = await upload("acctA", id, png(), "Resibo ñ — Juan.png");
    expect(up.status).toBe(201);
    const dl = await download("acctA", id, up.body.id);
    expect(dl.headers["content-disposition"]).toBe(`attachment; filename="Resibo _ _ Juan.png"; filename*=UTF-8''${encodeURIComponent("Resibo ñ — Juan.png")}`);
  });

  test("the same file twice on one RFP -> 409; at most 10 per RFP", async () => {
    const id = await draft();
    const bytes = png();
    expect((await upload("acctA", id, bytes, "a.png")).status).toBe(201);
    const dup = await upload("acctA", id, bytes, "copy.png");
    expect(dup.status).toBe(409);
    expect(dup.body.message).toMatch(/already attached as "a.png"/);
    for (let i = 0; i < 9; i += 1) expect((await upload("acctA", id, png(), `r${i}.png`)).status).toBe(201);
    const eleventh = await upload("acctA", id, png(), "r11.png");
    expect(eleventh.status).toBe(409);
    expect(eleventh.body.message).toMatch(/at most 10/);
  });
});

describe("permissions and company isolation", () => {
  let id;
  let attId;
  beforeAll(async () => {
    id = await draft();
    attId = (await upload("acctA", id, png(), "receipt.png")).body.id;
  });

  test("no token -> 401 on every route", async () => {
    expect((await request(app).get(`/api/rfp/${id}/attachments`)).status).toBe(401);
    expect((await request(app).post(`/api/rfp/${id}/attachments`).attach("file", png(), "x.png")).status).toBe(401);
    expect((await request(app).get(`/api/rfp/${id}/attachments/${attId}/download`)).status).toBe(401);
    expect((await request(app).delete(`/api/rfp/${id}/attachments/${attId}`)).status).toBe(401);
  });

  test("a user without RFP VIEW cannot list or download -> 403", async () => {
    expect((await list("noViewA", id)).status).toBe(403);
    expect((await download("noViewA", id, attId)).status).toBe(403);
  });

  test("a user with VIEW but without EDIT can view but not upload or remove -> 403", async () => {
    expect((await list("noEditA", id)).status).toBe(200);
    expect((await download("noEditA", id, attId)).status).toBe(200);
    expect((await upload("noEditA", id, png(), "x.png")).status).toBe(403);
    expect((await remove("noEditA", id, attId)).status).toBe(403);
  });

  test("another company's user gets 404 everywhere, exactly like an unknown id", async () => {
    expect((await list("acctB", id)).status).toBe(404);
    expect((await download("acctB", id, attId)).status).toBe(404);
    expect((await upload("acctB", id, png(), "x.png")).status).toBe(404);
    expect((await remove("acctB", id, attId)).status).toBe(404);
    expect((await list("acctA", 2147483000)).status).toBe(404);
    expect((await stored(attId)).deleted_at).toBeNull();
  });

  test("an attachment id is only reachable through its own RFP", async () => {
    const other = await draft();
    expect((await download("acctA", other, attId)).status).toBe(404);
    expect((await remove("acctA", other, attId)).status).toBe(404);
    const bOwn = await draft("acctB", "B");
    expect((await download("acctB", bOwn, attId)).status).toBe(404);
  });

  test("Super Admin can read any company's attachment", async () => {
    expect((await download("super", id, attId)).status).toBe(200);
  });

  test("malformed ids -> 400", async () => {
    expect((await download("acctA", id, "1;DROP")).status).toBe(400);
    expect((await download("acctA", "abc", attId)).status).toBe(400);
    expect((await list("acctA", "0x1")).status).toBe(400);
  });
});

describe("integrity", () => {
  test("a stored file that was altered is refused (500); a missing one -> 410", async () => {
    const id = await draft();
    const a = (await upload("acctA", id, png(), "a.png")).body.id;
    const b = (await upload("acctA", id, png(), "b.png")).body.id;
    const rowA = await stored(a);
    fs.writeFileSync(storedPath(rowA), png());
    expect((await download("acctA", id, a)).status).toBe(500);
    fs.unlinkSync(storedPath(await stored(b)));
    expect((await download("acctA", id, b)).status).toBe(410);
  });
});

describe("workflow: the attachment survives approval and conversion", () => {
  let id;
  let attId;
  let bytes;
  let apvId;

  test("save -> reload -> submit -> approve: still attached, and frozen after submit", async () => {
    id = await draft();
    bytes = pdf();
    attId = (await upload("acctA", id, bytes, "OR-5521.pdf")).body.id;
    expect((await list("acctA", id)).body.map((a) => a.id)).toEqual([attId]);

    expect((await act("acctA", id, "submit")).status).toBe(200);
    const late = await upload("acctA", id, png(), "late.png");
    expect(late.status).toBe(409);
    expect(late.body.message).toMatch(/DRAFT or RETURNED/);
    expect((await remove("acctA", id, attId)).status).toBe(409);

    expect((await act("adminA", id, "approve")).status).toBe(200);
    const after = await list("adminA", id);
    expect(after.body.map((a) => a.id)).toEqual([attId]);
    expect((await download("adminA", id, attId)).body.equals(bytes)).toBe(true);
  });

  test("convert: the RFP keeps it, and the APV reaches the same file through the link (no copy)", async () => {
    const before = (await pool.query("SELECT COUNT(*) AS n FROM rfp_attachments WHERE company_id = ?", [co.A]))[0][0].n;
    const res = await act("adminA", id, "convert", { apvDate: "2097-06-15", apAccountId: acc.AP });
    expect(res.status).toBe(200);
    apvId = res.body.apv.id;
    expect((await pool.query("SELECT COUNT(*) AS n FROM rfp_attachments WHERE company_id = ?", [co.A]))[0][0].n).toBe(before);

    expect((await download("acctA", id, attId)).body.equals(bytes)).toBe(true);
    const viaApv = await apvList("acctA", apvId);
    expect(viaApv.status).toBe(200);
    expect(viaApv.body).toMatchObject({ apvId, sourceRfp: { id, status: "CONVERTED" } });
    expect(viaApv.body.sourceRfp.rfpNo).toMatch(/^RFP/);
    expect(viaApv.body.attachments.map((a) => a.id)).toEqual([attId]);
    const dl = await apvDownload("acctA", apvId, attId);
    expect(dl.status).toBe(200);
    expect(dl.body.equals(bytes)).toBe(true);
    expect(dl.headers["content-type"]).toBe("application/pdf");
    // Still frozen after conversion.
    expect((await remove("adminA", id, attId)).status).toBe(409);
  });

  test("APV access follows APV VIEW and the APV's company", async () => {
    expect((await apvList("noApvViewA", apvId)).status).toBe(403);
    expect((await apvDownload("noApvViewA", apvId, attId)).status).toBe(403);
    expect((await apvList("acctB", apvId)).status).toBe(404);
    expect((await apvDownload("acctB", apvId, attId)).status).toBe(404);
    expect((await apvList("super", apvId)).status).toBe(200);
  });

  test("an APV only reaches its own RFP's attachments", async () => {
    const other = await draft();
    const otherAtt = (await upload("acctA", other, png(), "other.png")).body.id;
    expect((await apvDownload("acctA", apvId, otherAtt)).status).toBe(404);
  });

  test("an APV not created from an RFP has no source and no attachments", async () => {
    const [r] = await pool.execute(
      "INSERT INTO apv_headers (company_id, voucher_no, transaction_date, status, total_debit, total_credit) VALUES (?, ?, '2097-06-20', 'Draft', 0, 0)",
      [co.A, `${P}MANUAL-1`]
    );
    const res = await apvList("acctA", r.insertId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ apvId: r.insertId, sourceRfp: null, attachments: [] });
    expect((await apvDownload("acctA", r.insertId, attId)).status).toBe(404);
  });
});

describe("removal and deletion", () => {
  test("remove in DRAFT: soft delete with audit; the file is kept as evidence", async () => {
    const id = await draft();
    const bytes = png();
    const attId = (await upload("acctA", id, bytes, "wrong.png")).body.id;
    const res = await remove("acctA", id, attId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: attId, rfpId: id, removed: true });

    const row = await stored(attId);
    expect(row.deleted_by).toBe(users.acctA);
    expect(row.deleted_at).toBeInstanceOf(Date);
    expect(fs.readFileSync(storedPath(row)).equals(bytes)).toBe(true);
    expect((await list("acctA", id)).body).toEqual([]);
    expect((await download("acctA", id, attId)).status).toBe(404);
    expect((await remove("acctA", id, attId)).status).toBe(404);

    const [a] = await audits(id, "ATTACHMENT_REMOVE");
    expect(a).toMatchObject({ company_id: co.A, user_id: users.acctA });
    expect(a.before_data).toMatchObject({ attachmentId: attId, originalFilename: "wrong.png", sha256: sha(bytes) });
  });

  test("a RETURNED RFP can take a corrected receipt", async () => {
    const id = await draft();
    expect((await act("acctA", id, "submit")).status).toBe(200);
    expect((await act("adminA", id, "return", { note: "Attach the official receipt" })).status).toBe(200);
    expect((await upload("acctA", id, pdf(), "official-receipt.pdf")).status).toBe(201);
  });

  test("deleting a never-submitted draft removes its attachment rows and files, and the audit keeps their metadata", async () => {
    const id = await draft();
    const bytes = jpeg();
    const attId = (await upload("acctA", id, bytes, "r.jpg")).body.id;
    const removedId = (await upload("acctA", id, png(), "x.png")).body.id;
    await remove("acctA", id, removedId);
    const paths = [storedPath(await stored(attId)), storedPath(await stored(removedId))];

    const res = await request(app).delete(`/api/rfp/${id}`).set(auth("acctA"));
    expect(res.status).toBe(200);
    expect(await stored(attId)).toBeUndefined();
    expect(paths.every((p) => !fs.existsSync(p))).toBe(true);
    const [a] = await audits(id, "DELETE");
    expect(a.before_data.attachments).toEqual([
      expect.objectContaining({ attachmentId: attId, originalFilename: "r.jpg", sha256: sha(bytes), removed: false }),
      expect.objectContaining({ attachmentId: removedId, removed: true }),
    ]);
  });
});
