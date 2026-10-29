const pool = require("../db");
const { logAudit } = require("../lib/audit");
const { HttpError } = require("../lib/httpError");
const {
  BANK_RECON_SESSION_SELECT,
  loadCandidatePool,
  statementSetWhere,
  isInStatementSet,
  computeSessionSummary,
} = require("../services/BankMatchingService");
const StatementParser = require("../services/bankStatementParser");
const MatchService = require("../services/bankReconMatchService");
const { beginReadCommitted, lockSession } = MatchService;
const { postAdjustmentAsJV } = require("../services/JournalSuggestionService");
const {
  sessionListFilter,
  resolveCompanyForNewSession,
  assertSessionAccess,
} = require("../services/bankReconAccessService");
const QueueService = require("../services/bankReconQueueService");

// Routes guard every session / child id (bankReconAccessService.requireAccess)
// and leave the owning session on req.reconSession; its company is stamped
// on every Bank Reconciliation audit row.
const auditCompany = (req) => req.reconSession?.companyId ?? null;

function sendHttpError(res, err) {
  if (err instanceof HttpError) {
    res.status(err.statusCode).json({ message: err.message, ...(err.code ? { code: err.code } : {}) });
    return true;
  }
  return false;
}

exports.listSessions = async (req, res) => {
  try {
    const filter = await sessionListFilter(req.user);
    const [rows] = await pool.query(
      `${BANK_RECON_SESSION_SELECT}${filter.sql} ORDER BY s.id DESC`,
      filter.params
    );

    res.json(rows);
  } catch (err) {
    console.error("GET BANK RECON SESSIONS ERROR:", err);
    res.status(500).json({ message: "Failed to load reconciliation sessions" });
  }
};

exports.createSession = async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const {
      bankAccountId,
      periodStart,
      periodEnd,
      statementBeginningBalance,
      statementEndingBalance,
      dateToleranceDays,
      amountVarianceType,
      amountVarianceValue,
      notes,
      companyId: requestedCompanyId,
    } = req.body;

    if (!bankAccountId) {
      return res.status(400).json({ message: "Bank account is required" });
    }
    if (!periodStart || !periodEnd) {
      return res.status(400).json({ message: "Period start and end are required" });
    }
    if (new Date(periodEnd) < new Date(periodStart)) {
      return res.status(400).json({ message: "Period end cannot be before period start" });
    }

    let companyId;
    try {
      companyId = await resolveCompanyForNewSession(req.user, requestedCompanyId);
    } catch (err) {
      if (sendHttpError(res, err)) return;
      throw err;
    }

    const userId = req.user?.id || null;

    await conn.beginTransaction();

    const [result] = await conn.execute(
      `INSERT INTO bank_recon_sessions(
        company_id,
        bank_account_id,
        period_start,
        period_end,
        statement_beginning_balance,
        statement_ending_balance,
        date_tolerance_days,
        amount_variance_type,
        amount_variance_value,
        status,
        notes,
        created_by
      )
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        companyId,
        bankAccountId,
        periodStart,
        periodEnd,
        Number(statementBeginningBalance) || 0,
        Number(statementEndingBalance) || 0,
        Number(dateToleranceDays) || 3,
        amountVarianceType === "PERCENT" ? "PERCENT" : "FIXED",
        Number(amountVarianceValue) || 1.0,
        "IN_PROGRESS",
        notes || "",
        userId,
      ]
    );

    const sessionId = result.insertId;

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "SESSION",
      entityId: sessionId,
      action: "CREATE",
      description: `Reconciliation session #${sessionId} created for bank account ${bankAccountId} (${periodStart} to ${periodEnd})`,
      afterData: { companyId, bankAccountId, periodStart, periodEnd, statementBeginningBalance, statementEndingBalance },
      user: req.user,
      companyId,
    });

    await conn.commit();

    res.json({ success: true, id: sessionId, message: "Reconciliation session created" });
  } catch (err) {
    await conn.rollback();
    console.error("CREATE BANK RECON SESSION ERROR:", err);
    res.status(500).json({ message: "Failed to create reconciliation session" });
  } finally {
    conn.release();
  }
};

exports.getSession = async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await pool.execute(
      `${BANK_RECON_SESSION_SELECT} WHERE s.id = ?`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Reconciliation session not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("GET BANK RECON SESSION ERROR:", err);
    res.status(500).json({ message: "Failed to load reconciliation session" });
  }
};

