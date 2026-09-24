const pool = require("../db");
const { postedOnlySql } = require("./reportRecognitionService");

// AP List of Payables and Payments - a period, multi-supplier summary, the
// AP structural mirror of AR Billings & Collections (ArBillingsCollections
// Service.js). Deliberately NOT a copy of that file's approach for the
// Payments figure, because AP genuinely differs from AR here (see below) -
// per this task's own instruction not to assume the AR implementation can
// simply be copied.
//
// PAYABLES: apv_headers.total_credit, transaction_date-ranged, filtered
// with the EXACT VOID/CANCELLED + reversal-JV exclusion
// agingReportService.js's own AP branch already established (mirrored
// verbatim below, not imported - AgingReportService's exported functions
// are as-of-date snapshot tools and cannot directly serve a period range,
// so this file is not calling into it, but the correctness predicate text
// is kept byte-identical on purpose so the two never silently drift
// apart). agingReportService.js itself is NOT modified.
//
// PAYMENTS: transaction_applications (source_type IN ('APV','AP_BEGINNING'),
// applied_type='CV'), NOT a flat cv_headers.total_credit sum. This is the
// one deliberate divergence from AR Billings & Collections' flat-OR-total
// convention: Invoice/OR have no void/cancel/reverse lifecycle at all, so
// a flat total is always safe there. APV/CV DO have void/cancel/reverse -
// voidCancelService.js's unwindCvApplications DELETES a voided/cancelled/
// reversed CV's transaction_applications rows and rewrites the affected
// APV/AP_BEGINNING balance columns, so this reconstruction is naturally
// self-correcting for CV lifecycle events with no extra CV-status filter
// needed. A flat CV total would NOT self-correct (a reversed CV's own
// status column is left untouched by the reverse route) and would risk
// overstating Payments.
//
// Debit/Credit Memo direction is the confirmed OPPOSITE of AR (verified
// directly in the Subsidiary Ledger AP branch's own SUM(credit-debit)
// formula and its code comment): a Debit Memo DECREASES AP, a Credit Memo
// INCREASES AP.
//
// Ending Payable = Beginning Payable + Payables + Credit Memos - Payments
// - Debit Memos.

const AP_REVERSAL_EXCLUSION_SQL = `
  AND UPPER(h.status) NOT IN ('VOID', 'CANCELLED')
  AND NOT EXISTS (
    SELECT 1 FROM jv_headers rev
     WHERE rev.company_id = h.company_id
       AND rev.source_module = 'APV_REVERSAL'
       AND rev.source_reference_id = h.id
       AND UPPER(rev.status) = 'POSTED'
  )
`;

async function getSuppliersInScope({ companyId, partyId }) {
  if (partyId) {
    const [rows] = await pool.execute(
      "SELECT id, code, name FROM general_libraries WHERE id = ? AND company_id = ? AND party_type = 'SUPPLIER'",
      [partyId, companyId]
    );
    return rows;
  }

  const [rows] = await pool.execute(
    "SELECT id, code, name FROM general_libraries WHERE company_id = ? AND party_type = 'SUPPLIER' AND status = 'ACTIVE' ORDER BY code",
    [companyId]
  );
  return rows;
}

async function fetchApvPayables(companyId, to) {
  const [rows] = await pool.execute(
    `
    SELECT h.id, h.supplier_id AS party_id,
      DATE_FORMAT(h.transaction_date, '%Y-%m-%d') AS transaction_date,
      h.total_credit AS amount
    FROM apv_headers h
    WHERE h.transaction_date <= ? AND h.company_id = ?
      ${AP_REVERSAL_EXCLUSION_SQL}
    `,
    [to, companyId]
  );
  return rows;
}

async function fetchApBeginningPayables(companyId, to) {
  const [rows] = await pool.execute(
    `
    SELECT l.id, l.party_id,
      DATE_FORMAT(h.balance_date, '%Y-%m-%d') AS transaction_date,
      l.credit AS amount
    FROM arap_beginning_balance_lines l
    JOIN arap_beginning_balance_headers h ON h.id = l.header_id
    WHERE h.balance_type = ? AND h.balance_date <= ? AND h.company_id = ? AND ${postedOnlySql("h")}
    `,
    ["AP", to, companyId]
  );
  return rows;
}

async function fetchApvPayments(companyId, to) {
  const [rows] = await pool.execute(
    `
    SELECT ta.amount, DATE_FORMAT(ta.application_date, '%Y-%m-%d') AS application_date,
      apv.supplier_id AS party_id
    FROM transaction_applications ta
    JOIN apv_headers apv ON apv.id = ta.source_id
    WHERE ta.source_type = 'APV' AND ta.applied_type = 'CV'
      AND ta.application_date <= ? AND apv.company_id = ?
    `,
    [to, companyId]
  );
  return rows;
}

