import React from "react";
import TransactionFormLayout from "./TransactionFormLayout";

export default function PettyCashVoucher() {
  return (
    <TransactionFormLayout
      title="Petty Cash Voucher"
      code="PCV"
      partyLabel="Payee"
      defaultDescription="Petty cash disbursement"
      defaultLines={[
        {
          id: crypto.randomUUID(),
          accountId: "",
          particulars: "Petty Cash Expense",
          debit: "",
          credit: "",
        },
        {
          id: crypto.randomUUID(),
          accountId: "",
          particulars: "Petty Cash Fund",
          debit: "",
          credit: "",
        },
      ]}
    />
  );
}