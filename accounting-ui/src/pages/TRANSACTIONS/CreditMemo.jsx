import React from "react";
import TransactionFormLayout from "./TransactionFormLayout";

// Checkpoint 6: split out of the old single DebitCreditMemo.jsx - see
// DebitMemo.jsx for the full explanation. Approved convention: a Credit
// Memo decreases Accounts Receivable (customer owes less) or increases
// Accounts Payable (you owe the supplier more) - the reverse of Debit
// Memo. Default lines suggest that; actual accounts/amounts are always
// user-driven.
export default function CreditMemo() {
  return (
    <TransactionFormLayout
      title="Credit Memo"
      code="CM"
      printModuleType="creditMemo"
      partyLabel="Customer / Supplier"
      partyType="BOTH"
      defaultDescription="Credit memo adjustment"
      defaultLines={[
        {
          id: crypto.randomUUID(),
          accountId: "",
          particulars: "Offsetting Entry",
          debit: "",
          credit: "",
        },
        {
          id: crypto.randomUUID(),
          accountId: "",
          particulars: "Accounts Receivable / Accounts Payable",
          debit: "",
          credit: "",
        },
      ]}
    />
  );
}