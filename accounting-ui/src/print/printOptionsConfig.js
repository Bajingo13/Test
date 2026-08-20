import {
  FileText,
  FileSpreadsheet,
  ListOrdered,
  CalendarDays,
  Users,
  Landmark,
  Hash,
  CreditCard,
  Tag,
  Filter,
} from "lucide-react";

// Per-module print option catalogs. This is the extension point Phase 3
// adds to (JV, PO) - the modal, PDF builders, and backend dispatcher are
// all generic over "which option was picked", so adding a module is: one
// entry here + one MODULE_CONFIG case in the backend data service, not a
// rework of the framework itself.
//
// requiredPermissionAction is checked client-side only to decide which
// options to show/grey out (via GET /api/me/permissions, already built in
// the RBAC phases) - the real security boundary is server-side in
// transactionPrint.routes.js, which re-checks on every request.

function buildListColumns(partyLabel, extra = []) {
  return [
    { key: "voucherNo", label: "No.", width: 0.13 },
    { key: "transactionDate", label: "Date", width: 0.11 },
    { key: "partyName", label: partyLabel, width: 0.22 },
    { key: "referenceNo", label: "Reference", width: 0.12 },
    { key: "status", label: "Status", width: 0.09 },
    ...extra,
    { key: "totalAmount", label: "Amount", width: 0.11, money: true },
  ];
}

// JV has no party column at all - a separate column set rather than
// passing partyLabel: null through buildListColumns.
function buildListColumnsNoParty(extra = []) {
  return [
    { key: "voucherNo", label: "No.", width: 0.16 },
    { key: "transactionDate", label: "Date", width: 0.14 },
    { key: "referenceNo", label: "Reference", width: 0.2 },
    { key: "status", label: "Status", width: 0.12 },
    ...extra,
    { key: "totalAmount", label: "Amount", width: 0.14, money: true },
  ];
}

const SINGLE_OPTIONS = (partyLabel) => [
  {
    id: "without_entries",
    scope: "single",
    mode: "without_entries",
    label: "Print Without Entries",
    description: `${partyLabel}-facing document - no account codes, debit, or credit entries.`,
    icon: FileText,
    requiredPermissionAction: "PRINT",
  },
  {
    id: "with_entries",
    scope: "single",
    mode: "with_entries",
    label: "Print With Entries",
    description: "Internal accounting copy including the Accounting Entries section.",
    icon: FileSpreadsheet,
    requiredPermissionAction: "PRINT_WITH_ENTRIES",
  },
];

export const INVOICE_PRINT_OPTIONS = [
  ...SINGLE_OPTIONS("Customer"),
  {
    id: "list_by_number",
    scope: "list",
    grouping: "number",
    label: "Print List by Invoice Number",
    description: "Summarized list of invoices sorted by invoice number.",
    icon: ListOrdered,
    requiredPermissionAction: "PRINT",
    needsFilters: true,
    listTitle: "Invoice List — By Invoice Number",
    listColumns: buildListColumns("Customer"),
  },
  {
    id: "list_by_date",
    scope: "list",
    grouping: "date",
    label: "Print List by Invoice Date",
    description: "Summarized list of invoices sorted chronologically.",
    icon: CalendarDays,
    requiredPermissionAction: "PRINT",
    needsFilters: true,
    listTitle: "Invoice List — By Invoice Date",
    listColumns: buildListColumns("Customer"),
  },
  {
    id: "list_by_customer",
    scope: "list",
    grouping: "party",
    label: "Print List by Customer",
    description: "Invoices grouped by customer, with a subtotal per customer and a grand total.",
    icon: Users,
    requiredPermissionAction: "PRINT",
    needsFilters: true,
    listTitle: "Invoice List — By Customer",
    listColumns: buildListColumns("Customer"),
  },
];

