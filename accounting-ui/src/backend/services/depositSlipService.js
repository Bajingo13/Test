const pool = require("../db");
const { HttpError } = require("../lib/httpError");
const { logAudit } = require("../lib/audit");
const { loadBookItems } = require("./BankMatchingService");
const { resolveCompanyForNewSession, canSeeCompany } = require("./bankReconAccessService");
const { round2, bookKey } = require("./ConfidenceScoringService");

// R10 deposit slips: which posted OR / CV bank items went to the bank
// together, under one company-unique number (DS-00001), so Bank
// Reconciliation can match the statement deposit to the slip directly.
//
// A slip only GROUPS documents Bank Reconciliation already treats as money
// in on that bank account (BankMatchingService book items). It never posts
// a journal, never creates a bank transaction and never changes an OR / CV.
// A receipt booked only to cash on hand (no bank account) is not a bank item
// and is not eligible - recording that deposit needs a deposit journal, an
// accounting decision outside R10.
//
// Eligible document (deterministic, re-checked under lock on every write):
//   posted OR / CV of the slip's company, on the slip's bank account, whose
//   bank movement is money IN; payment method Cash or Check (a Bank Transfer
//   already went through the bank); in the company's base currency; dated
//   on or before the deposit date; not reconciled (no CONFIRMED match in a
//   reconciliation of the same company + bank account); not in another
//   active slip. Whole documents only - partial deposits are not supported.
//
// Status: DRAFT (editable) -> DEPOSITED (fixed, matchable) -> RECONCILED
// (set by Bank Reconciliation when its match is confirmed); DRAFT or
// DEPOSITED -> CANCELLED (lines released, kept for history).
//
// Company: an explicit, permitted company or the user's only company (the
// same resolver Bank Reconciliation sessions use). Bank account: must exist
// and be ACTIVE - bank accounts have no company owner yet
// (BANK-OWNERSHIP-01).

const STATUS = Object.freeze({ DRAFT: "DRAFT", DEPOSITED: "DEPOSITED", RECONCILED: "RECONCILED", CANCELLED: "CANCELLED" });
const DEPOSITABLE_METHODS = ["Cash", "Check"];
const PAGE_SIZE = 25;

const present = (v) => v !== undefined && v !== null && v !== "";
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
  && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const toId = (v, label) => {
  const s = String(v ?? "").trim();
  if (!/^[1-9][0-9]{0,9}$/.test(s)) throw new HttpError(400, `Invalid ${label}.`, "INVALID_ID");
  return Number(s);
};
const cents = (n) => Math.round(Number(n) * 100);

async function bankAccount(conn, bankAccountId) {
  const [[bank]] = await conn.execute(
    "SELECT id, bank_code AS bankCode, bank_name AS bankName, account_no AS accountNo, coa_account_id AS coaAccountId, status FROM bank_codes WHERE id = ?",
    [bankAccountId]
  );
  if (!bank) throw new HttpError(404, "Bank account not found.", "BANK_ACCOUNT_NOT_FOUND");
  return bank;
}

function assertActiveBank(bank) {
  if (String(bank.status || "").toUpperCase() !== "ACTIVE") throw new HttpError(400, "The selected bank account is not active.", "BANK_ACCOUNT_INACTIVE");
}

async function baseCurrencyId(conn, companyId) {
  const [[cur]] = await conn.execute("SELECT id FROM currencies WHERE company_id = ? AND is_base_currency = 1 ORDER BY id LIMIT 1", [companyId]);
  return cur ? cur.id : null;
}

