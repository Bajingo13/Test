const pool = require("../db");
const path = require("path");
const { logAudit } = require("../lib/audit");
const { HttpError } = require("../lib/httpError");
const {
  BANK_RECON_SESSION_SELECT,
  loadBookTransactions,
  computeSessionSummary,
} = require("../services/BankMatchingService");
const {
  scoreCandidate,
  classifyAdjustmentSuggestion,
  bookKey,
  classifyLineCandidates,
  markCrossLineAmbiguity,
  isStrictExactRow,
} = require("../services/ConfidenceScoringService");
const {
  resolveColumnMapping,
  buildStatementLine,
  extractRowsFromXlsx,
  parseCsvRows,
  resolveBankDateFormat,
  findDuplicateBatch,
} = require("../services/StatementImportService");
const {
  lockStatementLine,
  lockEligibleBookItem,
  assertMatchAmount,
  statementAmount,
  asConflict,
} = require("../services/bankReconMatchGuard");
const { postAdjustmentAsJV } = require("../services/JournalSuggestionService");
const {
  sessionListFilter,
  resolveCompanyForNewSession,
} = require("../services/bankReconAccessService");

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

exports.importStatement = async (req, res) => {
    const conn = await pool.getConnection();

    try {
      const { id } = req.params;

      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const [sessionRows] = await conn.execute(
        "SELECT id, status FROM bank_recon_sessions WHERE id = ?",
        [id]
      );

      if (sessionRows.length === 0) {
        return res.status(404).json({ message: "Reconciliation session not found" });
      }
      if (sessionRows[0].status === "FINALIZED") {
        return res.status(400).json({ message: "Cannot import into a finalized session" });
      }

      const ext = path.extname(req.file.originalname || "").toLowerCase();
      const fileType = ext === ".csv" ? "CSV" : "XLSX";

      let headers = [];
      let dataRows = [];

      // An unreadable file is the user's input problem (400), not a server
      // fault - and never echoes a parser's internal message.
      try {
        if (fileType === "CSV") {
          const records = parseCsvRows(req.file.buffer);
          headers = records[0] || [];
          dataRows = records.slice(1);
        } else {
          const extracted = await extractRowsFromXlsx(req.file.buffer);
          headers = extracted.headers;
          dataRows = extracted.dataRows;
        }
      } catch {
        return res.status(400).json({
          message: ext === ".xls"
            ? "Legacy Excel 97-2003 (.xls) statements cannot be read yet. Save the statement as .xlsx or .csv and import it again."
            : `The file could not be read as a ${fileType === "CSV" ? "CSV file" : ".xlsx workbook"}.`,
          code: "STATEMENT_FILE_UNREADABLE",
        });
      }

      if (headers.length === 0) {
        return res.status(400).json({ message: "The file appears to be empty" });
      }

      let explicitMapping = null;
      if (req.body.columnMapping) {
        try {
          explicitMapping = JSON.parse(req.body.columnMapping);
        } catch {
          explicitMapping = null;
        }
      }

      const mapping = resolveColumnMapping(headers, explicitMapping);

      if (mapping.date === undefined) {
        return res.status(400).json({
          message: "Could not detect a date column. Please provide columnMapping.",
          headers,
        });
      }
      if (mapping.debit === undefined && mapping.credit === undefined && mapping.amount === undefined) {
        return res.status(400).json({
          message: "Could not detect debit/credit or amount columns. Please provide columnMapping.",
          headers,
        });
      }

      // R7-5: one date format for the whole file - the user's choice, or
      // proven from the file itself; ambiguous / mixed files are refused.
      let dateFormat;
      try {
        dateFormat = resolveBankDateFormat(
          dataRows.map((row) => row[mapping.date]),
          req.body.dateFormat || "AUTO"
        );
      } catch (err) {
        if (sendHttpError(res, err)) return;
        throw err;
      }

      const parsedLines = [];
      const skippedRows = [];
      const invalidDateRows = [];

      dataRows.forEach((row, idx) => {
        const line = buildStatementLine(row, mapping, { dateFormat });
        const hasAmount = Boolean(line.debit || line.credit);

        // A row carrying money with a date that is not a real date is
        // never guessed or skipped silently - the import is refused.
        if (line.dateInvalid && hasAmount) {
          invalidDateRows.push({ row: idx + 2, value: String(line.rawDate ?? "").slice(0, 40) });
          return;
        }
        if (!line.txnDate) {
          skippedRows.push({ row: idx + 2, reason: line.dateBlank ? "Missing date" : "Not a transaction row (no date)" });
          return;
        }
        if (!hasAmount) {
          skippedRows.push({ row: idx + 2, reason: "No debit/credit/amount value" });
          return;
        }

        const { dateBlank, dateInvalid, rawDate, ...stored } = line;
        parsedLines.push(stored);
      });

      if (invalidDateRows.length) {
        return res.status(400).json({
          message: `${invalidDateRows.length} row(s) have a date that is not a valid ${dateFormat} date (e.g. row ${invalidDateRows[0].row}: "${invalidDateRows[0].value}"). Nothing was imported.`,
          code: "INVALID_STATEMENT_DATES",
          dateFormat,
          invalidRows: invalidDateRows.slice(0, 20),
        });
      }

      if (parsedLines.length === 0) {
        return res.status(400).json({
          message: "No valid statement lines could be parsed from the file",
          skippedRows,
        });
      }

      // R7-7: the session row lock serializes two imports into one session,
      // so an identical statement cannot slip in twice.
      await beginReadCommitted(conn);
      await lockSession(conn, id);
      const duplicate = await findDuplicateBatch(conn, id, parsedLines);
      if (duplicate) {
        await conn.rollback();
        return res.status(409).json({
          message: `This statement was already imported into this session (import batch #${duplicate.id}${duplicate.fileName ? `, ${duplicate.fileName}` : ""}). Delete that batch first if you need to import it again.`,
          code: "DUPLICATE_STATEMENT_IMPORT",
          batchId: duplicate.id,
        });
      }

      const [batchResult] = await conn.execute(
        `INSERT INTO bank_recon_import_batches(session_id, file_name, file_type, row_count, column_mapping, status, imported_by)
         VALUES(?,?,?,?,?,?,?)`,
        [
          id,
          req.file.originalname || "",
          fileType,
          parsedLines.length,
          JSON.stringify({ headers, mapping, dateFormat }),
          "IMPORTED",
          req.user?.id || null,
        ]
      );

      const batchId = batchResult.insertId;

      for (const line of parsedLines) {
        await conn.execute(
          `INSERT INTO bank_recon_statement_lines(
            batch_id, session_id, txn_date, description, reference_no, check_no, debit, credit, running_balance, match_status
          ) VALUES(?,?,?,?,?,?,?,?,?, 'UNMATCHED')`,
          [
            batchId,
            id,
            line.txnDate,
            line.description || "",
            line.referenceNo || "",
            line.checkNo || "",
            line.debit || 0,
            line.credit || 0,
            line.runningBalance,
          ]
        );
      }

      await logAudit(conn, {
        module: "BANK_RECON",
        entityType: "IMPORT_BATCH",
        entityId: batchId,
        action: "IMPORT",
        description: `Imported ${parsedLines.length} statement line(s) from ${req.file.originalname} into session #${id}`,
        afterData: {
          fileName: req.file.originalname,
          fileType,
          rowCount: parsedLines.length,
          skippedCount: skippedRows.length,
        },
        user: req.user,
        companyId: auditCompany(req),
      });

      await conn.commit();

      res.json({
        success: true,
        batchId,
        rowCount: parsedLines.length,
        skippedRows,
        message: `Imported ${parsedLines.length} statement line(s)${
          skippedRows.length ? `, ${skippedRows.length} row(s) skipped` : ""
        }`,
      });
    } catch (err) {
      await conn.rollback();
      if (sendHttpError(res, err)) return;
      console.error("IMPORT BANK STATEMENT ERROR:", err);
      // Never the raw database / parser message.
      res.status(500).json({ message: "Failed to import bank statement" });
    } finally {
      conn.release();
    }
  }
