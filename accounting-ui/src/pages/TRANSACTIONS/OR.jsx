import React from "react";
import TransactionFormLayout from "./TransactionFormLayout";

export default function OR() {
  return (
    <TransactionFormLayout
      title="Official Receipt"
      code="OR"
      partyLabel="Customer"
      defaultDescription="Collection from customer"
      defaultLines={[
        {
          id: crypto.randomUUID(),
          accountId: "",
          particulars: "Cash / Bank",
          debit: "",
          credit: "",
        },
        {
          id: crypto.randomUUID(),
          accountId: "",
          particulars: "Revenue / Receivable",
          debit: "",
          credit: "",
        },
      ]}
    />
  );
}