const { HttpError } = require("../lib/httpError");

// Phase 7K.1: closed-period APV/CV reversal (HYBRID model).
//
// A Posted APV/CV whose ORIGINAL accounting period is CLOSED cannot be
// voided in place (Phase 7K returns 409 REVERSAL_REQUIRED). Instead the
// original stays Posted and a separate Posted reversing JV is created,
// dated in the current open period, whose swapped debit/credit net the
// original to exactly zero in every POSTED-only ledger report. The
// "reversed" state is DERIVED from that linked JV - the original header
// status is never changed.
//
// Linkage uses the existing jv_headers.source_module / source_reference_id
// columns (same pattern as fxRevaluationService.reverse). No schema
// change, no new permission (reuses TRANSACTIONS.{APV,CV}/VOID).

const REVERSAL_SOURCE_MODULE = { APV: "APV_REVERSAL", CV: "CV_REVERSAL" };

// Returns the linked Posted reversal JV for an original APV/CV, or null.
// `db` may be a pool or an open connection (pass the txn conn inside a
// reversal so the check is serialized with the write).
async function findPostedReversalJv(db, { companyId, module, originalId }) {
  const sourceModule = REVERSAL_SOURCE_MODULE[module];
  if (!sourceModule) throw new HttpError(500, `Unknown reversal module "${module}".`);
  const [rows] = await db.execute(
    `SELECT id, voucher_no AS voucherNo, DATE_FORMAT(transaction_date, '%Y-%m-%d') AS reversalDate
       FROM jv_headers
      WHERE company_id = ? AND source_module = ? AND source_reference_id = ?
        AND UPPER(status) = 'POSTED'
      ORDER BY id DESC
      LIMIT 1`,
    [companyId, sourceModule, originalId]
  );
  return rows.length ? rows[0] : null;
}

// A reversal GL line: swap debit<->credit and foreign_debit<->foreign_credit;
// copy the account + party reference; replace particulars. Original line
// order is preserved by the caller (it iterates the originals in id order).
function buildReversalLine(origLine, label) {
  return {
    accountId: origLine.account_id ?? null,
    accountCode: origLine.account_code || "",
    accountTitle: origLine.account_title || "",
    particulars: label,
    genRef: origLine.gen_ref || "",
    genName: origLine.gen_name || "",
    debit: Number(origLine.credit) || 0,
    credit: Number(origLine.debit) || 0,
    foreignDebit: origLine.foreign_credit == null ? null : Number(origLine.foreign_credit),
    foreignCredit: origLine.foreign_debit == null ? null : Number(origLine.foreign_debit),
  };
}

// A reversal structured tax entry: same classification snapshots, NEGATED
// monetary amounts, linked to the reversal JV's matching line. Phase 7K.1
// only reverses INPUT_VAT (APV) - EWT is handled by report exclusion, not
// negative rows.
function buildReversalTaxEntry(origEntry, reversalLineId) {
  const neg = (v) => (v == null ? null : -Number(v));
  return {
    lineId: reversalLineId,
    accountId: origEntry.accountId || null,
    entryType: origEntry.entryType, // 'INPUT_VAT'
    partyId: origEntry.partyId || null,
    partyName: origEntry.partyName || null,
    partyTin: origEntry.partyTin || null,
    partyAddress: origEntry.partyAddress || null,
    transactionDate: origEntry.transactionDate || null,
    grossAmount: neg(origEntry.grossAmount),
    netAmount: neg(origEntry.netAmount),
    vatRate: origEntry.vatRate == null ? null : Number(origEntry.vatRate),
    vatAmount: neg(origEntry.vatAmount),
    purchaseClassification: origEntry.purchaseClassification || null,
    vatCode: origEntry.vatCode || null,
    vatTreatment: origEntry.vatTreatment || null,
    vatEntryMode: origEntry.vatEntryMode || null,
    // EWT fields intentionally omitted - no negative EWT rows (spec §17).
  };
}

function reversalVoucherNo(module, originalVoucherNo) {
  return `JV-REV-${module}-${originalVoucherNo || ""}`;
}

module.exports = {
  REVERSAL_SOURCE_MODULE,
  findPostedReversalJv,
  buildReversalLine,
  buildReversalTaxEntry,
  reversalVoucherNo,
};