exports.updateSession = async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    const [existingRows] = await conn.execute(
      "SELECT * FROM bank_recon_sessions WHERE id = ?",
      [id]
    );

    if (existingRows.length === 0) {
      return res.status(404).json({ message: "Reconciliation session not found" });
    }

    const existing = existingRows[0];

    if (existing.status === "FINALIZED") {
      return res.status(400).json({
        message: "Cannot edit a finalized session. Reopen it first.",
      });
    }

    const {
      periodStart,
      periodEnd,
      statementBeginningBalance,
      statementEndingBalance,
      dateToleranceDays,
      amountVarianceType,
      amountVarianceValue,
      notes,
      companyId: assignCompanyId,
    } = req.body;

    // Legacy sessions created before company isolation have no company and
    // are Super-Admin-only; a Super Admin can assign one (once). An owned
    // session's company never changes.
    let assignedCompanyId = null;
    if (assignCompanyId !== undefined && assignCompanyId !== null && assignCompanyId !== "") {
      if (existing.company_id) {
        if (Number(assignCompanyId) !== Number(existing.company_id)) {
          return res.status(400).json({ message: "This reconciliation already belongs to a company." });
        }
      } else if (req.user?.roleCode !== "SUPER_ADMIN") {
        return res.status(404).json({ message: "Reconciliation session not found" });
      } else {
        try {
          assignedCompanyId = await resolveCompanyForNewSession(req.user, assignCompanyId);
        } catch (err) {
          if (sendHttpError(res, err)) return;
          throw err;
        }
      }
    }

    const next = {
      periodStart: periodStart || existing.period_start,
      periodEnd: periodEnd || existing.period_end,
      statementBeginningBalance:
        statementBeginningBalance !== undefined
          ? Number(statementBeginningBalance) || 0
          : existing.statement_beginning_balance,
      statementEndingBalance:
        statementEndingBalance !== undefined
          ? Number(statementEndingBalance) || 0
          : existing.statement_ending_balance,
      dateToleranceDays:
        dateToleranceDays !== undefined
          ? Number(dateToleranceDays) || 0
          : existing.date_tolerance_days,
      amountVarianceType:
        amountVarianceType === "PERCENT" || amountVarianceType === "FIXED"
          ? amountVarianceType
          : existing.amount_variance_type,
      amountVarianceValue:
        amountVarianceValue !== undefined
          ? Number(amountVarianceValue) || 0
          : existing.amount_variance_value,
      notes: notes !== undefined ? notes : existing.notes,
    };

    await conn.beginTransaction();

    await conn.execute(
      `UPDATE bank_recon_sessions SET
        period_start = ?,
        period_end = ?,
        statement_beginning_balance = ?,
        statement_ending_balance = ?,
        date_tolerance_days = ?,
        amount_variance_type = ?,
        amount_variance_value = ?,
        notes = ?,
        company_id = COALESCE(company_id, ?)
      WHERE id = ?`,
      [
        next.periodStart,
        next.periodEnd,
        next.statementBeginningBalance,
        next.statementEndingBalance,
        next.dateToleranceDays,
        next.amountVarianceType,
        next.amountVarianceValue,
        next.notes,
        assignedCompanyId,
        id,
      ]
    );

    // R8.2: a legacy session's imported statement rows take the company the
    // session is assigned. A row whose fingerprint that company + bank
    // account already holds (the same bank line imported elsewhere before
    // R8.2) is kept but loses its fingerprint - the same rule the R8.2
    // migration applied to historical duplicates.
    if (assignedCompanyId) {
      await conn.execute(
        "UPDATE bank_recon_import_batches SET company_id = ? WHERE session_id = ? AND company_id IS NULL",
        [assignedCompanyId, id]
      );
      await conn.execute(
        `UPDATE bank_recon_statement_lines l
         JOIN (SELECT DISTINCT row_fingerprint AS fp FROM bank_recon_statement_lines
               WHERE company_id = ? AND bank_account_id = ? AND row_fingerprint IS NOT NULL) taken ON taken.fp = l.row_fingerprint
         SET l.row_fingerprint = NULL
         WHERE l.session_id = ? AND l.company_id IS NULL`,
        [assignedCompanyId, existing.bank_account_id, id]
      );
      await conn.execute(
        "UPDATE bank_recon_statement_lines SET company_id = ? WHERE session_id = ? AND company_id IS NULL",
        [assignedCompanyId, id]
      );
    }

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "SESSION",
      entityId: Number(id),
      action: "CONFIG_UPDATE",
      description: `Reconciliation session #${id} settings updated`,
      beforeData: existing,
      afterData: assignedCompanyId ? { ...next, companyId: assignedCompanyId } : next,
      user: req.user,
      companyId: assignedCompanyId || auditCompany(req),
    });

    await conn.commit();

    res.json({ success: true, message: "Reconciliation session updated" });
  } catch (err) {
    await conn.rollback();
    console.error("UPDATE BANK RECON SESSION ERROR:", err);
    res.status(500).json({ message: "Failed to update reconciliation session" });
  } finally {
    conn.release();
  }
};

