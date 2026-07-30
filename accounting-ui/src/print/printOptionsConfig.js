import { FileText, FileSpreadsheet, ListOrdered, CalendarDays, Users } from "lucide-react";

// Per-module print option catalogs. This is the extension point Phase 2/3
// add to (OR/APV/CV, then JV/PO) - the modal, PDF builders, and backend
// dispatcher are all already generic over "which option was picked", so
// adding a module is: one entry here + one case in the backend data
// service + one PDF builder file, not a rework of the framework itself.
//
// requiredPermissionAction is checked client-side only to decide which
// options to show/grey out (via GET /api/me/permissions, already built in
// the RBAC phases) - the real security boundary is server-side in
// transactionPrint.routes.js, which re-checks on every request.

export const INVOICE_PRINT_OPTIONS = [
  {
    id: "without_entries",
    scope: "single",
    mode: "without_entries",
    label: "Print Invoice Without Entries",
    description: "Customer-facing invoice - no account codes, debit, or credit entries.",
    icon: FileText,
    requiredPermissionAction: "PRINT",
  },
  {
    id: "with_entries",
    scope: "single",
    mode: "with_entries",
    label: "Print Invoice With Entries",
    description: "Internal accounting copy including the Accounting Entries section.",
    icon: FileSpreadsheet,
    requiredPermissionAction: "PRINT_WITH_ENTRIES",
  },
  {
    id: "list_by_number",
    scope: "list",
    grouping: "number",
    label: "Print Invoice List by Invoice Number",
    description: "Summarized list of invoices sorted by invoice number.",
    icon: ListOrdered,
    requiredPermissionAction: "PRINT",
    needsFilters: true,
  },
  {
    id: "list_by_date",
    scope: "list",
    grouping: "date",
    label: "Print Invoice List by Invoice Date",
    description: "Summarized list of invoices sorted chronologically.",
    icon: CalendarDays,
    requiredPermissionAction: "PRINT",
    needsFilters: true,
  },
  {
    id: "list_by_customer",
    scope: "list",
    grouping: "customer",
    label: "Print Invoice List by Customer",
    description: "Invoices grouped by customer, with a subtotal per customer and a grand total.",
    icon: Users,
    requiredPermissionAction: "PRINT",
    needsFilters: true,
  },
];

export const PRINT_OPTIONS_BY_MODULE = {
  invoice: {
    moduleKey: "TRANSACTIONS.INVOICE",
    title: "Invoice",
    options: INVOICE_PRINT_OPTIONS,
  },
};