;

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

exports.listStatementLines = async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await pool.execute(
      `SELECT
        sl.id,
        sl.batch_id AS batchId,
        DATE_FORMAT(sl.txn_date, '%Y-%m-%d') AS txnDate,
        sl.description,
        sl.reference_no AS referenceNo,
        sl.check_no AS checkNo,
        sl.debit,
        sl.credit,
        sl.running_balance AS runningBalance,
        sl.match_status AS matchStatus,
        m.id AS confirmedMatchId
      FROM bank_recon_statement_lines sl
      LEFT JOIN bank_recon_matches m
        ON m.statement_line_id = sl.id AND m.status = 'CONFIRMED'
      WHERE sl.session_id = ?
      ORDER BY sl.txn_date ASC, sl.id ASC`,
      [id]
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

exports.runMatching = async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    const [sessionRows] = await conn.execute(`${BANK_RECON_SESSION_SELECT} WHERE s.id = ?`, [id]);

    if (sessionRows.length === 0) {
      return res.status(404).json({ message: "Reconciliation session not found" });
    }

    const session = sessionRows[0];

    if (session.status === "FINALIZED") {
      return res.status(400).json({ message: "Cannot run matching on a finalized session" });
    }

    const [stmtLines] = await conn.execute(
      `SELECT id, DATE_FORMAT(txn_date, '%Y-%m-%d') AS txnDate, description,
              reference_no AS referenceNo, check_no AS checkNo, debit, credit
       FROM bank_recon_statement_lines
       WHERE session_id = ? AND match_status IN ('UNMATCHED', 'SUGGESTED')`,
      [id]
    );

    if (stmtLines.length === 0) {
      return res.json({
        success: true,
        processed: 0,
        suggested: 0,
        message: "No unmatched statement lines to process",
      });
    }

    const bookTxns = await loadBookTransactions(
      conn,
      session.bankAccountId,
      session.bankCoaAccountId,
      session.periodStart,
      session.periodEnd,
      session.dateToleranceDays,
      session.companyId
    );

    // R7-3: a document already CONFIRMED in any session of this company and
    // bank account is reconciled - never offered as a candidate again.
    const [confirmedRows] = await conn.execute(
      `SELECT m.book_source_type AS sourceType, m.book_source_id AS sourceId, m.book_line_id AS lineId
       FROM bank_recon_matches m
       JOIN bank_recon_sessions s ON s.id = m.session_id
       WHERE m.status = 'CONFIRMED' AND s.bank_account_id = ? AND s.company_id <=> ?`,
      [session.bankAccountId, session.companyId ?? null]
    );
    const confirmedKeys = new Set(confirmedRows.map(bookKey));

    // R7-4: score every line first, then decide EXACT vs AMBIGUOUS with the
    // whole statement in view (one document EXACT for two lines is
    // ambiguous for both).
    const candidatesByLine = new Map();
    for (const line of stmtLines) {
      const wantDirection = Number(line.debit) > 0 ? "OUT" : "IN";
      const scored = bookTxns
        .filter((t) => t.direction === wantDirection)
        .filter((t) => !confirmedKeys.has(bookKey(t)))
        .map((t) => scoreCandidate(line, t, session))
        .filter((c) => c && c.totalScore >= 30);
      candidatesByLine.set(line.id, classifyLineCandidates(scored, 3));
    }
    markCrossLineAmbiguity(candidatesByLine);

    await conn.beginTransaction();

    let suggestedCount = 0;

    for (const line of stmtLines) {
      await conn.execute(
        "DELETE FROM bank_recon_matches WHERE statement_line_id = ? AND status = 'PENDING'",
        [line.id]
      );

      const candidates = candidatesByLine.get(line.id);

      for (const c of candidates) {
        await conn.execute(
          `INSERT INTO bank_recon_matches(
            session_id, statement_line_id, book_source_type, book_source_id, book_line_id,
            match_type, confidence_score, score_breakdown, status, amount, created_by
          ) VALUES (?,?,?,?,?,?,?,?,'PENDING',?,?)`,
          [
            id,
            line.id,
            c.sourceType,
            c.sourceId,
            c.lineId,
            c.matchType,
            c.totalScore,
            JSON.stringify(c.breakdown),
            c.amount,
            req.user?.id || null,
          ]
        );
      }

      const newStatus = candidates.length > 0 ? "SUGGESTED" : "UNMATCHED";

      await conn.execute("UPDATE bank_recon_statement_lines SET match_status = ? WHERE id = ?", [
        newStatus,
        line.id,
      ]);

      if (newStatus === "SUGGESTED") suggestedCount++;

      // A line with no viable book match either explains itself (bank
      // charge/interest) or needs a human decision (OTHER) - either way it
      // becomes a PENDING adjustment suggestion. Only refresh suggestions
      // still PENDING; once a user has approved/rejected one, leave it be.
      if (newStatus === "UNMATCHED") {
        const [existingAdj] = await conn.execute(
          "SELECT id FROM bank_recon_adjustments WHERE statement_line_id = ? AND status = 'PENDING'",
          [line.id]
        );

        if (existingAdj.length === 0) {
          const [anyAdj] = await conn.execute(
            "SELECT id FROM bank_recon_adjustments WHERE statement_line_id = ?",
            [line.id]
          );

          if (anyAdj.length === 0) {
            const { adjustmentType, amount } = classifyAdjustmentSuggestion(line);

            await conn.execute(
              `INSERT INTO bank_recon_adjustments(
                session_id, statement_line_id, adjustment_type, amount, description, status
              ) VALUES (?,?,?,?,?, 'PENDING')`,
              [id, line.id, adjustmentType, amount, line.description || ""]
            );
          }
        }
      }
    }

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "SESSION",
      entityId: Number(id),
      action: "MATCH",
      description: `Matching engine run on session #${id}: ${stmtLines.length} line(s) processed, ${suggestedCount} with suggestions`,
      afterData: { processed: stmtLines.length, suggested: suggestedCount },
      user: req.user,
      companyId: auditCompany(req),
    });

    await conn.commit();

    res.json({
      success: true,
      processed: stmtLines.length,
      suggested: suggestedCount,
      message: `Processed ${stmtLines.length} statement line(s), ${suggestedCount} with suggested matches`,
    });
  } catch (err) {
    await conn.rollback();
    console.error("RUN MATCHING ERROR:", err);
    res.status(500).json({ message: "Failed to run matching" });
  } finally {
    conn.release();
  }
};