// ---- Statement import (R8.2): Upload -> Detect -> Map -> Preview -> Import ----
// Preview and import run the same deterministic parser
// (bankStatementParser); import re-parses the uploaded file itself and never
// trusts a preview the client sends back. Company and bank account always
// come from the reconciliation session - a request may only repeat them,
// never choose different ones.
async function statementContext(req) {
  const [rows] = await pool.execute(
    `SELECT id, company_id AS companyId, bank_account_id AS bankAccountId, status,
            DATE_FORMAT(period_start, '%Y-%m-%d') AS periodStart, DATE_FORMAT(period_end, '%Y-%m-%d') AS periodEnd
     FROM bank_recon_sessions WHERE id = ?`,
    [req.params.id]
  );
  const session = rows[0];
  if (!session) throw new HttpError(404, "Reconciliation session not found");
  if (session.status === "FINALIZED") throw new HttpError(400, "Cannot import into a finalized session");
  if (!session.companyId) {
    throw new HttpError(400, "This reconciliation session has no company. A Super Admin must assign its company before a statement can be imported.", "STATEMENT_COMPANY_REQUIRED");
  }
  for (const [field, expected] of [["companyId", session.companyId], ["bankAccountId", session.bankAccountId]]) {
    const raw = req.body?.[field];
    if (raw === undefined || raw === null || raw === "") continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${field}.`, "STATEMENT_CONTEXT_INVALID");
    if (n !== Number(expected)) {
      throw new HttpError(400, "A statement can only be imported into this session's own company and bank account.", "STATEMENT_CONTEXT_MISMATCH");
    }
  }
  return session;
}

function statementOptions(req) {
  let columnMapping = null;
  if (req.body?.columnMapping) {
    try {
      columnMapping = JSON.parse(req.body.columnMapping);
    } catch {
      throw new HttpError(400, "The column mapping is not valid.", "STATEMENT_MAPPING_INVALID");
    }
  }
  return { columnMapping, dateFormat: req.body?.dateFormat || "AUTO" };
}

async function parseUpload(req, session) {
  if (!req.file) throw new HttpError(400, "No file uploaded");
  return StatementParser.parseStatement({
    buffer: req.file.buffer,
    originalName: req.file.originalname || "",
    ctx: session,
    ...statementOptions(req),
  });
}

function classifyRows(parsed, existing) {
  return parsed.rows.map((r) => {
    if (!r.valid) return { ...r, status: "INVALID" };
    const prior = existing.get(r.fingerprint);
    return prior ? { ...r, status: "DUPLICATE", duplicateOf: prior } : { ...r, status: "NEW" };
  });
}

function blockingResponse(res, parsed) {
  if (parsed.missingRequired.length) {
    res.status(400).json({
      message: `Map the required column(s): ${parsed.missingRequired.join(", ")}.`,
      code: "STATEMENT_MAPPING_REQUIRED",
      headers: parsed.headers,
      missingRequired: parsed.missingRequired,
    });
    return true;
  }
  if (parsed.blocking.length) {
    const dateOnly = parsed.blocking.every((e) => e.field === "txnDate");
    res.status(400).json({
      message: `${parsed.blocking.length} problem(s) must be fixed before this statement can be imported (first: row ${parsed.blocking[0].row}: ${parsed.blocking[0].message}). Nothing was imported.`,
      code: dateOnly ? "INVALID_STATEMENT_DATES" : "STATEMENT_HAS_BLOCKING_ERRORS",
      dateFormat: parsed.dateFormat,
      blocking: parsed.blocking.slice(0, 50),
      invalidRows: parsed.blocking.slice(0, 20).map((e) => ({ row: e.row, field: e.field, message: e.message })),
    });
    return true;
  }
  return false;
}

const sampleRow = (r) => ({
  row: r.sourceRow,
  status: r.status,
  txnDate: r.txnDate || null,
  valueDate: r.valueDate ?? null,
  description: r.description,
  referenceNo: r.referenceNo,
  checkNo: r.checkNo,
  checkNoNormalized: r.checkNoNormalized,
  bankReference: r.bankReference,
  direction: r.direction || null,
  amount: r.amount || null,
  debit: r.debit || null,
  credit: r.credit || null,
  balance: r.balance ?? null,
  errors: r.errors.map((e) => e.message),
  warnings: r.warnings.map((w) => w.message),
});

// Writes nothing.
exports.previewStatement = async (req, res) => {
  try {
    const session = await statementContext(req);
    const parsed = await parseUpload(req, session);
    const existing = parsed.rows.length ? await StatementParser.existingFingerprints(pool, session) : new Map();
    const rows = classifyRows(parsed, existing);
    const count = (st) => rows.filter((r) => r.status === st).length;
    res.json({
      file: parsed.file,
      session: { id: session.id, companyId: session.companyId, bankAccountId: session.bankAccountId, periodStart: session.periodStart, periodEnd: session.periodEnd },
      dateFormat: parsed.dateFormat,
      detectedColumns: parsed.headers,
      fields: parsed.fields,
      missingRequired: parsed.missingRequired,
      summary: {
        rowsDetected: rows.length,
        valid: rows.length - count("INVALID"),
        invalid: count("INVALID"),
        duplicates: count("DUPLICATE"),
        toImport: count("NEW"),
        blockingErrors: parsed.blocking.length,
        warnings: parsed.warnings.length,
      },
      blockingErrors: parsed.blocking.slice(0, 100),
      warnings: parsed.warnings.slice(0, 100),
      sample: rows.slice(0, 25).map(sampleRow),
      canImport: parsed.missingRequired.length === 0 && parsed.blocking.length === 0 && count("NEW") > 0,
      parserVersion: StatementParser.PARSER_VERSION,
    });
  } catch (err) {
    if (sendHttpError(res, err)) return;
    console.error("PREVIEW BANK STATEMENT ERROR:", err);
    res.status(500).json({ message: "Failed to preview bank statement" });
  }
};

exports.importStatement = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const session = await statementContext(req);
    const parsed = await parseUpload(req, session);
    if (blockingResponse(res, parsed)) return;

    // Session lock + bank-account lock: two imports for the same bank account
    // (in any session) are serialized, so the duplicate check below cannot race.
    await beginReadCommitted(conn);
    await lockSession(conn, session.id);
    await conn.execute("SELECT id FROM bank_codes WHERE id = ? FOR UPDATE", [session.bankAccountId]);

    const existing = await StatementParser.existingFingerprints(conn, session);
    const rows = classifyRows(parsed, existing);
    const fresh = rows.filter((r) => r.status === "NEW");
    const duplicates = rows.filter((r) => r.status === "DUPLICATE");

    if (fresh.length === 0) {
      await conn.rollback();
      const first = duplicates[0]?.duplicateOf;
      return res.status(409).json({
        message: `Every transaction in this statement was already imported for this bank account${first ? ` (reconciliation session #${first.sessionId}, import batch #${first.batchId})` : ""}. Nothing was imported.`,
        code: "DUPLICATE_STATEMENT_IMPORT",
        batchId: first?.batchId ?? null,
        duplicates: duplicates.length,
      });
    }

    const ignored = parsed.warnings.filter((w) => w.row !== null && /^Ignored/.test(w.message));
    const [batchResult] = await conn.execute(
      `INSERT INTO bank_recon_import_batches(
        session_id, company_id, bank_account_id, file_name, file_type, file_sha256,
        row_count, duplicate_count, ignored_count, parser_version, column_mapping, status, imported_by
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        session.id,
        session.companyId,
        session.bankAccountId,
        parsed.file.name,
        parsed.file.type,
        parsed.file.sha256,
        fresh.length,
        duplicates.length,
        ignored.length,
        StatementParser.PARSER_VERSION,
        JSON.stringify({ headers: parsed.headers, mapping: parsed.mapping, dateFormat: parsed.dateFormat }),
        "IMPORTED",
        req.user?.id || null,
      ]
    );
    const batchId = batchResult.insertId;

    // UNIQUE(company_id, bank_account_id, row_fingerprint) is the final
    // duplicate guard: a row that slipped past the check above (concurrent
    // import) fails the whole transaction instead of being stored twice.
    for (const r of fresh) {
      await conn.execute(
        `INSERT INTO bank_recon_statement_lines(
          batch_id, session_id, company_id, bank_account_id, source_row,
          txn_date, value_date, description, reference_no, reference_no_normalized, bank_reference,
          check_no, check_no_normalized, debit, credit, running_balance, row_fingerprint, match_status
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'UNMATCHED')`,
        [
          batchId, session.id, session.companyId, session.bankAccountId, r.sourceRow,
          r.txnDate, r.valueDate ?? null, r.description, r.referenceNo, r.referenceNoNormalized, r.bankReference || null,
          r.checkNo, r.checkNoNormalized, r.debit, r.credit, r.balance, r.fingerprint,
        ]
      );
    }

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "IMPORT_BATCH",
      entityId: batchId,
      action: "IMPORT",
      description: `Imported ${fresh.length} statement line(s) from ${parsed.file.name} into session #${session.id}`,
      afterData: {
        fileName: parsed.file.name,
        fileType: parsed.file.type,
        fileSha256: parsed.file.sha256,
        dateFormat: parsed.dateFormat,
        rowCount: fresh.length,
        duplicatesSkipped: duplicates.length,
        ignoredRows: ignored.length,
        warnings: parsed.warnings.length,
        parserVersion: StatementParser.PARSER_VERSION,
      },
      user: req.user,
      companyId: session.companyId,
    });

    await conn.commit();

    res.json({
      success: true,
      batchId,
      rowCount: fresh.length,
      duplicatesSkipped: duplicates.length,
      skippedRows: ignored.map((w) => ({ row: w.row, reason: w.message })),
      message: `Imported ${fresh.length} statement line(s)${duplicates.length ? `, ${duplicates.length} already-imported transaction(s) skipped` : ""}${ignored.length ? `, ${ignored.length} non-transaction row(s) ignored` : ""}`,
    });
  } catch (err) {
    await conn.rollback();
    const e = asImportConflict(err);
    if (sendHttpError(res, e)) return;
    console.error("IMPORT BANK STATEMENT ERROR:", err);
    // Never the raw database / parser message.
    res.status(500).json({ message: "Failed to import bank statement" });
  } finally {
    conn.release();
  }
};