// The slip, if the user may see its company; otherwise the same 404 as a
// missing slip.
async function loadSlip(conn, slipId, user, { lock = false } = {}) {
  const id = toId(slipId, "deposit slip");
  const [[slip]] = await conn.execute(
    `SELECT s.id, s.company_id AS companyId, c.name AS companyName, s.bank_account_id AS bankAccountId,
            bc.bank_code AS bankCode, bc.bank_name AS bankName, bc.account_no AS bankAccountNo, s.deposit_no AS depositNo,
            DATE_FORMAT(s.deposit_date, '%Y-%m-%d') AS depositDate, s.currency_id AS currencyId, s.total_amount AS totalAmount,
            s.status, s.remarks, s.reconciled_match_group AS reconciledMatchGroup,
            DATE_FORMAT(s.created_at, '%Y-%m-%d %H:%i:%s') AS createdAt, cu.username AS createdBy,
            DATE_FORMAT(s.deposited_at, '%Y-%m-%d %H:%i:%s') AS depositedAt, du.username AS depositedBy,
            DATE_FORMAT(s.cancelled_at, '%Y-%m-%d %H:%i:%s') AS cancelledAt, xu.username AS cancelledBy, s.cancel_reason AS cancelReason
     FROM deposit_slips s
     JOIN companies c ON c.id = s.company_id
     JOIN bank_codes bc ON bc.id = s.bank_account_id
     LEFT JOIN users cu ON cu.id = s.created_by
     LEFT JOIN users du ON du.id = s.deposited_by
     LEFT JOIN users xu ON xu.id = s.cancelled_by
     WHERE s.id = ?${lock ? " FOR UPDATE" : ""}`,
    [id]
  );
  if (!slip || !(await canSeeCompany(user, slip.companyId))) throw new HttpError(404, "Deposit slip not found");
  return { ...slip, totalAmount: Number(slip.totalAmount) };
}

// Active lines of a slip with their documents.
async function slipLines(conn, slipId, { includeReleased = false } = {}) {
  const [rows] = await conn.execute(
    `SELECT l.id, l.source_type AS sourceType, COALESCE(l.or_id, l.cv_id) AS sourceId, l.amount, l.payment_method AS paymentMethod,
            DATE_FORMAT(l.released_at, '%Y-%m-%d %H:%i:%s') AS releasedAt,
            COALESCE(o.voucher_no, c.voucher_no) AS voucherNo, COALESCE(o.customer_name, c.payee_name) AS partyName,
            DATE_FORMAT(COALESCE(o.transaction_date, c.transaction_date), '%Y-%m-%d') AS txnDate,
            COALESCE(o.check_no, c.check_no) AS checkNo, o.receipt_no AS receiptNo, COALESCE(o.status, c.status) AS docStatus
     FROM deposit_slip_lines l
     LEFT JOIN or_headers o ON o.id = l.or_id
     LEFT JOIN cv_headers c ON c.id = l.cv_id
     WHERE l.deposit_slip_id = ?${includeReleased ? "" : " AND l.released_at IS NULL"}
     ORDER BY l.id`,
    [slipId]
  );
  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}

// Eligible documents for a slip of this company + bank account dated
// `depositDate`; `slipId` = the slip being edited (its own lines stay
// eligible). Returns book items keyed "OR:12:" / "CV:7:".
async function eligibleDocuments(conn, { companyId, bankAccountId, depositDate, slipId = null }) {
  const bank = await bankAccount(conn, bankAccountId);
  const base = await baseCurrencyId(conn, companyId);
  const items = await loadBookItems(
    conn,
    { companyId, bankAccountId, bankCoaAccountId: bank.coaAccountId },
    { toDate: depositDate, excludeCleared: true }
  );
  const [taken] = await conn.execute(
    `SELECT l.source_type AS sourceType, COALESCE(l.or_id, l.cv_id) AS sourceId, s.deposit_no AS depositNo
     FROM deposit_slip_lines l JOIN deposit_slips s ON s.id = l.deposit_slip_id
     WHERE l.released_at IS NULL AND s.company_id = ? AND s.id <> ?`,
    [companyId, slipId || 0]
  );
  const inOtherSlip = new Map(taken.map((t) => [`${t.sourceType}:${t.sourceId}:`, t.depositNo]));
  const eligible = new Map();
  for (const t of items) {
    if (!["OR", "CV"].includes(t.sourceType) || t.direction !== "IN") continue;
    if (!DEPOSITABLE_METHODS.includes(t.paymentMethod)) continue;
    if (t.foreignCurrency || (base && t.currencyId && Number(t.currencyId) !== Number(base))) continue;
    if (inOtherSlip.has(bookKey(t))) continue;
    eligible.set(bookKey(t), t);
  }
  return { eligible, inOtherSlip, bank, base };
}

