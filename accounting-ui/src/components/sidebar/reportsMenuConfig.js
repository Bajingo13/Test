// Data-driven Reports navigation tree. Every leaf either has a `path`
// (renders as a real link) or `path: null` (renders disabled, "Coming
// Soon" - no page/route exists for it yet, so nothing is fabricated here).
// To add a future report: add one node. Nothing else in the sidebar needs
// to change - see NavTree.jsx for the renderer.
import {
  Scale,
  BookOpenCheck,
  Search,
  FileBarChart,
  FileBarChart2,
  ClipboardList,
  TrendingUp,
  Calculator,
  Landmark,
  Sparkles,
  Waves,
  Banknote,
  ArrowDownToLine,
  ArrowUpFromLine,
  BookOpen,
  Receipt,
  HandCoins,
  AlertCircle,
  CreditCard,
  FileText,
  PiggyBank,
  FileWarning,
  Boxes,
  FileClock,
  ListChecks,
  FileCheck2,
  CircleDollarSign,
} from "lucide-react";

export const REPORTS_MENU = [
  {
    id: "financial-reports",
    label: "Financial Reports",
    children: [
      { id: "trial-balance", label: "Trial Balance", icon: Scale, path: "/reports/trial-balance" },
      { id: "general-ledger", label: "General Ledger Report", icon: BookOpenCheck, path: "/reports/general-ledger" },
      { id: "account-analysis", label: "Account Analysis", icon: Search, path: "/reports/account-analysis" },
      { id: "summary-of-books-totals", label: "Summary of Books by Totals", icon: FileBarChart, path: null },
      { id: "net-summary-of-books", label: "Net Summary of Books", icon: FileBarChart2, path: null },
      { id: "gl-beginning-balance-list", label: "GL Beginning Balance List", icon: ClipboardList, path: "/beginning-balances/gl" },
      { id: "income-statement", label: "Income Statement", icon: TrendingUp, path: "/reports/income-statement" },
      { id: "balance-sheet", label: "Balance Sheet", icon: Calculator, path: "/reports/balance-sheet" },
      { id: "bank-reconciliation", label: "Bank Reconciliation", icon: Landmark, path: "/reports/bank-reconciliation" },
      { id: "ai-reconciliation", label: "AI Reconciliation Assistant", icon: Sparkles, path: "/reports/ai-reconciliation" },
      { id: "cash-flow", label: "Cash Flow", icon: Waves, path: "/reports/cash-flow-statement" },
      { id: "daily-cash-position", label: "Daily Cash Position Report", icon: Banknote, path: null },
    ],
  },
  {
    id: "ar-reports",
    label: "Accounts Receivable Reports",
    children: [
      { id: "ar-beginning-balance-list", label: "AR Beginning Balance List", icon: ClipboardList, path: "/beginning-balances/ar" },
      {
        id: "ar-aging-reports",
        label: "Aging Reports",
        children: [
          { id: "ar-aging-detailed", label: "Detailed Aging Report", icon: FileText, path: null },
          { id: "ar-aging-summary", label: "Aging Summary Report", icon: FileBarChart, path: "/reports/ar-aging" },
        ],
      },
      { id: "ar-subsidiary-ledger", label: "Subsidiary Ledger Report", icon: BookOpen, path: "/reports/subsidiary-ledger" },
      { id: "ar-statement-of-accounts", label: "Statement of Accounts", icon: Receipt, path: null },
      { id: "ar-billings-and-collections", label: "Billings and Collections", icon: HandCoins, path: null },
      { id: "ar-overdue-accounts", label: "List of Overdue Accounts", icon: AlertCircle, path: null },
    ],
  },
  {
    id: "ap-reports",
    label: "Accounts Payable Reports",
    children: [
      { id: "ap-beginning-balance-list", label: "AP Beginning Balance List", icon: ClipboardList, path: "/beginning-balances/ap" },
      {
        id: "ap-aging-reports",
        label: "Aging Reports",
        children: [
          { id: "ap-aging-detailed", label: "Detailed Aging Report", icon: FileText, path: null },
          { id: "ap-aging-summary", label: "Aging Summary Report", icon: FileBarChart, path: "/reports/ap-aging" },
        ],
      },
      { id: "ap-subsidiary-ledger", label: "Subsidiary Ledger Report", icon: BookOpen, path: "/reports/subsidiary-ledger" },
      { id: "ap-payables-and-payments", label: "List of Payables and Payments", icon: CreditCard, path: null },
      { id: "ap-overdue-accounts", label: "List of Overdue Accounts", icon: AlertCircle, path: null },
    ],
  },
  {
    id: "books-of-accounts",
    label: "Books of Accounts",
    children: [
      { id: "income-book", label: "Income Book", icon: Banknote, path: null },
      { id: "cash-receipt-book", label: "Cash Receipt Book", icon: ArrowDownToLine, path: null },
      { id: "cash-disbursement-book", label: "Cash Disbursement Book", icon: ArrowUpFromLine, path: null },
      { id: "accounts-payable-book", label: "Accounts Payable Book", icon: CreditCard, path: null },
      { id: "journal-book", label: "Journal Book", icon: FileText, path: null },
      { id: "petty-cash-book", label: "Petty Cash Book", icon: PiggyBank, path: null },
      { id: "debit-credit-memo-book", label: "Debit/Credit Memo Book", icon: FileWarning, path: null },
    ],
  },
  {
    id: "fixed-asset-reports",
    label: "Fixed Asset Reports",
    children: [
      { id: "list-of-fixed-assets", label: "List of Fixed Assets", icon: Boxes, path: "/reports/fixed-asset-register" },
      { id: "fixed-asset-lapsing", label: "Fixed Asset Lapsing Report", icon: FileClock, path: null },
    ],
  },
  {
    id: "bir-compliance-reports",
    label: "BIR Compliance Reports",
    children: [
      {
        id: "prepaid-accounts-reports",
        label: "Prepaid Accounts Reports",
        children: [
          { id: "prepayment-lapsing", label: "Prepayment Lapsing Report", icon: FileClock, path: "/reports/prepayment-lapsing" },
          { id: "list-of-prepaid-accounts", label: "List of Prepaid Accounts", icon: ListChecks, path: "/reports/prepaid-accounts-list" },
          { id: "prepaid-subsidiary", label: "Prepaid Subsidiary", icon: BookOpen, path: "/reports/prepaid-subsidiary" },
          { id: "list-of-lapsed-prepayments", label: "List of Lapsed Prepayments", icon: FileWarning, path: "/reports/lapsed-prepayments" },
        ],
      },
      { id: "expanded-withholding-tax", label: "Expanded Withholding Tax Report", icon: FileText, path: "/reports/expanded-withholding-tax-report" },
      { id: "bir-form-2307", label: "BIR Form 2307", icon: FileCheck2, path: "/reports/2307" },
      { id: "input-vat-report", label: "Input VAT Report", icon: CircleDollarSign, path: "/reports/input-vat-report" },
      { id: "output-vat-report", label: "Output VAT Report", icon: CircleDollarSign, path: "/reports/output-vat-report" },
      { id: "monthly-final-tax-alphalist", label: "Monthly Final Tax / Alphalist Report", icon: FileBarChart, path: "/reports/final-withholding-tax-report" },
      { id: "monthly-expanded-tax-alphalist", label: "Monthly Expanded Tax List / Alphalist Report", icon: FileBarChart2, path: "/reports/expanded-withholding-tax-report" },
    ],
  },
];