function asImportConflict(err) {
  if (err && err.code === "ER_DUP_ENTRY" && /uq_stmt_fingerprint/.test(err.sqlMessage || err.message || "")) {
    return new HttpError(409, "Some of these bank transactions were already imported for this bank account. Nothing was imported - preview the statement again.", "DUPLICATE_STATEMENT_IMPORT");
  }
  if (err && (err.code === "ER_LOCK_DEADLOCK" || err.code === "ER_LOCK_WAIT_TIMEOUT")) {
    return new HttpError(409, "Another statement import for this bank account was in progress. Try again.", "RECON_CONCURRENT_CHANGE");
  }
  return err;
}

exports.listImportBatches = async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await pool.execute(
      `SELECT
        id,
        session_id AS sessionId,
        file_name AS fileName,
        file_type AS fileType,
        row_count AS rowCount,
        column_mapping AS columnMapping,
        status,
        imported_by AS importedBy,
        imported_at AS importedAt
      FROM bank_recon_import_batches
      WHERE session_id = ?
      ORDER BY id DESC`,
      [id]
    );

    res.json(rows);
  } catch (err) {
    console.error("GET IMPORT BATCHES ERROR:", err);
    res.status(500).json({ message: "Failed to load import batches" });
  }
};

async function loadSessionRow(id) {
  const [rows] = await pool.execute(`${BANK_RECON_SESSION_SELECT} WHERE s.id = ?`, [id]);
  if (!rows[0]) throw new HttpError(404, "Reconciliation session not found");
  return rows[0];
}

// R8.3: the session's slice of the bank account's statement history - its
// period plus earlier rows still unresolved (carriedForward) - wherever
// they were imported.
exports.listStatementLines = async (req, res) => {
  try {
    const session = await loadSessionRow(req.params.id);
    const set = statementSetWhere(session);

    const [rows] = await pool.execute(
      `SELECT
        sl.id,
        sl.batch_id AS batchId,
        sl.session_id AS importedInSessionId,
        DATE_FORMAT(sl.txn_date, '%Y-%m-%d') AS txnDate,
        sl.description,
        sl.reference_no AS referenceNo,
        sl.check_no AS checkNo,
        sl.debit,
        sl.credit,
        sl.running_balance AS runningBalance,
        sl.match_status AS matchStatus,
        (sl.txn_date < ?) AS carriedForward,
        m.id AS confirmedMatchId
      FROM bank_recon_statement_lines sl
      LEFT JOIN bank_recon_matches m
        ON m.statement_line_id = sl.id AND m.status = 'CONFIRMED'
      WHERE ${set.sql}
      ORDER BY sl.txn_date ASC, sl.id ASC`,
      [session.periodStart, ...set.params]
    );

    res.json(rows);
  } catch (err) {
    console.error("GET STATEMENT LINES ERROR:", err);
    res.status(500).json({ message: "Failed to load statement lines" });
  }
};

exports.deleteImportBatch = async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    const [existing] = await conn.execute(
      "SELECT session_id, file_name, row_count FROM bank_recon_import_batches WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ message: "Import batch not found" });
    }

    const [sessionRows] = await conn.execute(
      "SELECT status FROM bank_recon_sessions WHERE id = ?",
      [existing[0].session_id]
    );

    if (sessionRows[0]?.status === "FINALIZED") {
      return res.status(400).json({ message: "Cannot modify a finalized session" });
    }

    await conn.beginTransaction();

    await conn.execute("DELETE FROM bank_recon_import_batches WHERE id = ?", [id]);

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "IMPORT_BATCH",
      entityId: Number(id),
      action: "DELETE",
      description: `Import batch "${existing[0].file_name}" (${existing[0].row_count} rows) deleted from session #${existing[0].session_id}`,
      beforeData: existing[0],
      user: req.user,
      companyId: auditCompany(req),
    });

    await conn.commit();

    res.json({ success: true, message: "Import batch deleted" });
  } catch (err) {
    await conn.rollback();
    console.error("DELETE IMPORT BATCH ERROR:", err);
    res.status(500).json({ message: "Failed to delete import batch" });
  } finally {
    conn.release();
  }
};

