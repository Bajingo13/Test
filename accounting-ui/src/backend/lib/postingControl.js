// Maker-Checker Release 1 - mandatory posting authorization and separation of
// duties for the eight transaction modules (JV, APV, Invoice, OR, CV,
// Debit/Credit Memo, Petty Cash, Purchase Order).
//
// Rules (enforced on the server, never trusted from the browser):
//   1. A transaction is CREATED as Draft only. Creating it directly as Posted
//      (or a Purchase Order as Open) is refused for everyone - that would be
//      the creator posting their own work.
//   2. POSTING (Draft -> Posted, PO Draft -> Open) needs POSTING.POST (ADMIN;
//      SUPER_ADMIN by the existing bypass; ACCOUNTANT no longer has it), the
//      usual company + branch authority (the routes' existing checks), a KNOWN
//      maker (created_by), and a poster who is neither the creator nor the
//      last editor - whatever their role.
//   3. Posting never changes content: the header, lines, payment applications
//      and currency snapshot are fingerprinted under a row lock before the
//      route's own update and again just before commit; any difference rolls
//      the request back (409 POSTING_CONTENT_CHANGED). Corrections are saved
//      as Draft (making that user the last editor) and posted by someone else.
//   4. No duplicate posting: the header row is locked (SELECT ... FOR UPDATE)
//      and its stored status re-read under the lock, so a second concurrent
//      post waits and then gets 409 TRANSACTION_ALREADY_POSTED.
//   5. Void / reverse of a posted APV or CV needs POSTING.POST and a reverser
//      who is not the original creator (see assertCanReverse for the
//      poster rule, which is reported as a pending policy decision).
// Who did what is recorded in created_by / updated_by / posted_by / posted_at
// (migration 69); unknown makers stay NULL and block posting until established
// by the audited SUPER_ADMIN-only POST /api/posting/maker.
//
// Test-only switch: the separation-of-duties checks (1, 2 except locking, 3,
// 5) are skipped ONLY when NODE_ENV === "test" AND POSTING_SOD_TEST_BYPASS ===
// "1" (set for the legacy suites by jest's setup file, which post directly).
// It can never apply in production or development. Locking, duplicate
// protection, metadata stamping, branch isolation and the D1 fixes are never
// switchable.
const crypto = require("crypto");
const pool = require("../db");
const { HttpError } = require("./httpError");
const PermissionService = require("../services/permissionService");
const { logAudit } = require("./audit");

const upper = (s) => String(s || "").toUpperCase();

const MODULES = {
  INV: { table: "invoice_headers", lines: ["invoice_lines", "invoice_id"], snapshot: "INV", entityTypes: ["INV"] },
  OR: { table: "or_headers", lines: ["or_lines", "or_id"], snapshot: "OR", applied: "OR", entityTypes: ["OR"] },
  APV: { table: "apv_headers", lines: ["apv_lines", "apv_id"], snapshot: "APV", entityTypes: ["APV"] },
  CV: { table: "cv_headers", lines: ["cv_lines", "cv_id"], snapshot: "CV", applied: "CV", entityTypes: ["CV"] },
  JV: { table: "jv_headers", lines: ["jv_lines", "jv_id"], entityTypes: ["JV"] },
  MEMO: { table: "memo_headers", lines: ["memo_lines", "memo_id"], entityTypes: ["MEMO_DEBIT", "MEMO_CREDIT"] },
  PCV: { table: "petty_cash_headers", lines: ["petty_cash_lines", "petty_cash_id"], entityTypes: ["PETTY_CASH"] },
  PO: { table: "purchase_order_headers", lines: ["purchase_order_lines", "po_id"], entityTypes: ["PO"], postedWhenNotDraft: true },
};
const TABLE_TO_MODULE = Object.fromEntries(Object.entries(MODULES).map(([k, m]) => [m.table, k]));

// Header columns that are posting bookkeeping, not content.
const HEADER_NON_CONTENT = new Set([
  "id", "status", "created_at", "updated_at", "created_by", "updated_by", "posted_by", "posted_at",
  "paid_amount", "balance_amount", "payment_status", "foreign_paid_amount", "foreign_balance_amount",
  "verification_token", "verification_signature",
]);
const LINE_NON_CONTENT = new Set(["id", "created_at", "updated_at"]);
const SNAPSHOT_CONTENT = ["currency_code", "exchange_rate", "rate_date", "override_rate", "foreign_subtotal", "foreign_tax", "foreign_ewt", "foreign_total", "base_subtotal", "base_tax", "base_ewt", "base_total"];

