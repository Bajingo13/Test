import React from "react";
import TransactionFormLayout from "./TransactionFormLayout";

export default function JV() {
  return (
    <TransactionFormLayout
      title="Journal Voucher"
      code="JV"
      partyLabel="Prepared For"
      defaultDescription="Manual journal entry"
      defaultLines={[
        {
          id: crypto.randomUUID(),
          accountId: "",
          particulars: "Debit entry",
          debit: "",
          credit: "",
        },
        {
          id: crypto.randomUUID(),
          accountId: "",
          particulars: "Credit entry",
          debit: "",
          credit: "",
        },
      ]}
    />
  );
}