// Maker-Checker Release 1 (lib/postingControl.js, migration 69) - ENFORCED.
// Separation of duties is ON in this file (POSTING_SOD_TEST_BYPASS = "0").
// Live ALAS has POSTING.* = 0 for the Accountant role; here the shared test
// role table is NOT changed (other suites run in parallel) - the same effect is
// produced with user-level overrides on this file's own users.
// Local test database only. Fixture prefix UAT-MCK-.
process.env.POSTING_SOD_TEST_BYPASS = "0";
const fs = require("fs");
const path = require("path");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { signSessionToken } = require("../lib/sessionPolicy");
const CurrencyService = require("../services/currencyService");
const { sendRouteError } = require("../lib/routeError");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(240000);

const P = "UAT-MCK-";
const DATE = "2097-08-12";
const ids = { companies: [], users: [] };
const co = {};
const br = {};
const tok = {};
const usr = {};
const acc = {};
const party = {};
let seq = 0;

const as = (who) => ({ Authorization: `Bearer ${tok[who]}` });
const api = (method, who, url, body) => {
  const r = request(app)[method](url).set(as(who));
  return body === undefined ? r : r.send(body);
};
async function roleId(code) {
  const [[r]] = await pool.query("SELECT id FROM roles WHERE code = ?", [code]);
  return r.id;
}
async function permissionId(moduleKey, action) {
  const [[p]] = await pool.query("SELECT id FROM permissions WHERE module_key = ? AND action = ?", [moduleKey, action]);
  return p.id;
}
async function mkCompany(tag, branches) {
  const [c] = await pool.query("INSERT INTO companies (name, status) VALUES (?, 'Active')", [`${P}${tag}`]);
  co[tag] = c.insertId;
  ids.companies.push(c.insertId);
  for (const code of branches) {
    const [b] = await pool.query("INSERT INTO branches (company_id, name, code, status) VALUES (?, ?, ?, 'ACTIVE')", [c.insertId, `${P}${code}`, `${P}${code}`]);
    br[code] = b.insertId;
  }
}
async function mkUser(tag, roleCode, companies, branches = [], postingPost) {
  const [u] = await pool.query("INSERT INTO users (username, full_name, password, role_id, status) VALUES (?, ?, 'x', ?, 'ACTIVE')", [`${P}${tag}`, `${P}${tag}`, await roleId(roleCode)]);
  for (const c of companies) await pool.query("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  for (const b of branches) await pool.query("INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)", [u.insertId, b]);
  if (postingPost !== undefined) {
    // same effect as the live Accountant role change, scoped to this user only
    for (const action of ["POST", "VIEW", "APPROVE"]) {
      await pool.query("INSERT INTO user_permissions (user_id, permission_id, granted, reason) VALUES (?, ?, ?, ?)", [u.insertId, await permissionId("POSTING", action), postingPost ? 1 : 0, `${P}fixture`]);
    }
  }
  ids.users.push(u.insertId);
  usr[tag] = { id: u.insertId, username: `${P}${tag}`, role: roleCode, roleCode, token_version: 0 };
  tok[tag] = signSessionToken(usr[tag]);
}
async function mkAccount(key, cls) {
  const [r] = await pool.query("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, '2097-01-01', ?, ?)", [`${P}${key}`, `${P}${key}`, cls]);
  acc[key] = { id: r.insertId, code: `${P}${key}` };
}
async function mkParty(key, companyId, type) {
  const [r] = await pool.query("INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, ?, ?, ?, 'ACTIVE')", [companyId, `${P}${key}`, type, `${P}${key}`]);
  party[key] = { id: r.insertId, code: `${P}${key}`, name: `${P}${key}`, type };
}
const L = (key, debit, credit) => ({ accountId: acc[key].id, accountCode: acc[key].code, accountTitle: acc[key].code, particulars: "x", debit, credit });

