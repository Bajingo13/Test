const { HttpError } = require("../lib/httpError");
const TransactionCurrencyService = require("./transactionCurrencyService");
const { updateApvPaymentStatus } = require("./paymentApplicationService");

// Phase 7K: shared helpers for the explicit APV/CV Cancel (Draft -> Cancelled)
// and Void (Posted -> Void) accounting actions. Validation only + the CV
// settlement unwind - no new ledger/tax/EWT logic. Recognition is driven
// entirely by status (reportRecognitionService.postedOnlySql), so a
// Cancelled/Void header keeps every row/line/tax entry it had and simply
// stops being "financially recognized".

// The only transaction statuses the APV/CV write paths accept. Cancelled /
// Void are reached ONLY through the dedicated /cancel and /void endpoints,
// never through plain create/update.
const WRITE_STATUSES = ["DRAFT", "POSTED"];
const CANCELLED = "Cancelled";
const VOID = "Void";

function normalizeStatus(value) {
  return String(value == null ? "" : value).trim();
}

// Rejects an arbitrary status string on the plain create/update path.
function assertWriteStatus(status) {
  const up = normalizeStatus(status).toUpperCase();
  if (up && !WRITE_STATUSES.includes(up)) {
    throw new HttpError(
      400,
      `Invalid transaction status "${status}". Allowed on this action: Draft, Posted.`,
      "INVALID_TRANSACTION_STATUS"
    );
  }
}

// A trimmed, non-empty reason of at most 500 chars (fits audit_logs.description).
function assertReason(reason) {
  const r = typeof reason === "string" ? reason.trim() : "";
  if (!r) {
    throw new HttpError(400, "A reason is required.", "REASON_REQUIRED");
  }
  if (r.length > 500) {
    throw new HttpError(400, "Reason must be 500 characters or fewer.", "REASON_TOO_LONG");
  }
  return r;
}

// Mirrors PUT /api/cv/:id's "reverse the payment effects of this CV's
// previous applications" block, verbatim in behaviour: delete this CV's
// transaction_applications, restore any AP_BEGINNING lines, then recompute
// every affected APV's payment status. Used by both CV Cancel and CV Void.
async function unwindCvApplications(conn, cvId) {
  const [oldApplications] = await conn.execute(
    `SELECT source_type AS sourceType, source_id AS sourceId, amount
       FROM transaction_applications
      WHERE applied_type = 'CV' AND applied_id = ?`,
    [cvId]
  );

  await conn.execute(
    `DELETE FROM transaction_applications WHERE applied_type = 'CV' AND applied_id = ?`,
    [cvId]
  );

  for (const oldItem of oldApplications) {
    const oldAmount = Number(oldItem.amount || 0);
    if (oldItem.sourceType === "AP_BEGINNING") {
      await conn.execute(
        `
        UPDATE arap_beginning_balance_lines
        SET paid_amount = GREATEST(COALESCE(paid_amount, 0) - ?, 0),
            balance_amount = LEAST(COALESCE(balance_amount, credit, 0) + ?, COALESCE(credit, 0)),
            status = CASE
              WHEN GREATEST(COALESCE(paid_amount, 0) - ?, 0) <= 0 THEN 'Unpaid'
              WHEN LEAST(COALESCE(balance_amount, credit, 0) + ?, COALESCE(credit, 0)) > 0 THEN 'Partially Paid'
              ELSE 'Paid'
            END
        WHERE id = ?
        `,
        [oldAmount, oldAmount, oldAmount, oldAmount, oldItem.sourceId]
      );

      const foreignState = await TransactionCurrencyService.getForeignPaymentState(conn, {
        transactionType: "AP_BEGINNING",
        transactionId: oldItem.sourceId,
      });
      if (foreignState.hasForeignCurrency) {
        await conn.execute(
          `UPDATE arap_beginning_balance_lines SET foreign_paid_amount = ?, foreign_balance_amount = ? WHERE id = ?`,
          [foreignState.foreignPaidAmount, foreignState.foreignBalanceAmount, oldItem.sourceId]
        );
      }
    }
  }

  const affectedApvIds = [
    ...new Set(
      oldApplications.filter((a) => a.sourceType === "APV").map((a) => Number(a.sourceId))
    ),
  ];
  for (const apvId of affectedApvIds) {
    await updateApvPaymentStatus(conn, apvId);
  }

  return { unwoundApplications: oldApplications.length, affectedApvIds };
}

module.exports = {
  WRITE_STATUSES,
  CANCELLED,
  VOID,
  normalizeStatus,
  assertWriteStatus,
  assertReason,
  unwindCvApplications,
};
