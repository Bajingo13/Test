import React from "react";
import TransactionFormLayout from "./TransactionFormLayout";

// Checkpoint 6: split out of the old single DebitCreditMemo.jsx, which had
// no way to distinguish a Debit Memo from a Credit Memo at all (see the
// Checkpoint 6 investigation report). Approved convention: a Debit Memo
// increases Accounts Receivable (customer owes more) or decreases
// Accounts Payable (you owe the supplier less) - the default lines below
// suggest that, but the actual accounts/amounts are always user-driven,
// same as every other module here.
export default function DebitMemo() {
  return (
    <TransactionFormLayout
      title="Debit Memo"
      code="DM"
      printModuleType="debitMemo"
      partyLabel="Customer / Supplier"
      partyType="BOTH"
      defaultDescription="Debit memo adjustment"
      defaultLines={[
        {
          id: crypto.randomUUID(),
          accountId: "",
          particulars: "Accounts Receivable / Accounts Payable",
          debit: "",
          credit: "",
        },
        {
          id: crypto.randomUUID(),
          accountId: "",
          particulars: "Offsetting Entry",
          debit: "",
          credit: "",
        },
      ]}
    />
  );
}