exports.getMatchCandidates = async (req, res) => {
    try {
      const { id } = req.params;

      const [rows] = await pool.execute(
        `SELECT
          m.id,
          m.book_source_type AS bookSourceType,
          m.book_source_id AS bookSourceId,
          m.book_line_id AS bookLineId,
          m.match_type AS matchType,
          m.confidence_score AS confidenceScore,
          m.score_breakdown AS scoreBreakdown,
          m.status,
          m.amount
        FROM bank_recon_matches m
        WHERE m.statement_line_id = ? AND m.status = 'PENDING'
        ORDER BY m.confidence_score DESC`,
        [id]
      );

      const enriched = [];

      for (const row of rows) {
        let detail = null;

        if (row.bookSourceType === "CV") {
          const [d] = await pool.execute(
            `SELECT voucher_no AS voucherNo, payee_name AS payeeName,
                    DATE_FORMAT(transaction_date, '%Y-%m-%d') AS txnDate,
                    reference_no AS referenceNo, check_no AS checkNo, description
             FROM cv_headers WHERE id = ? AND (? IS NULL OR company_id = ?)`,
            [row.bookSourceId, auditCompany(req), auditCompany(req)]
          );
          detail = d[0] || null;
        } else if (row.bookSourceType === "OR") {
          const [d] = await pool.execute(
            `SELECT voucher_no AS voucherNo, customer_name AS customerName,
                    DATE_FORMAT(transaction_date, '%Y-%m-%d') AS txnDate,
                    reference_no AS referenceNo, receipt_no AS receiptNo, check_no AS checkNo, description
             FROM or_headers WHERE id = ? AND (? IS NULL OR company_id = ?)`,
            [row.bookSourceId, auditCompany(req), auditCompany(req)]
          );
          detail = d[0] || null;
        } else if (row.bookSourceType === "JV") {
          const [d] = await pool.execute(
            `SELECT jh.voucher_no AS voucherNo, jh.prepared_for AS preparedFor,
                    DATE_FORMAT(jh.transaction_date, '%Y-%m-%d') AS txnDate,
                    jh.reference_no AS referenceNo, jh.description
             FROM jv_headers jh WHERE jh.id = ? AND (? IS NULL OR jh.company_id = ?)`,
            [row.bookSourceId, auditCompany(req), auditCompany(req)]
          );
          detail = d[0] || null;
        }

        enriched.push({ ...row, detail });
      }

      res.json(enriched);
    } catch (err) {
      console.error("GET MATCH CANDIDATES ERROR:", err);
      res.status(500).json({ message: "Failed to load match candidates" });
    }
  }