// Matching, candidates and every confirmation path live in
// bankReconMatchService (R8.1) - shared with the AI assistant. These
// handlers only translate HTTP <-> service.
async function respond(res, label, failMessage, fn) {
  try {
    res.json(await fn());
  } catch (err) {
    if (sendHttpError(res, err)) return;
    console.error(label, err);
    res.status(500).json({ message: failMessage });
  }
}

exports.runMatching = (req, res) =>
  respond(res, "RUN MATCHING ERROR:", "Failed to run matching", async () => ({
    success: true,
    ...(await MatchService.runMatching({ sessionId: req.params.id, user: req.user })),
  }));

// R8.3: "what needs my attention" for this session (read-only).
exports.getQueue = (req, res) =>
  respond(res, "GET RECON QUEUE ERROR:", "Failed to load the reconciliation queue", () =>
    QueueService.buildQueue({ sessionId: req.params.id, user: req.user })
  );

exports.getMatchCandidates = (req, res) =>
  respond(res, "GET MATCH CANDIDATES ERROR:", "Failed to load match candidates", async () =>
    (await MatchService.listCandidates({ statementLineId: req.params.id, user: req.user })).candidates
  );

exports.listBookItems = async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    const [sessionRows] = await conn.execute(`${BANK_RECON_SESSION_SELECT} WHERE s.id = ?`, [id]);

    if (sessionRows.length === 0) {
      return res.status(404).json({ message: "Reconciliation session not found" });
    }

    const session = sessionRows[0];

    // R8.3: the session's window plus older never-cleared documents (carry-
    // forward), minus anything reconciled in any session of this company +
    // bank account - the same pool the matching engine scores.
    const bookTxns = await loadCandidatePool(conn, session);
    const [confirmedRows] = await conn.execute(
      `SELECT m.book_source_type AS sourceType, m.book_source_id AS sourceId, m.book_line_id AS lineId
       FROM bank_recon_matches m JOIN bank_recon_sessions s ON s.id = m.session_id
       WHERE m.status = 'CONFIRMED' AND s.bank_account_id = ? AND s.company_id <=> ?`,
      [session.bankAccountId, session.companyId ?? null]
    );
    const confirmedKeys = new Set(
      confirmedRows.map((r) => `${r.sourceType}:${r.sourceId}:${r.lineId ?? ""}`)
    );

    const unmatched = bookTxns
      .filter((t) => !confirmedKeys.has(`${t.sourceType}:${t.sourceId}:${t.lineId ?? ""}`))
      .map((t) => ({ ...t, carriedForward: t.date < session.periodStart }));

    res.json(unmatched);
  } catch (err) {
    console.error("GET BOOK ITEMS ERROR:", err);
    res.status(500).json({ message: "Failed to load book items" });
  } finally {
    conn.release();
  }
};

exports.confirmMatch = (req, res) =>
  respond(res, "CONFIRM MATCH ERROR:", "Failed to confirm match", async () => {
    await MatchService.confirmMatch({ matchId: req.params.id, user: req.user });
    return { success: true, message: "Match confirmed" };
  });

exports.bulkConfirmMatches = (req, res) => {
  if (!req.body.sessionId) return res.status(400).json({ message: "sessionId is required" });
  return respond(res, "BULK CONFIRM MATCHES ERROR:", "Failed to bulk-confirm matches", async () => ({
    success: true,
    ...(await MatchService.bulkConfirmExact({ sessionId: req.body.sessionId, user: req.user })),
  }));
};

exports.createManualMatch = (req, res) =>
  respond(res, "CREATE MANUAL MATCH ERROR:", "Failed to create match", async () => {
    const { statementLineId, bookSourceType, bookSourceId, bookLineId, amount, sessionId } = req.body;
    const result = await MatchService.createManualMatch({
      statementLineId, bookSourceType, bookSourceId, bookLineId, amount, sessionId, user: req.user,
    });
    return { success: true, ...result, message: "Match created" };
  });

exports.unmatch = async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    const [rows] = await conn.execute(
      `SELECT m.*, s.status AS sessionStatus
       FROM bank_recon_matches m
       JOIN bank_recon_sessions s ON s.id = m.session_id
       WHERE m.id = ?`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Match not found" });
    }

    const match = rows[0];

    if (match.sessionStatus === "FINALIZED") {
      return res.status(400).json({ message: "Cannot modify a finalized session" });
    }
    if (match.status !== "CONFIRMED") {
      return res.status(400).json({ message: "Only confirmed matches can be unmatched" });
    }

    const userId = req.user?.id || null;

    await conn.beginTransaction();

    await conn.execute(
      "UPDATE bank_recon_matches SET status = 'REJECTED', unmatched_by = ?, unmatched_at = NOW() WHERE id = ?",
      [userId, id]
    );

    await conn.execute(
      "UPDATE bank_recon_statement_lines SET match_status = 'UNMATCHED' WHERE id = ?",
      [match.statement_line_id]
    );

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "MATCH",
      entityId: Number(id),
      action: "UNMATCH",
      description: `Unmatched statement line #${match.statement_line_id} from ${match.book_source_type} #${match.book_source_id}`,
      beforeData: { status: match.status },
      afterData: { status: "REJECTED" },
      user: req.user,
      companyId: auditCompany(req),
    });

    await conn.commit();

    res.json({ success: true, message: "Match unmatched" });
  } catch (err) {
    await conn.rollback();
    console.error("UNMATCH ERROR:", err);
    res.status(500).json({ message: "Failed to unmatch" });
  } finally {
    conn.release();
  }
};

