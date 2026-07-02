import React from "react";
import TransactionFormLayout from "./TransactionFormLayout";

export default function DebitCreditMemo() {
  return (
    <TransactionFormLayout
      title="Debit / Credit Memo"
      code="DCM"
      partyLabel="Customer / Supplier"
      defaultDescription="Debit or credit memo adjustment"
      defaultLines={[
        {
          id: crypto.randomUUID(),
          accountId: "",
          particulars: "Adjustment Entry",
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