;

exports.listBookItems = async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    const [sessionRows] = await conn.execute(`${BANK_RECON_SESSION_SELECT} WHERE s.id = ?`, [id]);

    if (sessionRows.length === 0) {
      return res.status(404).json({ message: "Reconciliation session not found" });
    }

    const session = sessionRows[0];

    const bookTxns = await loadBookTransactions(
      conn,
      session.bankAccountId,
      session.bankCoaAccountId,
      session.periodStart,
      session.periodEnd,
      session.dateToleranceDays,
      session.companyId
    );

    const [confirmedRows] = await conn.execute(
      `SELECT book_source_type AS sourceType, book_source_id AS sourceId, book_line_id AS lineId
       FROM bank_recon_matches
       WHERE session_id = ? AND status = 'CONFIRMED'`,
      [id]
    );
    const confirmedKeys = new Set(
      confirmedRows.map((r) => `${r.sourceType}:${r.sourceId}:${r.lineId ?? ""}`)
    );

    const unmatched = bookTxns.filter(
      (t) => !confirmedKeys.has(`${t.sourceType}:${t.sourceId}:${t.lineId ?? ""}`)
    );

    res.json(unmatched);
  } catch (err) {
    console.error("GET BOOK ITEMS ERROR:", err);
    res.status(500).json({ message: "Failed to load book items" });
  } finally {
    conn.release();
  }
};