function sodEnforced() {
  return !(process.env.NODE_ENV === "test" && process.env.POSTING_SOD_TEST_BYPASS === "1");
}

function moduleOf(key) {
  const m = MODULES[key];
  if (!m) throw new Error(`postingControl: unknown module ${key}`);
  return m;
}

function isPostingStatus(key, status) {
  const m = moduleOf(key);
  if (m.postedWhenNotDraft) return status !== undefined && status !== null && upper(status) !== "DRAFT";
  return upper(status) === "POSTED";
}

// ---- content fingerprint -------------------------------------------------
// Business content, not storage representation (Release 1 validation finding):
// a Draft stored by older code (or another path) may hold NULL where today's
// save writes "" (reference_no, remarks, gen_ref, ...), "90" where it writes
// "90.00", or NULL foreign amounts on a base-currency line where it writes the
// base amount. Re-saving such a Draft unchanged must not count as a content
// change. Every real change - a different amount, date, account, party,
// reference, description, a non-empty text change - still differs.
const NUMERIC_RE = /^-?\d+(\.\d+)?$/;
function stable(value) {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  const s = String(value);
  return NUMERIC_RE.test(s) ? String(Number(s)) : s;
}
// A missing foreign amount means "same as the base amount" (pre-FX rows).
function withForeignDefaults(line) {
  const l = { ...line };
  if ("foreign_debit" in l && (l.foreign_debit === null || l.foreign_debit === undefined)) l.foreign_debit = l.debit;
  if ("foreign_credit" in l && (l.foreign_credit === null || l.foreign_credit === undefined)) l.foreign_credit = l.credit;
  return l;
}