// The eight posting modules (debit + credit memo share MEMO).
const MODULES = {
  INV: { path: "/api/invoices", table: "invoice_headers", party: "CUS", lines: () => [L("CASH", 100, 0), L("REV", 0, 100)], extra: { invoiceType: "Standard" } },
  OR: { path: "/api/or", table: "or_headers", party: "CUS", lines: () => [L("CASH", 100, 0), L("REV", 0, 100)], extra: { paymentMethod: "Cash" } },
  APV: { path: "/api/apv", table: "apv_headers", party: "SUP", lines: () => [L("EXP", 100, 0), L("CASH", 0, 100)] },
  CV: { path: "/api/cv", table: "cv_headers", party: "SUP", lines: () => [L("EXP", 100, 0), L("CASH", 0, 100)], extra: { paymentMethod: "Cash" } },
  JV: { path: "/api/jv", table: "jv_headers", party: null, lines: () => [L("EXP", 100, 0), L("CASH", 0, 100)] },
  DM: { path: "/api/debit-memos", table: "memo_headers", party: "CUS", lines: () => [L("CASH", 100, 0), L("REV", 0, 100)] },
  CM: { path: "/api/credit-memos", table: "memo_headers", party: "SUP", lines: () => [L("EXP", 100, 0), L("CASH", 0, 100)] },
  PCV: { path: "/api/petty-cash", table: "petty_cash_headers", party: null, lines: () => [L("EXP", 100, 0), L("CASH", 0, 100)], extra: { payeeName: "UAT-MCK walk-in" } },
  PO: { path: "/api/purchase-orders", table: "purchase_order_headers", party: "SUP", lines: () => [L("EXP", 100, 0), L("CASH", 0, 100)], postStatus: "Open" },
};
const POST_STATUS = (mod) => MODULES[mod].postStatus || "Posted";
function body(mod, { companyId = co.A, branchId = br.A1, status = "Draft", voucherNo, description = "UAT-MCK", ...extra } = {}) {
  const m = MODULES[mod];
  const p = party[m.party];
  const partyFields = p ? { supplierId: p.id, supplierName: p.name, customerId: p.id, customerName: p.name, payeeId: p.id, payeeName: p.name, partyId: p.id, partyName: p.name, partyType: p.type } : {};
  const n = voucherNo || `${P}${mod}-${++seq}`;
  return { voucherNo: n, transactionDate: DATE, dueDate: DATE, referenceNo: n, description, status,
    ...partyFields, lines: m.lines(), totalDebit: 100, totalCredit: 100, currency: { companyId }, branchId, ...(m.extra || {}), ...extra };
}
async function draft(who, mod, opts = {}) {
  const b = body(mod, opts);
  const r = await api("post", who, MODULES[mod].path, b);
  if (r.status !== 200 && r.status !== 201) throw new Error(`${mod} draft by ${who}: ${r.status} ${JSON.stringify(r.body)}`);
  return { id: r.body.id, body: b };
}
const post = (who, mod, d, changes = {}) => api("put", who, `${MODULES[mod].path}/${d.id}`, { ...d.body, ...changes, status: POST_STATUS(mod) });
const row = async (mod, id) => (await pool.query(`SELECT status, created_by, updated_by, posted_by, description, total_debit FROM ${MODULES[mod].table} WHERE id = ?`, [id]))[0][0];

beforeAll(async () => {
  assertNotProductionDatabase();
  await mkCompany("A", ["A1", "A2"]);
  await mkCompany("B", ["B1"]);
  await mkUser("acctA1", "ACCOUNTANT", [co.A], [br.A1], false); // like live ALAS: no POSTING
  await mkUser("acctA2", "ACCOUNTANT", [co.A], [br.A2], true); // an accountant explicitly given POSTING (override)
  await mkUser("adminA", "ADMIN", [co.A]);
  await mkUser("adminA2", "ADMIN", [co.A]);
  await mkUser("adminB", "ADMIN", [co.B]);
  await mkUser("super", "SUPER_ADMIN", []);
  for (const c of [co.A, co.B]) {
    await CurrencyService.createCurrency({ id: usr.adminA.id, roleCode: "SUPER_ADMIN" }, {
      currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "P", decimalPlaces: 2,
      symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: c,
    });
  }
  await mkAccount("CASH", "ASSET");
  await mkAccount("REV", "INCOME");
  await mkAccount("EXP", "EXPENSE");
  await mkParty("CUS", co.A, "CUSTOMER");
  await mkParty("SUP", co.A, "SUPPLIER");
});