// ---- Match confirmation (R7-3 / R7-4 / R7-6) ----
// Every path that turns a statement line MATCHED runs in one transaction
// under READ COMMITTED (each read after a lock wait sees what the other
// request committed) and takes its locks in one fixed order - session,
// statement line, book document - via bankReconMatchGuard.
async function beginReadCommitted(conn) {
  await conn.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
  await conn.beginTransaction();
}

async function lockSession(conn, sessionId) {
  await conn.execute("SELECT id FROM bank_recon_sessions WHERE id = ? FOR UPDATE", [sessionId]);
  const [rows] = await conn.execute(`${BANK_RECON_SESSION_SELECT} WHERE s.id = ?`, [sessionId]);
  if (!rows[0]) throw new HttpError(404, "Reconciliation session not found");
  if (rows[0].status === "FINALIZED") throw new HttpError(400, "Cannot modify a finalized session");
  return rows[0];
}

async function markConfirmed(conn, { matchId, statementLineId, amount, userId }) {
  await conn.execute(
    "UPDATE bank_recon_matches SET status = 'CONFIRMED', matched_by = ?, matched_at = NOW(), amount = ? WHERE id = ?",
    [userId, amount, matchId]
  );
  await conn.execute(
    `UPDATE bank_recon_matches
     SET status = 'REJECTED', unmatched_by = ?, unmatched_at = NOW()
     WHERE statement_line_id = ? AND status = 'PENDING' AND id != ?`,
    [userId, statementLineId, matchId]
  );
  await conn.execute("UPDATE bank_recon_statement_lines SET match_status = 'MATCHED' WHERE id = ?", [statementLineId]);
}

exports.confirmMatch = async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;
    const userId = req.user?.id || null;

    await beginReadCommitted(conn);

    const [rows] = await conn.execute("SELECT session_id AS sessionId FROM bank_recon_matches WHERE id = ?", [id]);
    if (rows.length === 0) throw new HttpError(404, "Match not found");

    const session = await lockSession(conn, rows[0].sessionId);
    const [[match]] = await conn.execute("SELECT * FROM bank_recon_matches WHERE id = ? FOR UPDATE", [id]);
    if (match.status !== "PENDING") {
      throw new HttpError(409, `Match is already ${match.status}`, "MATCH_NOT_PENDING");
    }

    const line = await lockStatementLine(conn, match.statement_line_id);
    const txn = await lockEligibleBookItem(conn, session, line, {
      sourceType: match.book_source_type,
      sourceId: match.book_source_id,
      lineId: match.book_line_id,
    });

    await markConfirmed(conn, { matchId: match.id, statementLineId: line.id, amount: txn.amount, userId });

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "MATCH",
      entityId: Number(id),
      action: "MATCH",
      description: `Confirmed ${match.match_type} match: statement line #${match.statement_line_id} <-> ${match.book_source_type} #${match.book_source_id}`,
      beforeData: { status: match.status },
      afterData: { status: "CONFIRMED", amount: txn.amount },
      user: req.user,
      companyId: auditCompany(req),
    });

    await conn.commit();

    res.json({ success: true, message: "Match confirmed" });
  } catch (err) {
    await conn.rollback();
    const e = asConflict(err);
    if (sendHttpError(res, e)) return;
    console.error("CONFIRM MATCH ERROR:", err);
    res.status(500).json({ message: "Failed to confirm match" });
  } finally {
    conn.release();
  }
};

