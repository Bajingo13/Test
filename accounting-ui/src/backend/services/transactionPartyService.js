const { HttpError } = require("../lib/httpError");

// P1 (TEST CASE 1: TC1-022 / TC1-090b, accountant report "all the customers
// are showing in CV and APV"): server-side enforcement of WHICH General
// Library party a transaction may carry. The frontend already filters the
// pickers (utils/partyFilter.mjs) - this is the same rule enforced where it
// cannot be bypassed, following the exact pattern rfpService already uses
// for its supplier (a general_libraries row of THIS company, of the right
// party_type; an unknown and another company's party get the same message).
//
// Required for Drafts too: every transaction form already refuses to save a
// Draft without its party (TransactionFormLayout.validate(): "<Party> is
// required."), so a Draft without a valid party is not an existing workflow -
// the server now gives the same deterministic answer instead of storing one.
//
//   AR  Invoice, Official Receipt, Quotation -> CUSTOMER
//   AP  APV, Check Voucher, Purchase Order   -> SUPPLIER
//   Debit / Credit Memo                      -> CUSTOMER or SUPPLIER (the
//       memo's party_type is taken from the library row, never the client,
//       because it decides whether the memo lands in AR or AP)
// Journal Voucher ("Prepared For") and Petty Cash ("Payee") accept any party
// or none and are not routed through here.
const RULES = {
  INV: { types: ["CUSTOMER"], label: "Customer", doc: "invoice" },
  OR: { types: ["CUSTOMER"], label: "Customer", doc: "official receipt" },
  QUOTATION: { types: ["CUSTOMER"], label: "Customer", doc: "quotation" },
  APV: { types: ["SUPPLIER"], label: "Supplier", doc: "APV" },
  CV: { types: ["SUPPLIER"], label: "Payee (supplier)", doc: "check voucher" },
  PO: { types: ["SUPPLIER"], label: "Supplier", doc: "purchase order" },
  DM: { types: ["CUSTOMER", "SUPPLIER"], label: "Customer / Supplier", doc: "debit memo" },
  CM: { types: ["CUSTOMER", "SUPPLIER"], label: "Customer / Supplier", doc: "credit memo" },
};
// Recurring template module types -> the transaction they generate.
const RECURRING_MODULES = { invoice: "INV", or: "OR", apv: "APV", cv: "CV", po: "PO" };

function parsePartyId(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

// Returns { id, code, name, type, status } of the validated party, or throws a
// 400 HttpError (PARTY_REQUIRED / PARTY_NOT_FOUND / PARTY_TYPE_NOT_ALLOWED /
// PARTY_INACTIVE).
//
// Inactive parties (P1 decision 2026-11-19): a NEW document (and every newly
// generated recurring document) needs an ACTIVE party. An existing document
// that already references a now-inactive party stays editable as long as the
// edit keeps that same party: pass `existing: { table, column, id }` for an
// edit and the stored party is read and compared. Historical rows are never
// rewritten.
async function resolveTransactionParty(conn, { module, companyId, partyId, existing = null }) {
  const rule = RULES[module];
  if (!rule) throw new Error(`transactionPartyService: no party rule for ${module}`);
  const id = parsePartyId(partyId);
  if (id === null) {
    throw new HttpError(400, `${rule.label} is required for this ${rule.doc}. Select one from General Libraries.`, "PARTY_REQUIRED");
  }
  if (Number.isNaN(id)) throw new HttpError(400, `${rule.label}: invalid party id.`, "PARTY_NOT_FOUND");
  const [rows] = await conn.execute(
    "SELECT id, code, name, party_type, status FROM general_libraries WHERE id = ? AND company_id = ?",
    [id, companyId]
  );
  const party = rows[0];
  if (!party) throw new HttpError(400, `${rule.label} not found for the selected company.`, "PARTY_NOT_FOUND");
  const type = String(party.party_type || "").toUpperCase();
  if (!rule.types.includes(type)) {
    throw new HttpError(
      400,
      `${party.name || "The selected party"} is set up as ${type || "no party type"} in General Libraries; this ${rule.doc} requires ${rule.types.join(" or ")}.`,
      "PARTY_TYPE_NOT_ALLOWED"
    );
  }
  const status = String(party.status || "").toUpperCase();
  if (status !== "ACTIVE") {
    let unchanged = false;
    if (existing && existing.table && existing.column && existing.id) {
      const [cur] = await conn.execute(`SELECT ${existing.column} AS partyId FROM ${existing.table} WHERE id = ?`, [existing.id]);
      unchanged = !!cur[0] && Number(cur[0].partyId) === party.id;
    }
    if (!unchanged) {
      throw new HttpError(
        400,
        `${party.name || "The selected party"} is inactive in General Libraries; choose an active ${rule.types.join(" or ").toLowerCase()} for this ${rule.doc}.`,
        "PARTY_INACTIVE"
      );
    }
  }
  return { id: party.id, code: party.code, name: party.name, type, status };
}

module.exports = { RULES, RECURRING_MODULES, resolveTransactionParty };
