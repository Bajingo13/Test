const { logAudit } = require("../lib/audit");
const { HttpError } = require("../lib/httpError");

// Only APPROVED adjustments (with an account already picked) can post, and
// only once - the adjustment moves straight to POSTED, never back to
// PENDING/APPROVED, so there is no double-post path. Caller owns the
// transaction lifecycle (beginTransaction/commit/rollback) around this call.
async function postAdjustmentAsJV(conn, adjustmentId, user) {
  const [rows] = await conn.execute(
    `SELECT a.*, sl.debit AS lineDebit, sl.credit AS lineCredit,
            sl.reference_no AS lineReferenceNo, sl.check_no AS lineCheckNo,
            DATE_FORMAT(sl.txn_date, '%Y-%m-%d') AS txnDate,
            s.status AS sessionStatus, s.bank_account_id AS bankAccountId
     FROM bank_recon_adjustments a
     JOIN bank_recon_statement_lines sl ON sl.id = a.statement_line_id
     JOIN bank_recon_sessions s ON s.id = a.session_id
     WHERE a.id = ?`,
    [adjustmentId]
  );

  if (rows.length === 0) {
    throw new HttpError(404, "Adjustment not found");
  }

  const adj = rows[0];

  if (adj.sessionStatus === "FINALIZED") {
    throw new HttpError(400, "Cannot modify a finalized session");
  }
  if (adj.status !== "APPROVED") {
    throw new HttpError(
      400,
      `Adjustment must be APPROVED before posting (currently ${adj.status})`
    );
  }
  if (!adj.suggested_account_id) {
    throw new HttpError(400, "Adjustment has no account assigned");
  }

  const [bankRows] = await conn.execute(
    "SELECT coa_account_id AS coaAccountId, coa_code AS coaCode, bank_name AS bankName FROM bank_codes WHERE id = ?",
    [adj.bankAccountId]
  );

  if (bankRows.length === 0 || !bankRows[0].coaAccountId) {
    throw new HttpError(400, "Bank account has no linked Chart of Accounts entry");
  }

  const bank = bankRows[0];

  const [accountRows] = await conn.execute(
    "SELECT code, title FROM chart_of_accounts WHERE id = ?",
    [adj.suggested_account_id]
  );

  if (accountRows.length === 0) {
    throw new HttpError(400, "Selected account not found");
  }

  const account = accountRows[0];
  const isMoneyOut = Number(adj.lineDebit) > 0;
  const amount = Number(adj.amount);
  const userId = user?.id || null;
  const voucherNo = `JV-BR-${adj.session_id}-${adj.id}`;

  const [jvResult] = await conn.execute(
    `INSERT INTO jv_headers(
      voucher_no, transaction_date, reference_no, prepared_for, description,
      total_debit, total_credit, status, source_module, source_reference_id,
      created_by, posted_by, posted_at
    ) VALUES (?,?,?,?,?,?,?, 'Posted', 'BANK_RECON', ?, ?, ?, NOW())`,
    [
      voucherNo,
      adj.txnDate,
      adj.lineReferenceNo || adj.lineCheckNo || "",
      bank.bankName,
      adj.description || `Bank reconciliation adjustment (${adj.adjustment_type})`,
      amount,
      amount,
      Number(adjustmentId),
      userId,
      userId,
    ]
  );

  const jvId = jvResult.insertId;

  // Money-out (bank charge, etc.): debit the suggested account, credit the
  // bank. Money-in (interest, etc.): debit the bank, credit the suggested
  // account.
  const lines = isMoneyOut
    ? [
        { accountId: adj.suggested_account_id, code: account.code, title: account.title, debit: amount, credit: 0 },
        { accountId: bank.coaAccountId, code: bank.coaCode, title: bank.bankName, debit: 0, credit: amount },
      ]
    : [
        { accountId: bank.coaAccountId, code: bank.coaCode, title: bank.bankName, debit: amount, credit: 0 },
        { accountId: adj.suggested_account_id, code: account.code, title: account.title, debit: 0, credit: amount },
      ];

  for (const line of lines) {
    await conn.execute(
      `INSERT INTO jv_lines(jv_id, account_id, account_code, account_title, particulars, debit, credit)
       VALUES (?,?,?,?,?,?,?)`,
      [jvId, line.accountId, line.code, line.title, adj.description || "", line.debit, line.credit]
    );
  }

  await conn.execute("UPDATE bank_recon_adjustments SET status = 'POSTED', jv_id = ? WHERE id = ?", [
    jvId,
    adjustmentId,
  ]);

  // The statement line is now fully explained by this adjustment's JV -
  // without this it would sit at UNMATCHED forever and its own resolving
  // JV would (incorrectly) show up as a fresh unmatched book item.
  await conn.execute(
    "UPDATE bank_recon_statement_lines SET match_status = 'MATCHED' WHERE id = ?",
    [adj.statement_line_id]
  );

  await logAudit(conn, {
    module: "JV",
    entityType: "JV",
    entityId: jvId,
    action: "POST",
    description: `JV ${voucherNo} created and posted from bank reconciliation adjustment #${adjustmentId}`,
    afterData: { voucherNo, amount, sourceModule: "BANK_RECON", sourceReferenceId: Number(adjustmentId) },
    user,
  });

  await logAudit(conn, {
    module: "BANK_RECON",
    entityType: "ADJUSTMENT",
    entityId: Number(adjustmentId),
    action: "POST_JV",
    description: `Adjustment #${adjustmentId} posted as JV ${voucherNo} (#${jvId})`,
    beforeData: { status: "APPROVED" },
    afterData: { status: "POSTED", jvId },
    user,
  });

  return { jvId, voucherNo };
}

module.exports = { postAdjustmentAsJV };