const presentEligible = (t) => ({
  sourceType: t.sourceType,
  sourceId: t.sourceId,
  voucherNo: t.voucherNo,
  txnDate: t.date,
  partyName: t.payeeOrCustomer,
  paymentMethod: t.paymentMethod,
  checkNo: t.checkNo || null,
  amount: t.amount,
});

function parseItems(items) {
  if (!Array.isArray(items)) throw new HttpError(400, "Select the receipts to deposit.", "DEPOSIT_ITEMS_REQUIRED");
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const type = String(it?.type || it?.sourceType || "").toUpperCase();
    if (!["OR", "CV"].includes(type)) throw new HttpError(400, "Each selected document must be an OR or a CV.", "INVALID_DEPOSIT_ITEM");
    const id = toId(it.id ?? it.sourceId, `${type} id`);
    const key = `${type}:${id}:`;
    if (seen.has(key)) throw new HttpError(400, `${type} #${id} is selected twice.`, "DUPLICATE_DEPOSIT_ITEM");
    seen.add(key);
    out.push({ type, id, key });
  }
  return out;
}

function parseSlipInput(body, { requireBank }) {
  const out = {};
  if (requireBank) out.bankAccountId = toId(body.bankAccountId, "bank account");
  if (!isDate(body.depositDate)) throw new HttpError(400, "Deposit date must be a valid date (YYYY-MM-DD).", "INVALID_DEPOSIT_DATE");
  out.depositDate = body.depositDate;
  if (present(body.remarks) && (typeof body.remarks !== "string" || body.remarks.length > 500)) {
    throw new HttpError(400, "Remarks must be text of at most 500 characters.", "INVALID_REMARKS");
  }
  out.remarks = present(body.remarks) ? body.remarks.trim() : null;
  out.items = parseItems(body.items ?? []);
  return out;
}

// Locks the selected documents (fixed order) and returns them resolved
// against the eligible set - any that is not eligible is a 409 naming why.
async function lockAndResolve(conn, items, ctx) {
  for (const it of [...items].sort((a, b) => a.type.localeCompare(b.type) || a.id - b.id)) {
    const [[doc]] = await conn.execute(`SELECT id, company_id FROM ${it.type === "OR" ? "or_headers" : "cv_headers"} WHERE id = ? FOR UPDATE`, [it.id]);
    if (!doc || Number(doc.company_id) !== Number(ctx.companyId)) {
      throw new HttpError(404, `${it.type} #${it.id} not found.`, "DEPOSIT_ITEM_NOT_FOUND");
    }
  }
  const { eligible, inOtherSlip, bank, base } = await eligibleDocuments(conn, ctx);
  const resolved = [];
  for (const it of items) {
    const t = eligible.get(it.key);
    if (!t) {
      const other = inOtherSlip.get(it.key);
      throw new HttpError(
        409,
        other
          ? `${it.type} #${it.id} is already in deposit slip ${other}.`
          : `${it.type} #${it.id} cannot be deposited on this slip: it must be a posted Cash or Check document of this company, received into this bank account on or before the deposit date, in the base currency and not yet reconciled.`,
        other ? "DEPOSIT_ITEM_ALREADY_DEPOSITED" : "DEPOSIT_ITEM_NOT_ELIGIBLE"
      );
    }
    resolved.push(t);
  }
  return { resolved, bank, base };
}

function translateDuplicate(err) {
  if (err && err.code === "ER_DUP_ENTRY") {
    if (/uq_deposit_line_active_(or|cv)/.test(err.message)) {
      return new HttpError(409, "One of the selected documents was just added to another deposit slip. Refresh and try again.", "DEPOSIT_ITEM_ALREADY_DEPOSITED");
    }
    if (/uq_deposit_slip_company_no/.test(err.message)) {
      return new HttpError(409, "Another deposit slip took this number at the same moment. Try again.", "DEPOSIT_NO_CONFLICT");
    }
  }
  if (err && (err.code === "ER_LOCK_DEADLOCK" || err.code === "ER_LOCK_WAIT_TIMEOUT")) {
    return new HttpError(409, "Another deposit slip change was in progress. Refresh and try again.", "DEPOSIT_CONCURRENT_CHANGE");
  }
  return err;
}

