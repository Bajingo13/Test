import React from "react";
import TransactionFormLayout from "./TransactionFormLayout";

export default function APV() {
  return (
    <TransactionFormLayout
      title="Accounts Payable Voucher"
      code="APV"
      partyLabel="Supplier"
      defaultDescription="Expense or asset purchase on account"
      defaultLines={[
        {
          id: crypto.randomUUID(),
          accountId: "",
          particulars: "Expense / Asset",
          debit: "",
          credit: "",
        },
        {
          id: crypto.randomUUID(),
          accountId: "",
          particulars: "Accounts Payable",
          debit: "",
          credit: "",
        },
      ]}
    />
  );
}