async function fingerprint(conn, key, id) {
  const m = moduleOf(key);
  const parts = [];
  const [[header]] = await conn.query(`SELECT * FROM ${m.table} WHERE id = ?`, [id]);
  if (!header) return null;
  // A missing currency means the company's base currency (pre-currency rows).
  if ("currency_id" in header && (header.currency_id === null || header.currency_id === undefined)) {
    const [[base]] = await conn.query("SELECT id FROM currencies WHERE company_id = ? AND is_base_currency = 1 ORDER BY id LIMIT 1", [header.company_id]);
    if (base) header.currency_id = base.id;
  }
  parts.push(Object.keys(header).filter((c) => !HEADER_NON_CONTENT.has(c)).sort().map((c) => [c, stable(header[c])]));
  const [lines] = await conn.query(`SELECT * FROM ${m.lines[0]} WHERE ${m.lines[1]} = ? ORDER BY id`, [id]);
  parts.push(lines.map(withForeignDefaults).map((l) => Object.keys(l).filter((c) => !LINE_NON_CONTENT.has(c)).sort().map((c) => [c, stable(l[c])])));
  if (m.applied) {
    const [apps] = await conn.query(
      "SELECT source_type, source_id, amount, foreign_amount_applied FROM transaction_applications WHERE applied_type = ? AND applied_id = ? ORDER BY source_type, source_id, id",
      [m.applied, id]
    );
    parts.push(apps.map((a) => [a.source_type, stable(a.source_id), stable(a.amount), stable(a.foreign_amount_applied ?? a.amount)]));
  }
  if (m.snapshot) {
    const [snap] = await conn.query(
      `SELECT ${SNAPSHOT_CONTENT.join(", ")} FROM transaction_currency_snapshots WHERE transaction_type = ? AND transaction_id = ?`,
      [m.snapshot, id]
    );
    parts.push(snap.map((s) => SNAPSHOT_CONTENT.map((c) => stable(s[c]))));
  }
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

// ---- creation ------------------------------------------------------------
// Called with the status the route is about to store.
function assertDraftOnCreate(key, finalStatus) {
  if (!sodEnforced()) return;
  if (isPostingStatus(key, finalStatus)) {
    throw new HttpError(
      403,
      "New transactions are saved as Draft. Another authorized user posts them after review.",
      "POSTING_ON_CREATE_NOT_ALLOWED"
    );
  }
}

// Records the maker of a newly inserted transaction (inside the route's transaction).
async function recordCreated(conn, key, id, user) {
  const m = moduleOf(key);
  if (!id) return;
  const userId = user && user.id ? Number(user.id) : null;
  await conn.query(
    `UPDATE ${m.table} SET created_by = COALESCE(created_by, ?), updated_by = ? WHERE id = ?`,
    [userId, userId, id]
  );
}

// ---- posting authority ----------------------------------------------------
// Reasons a given user may not post a given (locked or unlocked) header row.
async function postingBlockers(user, row) {
  const reasons = [];
  if (!(await PermissionService.can(user.id, "POSTING", "POST"))) {
    reasons.push({ code: "POSTING_NOT_PERMITTED", status: 403, message: "You are not authorized to post transactions." });
  }
  if (row.created_by === null || row.created_by === undefined) {
    reasons.push({
      code: "MAKER_UNKNOWN", status: 409,
      message: "This transaction's maker is not recorded, so it cannot be posted until a Super Admin establishes the maker.",
    });
  } else {
    const lastEditor = row.updated_by === null || row.updated_by === undefined ? row.created_by : row.updated_by;
    if (Number(row.created_by) === Number(user.id) || Number(lastEditor) === Number(user.id)) {
      reasons.push({
        code: "SELF_POSTING_NOT_ALLOWED", status: 403,
        message: "You prepared or last edited this transaction, so another authorized user must post it.",
      });
    }
  }
  return reasons;
}

// Starts the guarded part of an edit (call right after the route's own
// stored-status check, inside its transaction). Locks the header row.
async function beginEdit(conn, { module: key, id, user, finalStatus }) {
  const m = moduleOf(key);
  const enforced = sodEnforced();
  const [rows] = await conn.query(
    `SELECT id, status, created_by, updated_by FROM ${m.table} WHERE id = ? FOR UPDATE`,
    [id]
  );
  const row = rows[0];
  const gate = { key, id, user, enforced, isPosting: false, before: null, row };
  if (!row) return { ...gate, finish: async () => {} };

  const storedPosted = isPostingStatus(key, row.status);
  // Duplicate / late posting: re-checked under the lock (the route's own check
  // ran before the lock and may have read a stale status).
  if (storedPosted && (enforced || !m.postedWhenNotDraft)) {
    throw new HttpError(
      409,
      m.postedWhenNotDraft ? "This purchase order is no longer a Draft and cannot be edited." : "Posted transactions cannot be edited.",
      "TRANSACTION_ALREADY_POSTED"
    );
  }
  gate.isPosting = !storedPosted && isPostingStatus(key, finalStatus);

  if (gate.isPosting && enforced) {
    const blockers = await postingBlockers(user, row);
    if (blockers.length) {
      const b = blockers[0];
      throw new HttpError(b.status, b.message, b.code);
    }
    gate.before = await fingerprint(conn, key, id);
  }

  gate.finish = async (c = conn) => {
    if (gate.isPosting) {
      if (enforced) {
        const after = await fingerprint(c, key, id);
        if (after !== gate.before) {
          throw new HttpError(
            409,
            "Posting cannot change the transaction. Save the correction as Draft first; another authorized user then posts it.",
            "POSTING_CONTENT_CHANGED"
          );
        }
      }
      await c.query(`UPDATE ${m.table} SET posted_by = ?, posted_at = COALESCE(posted_at, NOW()) WHERE id = ?`, [user.id, id]);
    } else {
      await c.query(`UPDATE ${m.table} SET updated_by = ? WHERE id = ?`, [user.id, id]);
    }
  };
  return gate;
}

// ---- reversal / void --------------------------------------------------------
// Pending policy decision (reported): also refusing the ORIGINAL POSTER blocks
// every reversal when only one other authorized user exists. Kept switchable
// until the decision is made; the creator rule is always enforced.
const REQUIRE_REVERSER_NOT_POSTER = false;

async function assertCanReverse(conn, { module: key, id, user }) {
  if (!sodEnforced()) return;
  const m = moduleOf(key);
  if (!(await PermissionService.can(user.id, "POSTING", "POST"))) {
    throw new HttpError(403, "You are not authorized to void or reverse posted transactions.", "REVERSAL_NOT_PERMITTED");
  }
  const [[row]] = await conn.query(`SELECT created_by, posted_by FROM ${m.table} WHERE id = ?`, [id]);
  if (!row) return; // the route answers 404 itself
  if (row.created_by === null || row.created_by === undefined) {
    throw new HttpError(409, "This transaction's maker is not recorded, so it cannot be voided or reversed until a Super Admin establishes the maker.", "MAKER_UNKNOWN");
  }
  if (Number(row.created_by) === Number(user.id)) {
    throw new HttpError(403, "You prepared this transaction, so another authorized user must void or reverse it.", "SELF_REVERSAL_NOT_ALLOWED");
  }
  if (REQUIRE_REVERSER_NOT_POSTER && row.posted_by !== null && Number(row.posted_by) === Number(user.id)) {
    throw new HttpError(403, "You posted this transaction, so another authorized user must void or reverse it.", "SELF_REVERSAL_NOT_ALLOWED");
  }
}

// ---- read helpers for the UI ---------------------------------------------
async function eligibility(user, key, id, db = pool) {
  const m = moduleOf(key);
  const [[row]] = await db.query(
    `SELECT h.id, h.status, h.created_by, h.updated_by, h.posted_by, h.posted_at,
            cu.username AS created_by_username, uu.username AS updated_by_username, pu.username AS posted_by_username
       FROM ${m.table} h
       LEFT JOIN users cu ON cu.id = h.created_by
       LEFT JOIN users uu ON uu.id = h.updated_by
       LEFT JOIN users pu ON pu.id = h.posted_by
      WHERE h.id = ?`,
    [id]
  );
  if (!row) return null;
  const posted = isPostingStatus(key, row.status);
  const blockers = posted ? [] : sodEnforced() ? await postingBlockers(user, row) : [];
  return {
    module: key,
    id: row.id,
    status: row.status,
    maker: row.created_by_username || null,
    lastEditor: row.updated_by_username || row.created_by_username || null,
    postedBy: row.posted_by_username || null,
    posted,
    canPost: !posted && blockers.length === 0,
    reasons: blockers.map((b) => ({ code: b.code, message: b.message })),
  };
}

// SUPER_ADMIN-only, audited: record the maker of a Draft whose maker is unknown.
async function establishMaker({ actingUser, module: key, id, makerUserId, reason, meta = {} }) {
  const m = moduleOf(key);
  if (!reason || String(reason).trim().length < 10) {
    throw new HttpError(400, "A reason of at least 10 characters is required.", "REASON_REQUIRED");
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[row]] = await conn.query(`SELECT id, company_id, status, created_by FROM ${m.table} WHERE id = ? FOR UPDATE`, [id]);
    if (!row) throw new HttpError(404, "Transaction not found.", "NOT_FOUND");
    if (isPostingStatus(key, row.status)) throw new HttpError(409, "Only a Draft's maker can be established.", "TRANSACTION_ALREADY_POSTED");
    if (row.created_by !== null) throw new HttpError(409, "This transaction's maker is already recorded.", "MAKER_ALREADY_KNOWN");
    const [[maker]] = await conn.query(
      `SELECT u.id, u.username FROM users u
        WHERE u.id = ? AND u.status = 'ACTIVE'
          AND (EXISTS (SELECT 1 FROM user_companies uc WHERE uc.user_id = u.id AND uc.company_id = ?)
               OR EXISTS (SELECT 1 FROM roles r WHERE r.id = u.role_id AND r.code = 'SUPER_ADMIN'))`,
      [makerUserId, row.company_id]
    );
    if (!maker) throw new HttpError(400, "The maker must be an active user of this company.", "MAKER_INVALID");
    await conn.query(`UPDATE ${m.table} SET created_by = ?, updated_by = COALESCE(updated_by, ?) WHERE id = ? AND created_by IS NULL`, [maker.id, maker.id, id]);
    await logAudit(conn, {
      module: "POSTING_CONTROL", entityType: m.entityTypes[0], entityId: Number(id), companyId: row.company_id,
      action: "MAKER_ESTABLISHED",
      description: `${actingUser.username} recorded ${maker.username} as the maker of ${key} #${id}: ${String(reason).trim()}`,
      afterData: { makerUserId: maker.id, reason: String(reason).trim() },
      user: actingUser, ...meta,
    });
    await conn.commit();
    return { id: Number(id), maker: maker.username };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  MODULES,
  TABLE_TO_MODULE,
  REQUIRE_REVERSER_NOT_POSTER,
  sodEnforced,
  isPostingStatus,
  fingerprint,
  assertDraftOnCreate,
  recordCreated,
  postingBlockers,
  beginEdit,
  assertCanReverse,
  eligibility,
  establishMaker,
};
