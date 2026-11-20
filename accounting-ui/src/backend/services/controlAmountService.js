// P0 accounting integrity (TEST CASE 1: TC1-062 / TC1-092b / TC1-084).
//
// ONE authoritative definition of "the amount a document put on its AR/AP
// control account" - the figure every subledger consumer (payment status,
// unpaid lists, application caps, aging, overdue, statements, subsidiary
// ledgers, payables/billings lists, dashboard) must use, so that
//
//   subledger control balance == GL control account balance
//   document outstanding      == control amount - posted applications
//
// Previously every consumer used the voucher's HEADER SIDE TOTAL
// (apv_headers.total_credit / invoice_headers.total_debit). That equals the
// control amount only when the control line is the only line on its side.
// An APV that withholds EWT (Dr Expense, Dr Input VAT / Cr EWT, Cr AP) has a
// credit total of Gross while AP holds Gross - EWT, so a CV paying the real
// payable left the EWT amount "outstanding" forever (TC1-062). Invoices
// recording customer withholding (Dr AR, Dr CWT / Cr Sales, Cr Output VAT)
// had the mirror problem on AR.
//
// Rule, per document:
//   1. If the document has at least one line on an account flagged with the
//      party's control validation (AP CODE for payables, AR CODE for
//      receivables - the same COA flags the beginning-balance import, the
//      RFP -> APV conversion and the COA import already use), the control
//      amount is the NET of those lines (credit - debit for AP, debit -
//      credit for AR). This is exactly what the GL posted to the control
//      account.
//   2. Otherwise (no flagged control line - e.g. a COA whose AP/AR account
//      was never flagged, or a header-only legacy record), fall back to the
//      header side total LESS the document's own withholding lines, i.e. the
//      lines carrying an EWT entry in transaction_tax_entries (the existing
//      Phase 7C tax-entry model; reconcileEwtTaxEntry guarantees that entry
//      and its journal line agree). With no withholding entry this is the
//      old header-total figure unchanged, so documents without EWT/CWT and
//      without flagged control lines behave exactly as before.
//
// Foreign amounts follow the same rule on foreign_debit / foreign_credit,
// falling back to the currency snapshot's foreign_total.

const CONTROL_FLAG = { AP: "AP CODE", AR: "AR CODE" };

const DOCS = {
  APV: { table: "apv_headers", lines: "apv_lines", fk: "apv_id", taxType: "APV", ledger: "AP", sideTotal: "total_credit" },
  INV: { table: "invoice_headers", lines: "invoice_lines", fk: "invoice_id", taxType: "INV", ledger: "AR", sideTotal: "total_debit" },
  CV: { table: "cv_headers", lines: "cv_lines", fk: "cv_id", taxType: "CV", ledger: "AP" },
  OR: { table: "or_headers", lines: "or_lines", fk: "or_id", taxType: "OR", ledger: "AR" },
};

// Net amount of a line in the direction that INCREASES the ledger
// (credit for AP, debit for AR).
function netExpr(ledger, alias, prefix = "") {
  const up = ledger === "AP" ? "credit" : "debit";
  const down = ledger === "AP" ? "debit" : "credit";
  return `(COALESCE(${alias}.${prefix}${up}, 0) - COALESCE(${alias}.${prefix}${down}, 0))`;
}

function controlAccountsSql(ledger) {
  return `(SELECT DISTINCT coa_id FROM coa_validations WHERE UPPER(TRIM(validation_name)) = '${CONTROL_FLAG[ledger]}')`;
}