afterAll(async () => {
  try {
    const cos = ids.companies.concat(0);
    const usersIn = ids.users.concat(0);
    await pool.query("DELETE FROM transaction_applications WHERE applied_id IN (SELECT id FROM cv_headers WHERE company_id IN (?)) OR applied_id IN (SELECT id FROM or_headers WHERE company_id IN (?))", [cos, cos]);
    for (const [lines, fk, head] of [["apv_lines", "apv_id", "apv_headers"], ["cv_lines", "cv_id", "cv_headers"], ["invoice_lines", "invoice_id", "invoice_headers"], ["or_lines", "or_id", "or_headers"], ["jv_lines", "jv_id", "jv_headers"], ["memo_lines", "memo_id", "memo_headers"], ["petty_cash_lines", "petty_cash_id", "petty_cash_headers"], ["purchase_order_lines", "po_id", "purchase_order_headers"]]) {
      await pool.query(`DELETE l FROM ${lines} l JOIN ${head} h ON h.id = l.${fk} WHERE h.company_id IN (?)`, [cos]).catch(() => {});
    }
    for (const t of ["transaction_tax_entries", "transaction_currency_snapshots"]) await pool.query(`DELETE FROM ${t} WHERE company_id IN (?)`, [cos]);
    for (const t of ["jv_headers", "apv_headers", "invoice_headers", "cv_headers", "or_headers", "memo_headers", "petty_cash_headers", "purchase_order_headers"]) {
      await pool.query(`DELETE FROM ${t} WHERE company_id IN (?)`, [cos]);
    }
    await pool.query("DELETE FROM audit_logs WHERE company_id IN (?) OR user_id IN (?) OR description LIKE ?", [cos, usersIn, `%${P}%`]);
    await pool.query("DELETE FROM general_libraries WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE ?", [`${P}%`]);
    await pool.query("DELETE FROM currency_rates WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM currencies WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM user_permissions WHERE user_id IN (?)", [usersIn]);
    await pool.query("DELETE FROM user_branches WHERE user_id IN (?)", [usersIn]);
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [usersIn]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [usersIn]);
    await pool.query("DELETE FROM branches WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM companies WHERE id IN (?)", [cos]);
  } finally {
    await pool.end();
  }
});

// ===========================================================================
describe("1. maker drafts, a different authorized checker posts (all eight modules)", () => {
  test.each(Object.keys(MODULES))("%s: accountant Draft -> ADMIN posts; maker / poster recorded", async (mod) => {
    const d = await draft("acctA1", mod);
    const before = await row(mod, d.id);
    expect(before).toMatchObject({ status: "Draft", created_by: usr.acctA1.id, updated_by: usr.acctA1.id, posted_by: null });
    const r = await post("adminA", mod, d);
    expect([200, 201]).toContain(r.status);
    const after = await row(mod, d.id);
    expect(after.status).toBe(POST_STATUS(mod));
    expect(after).toMatchObject({ created_by: usr.acctA1.id, posted_by: usr.adminA.id });
    expect(String(after.total_debit)).toBe(String(before.total_debit)); // amounts untouched
  });
});

describe("2. no direct posting by makers", () => {
  test.each(Object.keys(MODULES))("%s: creating directly as Posted / Open is refused for every role", async (mod) => {
    for (const who of ["acctA1", "adminA", "super"]) {
      const r = await api("post", who, MODULES[mod].path, body(mod, { status: POST_STATUS(mod) }));
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("POSTING_ON_CREATE_NOT_ALLOWED");
    }
  });

  test("a PO created with no status is no longer silently Open", async () => {
    const b = body("PO");
    delete b.status;
    const r = await api("post", "adminA", "/api/purchase-orders", b);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("POSTING_ON_CREATE_NOT_ALLOWED");
  });

  test.each(["JV", "INV", "APV"])("%s: accountant without POSTING.POST cannot post even someone else's Draft", async (mod) => {
    const d = await draft("adminA", mod);
    const r = await post("acctA1", mod, d);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("POSTING_NOT_PERMITTED");
    expect((await row(mod, d.id)).status).toBe("Draft");
  });
});