// Bulk confirmation only accepts suggestions with strict EXACT evidence
// (check number or document number + identical amount) that are the single
// EXACT candidate of their statement line, and each one still goes through
// the same guard as a single confirmation. Anything else is skipped and
// reported, never confirmed.
exports.bulkConfirmMatches = async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ message: "sessionId is required" });
    }

    const userId = req.user?.id || null;

    await beginReadCommitted(conn);
    const session = await lockSession(conn, sessionId);

    const [exactRows] = await conn.execute(
      `SELECT id, statement_line_id AS statementLineId, book_source_type AS sourceType,
              book_source_id AS sourceId, book_line_id AS lineId, match_type AS matchType,
              score_breakdown AS scoreBreakdown
       FROM bank_recon_matches
       WHERE session_id = ? AND status = 'PENDING' AND match_type = 'EXACT'
       ORDER BY id`,
      [sessionId]
    );
    const strictPerLine = new Map();
    for (const m of exactRows) {
      if (isStrictExactRow(m.matchType, m.scoreBreakdown)) {
        strictPerLine.set(m.statementLineId, (strictPerLine.get(m.statementLineId) || 0) + 1);
      }
    }

    let confirmedCount = 0;
    const skipped = [];

    for (const m of exactRows) {
      if (!isStrictExactRow(m.matchType, m.scoreBreakdown)) {
        skipped.push({ matchId: m.id, reason: "Not backed by a check or document number - run matching again and review it." });
        continue;
      }
      if (strictPerLine.get(m.statementLineId) !== 1) {
        skipped.push({ matchId: m.id, reason: "More than one exact candidate for this statement line." });
        continue;
      }
      try {
        const line = await lockStatementLine(conn, m.statementLineId);
        const txn = await lockEligibleBookItem(conn, session, line, m);
        if (Math.round(statementAmount(line) * 100) !== Math.round(txn.amount * 100)) {
          skipped.push({ matchId: m.id, reason: "The amounts are no longer identical." });
          continue;
        }
        await markConfirmed(conn, { matchId: m.id, statementLineId: line.id, amount: txn.amount, userId });
        confirmedCount++;
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        skipped.push({ matchId: m.id, reason: err.message });
      }
    }

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "SESSION",
      entityId: Number(sessionId),
      action: "MATCH",
      description: `Bulk-confirmed ${confirmedCount} exact match(es) in session #${sessionId}${skipped.length ? `, ${skipped.length} skipped` : ""}`,
      afterData: { confirmedCount, skippedCount: skipped.length },
      user: req.user,
      companyId: auditCompany(req),
    });

    await conn.commit();

    res.json({
      success: true,
      confirmedCount,
      skippedCount: skipped.length,
      skipped: skipped.slice(0, 50),
      message: skipped.length
        ? `Confirmed ${confirmedCount} exact match(es). ${skipped.length} left for review.`
        : `Confirmed ${confirmedCount} exact match(es)`,
    });
  } catch (err) {
    await conn.rollback();
    const e = asConflict(err);
    if (sendHttpError(res, e)) return;
    console.error("BULK CONFIRM MATCHES ERROR:", err);
    res.status(500).json({ message: "Failed to bulk-confirm matches" });
  } finally {
    conn.release();
  }
};