// Derived table, one row per document: has_control, control_base,
// control_foreign, withholding_base, withholding_foreign. `whereSql` is an
// optional filter on the line alias `l` (e.g. "l.apv_id = ?").
function aggregateSql(type, whereSql = "") {
  const d = DOCS[type];
  if (!d) throw new Error(`controlAmountService: unknown document type ${type}`);
  const sideCol = d.ledger === "AP" ? "credit" : "debit";
  return `(
    SELECT l.${d.fk} AS doc_id,
      MAX(CASE WHEN ctl.coa_id IS NOT NULL THEN 1 ELSE 0 END) AS has_control,
      SUM(CASE WHEN ctl.coa_id IS NOT NULL THEN ${netExpr(d.ledger, "l")} ELSE 0 END) AS control_base,
      SUM(CASE WHEN ctl.coa_id IS NOT NULL THEN ${netExpr(d.ledger, "l", "foreign_")} ELSE 0 END) AS control_foreign,
      SUM(CASE WHEN wht.line_id IS NOT NULL THEN COALESCE(l.${sideCol}, 0) ELSE 0 END) AS withholding_base,
      SUM(CASE WHEN wht.line_id IS NOT NULL THEN COALESCE(l.foreign_${sideCol}, 0) ELSE 0 END) AS withholding_foreign
    FROM ${d.lines} l
    LEFT JOIN ${controlAccountsSql(d.ledger)} ctl ON ctl.coa_id = l.account_id
    LEFT JOIN (
      SELECT DISTINCT line_id FROM transaction_tax_entries
       WHERE transaction_type = '${d.taxType}' AND entry_type = 'EWT' AND line_id IS NOT NULL
    ) wht ON wht.line_id = l.id
    ${whereSql ? `WHERE ${whereSql}` : ""}
    GROUP BY l.${d.fk}
  )`;
}

// SQL expressions for the authoritative ORIGINAL amount of an APV / Invoice,
// given its header alias `h`, the aggregateSql() alias `ca` and (for the
// foreign figure) the currency snapshot alias `snap`.
function baseOriginalExpr(type, h = "h", ca = "ca") {
  const d = DOCS[type];
  return `(CASE WHEN COALESCE(${ca}.has_control, 0) = 1 THEN ${ca}.control_base
    ELSE COALESCE(${h}.${d.sideTotal}, 0) - COALESCE(${ca}.withholding_base, 0) END)`;
}

// A control line whose foreign columns were never populated (legacy rows)
// would otherwise read as a zero foreign amount; such a document keeps the
// snapshot-based figure instead.
function foreignOriginalExpr(type, ca = "ca", snap = "snap") {
  return `(CASE WHEN COALESCE(${ca}.has_control, 0) = 1
      AND NOT (ABS(COALESCE(${ca}.control_foreign, 0)) < 0.005 AND ABS(COALESCE(${ca}.control_base, 0)) > 0.01)
    THEN ${ca}.control_foreign
    ELSE ${snap}.foreign_total - COALESCE(${ca}.withholding_foreign, 0) END)`;
}

// Amount an OR / CV SETTLES on its AR / AP ledger (positive = reduces the
// party balance), for party ledgers/statements: the net of its control
// lines. A payment with no control line (a cash-sale OR, a CV paying an
// expense directly) settles nothing - unless the chart of accounts does not
// use the control flags at all, in which case the old header-total figure is
// kept (`headerTotalSql`) so unflagged installations behave as before.
function paymentSettledExpr(type, headerTotalSql, ca = "ca") {
  const d = DOCS[type];
  return `(CASE WHEN COALESCE(${ca}.has_control, 0) = 1 THEN -${ca}.control_base
    WHEN EXISTS ${controlAccountsSql(d.ledger)} THEN 0
    ELSE COALESCE(${headerTotalSql}, 0) END)`;
}

// Memos (shared memo_headers/memo_lines) are standalone party entries. The
// existing convention (Statement of Accounts, AR/AP Subsidiary Ledger, AP
// Payables & Payments; DebitMemo.jsx / CreditMemo.jsx Checkpoint 6): a Debit
// Memo increases AR / decreases AP, a Credit Memo decreases AR / increases
// AP. The signed control-line net produces exactly that sign; header-only
// memos (no flagged control line) fall back to the same convention on the
// header totals.
function memoAggregateSql(ledger, whereSql = "") {
  return `(
    SELECT l.memo_id AS doc_id,
      MAX(CASE WHEN ctl.coa_id IS NOT NULL THEN 1 ELSE 0 END) AS has_control,
      SUM(CASE WHEN ctl.coa_id IS NOT NULL THEN ${netExpr(ledger, "l")} ELSE 0 END) AS control_base,
      SUM(CASE WHEN ctl.coa_id IS NOT NULL THEN ${netExpr(ledger, "l", "foreign_")} ELSE 0 END) AS control_foreign
    FROM memo_lines l
    LEFT JOIN ${controlAccountsSql(ledger)} ctl ON ctl.coa_id = l.account_id
    ${whereSql ? `WHERE ${whereSql}` : ""}
    GROUP BY l.memo_id
  )`;
}

