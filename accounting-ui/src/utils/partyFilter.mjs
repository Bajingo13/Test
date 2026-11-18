// Which General Library parties a transaction module may pick (header party
// and the per-line Gen Ref / Gen Name). The module's explicit partyType prop
// is authoritative:
//   SUPPLIER -> suppliers only   (APV, Check Voucher, Purchase Order)
//   CUSTOMER -> customers only   (Invoice, Official Receipt)
//   BOTH     -> customers + suppliers (Debit / Credit Memo)
// Modules that pass no partyType (Journal Voucher "Prepared For", Petty Cash
// "Payee") fall back to the field label - and when the label names neither
// a customer nor a supplier, every party type is allowed, as before.
export function filterPartiesForModule(parties, { partyType = null, partyLabel = "" } = {}) {
  const list = Array.isArray(parties) ? parties : [];
  const type = String(partyType || "").toUpperCase();
  let allowed = null;
  if (type === "SUPPLIER") allowed = ["SUPPLIER"];
  else if (type === "CUSTOMER") allowed = ["CUSTOMER"];
  else if (type === "BOTH") allowed = ["CUSTOMER", "SUPPLIER"];
  else {
    const label = String(partyLabel || "").toLowerCase();
    const s = label.includes("supplier");
    const c = label.includes("customer");
    if (s && c) allowed = ["CUSTOMER", "SUPPLIER"];
    else if (s) allowed = ["SUPPLIER"];
    else if (c) allowed = ["CUSTOMER"];
  }
  return allowed ? list.filter((p) => allowed.includes(String(p?.type || "").toUpperCase())) : list;
}