describe("3. nobody posts their own work - ADMIN and SUPER_ADMIN included", () => {
  test.each([["adminA", "JV"], ["adminA", "INV"], ["super", "JV"], ["super", "APV"], ["acctA2", "CV"]])("%s cannot post their own %s", async (who, mod) => {
    const branchId = who === "acctA2" ? br.A2 : br.A1;
    const d = await draft(who, mod, { branchId });
    const r = await post(who, mod, d);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("SELF_POSTING_NOT_ALLOWED");
    expect((await row(mod, d.id)).status).toBe("Draft");
  });

  test("the LAST EDITOR cannot post either; a third person can", async () => {
    const d = await draft("acctA1", "JV");
    const edit = await api("put", "adminA", `/api/jv/${d.id}`, { ...d.body, description: "corrected by adminA" });
    expect(edit.status).toBe(200);
    expect(await row("JV", d.id)).toMatchObject({ created_by: usr.acctA1.id, updated_by: usr.adminA.id, status: "Draft" });
    const corrected = { id: d.id, body: { ...d.body, description: "corrected by adminA" } };
    const self = await post("adminA", "JV", corrected);
    expect(self.status).toBe(403);
    expect(self.body.code).toBe("SELF_POSTING_NOT_ALLOWED");
    const ok = await post("adminA2", "JV", corrected);
    expect(ok.status).toBe(200);
    expect(await row("JV", d.id)).toMatchObject({ status: "Posted", posted_by: usr.adminA2.id });
  });
});

describe("4. posting never changes content", () => {
  test.each([["JV", () => ({ description: "changed while posting" })], ["INV", () => ({ totalDebit: 150, totalCredit: 150, lines: [L("CASH", 150, 0), L("REV", 0, 150)] })], ["APV", () => ({ transactionDate: "2097-08-13" })], ["OR", () => ({ referenceNo: "OTHER-REF" })]])(
    "%s: a posting request that alters content is refused and nothing changes", async (mod, change) => {
      const d = await draft("acctA1", mod);
      const before = await row(mod, d.id);
      const r = await post("adminA", mod, d, change());
      expect(r.status).toBe(409);
      expect(r.body.code).toBe("POSTING_CONTENT_CHANGED");
      expect(await row(mod, d.id)).toEqual(before);
    });
});

describe("5. company and branch authority on every posting path", () => {
  test("an accountant WITH posting rights cannot post another branch's Draft", async () => {
    const d = await draft("acctA1", "INV"); // branch A1
    const r = await post("acctA2", "INV", d); // acctA2 is A2-only
    expect([403, 404]).toContain(r.status);
    expect((await row("INV", d.id)).status).toBe("Draft");
  });
  test("another company's ADMIN cannot post it", async () => {
    const d = await draft("acctA1", "JV");
    const r = await api("put", "adminB", `/api/jv/${d.id}`, { ...d.body, currency: { companyId: co.B }, status: "Posted" });
    expect([403, 404]).toContain(r.status);
    expect((await row("JV", d.id)).status).toBe("Draft");
  });
  test("posting eligibility: maker sees why not, a checker may, another branch gets 404", async () => {
    const d = await draft("acctA1", "APV");
    const mine = await api("get", "acctA1", `/api/posting/eligibility?module=APV&id=${d.id}`);
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ canPost: false, maker: usr.acctA1.username });
    expect(mine.body.reasons.map((x) => x.code)).toEqual(expect.arrayContaining(["POSTING_NOT_PERMITTED", "SELF_POSTING_NOT_ALLOWED"]));
    const checker = await api("get", "adminA", `/api/posting/eligibility?module=APV&id=${d.id}`);
    expect(checker.body).toMatchObject({ canPost: true, reasons: [] });
    const other = await api("get", "acctA2", `/api/posting/eligibility?module=APV&id=${d.id}`);
    expect(other.status).toBe(404);
    const otherCo = await api("get", "adminB", `/api/posting/eligibility?module=APV&id=${d.id}`);
    expect([403, 404]).toContain(otherCo.status);
  });
});

