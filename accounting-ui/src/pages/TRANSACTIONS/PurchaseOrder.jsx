import React from "react";
import TransactionFormLayout from "./TransactionFormLayout";

export default function PurchaseOrder() {
  return (
    <TransactionFormLayout
      title="Purchase Order"
      code="PO"
      partyLabel="Supplier"
      defaultDescription="Purchase order issued to supplier"
      defaultLines={[
        {
          id: crypto.randomUUID(),
          accountId: "",
          particulars: "Purchase / Inventory / Expense",
          debit: "",
          credit: "",
        },
        {
          id: crypto.randomUUID(),
          accountId: "",
          particulars: "Accounts Payable / Accrued Payable",
          debit: "",
          credit: "",
        },
      ]}
    />
  );
}