export const OR_PRINT_OPTIONS = [
  ...SINGLE_OPTIONS("Customer"),
  {
    id: "list_by_number",
    scope: "list",
    grouping: "number",
    label: "Print List by OR Number",
    description: "Summarized list of official receipts sorted by OR number.",
    icon: ListOrdered,
    requiredPermissionAction: "PRINT",
    needsFilters: true,
    listTitle: "Official Receipt List — By OR Number",
    listColumns: buildListColumns("Customer"),
  },
  {
    id: "list_by_date",
    scope: "list",
    grouping: "date",
    label: "Print List by Date",
    description: "Summarized list of official receipts sorted chronologically.",
    icon: CalendarDays,
    requiredPermissionAction: "PRINT",
    needsFilters: true,
    listTitle: "Official Receipt List — By Date",
    listColumns: buildListColumns("Customer"),
  },
  {
    id: "list_by_customer",
    scope: "list",
    grouping: "party",
    label: "Print List by Customer",
    description: "Official receipts grouped by customer, with a subtotal per customer and a grand total.",
    icon: Users,
    requiredPermissionAction: "PRINT",
    needsFilters: true,
    listTitle: "Official Receipt List — By Customer",
    listColumns: buildListColumns("Customer"),
  },
  {
    id: "list_by_payment_method",
    scope: "list",
    grouping: "payment_method",
    label: "Print List by Payment Method",
    description: "Official receipts grouped by payment method (Cash/Check), with a subtotal per method.",
    icon: CreditCard,
    requiredPermissionAction: "PRINT",
    needsFilters: true,
    listTitle: "Official Receipt List — By Payment Method",
    listColumns: buildListColumns("Customer"),
  },
];

export const APV_PRINT_OPTIONS = [
  ...SINGLE_OPTIONS("Supplier"),
  {
    id: "list_by_number",
    scope: "list",
    grouping: "number",
    label: "Print List by APV Number",
    description: "Summarized list of AP vouchers sorted by APV number.",
    icon: ListOrdered,
    requiredPermissionAction: "PRINT",
    needsFilters: true,
    listTitle: "AP Voucher List — By APV Number",
    listColumns: buildListColumns("Supplier"),
  },
  {
    id: "list_by_date",
    scope: "list",
    grouping: "date",
    label: "Print List by Date",
    description: "Summarized list of AP vouchers sorted chronologically.",
    icon: CalendarDays,
    requiredPermissionAction: "PRINT",
    needsFilters: true,
    listTitle: "AP Voucher List — By Date",
    listColumns: buildListColumns("Supplier"),
  },
  {
    id: "list_by_supplier",
    scope: "list",
    grouping: "party",
    label: "Print List by Supplier",
    description: "AP vouchers grouped by supplier, with a subtotal per supplier and a grand total.",
    icon: Users,
    requiredPermissionAction: "PRINT",
    needsFilters: true,
    listTitle: "AP Voucher List — By Supplier",
    listColumns: buildListColumns("Supplier"),
  },
  {
    id: "list_by_due_date",
    scope: "list",
    grouping: "due_date",
    label: "Print List by Due Date",
    description: "Summarized list of AP vouchers sorted by due date - useful for payment planning.",
    icon: CalendarDays,
    requiredPermissionAction: "PRINT",
    needsFilters: true,
    listTitle: "AP Voucher List — By Due Date",
    listColumns: buildListColumns("Supplier", [{ key: "dueDate", label: "Due Date", width: 0.1 }]),
  },
];

export const CV_PRINT_OPTIONS = [
  ...SINGLE_OPTIONS("Payee"),
  {
    id: "list_by_number",
    scope: "list",
    grouping: "number",
    label: "Print List by CV Number",
    description: "Summarized list of check vouchers sorted by CV number.",
    icon: ListOrdered,
    requiredPermissionAction: "PRINT",
    needsFilters: true,
    listTitle: "Check Voucher List — By CV Number",
    listColumns: buildListColumns("Payee"),
  },
  {
    id: "list_by_date",
    scope: "list",
    grouping: "date",
    label: "Print List by Date",
    description: "Summarized list of check vouchers sorted chronologically.",
    icon: CalendarDays,
    requiredPermissionAction: "PRINT",
    needsFilters: true,
    listTitle: "Check Voucher List — By Date",
    listColumns: buildListColumns("Payee"),
  },
  {
    id: "list_by_payee",
    scope: "list",
    grouping: "party",
    label: "Print List by Payee",
    description: "Check vouchers grouped by payee, with a subtotal per payee and a grand total.",
    icon: Users,
    requiredPermissionAction: "PRINT",
    needsFilters: true,
    listTitle: "Check Voucher List — By Payee",
    listColumns: buildListColumns("Payee"),
  },
  {
    id: "list_by_bank_account",
    scope: "list",
    grouping: "bank_account",
    label: "Print List by Bank Account",
    description: "Check vouchers grouped by the bank account they were drawn from, with a subtotal per account.",
    icon: Landmark,
    requiredPermissionAction: "PRINT",
    needsFilters: true,
    listTitle: "Check Voucher List — By Bank Account",
    listColumns: buildListColumns("Payee"),
  },
  {
    id: "list_by_check_number",
    scope: "list",
    grouping: "check_number",
    label: "Print List by Check Number",
    description: "Summarized list of check vouchers sorted by check number.",
    icon: Hash,
    requiredPermissionAction: "PRINT",
    needsFilters: true,
    listTitle: "Check Voucher List — By Check Number",
    listColumns: buildListColumns("Payee", [{ key: "checkNo", label: "Check No.", width: 0.1 }]),
  },
];