async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw translateDuplicate(err);
  } finally {
    conn.release();
  }
}

// Next DS-<5 digits> for the company. Called with the company row locked, so
// two slips of one company are numbered one after the other; the UNIQUE
// (company_id, deposit_no) index is the backstop.
async function nextDepositNo(conn, companyId) {
  const [[row]] = await conn.execute(
    `SELECT MAX(CAST(SUBSTRING(deposit_no, 4) AS UNSIGNED)) AS n FROM deposit_slips
     WHERE company_id = ? AND deposit_no REGEXP '^DS-[0-9]+$'`,
    [companyId]
  );
  return `DS-${String((Number(row.n) || 0) + 1).padStart(5, "0")}`;
}

const auditLines = (lines) => lines.map((l) => ({ sourceType: l.sourceType, sourceId: l.sourceId, voucherNo: l.voucherNo, amount: l.amount, paymentMethod: l.paymentMethod }));

async function writeLines(conn, slipId, resolved) {
  for (const t of resolved) {
    await conn.execute(
      "INSERT INTO deposit_slip_lines (deposit_slip_id, source_type, or_id, cv_id, amount, payment_method) VALUES (?, ?, ?, ?, ?, ?)",
      [slipId, t.sourceType, t.sourceType === "OR" ? t.sourceId : null, t.sourceType === "CV" ? t.sourceId : null, t.amount, t.paymentMethod]
    );
  }
  const totalCents = resolved.reduce((s, t) => s + cents(t.amount), 0);
  await conn.execute("UPDATE deposit_slips SET total_amount = ? WHERE id = ?", [totalCents / 100, slipId]);
  return totalCents / 100;
}

async function createSlip({ user, body }) {
  const input = parseSlipInput(body, { requireBank: true });
  const companyId = await resolveCompanyForNewSession(user, body.companyId);
  return withTransaction(async (conn) => {
    await conn.execute("SELECT id FROM companies WHERE id = ? FOR UPDATE", [companyId]);
    const bank = await bankAccount(conn, input.bankAccountId);
    assertActiveBank(bank);
    const ctx = { companyId, bankAccountId: input.bankAccountId, depositDate: input.depositDate };
    const { resolved, base } = await lockAndResolve(conn, input.items, ctx);
    const depositNo = await nextDepositNo(conn, companyId);
    const [ins] = await conn.execute(
      "INSERT INTO deposit_slips (company_id, bank_account_id, deposit_no, deposit_date, currency_id, status, remarks, created_by) VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?)",
      [companyId, input.bankAccountId, depositNo, input.depositDate, base, input.remarks, user.id]
    );
    const total = await writeLines(conn, ins.insertId, resolved);
    await logAudit(conn, {
      module: "BANK_RECON", entityType: "DEPOSIT_SLIP", entityId: ins.insertId, companyId, action: "CREATE",
      description: `Deposit slip ${depositNo} created (${resolved.length} document(s), total ${total.toFixed(2)})`,
      afterData: { depositNo, status: STATUS.DRAFT, bankAccountId: input.bankAccountId, depositDate: input.depositDate, total, lines: auditLines(resolved.map(presentLine)) },
      user,
    });
    return { id: ins.insertId, depositNo, status: STATUS.DRAFT, total };
  });
}

const presentLine = (t) => ({ sourceType: t.sourceType, sourceId: t.sourceId, voucherNo: t.voucherNo, amount: t.amount, paymentMethod: t.paymentMethod });