exports.ignoreStatementLine = async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    const [rows] = await conn.execute(
      `SELECT sl.id, sl.match_status AS matchStatus, s.status AS sessionStatus
       FROM bank_recon_statement_lines sl
       JOIN bank_recon_sessions s ON s.id = sl.session_id
       WHERE sl.id = ?`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Statement line not found" });
    }

    const line = rows[0];

    // R8.3: a row carried into a later session is handled from that session
    // (sessionId) - its own import session may already be finalized.
    if (req.body?.sessionId) {
      try {
        const working = await assertSessionAccess(req.body.sessionId, req.user);
        const session = await loadSessionRow(working.id);
        if (!(await isInStatementSet(conn, session, id))) throw new HttpError(404, "Statement line not found");
        line.sessionStatus = session.status;
        req.reconSession = working;
      } catch (err) {
        if (sendHttpError(res, err)) return;
        throw err;
      }
    }

    if (line.sessionStatus === "FINALIZED") {
      return res.status(400).json({ message: "Cannot modify a finalized session" });
    }
    if (line.matchStatus === "MATCHED") {
      return res
        .status(400)
        .json({ message: "Cannot ignore a matched line - unmatch it first" });
    }

    const nextStatus = line.matchStatus === "IGNORED" ? "UNMATCHED" : "IGNORED";

    await conn.beginTransaction();

    await conn.execute("UPDATE bank_recon_statement_lines SET match_status = ? WHERE id = ?", [
      nextStatus,
      id,
    ]);

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "STATEMENT_LINE",
      entityId: Number(id),
      action: nextStatus === "IGNORED" ? "IGNORE" : "CONFIG_UPDATE",
      description: `Statement line #${id} ${
        nextStatus === "IGNORED" ? "marked as ignored" : "un-ignored"
      }`,
      beforeData: { matchStatus: line.matchStatus },
      afterData: { matchStatus: nextStatus },
      user: req.user,
      companyId: auditCompany(req),
    });

    await conn.commit();

    res.json({
      success: true,
      status: nextStatus,
      message: nextStatus === "IGNORED" ? "Line ignored" : "Line un-ignored",
    });
  } catch (err) {
    await conn.rollback();
    console.error("IGNORE STATEMENT LINE ERROR:", err);
    res.status(500).json({ message: "Failed to update statement line" });
  } finally {
    conn.release();
  }
};

// R8.3: outstanding = not cleared by any session whose period ended on or
// before this one's end - including items carried from earlier periods.
exports.getOutstandingItems = async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const session = await loadSessionRow(req.params.id);
    const summary = await computeSessionSummary(conn, session);
    const mark = (t) => ({ ...t, carriedForward: t.date < session.periodStart });

    res.json({
      outstandingChecks: summary.outstandingChecks.map(mark),
      depositsInTransit: summary.depositsInTransit.map(mark),
    });
  } catch (err) {
    if (sendHttpError(res, err)) return;
    console.error("GET OUTSTANDING ITEMS ERROR:", err);
    res.status(500).json({ message: "Failed to load outstanding items" });
  } finally {
    conn.release();
  }
};

exports.listAdjustments = async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await pool.execute(
      `SELECT
        a.id,
        a.statement_line_id AS statementLineId,
        a.adjustment_type AS adjustmentType,
        a.suggested_account_id AS suggestedAccountId,
        a.amount,
        a.description,
        a.status,
        a.jv_id AS jvId,
        a.created_at AS createdAt,
        a.decided_by AS decidedBy,
        a.decided_at AS decidedAt,
        DATE_FORMAT(sl.txn_date, '%Y-%m-%d') AS txnDate,
        sl.reference_no AS referenceNo,
        sl.check_no AS checkNo
      FROM bank_recon_adjustments a
      JOIN bank_recon_statement_lines sl ON sl.id = a.statement_line_id
      WHERE a.session_id = ?
      ORDER BY a.status = 'PENDING' DESC, sl.txn_date ASC`,
      [id]
    );

    res.json(rows);
  } catch (err) {
    console.error("GET ADJUSTMENTS ERROR:", err);
    res.status(500).json({ message: "Failed to load adjustments" });
  }
};

exports.createAdjustment = async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;
    const { statementLineId, adjustmentType, suggestedAccountId, amount, description } = req.body;

    if (!statementLineId || !adjustmentType) {
      return res.status(400).json({ message: "statementLineId and adjustmentType are required" });
    }
    if (!["BANK_CHARGE", "INTEREST_INCOME", "OTHER"].includes(adjustmentType)) {
      return res.status(400).json({ message: "Invalid adjustmentType" });
    }

    const [sessionRows] = await conn.execute(
      "SELECT status FROM bank_recon_sessions WHERE id = ?",
      [id]
    );
    if (sessionRows.length === 0) {
      return res.status(404).json({ message: "Reconciliation session not found" });
    }
    if (sessionRows[0].status === "FINALIZED") {
      return res.status(400).json({ message: "Cannot modify a finalized session" });
    }

    // R8.3: any row of this session's statement set (history), not only
    // rows imported through it.
    const adjustmentSet = statementSetWhere(await loadSessionRow(id));
    const [lineRows] = await conn.execute(
      `SELECT sl.id FROM bank_recon_statement_lines sl WHERE sl.id = ? AND ${adjustmentSet.sql}`,
      [statementLineId, ...adjustmentSet.params]
    );
    if (lineRows.length === 0) {
      return res.status(404).json({ message: "Statement line not found" });
    }

    await conn.beginTransaction();

    const [result] = await conn.execute(
      `INSERT INTO bank_recon_adjustments(
        session_id, statement_line_id, adjustment_type, suggested_account_id, amount, description, status
      ) VALUES (?,?,?,?,?,?, 'PENDING')`,
      [
        id,
        statementLineId,
        adjustmentType,
        suggestedAccountId || null,
        Number(amount) || 0,
        description || "",
      ]
    );

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "ADJUSTMENT",
      entityId: result.insertId,
      action: "CREATE",
      description: `Adjustment (${adjustmentType}) added for statement line #${statementLineId} in session #${id}`,
      afterData: { adjustmentType, amount, suggestedAccountId },
      user: req.user,
      companyId: auditCompany(req),
    });

    await conn.commit();

    res.json({ success: true, id: result.insertId, message: "Adjustment added" });
  } catch (err) {
    await conn.rollback();
    console.error("CREATE ADJUSTMENT ERROR:", err);
    res.status(500).json({ message: "Failed to add adjustment" });
  } finally {
    conn.release();
  }
};

