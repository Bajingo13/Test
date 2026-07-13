import React from "react";
import TransactionFormLayout from "./TransactionFormLayout";

export default function Invoice() {
  return (
    <TransactionFormLayout
      title="Invoice"
      code="INV"
      partyLabel="Customer"
      defaultDescription="Sales invoice on account"
      defaultLines={[
        {
          id: crypto.randomUUID(),
          accountId: "",
          particulars: "Accounts Receivable",
          debit: "",
          credit: "",
        },
        {
          id: crypto.randomUUID(),
          accountId: "",
          particulars: "Sales / Revenue",
          debit: "",
          credit: "",
        },
      ]}
    />
  );
}