async function updateSlip({ user, slipId, body }) {
  const input = parseSlipInput(body, { requireBank: false });
  return withTransaction(async (conn) => {
    const slip = await loadSlip(conn, slipId, user, { lock: true });
    if (slip.status !== STATUS.DRAFT) throw new HttpError(409, `Deposit slip ${slip.depositNo} is ${slip.status} and can no longer be edited.`, "DEPOSIT_SLIP_NOT_EDITABLE");
    const before = await slipLines(conn, slip.id);
    const ctx = { companyId: slip.companyId, bankAccountId: slip.bankAccountId, depositDate: input.depositDate, slipId: slip.id };
    assertActiveBank(await bankAccount(conn, slip.bankAccountId));
    const { resolved } = await lockAndResolve(conn, input.items, ctx);
    await conn.execute("DELETE FROM deposit_slip_lines WHERE deposit_slip_id = ? AND released_at IS NULL", [slip.id]);
    await conn.execute("UPDATE deposit_slips SET deposit_date = ?, remarks = ? WHERE id = ?", [input.depositDate, input.remarks, slip.id]);
    const total = await writeLines(conn, slip.id, resolved);
    await logAudit(conn, {
      module: "BANK_RECON", entityType: "DEPOSIT_SLIP", entityId: slip.id, companyId: slip.companyId, action: "EDIT",
      description: `Deposit slip ${slip.depositNo} edited (${resolved.length} document(s), total ${total.toFixed(2)})`,
      beforeData: { depositDate: slip.depositDate, total: slip.totalAmount, lines: auditLines(before) },
      afterData: { depositDate: input.depositDate, total, lines: auditLines(resolved.map(presentLine)) },
      user,
    });
    return { id: slip.id, depositNo: slip.depositNo, status: STATUS.DRAFT, total };
  });
}

// DRAFT -> DEPOSITED: every line re-checked (still eligible, same amount).
async function markDeposited({ user, slipId }) {
  return withTransaction(async (conn) => {
    const slip = await loadSlip(conn, slipId, user, { lock: true });
    if (slip.status !== STATUS.DRAFT) throw new HttpError(409, `Deposit slip ${slip.depositNo} is ${slip.status}.`, "DEPOSIT_SLIP_NOT_DRAFT");
    const lines = await slipLines(conn, slip.id);
    if (!lines.length) throw new HttpError(400, "Add at least one receipt before marking the slip deposited.", "DEPOSIT_SLIP_EMPTY");
    const ctx = { companyId: slip.companyId, bankAccountId: slip.bankAccountId, depositDate: slip.depositDate, slipId: slip.id };
    assertActiveBank(await bankAccount(conn, slip.bankAccountId));
    const { resolved } = await lockAndResolve(conn, lines.map((l) => ({ type: l.sourceType, id: l.sourceId, key: `${l.sourceType}:${l.sourceId}:` })), ctx);
    for (const t of resolved) {
      const line = lines.find((l) => l.sourceType === t.sourceType && Number(l.sourceId) === Number(t.sourceId));
      if (cents(line.amount) !== cents(t.amount)) {
        throw new HttpError(409, `${t.sourceType} ${t.voucherNo} now moves ${t.amount.toFixed(2)} through the bank, not ${line.amount.toFixed(2)} - edit the slip first.`, "DEPOSIT_ITEM_CHANGED");
      }
    }
    await conn.execute("UPDATE deposit_slips SET status = 'DEPOSITED', deposited_by = ?, deposited_at = NOW() WHERE id = ?", [user.id, slip.id]);
    await logAudit(conn, {
      module: "BANK_RECON", entityType: "DEPOSIT_SLIP", entityId: slip.id, companyId: slip.companyId, action: "DEPOSIT",
      description: `Deposit slip ${slip.depositNo} marked deposited (${lines.length} document(s), total ${slip.totalAmount.toFixed(2)})`,
      beforeData: { status: STATUS.DRAFT },
      afterData: { status: STATUS.DEPOSITED, total: slip.totalAmount, lines: auditLines(lines) },
      user,
    });
    return { id: slip.id, depositNo: slip.depositNo, status: STATUS.DEPOSITED, total: slip.totalAmount };
  });
}

