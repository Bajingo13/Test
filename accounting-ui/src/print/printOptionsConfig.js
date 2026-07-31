import {
  FileText,
  FileSpreadsheet,
  ListOrdered,
  CalendarDays,
  Users,
  Landmark,
  Hash,
  CreditCard,
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

export const PRINT_OPTIONS_BY_MODULE = {
  invoice: { moduleKey: "TRANSACTIONS.INVOICE", title: "Invoice", options: INVOICE_PRINT_OPTIONS },
  or: { moduleKey: "TRANSACTIONS.OR", title: "Official Receipt", options: OR_PRINT_OPTIONS },
  apv: { moduleKey: "TRANSACTIONS.APV", title: "AP Voucher", options: APV_PRINT_OPTIONS },
  cv: { moduleKey: "TRANSACTIONS.CV", title: "Check Voucher", options: CV_PRINT_OPTIONS },
};