exports.approveAdjustment = async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;
    const { adjustmentType, suggestedAccountId, amount, description } = req.body;

    const [rows] = await conn.execute(
      `SELECT a.*, s.status AS sessionStatus
       FROM bank_recon_adjustments a
       JOIN bank_recon_sessions s ON s.id = a.session_id
       WHERE a.id = ?`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Adjustment not found" });
    }

    const adj = rows[0];

    if (adj.sessionStatus === "FINALIZED") {
      return res.status(400).json({ message: "Cannot modify a finalized session" });
    }
    if (adj.status !== "PENDING") {
      return res.status(400).json({ message: `Adjustment is already ${adj.status}` });
    }
    if (!suggestedAccountId && !adj.suggested_account_id) {
      return res.status(400).json({ message: "An account must be selected to approve this adjustment" });
    }

    const userId = req.user?.id || null;

    await conn.beginTransaction();

    await conn.execute(
      `UPDATE bank_recon_adjustments SET
        status = 'APPROVED',
        adjustment_type = ?,
        suggested_account_id = ?,
        amount = ?,
        description = ?,
        decided_by = ?,
        decided_at = NOW()
      WHERE id = ?`,
      [
        adjustmentType || adj.adjustment_type,
        suggestedAccountId || adj.suggested_account_id,
        amount !== undefined ? Number(amount) : adj.amount,
        description !== undefined ? description : adj.description,
        userId,
        id,
      ]
    );

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "ADJUSTMENT",
      entityId: Number(id),
      action: "APPROVE_ADJUSTMENT",
      description: `Adjustment #${id} approved`,
      beforeData: { status: adj.status },
      afterData: { status: "APPROVED" },
      user: req.user,
      companyId: auditCompany(req),
    });

    await conn.commit();

    res.json({ success: true, message: "Adjustment approved" });
  } catch (err) {
    await conn.rollback();
    console.error("APPROVE ADJUSTMENT ERROR:", err);
    res.status(500).json({ message: "Failed to approve adjustment" });
  } finally {
    conn.release();
  }
};

exports.rejectAdjustment = async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    const [rows] = await conn.execute(
      `SELECT a.*, s.status AS sessionStatus
       FROM bank_recon_adjustments a
       JOIN bank_recon_sessions s ON s.id = a.session_id
       WHERE a.id = ?`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Adjustment not found" });
    }

    const adj = rows[0];

    if (adj.sessionStatus === "FINALIZED") {
      return res.status(400).json({ message: "Cannot modify a finalized session" });
    }
    if (adj.status !== "PENDING") {
      return res.status(400).json({ message: `Adjustment is already ${adj.status}` });
    }

    const userId = req.user?.id || null;

    await conn.beginTransaction();

    await conn.execute(
      "UPDATE bank_recon_adjustments SET status = 'REJECTED', decided_by = ?, decided_at = NOW() WHERE id = ?",
      [userId, id]
    );

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "ADJUSTMENT",
      entityId: Number(id),
      action: "REJECT_ADJUSTMENT",
      description: `Adjustment #${id} rejected`,
      beforeData: { status: adj.status },
      afterData: { status: "REJECTED" },
      user: req.user,
      companyId: auditCompany(req),
    });

    await conn.commit();

    res.json({ success: true, message: "Adjustment rejected" });
  } catch (err) {
    await conn.rollback();
    console.error("REJECT ADJUSTMENT ERROR:", err);
    res.status(500).json({ message: "Failed to reject adjustment" });
  } finally {
    conn.release();
  }
};

exports.getSessionSummary = async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    const [sessionRows] = await conn.execute(`${BANK_RECON_SESSION_SELECT} WHERE s.id = ?`, [id]);

    if (sessionRows.length === 0) {
      return res.status(404).json({ message: "Reconciliation session not found" });
    }

    const session = sessionRows[0];
    const summary = await computeSessionSummary(conn, session);

    res.json({ status: session.status, ...summary });
  } catch (err) {
    console.error("GET SESSION SUMMARY ERROR:", err);
    res.status(500).json({ message: "Failed to load session summary" });
  } finally {
    conn.release();
  }
};

exports.finalizeSession = async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;
    const { overrideReason } = req.body;

    const [sessionRows] = await conn.execute(`${BANK_RECON_SESSION_SELECT} WHERE s.id = ?`, [id]);

    if (sessionRows.length === 0) {
      return res.status(404).json({ message: "Reconciliation session not found" });
    }

    const session = sessionRows[0];

    if (session.status === "FINALIZED") {
      return res.status(400).json({ message: "Session is already finalized" });
    }

    const summary = await computeSessionSummary(conn, session);

    if (!summary.canFinalizeCleanly && !String(overrideReason || "").trim()) {
      return res.status(400).json({
        message:
          "Cannot finalize: unresolved items remain. Provide an override reason to finalize anyway.",
        difference: summary.difference,
        pendingAdjustmentsCount: summary.pendingAdjustmentsCount,
        unresolvedStatementLinesCount: summary.unresolvedStatementLinesCount,
      });
    }

    const userId = req.user?.id || null;

    await conn.beginTransaction();

    await conn.execute(
      "UPDATE bank_recon_sessions SET status = 'FINALIZED', finalized_by = ?, finalized_at = NOW() WHERE id = ?",
      [userId, id]
    );

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "SESSION",
      entityId: Number(id),
      action: "FINALIZE",
      description: summary.canFinalizeCleanly
        ? `Session #${id} finalized (difference = 0)`
        : `Session #${id} finalized with override: ${overrideReason}`,
      afterData: {
        difference: summary.difference,
        overrideReason: overrideReason || null,
        pendingAdjustmentsCount: summary.pendingAdjustmentsCount,
        unresolvedStatementLinesCount: summary.unresolvedStatementLinesCount,
      },
      user: req.user,
      companyId: auditCompany(req),
    });

    await conn.commit();

    res.json({ success: true, message: "Session finalized" });
  } catch (err) {
    await conn.rollback();
    console.error("FINALIZE SESSION ERROR:", err);
    res.status(500).json({ message: "Failed to finalize session" });
  } finally {
    conn.release();
  }
};