describe("6. duplicate posting is impossible", () => {
  test.each(["JV", "INV", "CV"])("%s: two checkers posting at the same moment -> exactly one succeeds", async (mod) => {
    const d = await draft("acctA1", mod);
    const results = await Promise.all([post("adminA", mod, d), post("adminA2", mod, d), post("super", mod, d)]);
    const codes = results.map((r) => r.status).sort();
    expect(codes.filter((c) => c === 200 || c === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.code === "TRANSACTION_ALREADY_POSTED")).toBe(true);
    const [[{ n }]] = await pool.query("SELECT COUNT(*) n FROM audit_logs WHERE entity_id = ? AND action = 'POST' AND entity_type = ?", [d.id, mod === "INV" ? "INV" : mod]);
    expect(Number(n)).toBeLessThanOrEqual(1);
    expect((await row(mod, d.id)).status).toBe("Posted");
  });

  test("bulk Post All racing a single post -> the document is posted once", async () => {
    const d = await draft("acctA1", "APV");
    const [single, bulk] = await Promise.all([post("adminA", "APV", d), api("post", "adminA2", "/api/posting/post", { companyId: co.A, scope: "ap" })]);
    expect([single.status, bulk.status].every((s) => s === 200 || s === 409)).toBe(true);
    const r = await row("APV", d.id);
    expect(r.status).toBe("Posted");
    expect([usr.adminA.id, usr.adminA2.id]).toContain(r.posted_by);
  });
});

describe("7. bulk posting obeys the same rules (B1 included)", () => {
  test("pending list: an accountant sees only own branches; maker shown; own work flagged", async () => {
    const a1 = await draft("acctA1", "INV");
    const a2 = await draft("acctA2", "INV", { branchId: br.A2 });
    const list = await api("get", "acctA2", `/api/posting/pending?companyId=${co.A}`);
    expect(list.status).toBe(200);
    const vouchers = list.body.map((x) => x.voucherNo);
    expect(vouchers).toContain(a2.body.voucherNo);
    expect(vouchers).not.toContain(a1.body.voucherNo);
    const mine = list.body.find((x) => x.voucherNo === a2.body.voucherNo);
    expect(mine).toMatchObject({ maker: usr.acctA2.username, canPost: false, blockedReason: "OWN_WORK", branchCode: `${P}A2` });
    const noView = await api("get", "acctA1", `/api/posting/pending?companyId=${co.A}`);
    expect(noView.status).toBe(403);
  });

  test("Post All: cross-branch drafts untouched, own drafts skipped, others' drafts posted", async () => {
    const a1 = await draft("acctA1", "CV");
    const a2own = await draft("acctA2", "CV", { branchId: br.A2 });
    const a2other = await draft("adminA", "CV", { branchId: br.A2 });
    const r = await api("post", "acctA2", "/api/posting/post", { companyId: co.A, scope: "ap" });
    expect(r.status).toBe(200);
    expect(r.body.message).toMatch(/skipped because you prepared or last edited them/);
    expect((await row("CV", a1.id)).status).toBe("Draft"); // other branch (B1 fix)
    expect((await row("CV", a2own.id)).status).toBe("Draft"); // own work
    expect(await row("CV", a2other.id)).toMatchObject({ status: "Posted", posted_by: usr.acctA2.id });
  });

  test("Post All refused outright for an accountant without POSTING.POST", async () => {
    const r = await api("post", "acctA1", "/api/posting/post", { companyId: co.A });
    expect(r.status).toBe(403);
  });
});