// R7-6: the matched amount is the selected document's own bank movement,
// derived on the server. A client "amount" is only checked against it,
// and the statement amount must agree with it within the session variance.
exports.createManualMatch = async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { statementLineId, bookSourceType, bookSourceId, bookLineId, amount } = req.body;

    if (!statementLineId || !bookSourceType || !bookSourceId) {
      return res
        .status(400)
        .json({ message: "statementLineId, bookSourceType, and bookSourceId are required" });
    }
    if (!["CV", "OR", "JV"].includes(bookSourceType)) {
      return res.status(400).json({ message: "Invalid bookSourceType" });
    }
    if (bookSourceType === "JV" && !bookLineId) {
      return res.status(400).json({ message: "Select the journal voucher line that moved through the bank." });
    }

    const userId = req.user?.id || null;

    await beginReadCommitted(conn);

    const [lineRows] = await conn.execute(
      "SELECT session_id AS sessionId FROM bank_recon_statement_lines WHERE id = ?",
      [statementLineId]
    );
    if (lineRows.length === 0) throw new HttpError(404, "Statement line not found");

    const session = await lockSession(conn, lineRows[0].sessionId);
    const line = await lockStatementLine(conn, statementLineId);
    const txn = await lockEligibleBookItem(conn, session, line, {
      sourceType: bookSourceType,
      sourceId: bookSourceId,
      lineId: bookSourceType === "JV" ? bookLineId : null,
    });
    const matchAmount = assertMatchAmount(session, line, txn, amount);

    await conn.execute(
      `UPDATE bank_recon_matches
       SET status = 'REJECTED', unmatched_by = ?, unmatched_at = NOW()
       WHERE statement_line_id = ? AND status = 'PENDING'`,
      [userId, statementLineId]
    );

    const [result] = await conn.execute(
      `INSERT INTO bank_recon_matches(
        session_id, statement_line_id, book_source_type, book_source_id, book_line_id,
        match_type, confidence_score, status, amount, created_by, matched_by, matched_at
      ) VALUES (?,?,?,?,?, 'MANUAL', NULL, 'CONFIRMED', ?, ?, ?, NOW())`,
      [
        session.id,
        statementLineId,
        bookSourceType,
        Number(bookSourceId),
        bookSourceType === "JV" ? Number(bookLineId) : null,
        matchAmount,
        userId,
        userId,
      ]
    );

    await conn.execute(
      "UPDATE bank_recon_statement_lines SET match_status = 'MATCHED' WHERE id = ?",
      [statementLineId]
    );

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "MATCH",
      entityId: result.insertId,
      action: "MATCH",
      description: `Manually matched statement line #${statementLineId} to ${bookSourceType} #${bookSourceId}`,
      afterData: { bookSourceType, bookSourceId, bookLineId, amount: matchAmount },
      user: req.user,
      companyId: auditCompany(req),
    });

    await conn.commit();

    res.json({ success: true, id: result.insertId, amount: matchAmount, message: "Match created" });
  } catch (err) {
    await conn.rollback();
    const e = asConflict(err);
    if (sendHttpError(res, e)) return;
    console.error("CREATE MANUAL MATCH ERROR:", err);
    res.status(500).json({ message: "Failed to create match" });
  } finally {
    conn.release();
  }
};

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

exports.getOutstandingItems = async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    const [sessionRows] = await conn.execute(`${BANK_RECON_SESSION_SELECT} WHERE s.id = ?`, [id]);

    if (sessionRows.length === 0) {
      return res.status(404).json({ message: "Reconciliation session not found" });
    }

    const session = sessionRows[0];

    const bookTxns = await loadBookTransactions(
      conn,
      session.bankAccountId,
      session.bankCoaAccountId,
      session.periodStart,
      session.periodEnd,
      session.dateToleranceDays,
      session.companyId
    );

    const [confirmedRows] = await conn.execute(
      `SELECT book_source_type AS sourceType, book_source_id AS sourceId, book_line_id AS lineId
       FROM bank_recon_matches
       WHERE session_id = ? AND status = 'CONFIRMED'`,
      [id]
    );
    const confirmedKeys = new Set(
      confirmedRows.map((r) => `${r.sourceType}:${r.sourceId}:${r.lineId ?? ""}`)
    );

    const unmatched = bookTxns.filter(
      (t) =>
        !confirmedKeys.has(`${t.sourceType}:${t.sourceId}:${t.lineId ?? ""}`) &&
        t.date <= session.periodEnd
    );

    res.json({
      outstandingChecks: unmatched.filter((t) => t.direction === "OUT"),
      depositsInTransit: unmatched.filter((t) => t.direction === "IN"),
    });
  } catch (err) {
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

    const [lineRows] = await conn.execute(
      "SELECT id FROM bank_recon_statement_lines WHERE id = ? AND session_id = ?",
      [statementLineId, id]
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