exports.reopenSession = async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!String(reason || "").trim()) {
      return res.status(400).json({ message: "A reason is required to reopen a finalized session" });
    }

    const [sessionRows] = await conn.execute(
      "SELECT status FROM bank_recon_sessions WHERE id = ?",
      [id]
    );

    if (sessionRows.length === 0) {
      return res.status(404).json({ message: "Reconciliation session not found" });
    }
    if (sessionRows[0].status !== "FINALIZED") {
      return res.status(400).json({ message: "Session is not finalized" });
    }

    const userId = req.user?.id || null;

    await conn.beginTransaction();

    await conn.execute(
      "UPDATE bank_recon_sessions SET status = 'IN_PROGRESS', finalized_by = NULL, finalized_at = NULL WHERE id = ?",
      [id]
    );

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "SESSION",
      entityId: Number(id),
      action: "REOPEN",
      description: `Session #${id} reopened: ${reason}`,
      afterData: { reason },
      user: req.user,
      companyId: auditCompany(req),
    });

    await conn.commit();

    res.json({ success: true, message: "Session reopened" });
  } catch (err) {
    await conn.rollback();
    console.error("REOPEN SESSION ERROR:", err);
    res.status(500).json({ message: "Failed to reopen session" });
  } finally {
    conn.release();
  }
};

exports.getSessionAuditLog = async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await pool.execute(
      `SELECT
        id, module, entity_type AS entityType, entity_id AS entityId, action, description,
        before_data AS beforeData, after_data AS afterData, user_id AS userId, username,
        created_at AS createdAt
      FROM audit_logs
      WHERE module = 'BANK_RECON' AND (
        (entity_type = 'SESSION' AND entity_id = ?)
        OR (entity_type = 'IMPORT_BATCH' AND entity_id IN (SELECT id FROM bank_recon_import_batches WHERE session_id = ?))
        OR (entity_type = 'STATEMENT_LINE' AND entity_id IN (SELECT id FROM bank_recon_statement_lines WHERE session_id = ?))
        OR (entity_type = 'MATCH' AND entity_id IN (SELECT id FROM bank_recon_matches WHERE session_id = ?))
        OR (entity_type = 'ADJUSTMENT' AND entity_id IN (SELECT id FROM bank_recon_adjustments WHERE session_id = ?))
      )
      ORDER BY id DESC`,
      [id, id, id, id, id]
    );

    res.json(rows);
  } catch (err) {
    console.error("GET SESSION AUDIT LOG ERROR:", err);
    res.status(500).json({ message: "Failed to load session audit log" });
  }
};

exports.getSessionReport = async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    const [sessionRows] = await conn.execute(`${BANK_RECON_SESSION_SELECT} WHERE s.id = ?`, [id]);

    if (sessionRows.length === 0) {
      return res.status(404).json({ message: "Reconciliation session not found" });
    }

    const session = sessionRows[0];
    const summary = await computeSessionSummary(conn, session);

    const [confirmedMatches] = await conn.execute(
      `SELECT
        m.id, m.book_source_type AS bookSourceType, m.book_source_id AS bookSourceId,
        m.match_type AS matchType, m.confidence_score AS confidenceScore, m.amount,
        DATE_FORMAT(sl.txn_date, '%Y-%m-%d') AS txnDate, sl.description AS statementDescription
      FROM bank_recon_matches m
      JOIN bank_recon_statement_lines sl ON sl.id = m.statement_line_id
      WHERE m.session_id = ? AND m.status = 'CONFIRMED'
      ORDER BY sl.txn_date ASC`,
      [id]
    );

    const [postedAdjustments] = await conn.execute(
      `SELECT
        a.id, a.adjustment_type AS adjustmentType, a.amount, a.description, a.jv_id AS jvId,
        DATE_FORMAT(sl.txn_date, '%Y-%m-%d') AS txnDate
      FROM bank_recon_adjustments a
      JOIN bank_recon_statement_lines sl ON sl.id = a.statement_line_id
      WHERE a.session_id = ? AND a.status = 'POSTED'
      ORDER BY sl.txn_date ASC`,
      [id]
    );

    res.json({
      session: {
        id: session.id,
        bankCode: session.bankCode,
        bankName: session.bankName,
        bankAccountNo: session.bankAccountNo,
        periodStart: session.periodStart,
        periodEnd: session.periodEnd,
        status: session.status,
        finalizedAt: session.finalizedAt,
      },
      summary,
      confirmedMatches,
      postedAdjustments,
    });
  } catch (err) {
    console.error("GET SESSION REPORT ERROR:", err);
    res.status(500).json({ message: "Failed to load session report" });
  } finally {
    conn.release();
  }
};

exports.postAdjustment = async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    await conn.beginTransaction();
    const result = await postAdjustmentAsJV(conn, id, req.user);
    await conn.commit();

    res.json({
      success: true,
      jvId: result.jvId,
      voucherNo: result.voucherNo,
      message: "Adjustment posted as JV",
    });
  } catch (err) {
    await conn.rollback();

    if (err instanceof HttpError) {
      return res.status(err.statusCode).json({ message: err.message, ...(err.code ? { code: err.code } : {}) });
    }

    console.error("POST ADJUSTMENT ERROR:", err);
    res.status(500).json({ message: "Failed to post adjustment" });
  } finally {
    conn.release();
  }
};