describe("8. unknown maker", () => {
  test("Draft with no recorded maker: posting and bulk refuse; SUPER_ADMIN records the maker (audited); then a checker posts", async () => {
    const d = await draft("acctA1", "INV");
    await pool.query("UPDATE invoice_headers SET created_by = NULL, updated_by = NULL WHERE id = ?", [d.id]); // simulate a pre-Release-1 Draft
    const r = await post("adminA", "INV", d);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("MAKER_UNKNOWN");
    await api("post", "adminA", "/api/posting/post", { companyId: co.A, scope: "ar" });
    expect((await row("INV", d.id)).status).toBe("Draft");
    const noReason = await api("post", "super", "/api/posting/maker", { module: "INV", id: d.id, makerUserId: usr.acctA1.id, reason: "" });
    expect(noReason.status).toBe(400);
    const notSa = await api("post", "adminA", "/api/posting/maker", { module: "INV", id: d.id, makerUserId: usr.acctA1.id, reason: "Confirmed with the accountant by phone" });
    expect(notSa.status).toBe(403);
    const ok = await api("post", "super", "/api/posting/maker", { module: "INV", id: d.id, makerUserId: usr.acctA1.id, reason: "Confirmed with the accountant by phone" });
    expect(ok.status).toBe(200);
    const [[audit]] = await pool.query("SELECT user_id, description FROM audit_logs WHERE action = 'MAKER_ESTABLISHED' AND entity_id = ? ORDER BY id DESC LIMIT 1", [d.id]);
    expect(audit.user_id).toBe(usr.super.id);
    expect(audit.description).toMatch(/Confirmed with the accountant by phone/);
    const again = await api("post", "super", "/api/posting/maker", { module: "INV", id: d.id, makerUserId: usr.adminA.id, reason: "trying to overwrite the maker" });
    expect(again.status).toBe(409);
    expect((await post("adminA", "INV", d)).status).toBe(200);
  });
});

describe("9. voids and reversals", () => {
  async function postedApv(maker, poster) {
    const d = await draft(maker, "APV");
    const r = await post(poster, "APV", d);
    if (r.status !== 200) throw new Error(`post ${r.status} ${JSON.stringify(r.body)}`);
    return d.id;
  }
  test("the maker cannot void, even with posting rights; an accountant without them cannot either", async () => {
    const id = await postedApv("adminA2", "adminA");
    const byMaker = await api("post", "adminA2", `/api/apv/${id}/void`, { reason: "x" });
    expect(byMaker.status).toBe(403);
    expect(byMaker.body.code).toBe("SELF_REVERSAL_NOT_ALLOWED");
    const id2 = await postedApv("acctA1", "adminA");
    const byAcct = await api("post", "acctA1", `/api/apv/${id2}/void`, { reason: "x" });
    expect(byAcct.status).toBe(403);
    expect(byAcct.body.code).toBe("REVERSAL_NOT_PERMITTED");
    expect((await row("APV", id2)).status).toBe("Posted");
  });
  test("a different authorized user may void (poster rule pending decision: the poster is currently allowed)", async () => {
    const id = await postedApv("acctA1", "adminA");
    const r = await api("post", "adminA", `/api/apv/${id}/void`, { reason: "duplicate bill" });
    expect(r.status).toBe(200);
  });
});

describe("10. B5 - apply-payment checks the CALLER's branch", () => {
  test("an accountant with posting rights cannot settle another branch's APV", async () => {
    const apv = await draft("acctA1", "APV");
    await post("adminA", "APV", apv);
    const cv = await draft("acctA1", "CV");
    const r = await api("post", "acctA2", "/api/apply-payment", { companyId: co.A, appliedType: "CV", appliedId: cv.id, sourceType: "APV", sourceId: apv.id, amount: 10 });
    expect([403, 404]).toContain(r.status);
    const [[{ n }]] = await pool.query("SELECT COUNT(*) n FROM transaction_applications WHERE applied_type = 'CV' AND applied_id = ?", [cv.id]);
    expect(Number(n)).toBe(0);
  });
});