// JV has no customer/supplier-facing form at all - a journal voucher IS
// its accounting entries, so there's no "Without Entries" option (matches
// the original spec, which never asked for one here). "Detailed Entries"
// and "List by Account" are deferred: both need a line-level listing
// architecture (a JV's lines can span several accounts, so "group by
// account" doesn't fit the header-level list model every other module
// uses) - not implemented in this phase, same discipline as deferring
// APV/Invoice's "Detailed Particulars" in Phase 1/2.
export const JV_PRINT_OPTIONS = [
  {
    id: "with_entries",
    scope: "single",
    mode: "with_entries",
    label: "Print Journal Voucher",
    description: "Full journal voucher including the Accounting Entries section - a JV has no separate customer-facing form.",
    icon: FileSpreadsheet,
    requiredPermissionAction: "PRINT_WITH_ENTRIES",
  },
  {
    id: "list_by_number",
    scope: "list",
    grouping: "number",
    label: "Print List by JV Number",
    description: "Summarized list of journal vouchers sorted by JV number.",
    icon: ListOrdered,
    requiredPermissionAction: "PRINT",
    needsFilters: true,
    listTitle: "Journal Voucher List — By JV Number",
    listColumns: buildListColumnsNoParty(),
  },
  {
    id: "list_by_date",
    scope: "list",
    grouping: "date",
    label: "Print List by Date",
    description: "Summarized list of journal vouchers sorted chronologically.",
    icon: CalendarDays,
    requiredPermissionAction: "PRINT",
    needsFilters: true,
    listTitle: "Journal Voucher List — By Date",
    listColumns: buildListColumnsNoParty(),
  },
  {
    id: "list_by_reference",
    scope: "list",
    grouping: "reference",
    label: "Print List by Reference",
    description: "Summarized list of journal vouchers sorted by reference number.",
    icon: Tag,
    requiredPermissionAction: "PRINT",
    needsFilters: true,
    listTitle: "Journal Voucher List — By Reference",
    listColumns: buildListColumnsNoParty(),
  },
];

// "With Internal Costing" (permission-controlled) is deferred - it needs
// margin/costing data that doesn't exist in purchase_order_lines today
// (same schema-gap reasoning as Invoice's deferred item-level breakdown).
export const PO_PRINT_OPTIONS = [
  ...SINGLE_OPTIONS("Supplier"),
  {
    id: "list_by_number",
    scope: "list",
    grouping: "number",
    label: "Print List by PO Number",
    description: "Summarized list of purchase orders sorted by PO number.",
    icon: ListOrdered,
    requiredPermissionAction: "PRINT",
    needsFilters: true,
    listTitle: "Purchase Order List — By PO Number",
    listColumns: buildListColumns("Supplier"),
  },
  {
    id: "list_by_date",
    scope: "list",
    grouping: "date",
    label: "Print List by Date",
    description: "Summarized list of purchase orders sorted chronologically.",
    icon: CalendarDays,
    requiredPermissionAction: "PRINT",
    needsFilters: true,
    listTitle: "Purchase Order List — By Date",
    listColumns: buildListColumns("Supplier"),
  },
  {
    id: "list_by_supplier",
    scope: "list",
    grouping: "party",
    label: "Print List by Supplier",
    description: "Purchase orders grouped by supplier, with a subtotal per supplier and a grand total.",
    icon: Users,
    requiredPermissionAction: "PRINT",
    needsFilters: true,
    listTitle: "Purchase Order List — By Supplier",
    listColumns: buildListColumns("Supplier"),
  },
  {
    id: "list_by_status",
    scope: "list",
    grouping: "status",
    label: "Print List by Status",
    description: "Purchase orders grouped by status (Draft/Posted/Cancelled), with a subtotal per status.",
    icon: Filter,
    requiredPermissionAction: "PRINT",
    needsFilters: true,
    listTitle: "Purchase Order List — By Status",
    listColumns: buildListColumns("Supplier"),
  },
];

