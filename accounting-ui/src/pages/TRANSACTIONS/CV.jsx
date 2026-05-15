import React from "react";
import TransactionFormLayout from "./TransactionFormLayout";

export default function CV() {
  return (
    <TransactionFormLayout
      title="Check Voucher"
      code="CV"
      partyLabel="Payee"
      showCheckNo={true}
      defaultDescription="Cash disbursement through check"
      defaultLines={[
        {
          id: crypto.randomUUID(),
          accountId: "",
          particulars: "Payable / Expense",
          debit: "",
          credit: "",
        },
        {
          id: crypto.randomUUID(),
          accountId: "",
          particulars: "Cash in Bank",
          debit: "",
          credit: "",
        },
      ]}
    />
  );
}