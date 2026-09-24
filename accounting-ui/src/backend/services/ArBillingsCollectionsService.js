const pool = require("../db");
const { getArStatementOfAccounts } = require("./ArStatementService");

// AR Billings & Collections - a period, multi-customer SUMMARY, distinct
// from AR Statement of Accounts (the single-customer chronological detail
// ledger completed just before this report). This is a pure composition
// layer: it enumerates the customers in scope and, for each one, calls the
// EXISTING, UNCHANGED ArStatementService.getArStatementOfAccounts - no new
// recognition SQL, no new balance-computation logic, no modification to
// ArStatementService.js at all. Each customer's already-computed rows[]
// (one row per Invoice/OR/AR-Beginning-Balance-line/Memo, each already
// carrying the correct Posted-only, company-scoped, debit/credit figures)
// are simply reduced into 5 named period buckets by their existing
// sourceType, using the SAME sign convention ArStatementService already
// established and proved correct:
//   Billings       = sum debit  where sourceType === 'INV'
//                     (+ 'AR BEGINNING' rows dated INSIDE the period - a
//                     rare edge case, folded here rather than dropped, so
//                     Beginning + Billings + DebitMemos - Collections -
//                     CreditMemos always reconciles exactly to Ending)
//   Debit Memos    = sum debit  where sourceType === 'DEBIT MEMO'
//   Collections    = sum credit where sourceType === 'OR'
//   Credit Memos   = sum credit where sourceType === 'CREDIT MEMO'
//
// transaction_applications is deliberately NOT read anywhere in this file
// (or in ArStatementService) - Collections is the flat OR total, which is
// the only source that also captures a deliberately unallocated OR (a
// real, tested, supported scenario - an OR with zero invoiceApplications
// still represents real cash received and must not be silently excluded
// from a "Collections" total). Since transaction_applications is never
// summed anywhere in this report, there is no possibility of double-
// counting a collection against its own allocation detail.

function bucketRows(rows) {
  let billings = 0;
  let debitMemos = 0;
  let collections = 0;
  let creditMemos = 0;

  for (const r of rows) {
    if (r.sourceType === "INV" || r.sourceType === "AR BEGINNING") {
      billings += r.debit;
    } else if (r.sourceType === "DEBIT MEMO") {
      debitMemos += r.debit;
    } else if (r.sourceType === "OR") {
      collections += r.credit;
    } else if (r.sourceType === "CREDIT MEMO") {
      creditMemos += r.credit;
    }
  }

  return { billings, debitMemos, collections, creditMemos };
}

async function getCustomersInScope({ companyId, partyId }) {
  if (partyId) {
    const [rows] = await pool.execute(
      "SELECT id, code, name FROM general_libraries WHERE id = ? AND company_id = ? AND party_type = 'CUSTOMER'",
      [partyId, companyId]
    );
    return rows;
  }

  const [rows] = await pool.execute(
    "SELECT id, code, name FROM general_libraries WHERE company_id = ? AND party_type = 'CUSTOMER' AND status = 'ACTIVE' ORDER BY code",
    [companyId]
  );
  return rows;
}

async function getArBillingsAndCollections({ from, to, companyId, partyId }) {
  const customerRows = await getCustomersInScope({ companyId, partyId });

  const perCustomer = await Promise.all(
    customerRows.map(async (c) => {
      const statement = await getArStatementOfAccounts({ partyId: c.id, from, to, companyId });
      const { billings, debitMemos, collections, creditMemos } = bucketRows(statement.rows);
      return {
        partyId: c.id,
        partyCode: c.code,
        partyName: c.name,
        beginningBalance: statement.beginningBalance,
        billings,
        debitMemos,
        collections,
        creditMemos,
        endingBalance: statement.endingBalance,
      };
    })
  );

  // When no single partyId was requested, an all-customers view omits a
  // customer with no beginning balance and no period activity at all - a
  // never-transacted customer as an all-zero row would only add noise to
  // a potentially large company-wide report. A customer explicitly
  // requested via partyId is always shown, even at all-zero, matching AR
  // Statement of Accounts' own established precedent.
  const customers = partyId
    ? perCustomer
    : perCustomer.filter(
        (c) =>
          c.beginningBalance !== 0 ||
          c.billings !== 0 ||
          c.debitMemos !== 0 ||
          c.collections !== 0 ||
          c.creditMemos !== 0
      );

  const sum = (key) => customers.reduce((s, c) => s + c[key], 0);

  return {
    customers,
    grandTotalBeginningBalance: sum("beginningBalance"),
    grandTotalBillings: sum("billings"),
    grandTotalDebitMemos: sum("debitMemos"),
    grandTotalCollections: sum("collections"),
    grandTotalCreditMemos: sum("creditMemos"),
    grandTotalEndingBalance: sum("endingBalance"),
  };
}

module.exports = { getArBillingsAndCollections };