async function fetchApBeginningPayments(companyId, to) {
  const [rows] = await pool.execute(
    `
    SELECT ta.amount, DATE_FORMAT(ta.application_date, '%Y-%m-%d') AS application_date,
      bbl.party_id AS party_id
    FROM transaction_applications ta
    JOIN arap_beginning_balance_lines bbl ON bbl.id = ta.source_id
    JOIN arap_beginning_balance_headers bblh ON bblh.id = bbl.header_id
    WHERE ta.source_type = 'AP_BEGINNING' AND ta.applied_type = 'CV'
      AND ta.application_date <= ? AND bblh.company_id = ?
    `,
    [to, companyId]
  );
  return rows;
}

async function fetchSupplierMemos(companyId, to) {
  const [rows] = await pool.execute(
    `
    SELECT id, party_id, memo_type,
      DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transaction_date,
      total_debit, total_credit
    FROM memo_headers
    WHERE party_type = 'SUPPLIER' AND transaction_date <= ? AND company_id = ? AND ${postedOnlySql()}
    `,
    [to, companyId]
  );
  return rows;
}

function sumFor(rows, partyId, dateField, amountField, { before, from, to } = {}) {
  let total = 0;
  for (const r of rows) {
    if (String(r.party_id) !== String(partyId)) continue;
    const d = r[dateField];
    if (before) {
      if (d < before) total += Number(r[amountField] || 0);
    } else {
      if (d >= from && d <= to) total += Number(r[amountField] || 0);
    }
  }
  return total;
}

async function getApPayablesAndPayments({ from, to, companyId, partyId }) {
  const suppliers = await getSuppliersInScope({ companyId, partyId });

  const [apvRows, apBeginningRows, apvPaymentRows, apBeginningPaymentRows, memoRows] = await Promise.all([
    fetchApvPayables(companyId, to),
    fetchApBeginningPayables(companyId, to),
    fetchApvPayments(companyId, to),
    fetchApBeginningPayments(companyId, to),
    fetchSupplierMemos(companyId, to),
  ]);

  const debitMemoRows = memoRows.filter((m) => m.memo_type === "DEBIT");
  const creditMemoRows = memoRows.filter((m) => m.memo_type === "CREDIT");

  const perSupplier = suppliers.map((s) => {
    const beginningPayable =
      sumFor(apvRows, s.id, "transaction_date", "amount", { before: from }) +
      sumFor(apBeginningRows, s.id, "transaction_date", "amount", { before: from }) -
      sumFor(apvPaymentRows, s.id, "application_date", "amount", { before: from }) -
      sumFor(apBeginningPaymentRows, s.id, "application_date", "amount", { before: from });

    const payables =
      sumFor(apvRows, s.id, "transaction_date", "amount", { from, to }) +
      sumFor(apBeginningRows, s.id, "transaction_date", "amount", { from, to });

    const payments =
      sumFor(apvPaymentRows, s.id, "application_date", "amount", { from, to }) +
      sumFor(apBeginningPaymentRows, s.id, "application_date", "amount", { from, to });

    const debitMemos = sumFor(debitMemoRows, s.id, "transaction_date", "total_debit", { from, to });
    const creditMemos = sumFor(creditMemoRows, s.id, "transaction_date", "total_credit", { from, to });

    const endingPayable = beginningPayable + payables + creditMemos - payments - debitMemos;

    return {
      partyId: s.id,
      partyCode: s.code,
      partyName: s.name,
      beginningPayable,
      payables,
      debitMemos,
      payments,
      creditMemos,
      endingPayable,
    };
  });

  // Mirrors AR Billings & Collections' exact judgment: an all-suppliers
  // view omits a supplier with no beginning payable and no period
  // activity (avoids a wall of meaningless zero rows); an explicitly
  // requested partyId is always shown, even at all-zero.
  const suppliersOut = partyId
    ? perSupplier
    : perSupplier.filter(
        (s) =>
          s.beginningPayable !== 0 ||
          s.payables !== 0 ||
          s.debitMemos !== 0 ||
          s.payments !== 0 ||
          s.creditMemos !== 0
      );

  const sum = (key) => suppliersOut.reduce((acc, s) => acc + s[key], 0);

  return {
    suppliers: suppliersOut,
    grandTotalBeginningPayable: sum("beginningPayable"),
    grandTotalPayables: sum("payables"),
    grandTotalDebitMemos: sum("debitMemos"),
    grandTotalPayments: sum("payments"),
    grandTotalCreditMemos: sum("creditMemos"),
    grandTotalEndingPayable: sum("endingPayable"),
  };
}

module.exports = { getApPayablesAndPayments };