// DRAFT / DEPOSITED -> CANCELLED; its documents are released for another slip.
async function cancelSlip({ user, slipId, reason }) {
  if (!present(reason) || typeof reason !== "string" || !reason.trim() || reason.length > 255) {
    throw new HttpError(400, "Enter a reason (at most 255 characters) to cancel the deposit slip.", "CANCEL_REASON_REQUIRED");
  }
  return withTransaction(async (conn) => {
    const slip = await loadSlip(conn, slipId, user, { lock: true });
    if (slip.status === STATUS.RECONCILED) {
      throw new HttpError(409, `Deposit slip ${slip.depositNo} is reconciled - unmatch it in Bank Reconciliation before cancelling.`, "DEPOSIT_SLIP_RECONCILED");
    }
    if (slip.status === STATUS.CANCELLED) throw new HttpError(409, `Deposit slip ${slip.depositNo} is already cancelled.`, "DEPOSIT_SLIP_CANCELLED");
    const lines = await slipLines(conn, slip.id);
    await conn.execute("UPDATE deposit_slip_lines SET released_at = NOW() WHERE deposit_slip_id = ? AND released_at IS NULL", [slip.id]);
    await conn.execute(
      "UPDATE deposit_slips SET status = 'CANCELLED', cancelled_by = ?, cancelled_at = NOW(), cancel_reason = ? WHERE id = ?",
      [user.id, reason.trim(), slip.id]
    );
    await logAudit(conn, {
      module: "BANK_RECON", entityType: "DEPOSIT_SLIP", entityId: slip.id, companyId: slip.companyId, action: "CANCEL",
      description: `Deposit slip ${slip.depositNo} cancelled: ${reason.trim()}`,
      beforeData: { status: slip.status, total: slip.totalAmount, lines: auditLines(lines) },
      afterData: { status: STATUS.CANCELLED, reason: reason.trim() },
      user,
    });
    return { id: slip.id, depositNo: slip.depositNo, status: STATUS.CANCELLED };
  });
}

// Bank Reconciliation status of a slip: the confirmed statement match.
async function reconciliationOf(conn, slip) {
  if (!slip.reconciledMatchGroup) return null;
  const [[m]] = await conn.execute(
    `SELECT m.session_id AS sessionId, m.statement_line_id AS statementLineId, DATE_FORMAT(sl.txn_date, '%Y-%m-%d') AS statementDate,
            sl.credit AS bankAmount, sl.description AS statementDescription, sl.reference_no AS statementReference,
            DATE_FORMAT(m.matched_at, '%Y-%m-%d %H:%i:%s') AS matchedAt, u.username AS confirmedBy, m.score_breakdown AS breakdown
     FROM bank_recon_matches m
     JOIN bank_recon_statement_lines sl ON sl.id = m.statement_line_id
     LEFT JOIN users u ON u.id = m.matched_by
     WHERE m.match_group = ? AND m.status = 'CONFIRMED' ORDER BY m.id LIMIT 1`,
    [slip.reconciledMatchGroup]
  );
  if (!m) return null;
  const b = typeof m.breakdown === "string" ? JSON.parse(m.breakdown) : m.breakdown;
  const { explainDepositSlip } = require("./bankReconMatchService");
  return {
    sessionId: m.sessionId,
    statementLineId: m.statementLineId,
    statementDate: m.statementDate,
    bankAmount: Number(m.bankAmount),
    statementDescription: m.statementDescription,
    statementReference: m.statementReference,
    matchedAt: m.matchedAt,
    confirmedBy: m.confirmedBy,
    evidence: b?.evidence || null,
    explanation: explainDepositSlip("EXACT", b, { credit: m.bankAmount }),
  };
}

async function slipDetail({ user, slipId }) {
  const conn = await pool.getConnection();
  try {
    const slip = await loadSlip(conn, slipId, user);
    const lines = await slipLines(conn, slip.id, { includeReleased: slip.status === STATUS.CANCELLED });
    return {
      ...slip,
      reconciledMatchGroup: undefined,
      editable: slip.status === STATUS.DRAFT,
      lines,
      bankRecon: { status: slip.status === STATUS.RECONCILED ? "MATCHED" : "NOT_MATCHED", match: await reconciliationOf(conn, slip) },
    };
  } finally {
    conn.release();
  }
}

