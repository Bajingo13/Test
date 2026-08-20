// Maps a sidebar leaf's route path to the (moduleKey, action) that gates
// GET/VIEW access to it, mirroring the exact mapping server.js's routes
// were wired with. Paths intentionally left OUT of this map (Book
// Template, Particulars Template, Transaction Setup, Industry, Category
// Code, Input VAT, Comparative Income Statement, and the `path: null`
// "Coming Soon" placeholders) have no corresponding permission in the
// catalog yet - they stay visible to everyone rather than being hidden on
// a guessed mapping, since an incorrect guess here is worse than no
// filtering at all. Petty Cash Voucher / Debit Memo / Credit Memo used to
// be in that excluded list too - Checkpoint 6 gave them real backend
// routes gated by TRANSACTIONS.PETTY_CASH/TRANSACTIONS.DEBIT_CREDIT_MEMO,
// so they're mapped below like every other real transaction module now.
const PATH_PERMISSIONS = {
  "/coa": ["FILESETUP.COA", "VIEW"],
  "/general-libraries": ["FILESETUP.GENLIB", "VIEW"],
  "/beginning-balances/gl": ["FILESETUP.BEGINNING_BALANCES", "VIEW"],
  "/beginning-balances/ar": ["FILESETUP.BEGINNING_BALANCES", "VIEW"],
  "/beginning-balances/ap": ["FILESETUP.BEGINNING_BALANCES", "VIEW"],
  "/bank-codes": ["FILESETUP.BANK_CODES", "VIEW"],
  "/tax-file-setup": ["FILESETUP.TAX_SETUP", "VIEW"],
  "/ewt-library": ["FILESETUP.TAX_SETUP", "VIEW"],
  "/fixed-asset-setup": ["FILESETUP.FIXED_ASSETS", "VIEW"],
  "/prepaid-account-setup": ["FILESETUP.PREPAID_ACCOUNTS", "VIEW"],
  "/company-profile": ["FILESETUP.COMPANY_SETUP", "VIEW"],
  "/currency-file-setup": ["FILESETUP.CURRENCY_SETUP", "VIEW"],

  "/transactions/invoice": ["TRANSACTIONS.INVOICE", "VIEW"],
  "/transactions/recurring": ["RECURRING.TRANSACTIONS", "VIEW"],
  "/reports/fx-revaluation": ["FX_REVALUATION", "VIEW"],
  "/transactions/quotation": ["TRANSACTIONS.QUOTATION", "VIEW"],
  "/transactions/or": ["TRANSACTIONS.OR", "VIEW"],
  "/transactions/cv": ["TRANSACTIONS.CV", "VIEW"],
  "/transactions/jv": ["TRANSACTIONS.JV", "VIEW"],
  "/transactions/apv": ["TRANSACTIONS.APV", "VIEW"],
  "/transactions/purchase-order": ["TRANSACTIONS.PURCHASE_ORDER", "VIEW"],
  "/transactions/petty-cash-voucher": ["TRANSACTIONS.PETTY_CASH", "VIEW"],
  "/transactions/debit-memo": ["TRANSACTIONS.DEBIT_CREDIT_MEMO", "VIEW"],
  "/transactions/credit-memo": ["TRANSACTIONS.DEBIT_CREDIT_MEMO", "VIEW"],

  "/posting": ["POSTING", "VIEW"],

  "/reports/trial-balance": ["REPORTS.FINANCIAL", "VIEW"],
  "/reports/general-ledger": ["REPORTS.FINANCIAL", "VIEW"],
  "/reports/account-analysis": ["REPORTS.FINANCIAL", "VIEW"],
  "/reports/income-statement": ["REPORTS.FINANCIAL", "VIEW"],
  "/reports/balance-sheet": ["REPORTS.FINANCIAL", "VIEW"],
  "/reports/cash-flow-statement": ["REPORTS.FINANCIAL", "VIEW"],
  "/reports/bank-reconciliation": ["REPORTS.BANK_RECONCILIATION", "VIEW"],
  "/reports/ai-reconciliation": ["REPORTS.AI_RECONCILIATION", "VIEW"],
  "/reports/ar-aging": ["REPORTS.AR", "VIEW"],
  "/reports/ap-aging": ["REPORTS.AP", "VIEW"],
  "/reports/ar-aging-summary": ["REPORTS.AR", "VIEW"],
  "/reports/ap-aging-summary": ["REPORTS.AP", "VIEW"],
  "/reports/subsidiary-ledger": ["LEDGER.SUBSIDIARY_LEDGER", "VIEW"],
  "/reports/fixed-asset-register": ["REPORTS.FIXED_ASSETS", "VIEW"],
  "/reports/prepayment-lapsing": ["REPORTS.FINANCIAL", "VIEW"],
  "/reports/prepaid-accounts-list": ["REPORTS.FINANCIAL", "VIEW"],
  "/reports/prepaid-subsidiary": ["REPORTS.FINANCIAL", "VIEW"],
  "/reports/lapsed-prepayments": ["REPORTS.FINANCIAL", "VIEW"],
  "/reports/expanded-withholding-tax-report": ["REPORTS.BIR_COMPLIANCE", "VIEW"],
  "/reports/2307": ["REPORTS.BIR_COMPLIANCE", "VIEW"],
  "/reports/output-vat-report": ["REPORTS.BIR_COMPLIANCE", "VIEW"],
  "/reports/final-withholding-tax-report": ["REPORTS.BIR_COMPLIANCE", "VIEW"],

  "/admin/user-settings": ["ADMIN.USER_SETTINGS", "VIEW"],
  "/admin/invitations": ["ADMIN.INVITATIONS", "VIEW"],
  "/admin/roles-permissions": ["ADMIN.ROLES_PERMISSIONS", "VIEW"],
  "/admin/access-restrictions": ["ADMIN.ACCESS_RESTRICTIONS", "VIEW"],
  "/admin/permission-templates": ["ADMIN.ROLES_PERMISSIONS", "VIEW"],
  "/admin/accounting-period-locking": ["ACCOUNTING_PERIODS", "VIEW"],
};

export function pathAllowed(path, can) {
  const mapping = PATH_PERMISSIONS[path];
  if (!mapping) return true; // unmapped paths stay visible - see note above
  return can(mapping[0], mapping[1]);
}

export default PATH_PERMISSIONS;