// Signed amount a memo adds to the party's AR (ledger "AR") or AP ("AP").
function memoSignedBaseExpr(ledger, h = "h", ca = "ma") {
  const fallback = ledger === "AR"
    ? `(CASE WHEN ${h}.memo_type = 'DEBIT' THEN COALESCE(${h}.total_debit, 0) ELSE -COALESCE(${h}.total_credit, 0) END)`
    : `(CASE WHEN ${h}.memo_type = 'CREDIT' THEN COALESCE(${h}.total_credit, 0) ELSE -COALESCE(${h}.total_debit, 0) END)`;
  return `(CASE WHEN COALESCE(${ca}.has_control, 0) = 1 THEN ${ca}.control_base ELSE ${fallback} END)`;
}

function memoSignedForeignExpr(ledger, h = "h", ca = "ma", snap = "snap") {
  const sign = ledger === "AR"
    ? `(CASE WHEN ${h}.memo_type = 'DEBIT' THEN 1 ELSE -1 END)`
    : `(CASE WHEN ${h}.memo_type = 'CREDIT' THEN 1 ELSE -1 END)`;
  return `(CASE WHEN COALESCE(${ca}.has_control, 0) = 1
      AND NOT (ABS(COALESCE(${ca}.control_foreign, 0)) < 0.005 AND ABS(COALESCE(${ca}.control_base, 0)) > 0.01)
    THEN ${ca}.control_foreign ELSE ${sign} * ${snap}.foreign_total END)`;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Authoritative original amount of ONE stored APV / Invoice:
// { baseOriginal, foreignOriginal (null when no snapshot) }.
async function getDocumentControlAmount(conn, type, id) {
  const d = DOCS[type];
  const [rows] = await conn.execute(
    `SELECT ${baseOriginalExpr(type)} AS base_original, ${foreignOriginalExpr(type)} AS foreign_original
       FROM ${d.table} h
       LEFT JOIN ${aggregateSql(type, `l.${d.fk} = ?`)} ca ON ca.doc_id = h.id
       LEFT JOIN transaction_currency_snapshots snap ON snap.transaction_type = ? AND snap.transaction_id = h.id
      WHERE h.id = ?`,
    [id, type, id]
  );
  if (!rows.length) return null;
  return {
    baseOriginal: round2(rows[0].base_original || 0),
    foreignOriginal: rows[0].foreign_original == null ? null : round2(rows[0].foreign_original),
  };
}

// Live balance of ONE APV / Invoice: authoritative control amount minus the
// applications on file. The same figure aging reconstructs, so the stored
// paid/balance columns, the unpaid lists, the application cap and aging can
// never disagree.
async function getDocumentBalance(conn, type, id) {
  const control = await getDocumentControlAmount(conn, type, id);
  if (!control) return null;
  const [rows] = await conn.execute(
    "SELECT COALESCE(SUM(amount), 0) AS paid FROM transaction_applications WHERE source_type = ? AND source_id = ?",
    [type, id]
  );
  const paidAmount = round2(rows[0].paid || 0);
  return {
    totalAmount: control.baseOriginal,
    foreignOriginal: control.foreignOriginal,
    paidAmount,
    balanceAmount: round2(Math.max(control.baseOriginal - paidAmount, 0)),
  };
}

// TC1-084 (Option A, decided 2026-11-18): the system has no unapplied /
// advance-payment subledger, so a POSTED CV/OR whose lines move the AP/AR
// control account must carry applications for exactly that amount - a
// payment that changes the GL control account but no document balance would
// silently drift the subledger from the GL. Lines that do not touch a
// flagged control account (a "direct" CV paying an expense, a cash-sale OR)
// are untouched by this rule.
//
// lines: request lines in TRANSACTION currency ({ accountId, debit, credit });
// appliedTotal: sum of applications in the same (payment) currency.
async function assertControlAmountFullyApplied(conn, { type, lines, appliedTotal, isPosting }) {
  if (!isPosting) return;
  const d = DOCS[type];
  const accountIds = [...new Set((lines || []).map((l) => Number(l.accountId)).filter((v) => Number.isFinite(v) && v > 0))];
  if (!accountIds.length) return;
  const [flagged] = await conn.query(
    `SELECT DISTINCT coa_id FROM coa_validations WHERE UPPER(TRIM(validation_name)) = ? AND coa_id IN (?)`,
    [CONTROL_FLAG[d.ledger], accountIds]
  );
  if (!flagged.length) return;
  const control = new Set(flagged.map((r) => Number(r.coa_id)));
  // A payment REDUCES the ledger: AP is debited by a CV, AR credited by an OR.
  let settled = 0;
  for (const l of lines) {
    if (!control.has(Number(l.accountId))) continue;
    settled += d.ledger === "AP" ? Number(l.debit || 0) - Number(l.credit || 0) : Number(l.credit || 0) - Number(l.debit || 0);
  }
  settled = round2(settled);
  const applied = round2(appliedTotal || 0);
  if (Math.abs(settled) <= 0.01 && applied <= 0.01) return;
  if (Math.abs(settled - applied) > 0.01) {
    const { HttpError } = require("../lib/httpError");
    const what = type === "CV" ? "Accounts Payable" : "Accounts Receivable";
    const doc = type === "CV" ? "APV" : "invoice";
    throw new HttpError(
      400,
      applied <= 0.01
        ? `This ${type} moves ${settled.toFixed(2)} on the ${what} control account but is not applied to any ${doc}. ` +
            `Apply it to the open ${doc}(s) it pays - unapplied/advance payments are not supported.`
        : `This ${type} moves ${settled.toFixed(2)} on the ${what} control account but only ${applied.toFixed(2)} is applied to ${doc}s. ` +
            `The applied amount must equal the ${what} amount - unapplied/advance payments are not supported.`,
      "UNAPPLIED_CONTROL_PAYMENT"
    );
  }
}

// SQL condition (for bulk posting) that is TRUE when a stored Draft CV/OR
// would violate assertControlAmountFullyApplied. `h` is the header alias.
function unappliedControlPaymentSql(type, h = "h") {
  const d = DOCS[type];
  const settle = d.ledger === "AP" ? "(COALESCE(l.debit,0) - COALESCE(l.credit,0))" : "(COALESCE(l.credit,0) - COALESCE(l.debit,0))";
  const fsettle = d.ledger === "AP" ? "(COALESCE(l.foreign_debit,0) - COALESCE(l.foreign_credit,0))" : "(COALESCE(l.foreign_credit,0) - COALESCE(l.foreign_debit,0))";
  return `ABS(
    COALESCE((SELECT SUM(CASE WHEN snap.currency_id IS NOT NULL AND snap.currency_id <> snap.base_currency_id THEN ${fsettle} ELSE ${settle} END)
                FROM ${d.lines} l
                JOIN ${controlAccountsSql(d.ledger)} ctl ON ctl.coa_id = l.account_id
                LEFT JOIN transaction_currency_snapshots snap ON snap.transaction_type = '${type}' AND snap.transaction_id = l.${d.fk}
               WHERE l.${d.fk} = ${h}.id), 0)
    - COALESCE((SELECT SUM(COALESCE(ta.foreign_amount_applied, ta.amount)) FROM transaction_applications ta
               WHERE ta.applied_type = '${type}' AND ta.applied_id = ${h}.id), 0)
  ) > 0.01`;
}

module.exports = {
  CONTROL_FLAG,
  aggregateSql,
  baseOriginalExpr,
  foreignOriginalExpr,
  paymentSettledExpr,
  memoAggregateSql,
  memoSignedBaseExpr,
  memoSignedForeignExpr,
  getDocumentControlAmount,
  getDocumentBalance,
  assertControlAmountFullyApplied,
  unappliedControlPaymentSql,
};
