// Multi-Branch Foundation - branch-aware open items for payment application.
//
//   CV -> APV:     company + branch + supplier + Posted + not reversed + balance > 0
//   OR -> Invoice: company + branch + customer + Posted + balance > 0
//
// Plus the matching AP / AR beginning-balance lines (branch of their header).
// The amounts reuse the SAME authoritative expressions as the existing
// GET /api/apv/unpaid and GET /api/invoices/unpaid (ControlAmountService
// original amount, header paid_amount, posted-only recognition); nothing is
// recalculated differently. Differences from those legacy lookups:
//   - the branch is mandatory and server-resolved (lib/branchResolution);
//   - the party is mandatory (no "all suppliers" list);
//   - invoices must be Posted (the legacy invoice lookup checks balance and
//     payment status only - see the Phase A report; that lookup is invoice code
//     and is deliberately left unchanged here).
// Historical rows whose branch could not be determined (branch_id NULL) are
// NOT offered to a branch: they must be resolved first, never guessed.
const pool = require("../db");
const ControlAmountService = require("./controlAmountService");
const { postedOnlySql } = require("./reportRecognitionService");
const { HttpError } = require("../lib/httpError");

const APV_ORIGINAL_SQL = ControlAmountService.baseOriginalExpr("APV", "apv_headers", "ca");
const INV_ORIGINAL_SQL = ControlAmountService.baseOriginalExpr("INV", "invoice_headers", "ca");

function requirePartyId(partyId, label) {
  const n = Number(partyId);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `A ${label} is required.`, "PARTY_REQUIRED");
  return n;
}

async function listOpenApvs({ companyId, branchId, supplierId }, db = pool) {
  const partyId = requirePartyId(supplierId, "supplier");
  const [rows] = await db.execute(
    `
    SELECT apv_headers.id AS id, 'APV' AS sourceType, voucher_no AS voucherNo,
           DATE_FORMAT(apv_headers.transaction_date, '%Y-%m-%d') AS transactionDate,
           supplier_id AS partyId, supplier_name AS partyName, apv_headers.branch_id AS branchId,
           ${APV_ORIGINAL_SQL} AS totalAmount,
           COALESCE(paid_amount, 0) AS paidAmount,
           GREATEST(${APV_ORIGINAL_SQL} - COALESCE(paid_amount, 0), 0) AS balanceAmount
      FROM apv_headers
      LEFT JOIN ${ControlAmountService.aggregateSql("APV")} ca ON ca.doc_id = apv_headers.id
     WHERE apv_headers.company_id = ?
       AND apv_headers.branch_id = ?
       AND apv_headers.supplier_id = ?
       AND ${postedOnlySql("apv_headers")}
       AND NOT EXISTS (
         SELECT 1 FROM jv_headers rev
          WHERE rev.company_id = apv_headers.company_id
            AND rev.source_module = 'APV_REVERSAL'
            AND rev.source_reference_id = apv_headers.id
            AND UPPER(rev.status) = 'POSTED')
       AND ${APV_ORIGINAL_SQL} - COALESCE(paid_amount, 0) > 0.005
       AND COALESCE(payment_status, 'Unpaid') != 'Paid'
    UNION ALL
    SELECT l.id, 'AP_BEGINNING', l.reference_no, DATE_FORMAT(h.balance_date, '%Y-%m-%d'),
           l.party_id, l.party_name, h.branch_id,
           l.credit, COALESCE(l.paid_amount, 0), COALESCE(l.balance_amount, l.credit, 0)
      FROM arap_beginning_balance_lines l
      JOIN arap_beginning_balance_headers h ON h.id = l.header_id
     WHERE h.balance_type = 'AP' AND h.company_id = ? AND h.branch_id = ? AND l.party_id = ?
       AND ${postedOnlySql("h")}
       AND COALESCE(l.balance_amount, l.credit, 0) > 0
       AND COALESCE(l.status, 'Unpaid') != 'Paid'
     ORDER BY voucherNo
    `,
    [companyId, branchId, partyId, companyId, branchId, partyId]
  );
  return rows;
}

async function listOpenInvoices({ companyId, branchId, customerId }, db = pool) {
  const partyId = requirePartyId(customerId, "customer");
  const [rows] = await db.execute(
    `
    SELECT invoice_headers.id AS id, 'INV' AS sourceType, voucher_no AS voucherNo,
           DATE_FORMAT(invoice_headers.transaction_date, '%Y-%m-%d') AS transactionDate,
           customer_id AS partyId, customer_name AS partyName, invoice_headers.branch_id AS branchId,
           ${INV_ORIGINAL_SQL} AS totalAmount,
           COALESCE(paid_amount, 0) AS paidAmount,
           GREATEST(${INV_ORIGINAL_SQL} - COALESCE(paid_amount, 0), 0) AS balanceAmount
      FROM invoice_headers
      LEFT JOIN ${ControlAmountService.aggregateSql("INV")} ca ON ca.doc_id = invoice_headers.id
     WHERE invoice_headers.company_id = ?
       AND invoice_headers.branch_id = ?
       AND invoice_headers.customer_id = ?
       AND ${postedOnlySql("invoice_headers")}
       AND ${INV_ORIGINAL_SQL} - COALESCE(paid_amount, 0) > 0.005
       AND COALESCE(payment_status, 'Unpaid') != 'Paid'
    UNION ALL
    SELECT l.id, 'AR_BEGINNING', l.reference_no, DATE_FORMAT(h.balance_date, '%Y-%m-%d'),
           l.party_id, l.party_name, h.branch_id,
           l.debit, COALESCE(l.paid_amount, 0), COALESCE(l.balance_amount, l.debit, 0)
      FROM arap_beginning_balance_lines l
      JOIN arap_beginning_balance_headers h ON h.id = l.header_id
     WHERE h.balance_type = 'AR' AND h.company_id = ? AND h.branch_id = ? AND l.party_id = ?
       AND ${postedOnlySql("h")}
       AND COALESCE(l.balance_amount, l.debit, 0) > 0
       AND COALESCE(l.status, 'Unpaid') != 'Paid'
     ORDER BY voucherNo
    `,
    [companyId, branchId, partyId, companyId, branchId, partyId]
  );
  return rows;
}

// Read-only: historical rows left NULL because their company has 2+ branches.
const UNRESOLVED_TABLES = [
  "apv_headers", "invoice_headers", "cv_headers", "or_headers", "jv_headers", "memo_headers",
  "petty_cash_headers", "purchase_order_headers", "quotation_headers",
  "arap_beginning_balance_headers", "gl_beginning_balance_headers",
];
async function unresolvedHistoricalRows(companyId, db = pool) {
  const out = [];
  for (const t of UNRESOLVED_TABLES) {
    const [[row]] = await db.execute(
      `SELECT COUNT(*) AS n FROM ${t} x
        WHERE x.company_id = ? AND x.branch_id IS NULL
          AND (SELECT COUNT(*) FROM branches b WHERE b.company_id = x.company_id) > 1`,
      [companyId]
    );
    out.push({ table: t, unresolved: Number(row.n) });
  }
  return out;
}

module.exports = { listOpenApvs, listOpenInvoices, unresolvedHistoricalRows, UNRESOLVED_TABLES };