// Checkpoint 6 - previously fell through to apv (indistinguishable
// printing, or unreachable since PettyCashVoucher.jsx/DebitCreditMemo.jsx
// never passed printModuleType at all). Petty Cash has a payee (party-like,
// matches CV's shape); Debit/Credit Memo share one options array since
// they're structurally identical, only the module key + title differ.
export const PETTY_CASH_PRINT_OPTIONS = [
  ...SINGLE_OPTIONS("Payee"),
  {
    id: "list_by_number",
    scope: "list",
    grouping: "number",
    label: "Print List by Voucher Number",
    description: "Summarized list of petty cash vouchers sorted by voucher number.",
    icon: ListOrdered,
    requiredPermissionAction: "PRINT",
    needsFilters: true,
    listTitle: "Petty Cash Voucher List — By Voucher Number",
    listColumns: buildListColumns("Payee"),
  },
  {
    id: "list_by_date",
    scope: "list",
    grouping: "date",
    label: "Print List by Date",
    description: "Summarized list of petty cash vouchers sorted chronologically.",
    icon: CalendarDays,
    requiredPermissionAction: "PRINT",
    needsFilters: true,
    listTitle: "Petty Cash Voucher List — By Date",
    listColumns: buildListColumns("Payee"),
  },
  {
    id: "list_by_reference",
    scope: "list",
    grouping: "reference",
    label: "Print List by Reference",
    description: "Summarized list of petty cash vouchers sorted by reference number.",
    icon: Tag,
    requiredPermissionAction: "PRINT",
    needsFilters: true,
    listTitle: "Petty Cash Voucher List — By Reference",
    listColumns: buildListColumns("Payee"),
  },
];

function memoPrintOptions(memoLabel) {
  return [
    ...SINGLE_OPTIONS("Customer/Supplier"),
    {
      id: "list_by_number",
      scope: "list",
      grouping: "number",
      label: `Print List by ${memoLabel} Number`,
      description: `Summarized list of ${memoLabel.toLowerCase()}s sorted by memo number.`,
      icon: ListOrdered,
      requiredPermissionAction: "PRINT",
      needsFilters: true,
      listTitle: `${memoLabel} List — By Memo Number`,
      listColumns: buildListColumns("Customer/Supplier"),
    },
    {
      id: "list_by_date",
      scope: "list",
      grouping: "date",
      label: "Print List by Date",
      description: `Summarized list of ${memoLabel.toLowerCase()}s sorted chronologically.`,
      icon: CalendarDays,
      requiredPermissionAction: "PRINT",
      needsFilters: true,
      listTitle: `${memoLabel} List — By Date`,
      listColumns: buildListColumns("Customer/Supplier"),
    },
    {
      id: "list_by_reference",
      scope: "list",
      grouping: "reference",
      label: "Print List by Reference",
      description: `Summarized list of ${memoLabel.toLowerCase()}s sorted by reference number.`,
      icon: Tag,
      requiredPermissionAction: "PRINT",
      needsFilters: true,
      listTitle: `${memoLabel} List — By Reference`,
      listColumns: buildListColumns("Customer/Supplier"),
    },
  ];
}

export const DEBIT_MEMO_PRINT_OPTIONS = memoPrintOptions("Debit Memo");
export const CREDIT_MEMO_PRINT_OPTIONS = memoPrintOptions("Credit Memo");

export const PRINT_OPTIONS_BY_MODULE = {
  invoice: { moduleKey: "TRANSACTIONS.INVOICE", title: "Invoice", options: INVOICE_PRINT_OPTIONS },
  or: { moduleKey: "TRANSACTIONS.OR", title: "Official Receipt", options: OR_PRINT_OPTIONS },
  apv: { moduleKey: "TRANSACTIONS.APV", title: "AP Voucher", options: APV_PRINT_OPTIONS },
  cv: { moduleKey: "TRANSACTIONS.CV", title: "Check Voucher", options: CV_PRINT_OPTIONS },
  jv: { moduleKey: "TRANSACTIONS.JV", title: "Journal Voucher", options: JV_PRINT_OPTIONS },
  po: { moduleKey: "TRANSACTIONS.PURCHASE_ORDER", title: "Purchase Order", options: PO_PRINT_OPTIONS },
  pettyCash: { moduleKey: "TRANSACTIONS.PETTY_CASH", title: "Petty Cash Voucher", options: PETTY_CASH_PRINT_OPTIONS },
  debitMemo: { moduleKey: "TRANSACTIONS.DEBIT_CREDIT_MEMO", title: "Debit Memo", options: DEBIT_MEMO_PRINT_OPTIONS },
  creditMemo: { moduleKey: "TRANSACTIONS.DEBIT_CREDIT_MEMO", title: "Credit Memo", options: CREDIT_MEMO_PRINT_OPTIONS },
};