describe("11. D1 - cross-company requests get 403, never 500; no internal detail", () => {
  test("JV / APV details and four reports for another company", async () => {
    const jv = await draft("adminB", "JV", { companyId: co.B, branchId: br.B1 });
    const apvB = await pool.query("INSERT INTO apv_headers (company_id, branch_id, voucher_no, supplier_name, transaction_date, total_debit, total_credit, status) VALUES (?, ?, ?, 'x', ?, 1, 1, 'Draft')", [co.B, br.B1, `${P}APVB`, DATE]);
    const apvId = apvB[0].insertId;
    const range = "from=2097-08-01&to=2097-08-31";
    const calls = [
      [`/api/jv/${jv.id}?companyId=${co.B}`], [`/api/apv/${apvId}?companyId=${co.B}`],
      [`/api/reports/general-ledger?companyId=${co.B}&${range}`], [`/api/reports/income-statement?companyId=${co.B}&${range}`],
      [`/api/reports/balance-sheet?companyId=${co.B}&to=2097-08-31`], [`/api/reports/books/journal?companyId=${co.B}&${range}`],
    ];
    for (const [url] of calls) {
      const r = await api("get", "acctA1", url);
      expect([403, 404]).toContain(r.status);
      expect(r.body.error).toBeUndefined();
      expect(JSON.stringify(r.body)).not.toMatch(/UAT-MCK-APVB|stack|SELECT /i);
    }
  });
  test("a genuine server error answers with a generic message only", () => {
    const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    sendRouteError(res, new Error("ER_BAD_FIELD_ERROR: Unknown column 'secret_col' in SELECT ..."), "X", "Failed to do X");
    spy.mockRestore();
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ message: "Failed to do X" });
  });
});

describe("12. migration 69 backfill - Draft rows only, reliable evidence only", () => {
  test("single CREATE entry -> maker; posted rows untouched; ambiguous or missing evidence -> stays unknown", async () => {
    const mk = async (status, no) => (await pool.query("INSERT INTO jv_headers (company_id, branch_id, voucher_no, transaction_date, total_debit, total_credit, status) VALUES (?, ?, ?, ?, 1, 1, ?)", [co.A, br.A1, `${P}BF-${no}`, DATE, status]))[0].insertId;
    const audit = (id, userId, action = "CREATE") => pool.query("INSERT INTO audit_logs (module, entity_type, entity_id, action, description, user_id, username, company_id) VALUES ('JV', 'JV', ?, ?, ?, ?, 'x', ?)", [id, action, `${P}bf`, userId, co.A]);
    const draftOne = await mk("Draft", 1); await audit(draftOne, usr.acctA1.id); await audit(draftOne, usr.adminA.id, "UPDATE");
    const postedOne = await mk("Posted", 2); await audit(postedOne, usr.acctA1.id);
    const ambiguous = await mk("Draft", 3); await audit(ambiguous, usr.acctA1.id); await audit(ambiguous, usr.adminA.id);
    const noEvidence = await mk("Draft", 4);
    const sql = fs.readFileSync(path.join(__dirname, "..", "migrations", "posting_control_migration.sql"), "utf8");
    // the file has no ';' inside string literals, so a plain split is exact
    const statements = sql.replace(/^\s*--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean);
    for (const st of statements) await pool.query(st); // idempotent; re-running it here is safe
    const get = async (id) => (await pool.query("SELECT created_by, updated_by FROM jv_headers WHERE id = ?", [id]))[0][0];
    expect(await get(draftOne)).toEqual({ created_by: usr.acctA1.id, updated_by: usr.adminA.id });
    expect(await get(postedOne)).toEqual({ created_by: null, updated_by: null });
    expect(await get(ambiguous)).toEqual({ created_by: null, updated_by: null });
    expect(await get(noEvidence)).toEqual({ created_by: null, updated_by: null });
  });
});

describe("13. payment documents with applications post cleanly through the checker", () => {
  test("OR settling a posted invoice, CV settling a posted APV: no false content change; settlement as before", async () => {
    const inv = await draft("acctA1", "INV");
    expect((await post("adminA", "INV", inv)).status).toBe(200);
    const or = await draft("acctA1", "OR", { invoiceApplications: [{ sourceType: "INV", sourceId: inv.id, amount: 100, applicationDate: DATE }] });
    const orPost = await post("adminA", "OR", or);
    expect({ status: orPost.status, code: orPost.body.code }).toEqual({ status: 200, code: undefined });
    const [[invAfter]] = await pool.query("SELECT payment_status, balance_amount FROM invoice_headers WHERE id = ?", [inv.id]);
    expect(Number(invAfter.balance_amount)).toBe(0);

    const apv = await draft("acctA1", "APV");
    expect((await post("adminA", "APV", apv)).status).toBe(200);
    const cv = await draft("acctA1", "CV", { apvApplications: [{ sourceType: "APV", sourceId: apv.id, amount: 100, applicationDate: DATE }] });
    const cvPost = await post("adminA2", "CV", cv);
    expect({ status: cvPost.status, code: cvPost.body.code }).toEqual({ status: 200, code: undefined });
    const [[apvAfter]] = await pool.query("SELECT payment_status, balance_amount FROM apv_headers WHERE id = ?", [apv.id]);
    expect(Number(apvAfter.balance_amount)).toBe(0);
    expect((await row("CV", cv.id))).toMatchObject({ status: "Posted", posted_by: usr.adminA2.id, created_by: usr.acctA1.id });
  });
});