async function listSlips({ user, query }) {
  const companyId = await resolveCompanyForNewSession(user, query.companyId);
  const where = ["s.company_id = ?"];
  const params = [companyId];
  if (present(query.bankAccountId)) {
    where.push("s.bank_account_id = ?");
    params.push(toId(query.bankAccountId, "bank account"));
  }
  if (present(query.status)) {
    const st = String(query.status).toUpperCase();
    if (st === "UNRECONCILED") where.push("s.status = 'DEPOSITED'");
    else if (STATUS[st]) {
      where.push("s.status = ?");
      params.push(st);
    } else throw new HttpError(400, "Unknown deposit slip status.", "INVALID_STATUS");
  }
  for (const [k, op] of [["from", ">="], ["to", "<="]]) {
    if (present(query[k])) {
      if (!isDate(query[k])) throw new HttpError(400, `${k} must be a YYYY-MM-DD date.`, "INVALID_DATE");
      where.push(`s.deposit_date ${op} ?`);
      params.push(query[k]);
    }
  }
  if (present(query.q)) {
    where.push("s.deposit_no LIKE ?");
    params.push(`%${String(query.q).trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  const page = present(query.page) ? toId(query.page, "page") : 1;
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM deposit_slips s WHERE ${where.join(" AND ")}`, params);
  const [rows] = await pool.query(
    `SELECT s.id, s.deposit_no AS depositNo, DATE_FORMAT(s.deposit_date, '%Y-%m-%d') AS depositDate, s.status,
            s.total_amount AS totalAmount, s.bank_account_id AS bankAccountId, bc.bank_code AS bankCode, bc.bank_name AS bankName,
            (SELECT COUNT(*) FROM deposit_slip_lines l WHERE l.deposit_slip_id = s.id AND l.released_at IS NULL) AS lineCount,
            (SELECT DATE_FORMAT(MAX(sl.txn_date), '%Y-%m-%d') FROM bank_recon_statement_lines sl
             WHERE sl.company_id = s.company_id AND sl.bank_account_id = s.bank_account_id) AS statementCoveredTo
     FROM deposit_slips s JOIN bank_codes bc ON bc.id = s.bank_account_id
     WHERE ${where.join(" AND ")}
     ORDER BY s.deposit_date DESC, s.id DESC LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, (page - 1) * PAGE_SIZE]
  );
  return {
    companyId,
    page,
    pageSize: PAGE_SIZE,
    total: Number(total),
    pageCount: Math.max(1, Math.ceil(Number(total) / PAGE_SIZE)),
    rows: rows.map((r) => ({
      ...r,
      totalAmount: Number(r.totalAmount),
      lineCount: Number(r.lineCount),
      // A deposited slip dated on or before the last imported statement row
      // of its bank account that is still not reconciled.
      missingFromStatement: r.status === STATUS.DEPOSITED && Boolean(r.statementCoveredTo) && r.depositDate <= r.statementCoveredTo,
    })),
  };
}

async function listEligible({ user, query }) {
  const companyId = await resolveCompanyForNewSession(user, query.companyId);
  const bankAccountId = toId(query.bankAccountId, "bank account");
  if (!isDate(query.depositDate)) throw new HttpError(400, "Deposit date must be a valid date (YYYY-MM-DD).", "INVALID_DEPOSIT_DATE");
  let slipId = null;
  if (present(query.slipId)) {
    const slip = await loadSlip(pool, query.slipId, user);
    if (Number(slip.companyId) !== Number(companyId) || Number(slip.bankAccountId) !== bankAccountId) throw new HttpError(404, "Deposit slip not found");
    slipId = slip.id;
  }
  const conn = await pool.getConnection();
  try {
    const { eligible } = await eligibleDocuments(conn, { companyId, bankAccountId, depositDate: query.depositDate, slipId });
    const rows = [...eligible.values()].map(presentEligible).sort((a, b) => a.txnDate.localeCompare(b.txnDate) || a.sourceType.localeCompare(b.sourceType) || a.sourceId - b.sourceId);
    return { companyId, bankAccountId, depositDate: query.depositDate, rows };
  } finally {
    conn.release();
  }
}

module.exports = {
  STATUS,
  createSlip,
  updateSlip,
  markDeposited,
  cancelSlip,
  slipDetail,
  listSlips,
  listEligible,
  slipLines,
};
