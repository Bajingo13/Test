// Data-driven Transactions navigation tree - same NavTree.jsx renderer the
// Reports menu uses. See reportsMenuConfig.js for the pattern this follows.
import {
  FileText,
  FileSignature,
  Receipt,
  FileCheck2,
  BookOpenCheck,
  CreditCard,
  ShoppingCart,
  PiggyBank,
  FileWarning,
  Repeat,
} from "lucide-react";

export const TRANSACTIONS_MENU = [
  {
    id: "invoice-group",
    label: "Invoice",
    children: [
      { id: "invoice", label: "Invoice", icon: FileText, path: "/transactions/invoice" },
      { id: "quotation", label: "Quotation", icon: FileSignature, path: "/transactions/quotation" },
    ],
  },
  { id: "recurring-transactions", label: "Recurring Transactions", icon: Repeat, path: "/transactions/recurring" },
  { id: "official-receipts", label: "Official Receipts", icon: Receipt, path: "/transactions/or" },
  { id: "check-voucher", label: "Check Voucher", icon: FileCheck2, path: "/transactions/cv" },
  { id: "journal-voucher", label: "Journal Voucher", icon: BookOpenCheck, path: "/transactions/jv" },
  { id: "accounts-payable-voucher", label: "Accounts Payable Voucher", icon: CreditCard, path: "/transactions/apv" },
  { id: "purchase-order", label: "Purchase Order", icon: ShoppingCart, path: "/transactions/purchase-order" },
  { id: "petty-cash-voucher", label: "Petty Cash Voucher", icon: PiggyBank, path: "/transactions/petty-cash-voucher" },
  // Checkpoint 6: split from a single "Debit Credit Memo" entry - the old
  // page had no way to distinguish the two at all (see the Checkpoint 6
  // investigation report). Same sidebar position, now two items.
  { id: "debit-memo", label: "Debit Memo", icon: FileWarning, path: "/transactions/debit-memo" },
  { id: "credit-memo", label: "Credit Memo", icon: FileWarning, path: "/transactions/credit-memo" },
];