describe("14. an opened PO is no longer the maker's", () => {
  test("after a checker opens it: the maker can neither edit nor delete it", async () => {
    const d = await draft("acctA1", "PO");
    expect((await post("adminA", "PO", d)).status).toBe(200);
    const edit = await api("put", "acctA1", `/api/purchase-orders/${d.id}`, { ...d.body, status: "Draft", description: "sneaky edit" });
    expect(edit.status).toBe(409);
    const del = await api("delete", "acctA1", `/api/purchase-orders/${d.id}?companyId=${co.A}`);
    expect(del.status).toBe(409);
    expect((await row("PO", d.id))).toMatchObject({ status: "Open", description: "UAT-MCK" });
  });
  test("a Draft PO can still be deleted by its maker", async () => {
    const d = await draft("acctA1", "PO");
    expect((await api("delete", "acctA1", `/api/purchase-orders/${d.id}?companyId=${co.A}`)).status).toBe(200);
  });
});

describe("15. legacy storage representation is not mistaken for a content change (validation finding)", () => {
  async function legacyJv(no) {
    // stored the way older code / direct inserts did: NULL text fields, NULL foreign amounts
    const [h] = await pool.query("INSERT INTO jv_headers (company_id, branch_id, voucher_no, transaction_date, description, total_debit, total_credit, status, created_by) VALUES (?, ?, ?, ?, 'legacy', 90, 90, 'Draft', ?)", [co.A, br.A1, `${P}LEG-${no}`, DATE, usr.acctA1.id]);
    await pool.query("INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, ?, ?, 'x', 90, 0), (?, ?, ?, ?, 'x', 0, 90)", [h.insertId, acc.EXP.id, acc.EXP.code, acc.EXP.code, h.insertId, acc.CASH.id, acc.CASH.code, acc.CASH.code]);
    const b = { voucherNo: `${P}LEG-${no}`, transactionDate: DATE, description: "legacy", status: "Posted", lines: [{ ...L("EXP", 90, 0), particulars: "x" }, { ...L("CASH", 0, 90), particulars: "x" }], totalDebit: 90, totalCredit: 90, currency: { companyId: co.A }, branchId: br.A1 };
    return { id: h.insertId, b };
  }
  test("re-saving a NULL-format Draft unchanged posts (NULL = empty text; missing foreign amount = base amount; 90 = 90.00)", async () => {
    const d = await legacyJv(1);
    const r = await api("put", "adminA", `/api/jv/${d.id}`, d.b);
    expect({ status: r.status, code: r.body.code }).toEqual({ status: 200, code: undefined });
    expect((await row("JV", d.id)).status).toBe("Posted");
  });
  test("but a real change is still refused - including filling an empty field with text", async () => {
    const d = await legacyJv(2);
    const withRef = await api("put", "adminA", `/api/jv/${d.id}`, { ...d.b, referenceNo: "NEW-REF" });
    expect(withRef.status).toBe(409);
    expect(withRef.body.code).toBe("POSTING_CONTENT_CHANGED");
    const otherAmount = await api("put", "adminA", `/api/jv/${d.id}`, { ...d.b, lines: [{ ...L("EXP", 95, 0), particulars: "x" }, { ...L("CASH", 0, 95), particulars: "x" }], totalDebit: 95, totalCredit: 95 });
    expect(otherAmount.status).toBe(409);
    expect((await row("JV", d.id)).status).toBe("Draft");
  });
});
