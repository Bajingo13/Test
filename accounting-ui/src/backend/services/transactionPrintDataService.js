const pool = require("../db");
const { HttpError } = require("../lib/httpError");
const TransactionCurrencyService = require("./transactionCurrencyService");

// Shared and configurable printing framework (Phase 1 = invoice, Phase 2
// adds or/apv/cv) - one query builder driven by this table/column config
// instead of a copy-pasted service per module. Adding a module later is a
// new MODULE_CONFIG entry, not new query code.
//
// *_lines doubles as both the item list and the GL entries for every one
// of these modules (no separate qty/unit-price/discount/VAT/EWT columns
// exist today) - see transaction_print_permissions_migration.sql and the
// Phase 1 plan for why "without entries" strips account code/title/debit/
// credit down to a single customer-facing amount per line.
const MODULE_CONFIG = {
  invoice: {
    moduleKey: "TRANSACTIONS.INVOICE",
    headerTable: "invoice_headers",
    lineTable: "invoice_lines",
    lineIdCol: "invoice_id",
    hasParty: true,
    partyIdCol: "customer_id",
    partyNameCol: "customer_name",
    hasDueDate: true,
    hasPaidBalance: true,
    hasCheck: false,
    hasPaymentMethod: false,
    hasEwt: true,
    hasCurrency: true,
    currencyTxnType: "INV",
  },
  or: {
    moduleKey: "TRANSACTIONS.OR",
    headerTable: "or_headers",
    lineTable: "or_lines",
    lineIdCol: "or_id",
    hasParty: true,
    partyIdCol: "customer_id",
    partyNameCol: "customer_name",
    hasDueDate: false,
    hasPaidBalance: false,
    hasCheck: true,
    hasPaymentMethod: true,
    hasEwt: true,
    hasCurrency: true,
    currencyTxnType: "OR",
    // Phase 1 print-completeness checkpoint: an OR that settles one or more
    // Invoices should print the applied-invoice breakdown (see
    // getAppliedInvoices below) - scoped to OR only per the approved plan,
    // not extended to CV/APV's own settlement tables in this checkpoint.
    hasAppliedInvoices: true,
  },
  apv: {
    moduleKey: "TRANSACTIONS.APV",
    headerTable: "apv_headers",
    lineTable: "apv_lines",
    lineIdCol: "apv_id",
    hasParty: true,
    partyIdCol: "supplier_id",
    partyNameCol: "supplier_name",
    hasDueDate: true,
    hasPaidBalance: true,
    hasCheck: false,
    hasPaymentMethod: false,
    hasEwt: true,
    hasPayeeTin: true,
    hasCurrency: true,
    currencyTxnType: "APV",
  },
  cv: {
    moduleKey: "TRANSACTIONS.CV",
    headerTable: "cv_headers",
    lineTable: "cv_lines",
    lineIdCol: "cv_id",
    hasParty: true,
    partyIdCol: "payee_id",
    partyNameCol: "payee_name",
    hasDueDate: false,
    hasPaidBalance: false,
    hasCheck: true,
    hasPaymentMethod: true,
    hasEwt: true,
    hasPayeeTin: true,
    hasCurrency: true,
    currencyTxnType: "CV",
  },
  // JV has no party at all (it's a pure double-entry accounting document,
  // not a customer/supplier-facing one) - prepared_for is a free-text
  // field, carried through via extraCols instead of the party machinery.
  jv: {
    moduleKey: "TRANSACTIONS.JV",
    headerTable: "jv_headers",
    lineTable: "jv_lines",
    lineIdCol: "jv_id",
    hasParty: false,
    hasDueDate: false,
    hasPaidBalance: false,
    hasCheck: false,
    hasPaymentMethod: false,
    hasCurrency: true,
    currencyTxnType: "JV",
    extraCols: ["prepared_for AS preparedFor"],
  },
  po: {
    moduleKey: "TRANSACTIONS.PURCHASE_ORDER",
    headerTable: "purchase_order_headers",
    lineTable: "purchase_order_lines",
    lineIdCol: "po_id",
    hasParty: true,
    partyIdCol: "supplier_id",
    partyNameCol: "supplier_name",
    hasDueDate: false,
    hasPaidBalance: false,
    hasCheck: false,
    hasPaymentMethod: false,
    hasEwt: true,
    hasPayeeTin: true,
    hasCurrency: true,
    currencyTxnType: "PO",
  },
  // Checkpoint 6 - previously fell through to apv, printing indistinguishably
  // from a real Accounts Payable Voucher. Shaped like cv (payee_id/payee_name,
  // no aging), no check/tax fields since a petty cash voucher isn't a check
  // payment.
  pettyCash: {
    moduleKey: "TRANSACTIONS.PETTY_CASH",
    headerTable: "petty_cash_headers",
    lineTable: "petty_cash_lines",
    lineIdCol: "petty_cash_id",
    hasParty: true,
    partyIdCol: "payee_id",
    partyNameCol: "payee_name",
    hasDueDate: false,
    hasPaidBalance: false,
    hasCheck: false,
    hasPaymentMethod: false,
    hasEwt: false,
    hasCurrency: true,
    currencyTxnType: "PETTY_CASH",
  },
  // Checkpoint 6 - debitMemo/creditMemo share memo_headers/memo_lines
  // (memoType distinguishes them, enforced server-side in server.js's
  // route registration, never client-controlled) - see the Checkpoint 6
  // completion report for the approved design.
  debitMemo: {
    moduleKey: "TRANSACTIONS.DEBIT_CREDIT_MEMO",
    headerTable: "memo_headers",
    lineTable: "memo_lines",
    lineIdCol: "memo_id",
    extraWhere: "h.memo_type = 'DEBIT'",
    hasParty: true,
    partyIdCol: "party_id",
    partyNameCol: "party_name",
    hasDueDate: false,
    hasPaidBalance: false,
    hasCheck: false,
    hasPaymentMethod: false,
    hasEwt: false,
    hasCurrency: true,
    currencyTxnType: "MEMO_DEBIT",
    extraCols: ["source_type AS sourceType", "source_id AS sourceId"],
  },
  creditMemo: {
    moduleKey: "TRANSACTIONS.DEBIT_CREDIT_MEMO",
    headerTable: "memo_headers",
    lineTable: "memo_lines",
    lineIdCol: "memo_id",
    extraWhere: "h.memo_type = 'CREDIT'",
    hasParty: true,
    partyIdCol: "party_id",
    partyNameCol: "party_name",
    hasDueDate: false,
    hasPaidBalance: false,
    hasCheck: false,
    hasPaymentMethod: false,
    hasEwt: false,
    hasCurrency: true,
    currencyTxnType: "MEMO_CREDIT",
    extraCols: ["source_type AS sourceType", "source_id AS sourceId"],
  },
};

function getModuleConfig(transactionType) {
  const cfg = MODULE_CONFIG[transactionType];
  if (!cfg) throw new HttpError(400, `Unsupported print module: ${transactionType}`);
  return cfg;
}

async function getCompanyProfile() {
  const [rows] = await pool.execute(
    "SELECT payor_name AS name, payor_tin AS tin, payor_address AS address, payor_zip AS zip FROM company_profile WHERE id = 1"
  );
  return rows[0] || { name: "", tin: "", address: "", zip: "" };
}

// Phase 1 print-completeness checkpoint: resolves the applied-Invoice
// breakdown for an OR from transaction_applications - the authoritative
// settlement relationship (never inferred from journal lines, which don't
// carry a per-source-document amount at all). company-scoped twice over:
// the OR itself was already confirmed to belong to `companyId` by the
// caller's own header query (WHERE id = ? AND company_id = ?), and this
// query re-verifies the JOINED invoice also belongs to the same company -
// defense in depth matching the same re-check pattern
// paymentApplicationService.js's applyInvoicePayment() already does at
// application-creation time (a cross-company application should never
// exist, but the print path re-verifies rather than trusting that).
// AR_BEGINNING-sourced applications (settling a beginning balance, not a
// real Invoice row) are intentionally excluded - source_type = 'INV' only,
// per the approved scope ("Invoice No./Date/Description/Amount").
async function getAppliedInvoices(companyId, orId) {
  const [rows] = await pool.execute(
    `SELECT
      ta.id,
      ta.source_id AS invoiceId,
      ta.amount AS amountPaid,
      DATE_FORMAT(ta.application_date, '%Y-%m-%d') AS applicationDate,
      ih.voucher_no AS invoiceNo,
      DATE_FORMAT(ih.transaction_date, '%Y-%m-%d') AS invoiceDate,
      ih.total_debit AS invoiceAmount
    FROM transaction_applications ta
    JOIN invoice_headers ih ON ih.id = ta.source_id AND ih.company_id = ?
    WHERE ta.applied_type = 'OR' AND ta.applied_id = ? AND ta.source_type = 'INV'
    ORDER BY ta.id ASC`,
    [companyId, orId]
  );
  // Description is a print-only label, not a stored accounting fact -
  // mirrors the plain "Payment for invoice {voucherNo}" convention already
  // visible on this system's own generated payment records elsewhere, so
  // nothing here is invented data, just a presentation-layer string.
  return rows.map((r) => ({
    invoiceId: r.invoiceId,
    invoiceNo: r.invoiceNo,
    invoiceDate: r.invoiceDate,
    description: `Payment for invoice ${r.invoiceNo}`,
    invoiceAmount: Number(r.invoiceAmount) || 0,
    amountPaid: Number(r.amountPaid) || 0,
  }));
}

// Phase 1 print-completeness checkpoint: previously only built when the
// transaction was foreign-denominated (isForeign), leaving base-currency
// documents with a null doc.currency and no currency line printed at all.
// Now always resolves a display-ready currency object - for a foreign
// transaction, from its own snapshot; for a base-currency transaction
// (snapshot exists but currencyId === baseCurrencyId, or no snapshot row
// at all for a pre-currency-feature legacy transaction), from the
// company's CURRENT base currency. This is a metadata lookup for display
// only (code/name/symbol) - never a rate re-resolution, so it doesn't
// conflict with the "never re-resolve a rate at render time" rule; a
// legacy transaction's exchange rate is never guessed, only its currency
// label, which is fine to source from the company's current setup.
async function resolveCurrencyForDisplay(companyId, currencyTxnType, transactionId) {
  const snapshot = await TransactionCurrencyService.getSnapshot(currencyTxnType, transactionId);

  if (snapshot) {
    const isForeign = snapshot.currencyId !== snapshot.baseCurrencyId;
    const [symRows] = await pool.execute(
      "SELECT id, currency_name AS name, currency_symbol AS symbol FROM currencies WHERE id IN (?, ?)",
      [snapshot.currencyId, snapshot.baseCurrencyId]
    );
    const byId = new Map(symRows.map((r) => [r.id, r]));
    return {
      ...snapshot,
      isForeign,
      currencyName: byId.get(snapshot.currencyId)?.name || "",
      currencySymbol: byId.get(snapshot.currencyId)?.symbol || snapshot.currencyCode,
      baseCurrencyName: byId.get(snapshot.baseCurrencyId)?.name || "",
      baseCurrencySymbol: byId.get(snapshot.baseCurrencyId)?.symbol || "P",
    };
  }

  // No snapshot row at all - a legacy transaction saved before the
  // currency-snapshot feature existed. Falls back to the company's current
  // base currency for a LABEL only (every pre-currency-feature transaction
  // was implicitly base-currency, since foreign entry didn't exist yet) -
  // no rate is invented, and isForeign is always false on this path.
  const [baseRows] = await pool.execute(
    "SELECT id, currency_code AS currencyCode, currency_name AS currencyName, currency_symbol AS currencySymbol FROM currencies WHERE company_id = ? AND is_base_currency = 1 LIMIT 1",
    [companyId]
  );
  if (!baseRows.length) return null;
  const base = baseRows[0];
  return {
    isForeign: false,
    currencyId: base.id,
    currencyCode: base.currencyCode,
    currencyName: base.currencyName,
    currencySymbol: base.currencySymbol,
    baseCurrencyId: base.id,
    baseCurrencyCode: base.currencyCode,
    baseCurrencyName: base.currencyName,
    baseCurrencySymbol: base.currencySymbol,
    exchangeRate: 1,
    rateDate: null,
  };
}

// When the transaction was saved in a foreign currency, `without_entries`
// (customer/supplier-facing) copies show the amount the party actually
// agreed to - the stored foreign_debit/foreign_credit - not the converted
// base-currency debit/credit those columns hold for GL purposes. The
// `with_entries` (internal accounting) copy always shows debit/credit
// as-is, since that IS the base-currency ledger.
function mapLines(lineRows, withEntries, useForeignAmount) {
  return lineRows.map((l) => {
    const debit = Number(l.debit) || 0;
    const credit = Number(l.credit) || 0;
    const foreignDebit = useForeignAmount ? Number(l.foreignDebit) || 0 : debit;
    const foreignCredit = useForeignAmount ? Number(l.foreignCredit) || 0 : credit;
    const amount = useForeignAmount
      ? (foreignDebit > 0 ? foreignDebit : foreignCredit)
      : (debit > 0 ? debit : credit);
    if (withEntries) {
      return {
        particulars: l.particulars,
        amount,
        accountCode: l.accountCode,
        accountTitle: l.accountTitle,
        debit,
        credit,
        genRef: l.genRef,
        genName: l.genName,
      };
    }
    return { particulars: l.particulars, amount };
  });
}

function buildEntriesSummary(lineRows) {
  const totalDebit = lineRows.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCredit = lineRows.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  return { totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.01 };
}

async function getTransactionDocument(transactionType, id, { withEntries, companyId }) {
  const cfg = getModuleConfig(transactionType);

  const metaCols = ["id", "voucher_no AS voucherNo"];
  if (cfg.hasParty) metaCols.push(`${cfg.partyIdCol} AS partyId`, `${cfg.partyNameCol} AS partyName`);
  metaCols.push(
    "DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transactionDate",
    "reference_no AS referenceNo",
    "description",
    "remarks",
    "total_debit AS totalDebit",
    "total_credit AS totalCredit",
    "status"
  );
  if (cfg.hasDueDate) metaCols.push("DATE_FORMAT(due_date, '%Y-%m-%d') AS dueDate");
  if (cfg.hasPaidBalance) {
    metaCols.push("paid_amount AS paidAmount", "balance_amount AS balanceAmount", "payment_status AS paymentStatus");
  }
  if (cfg.hasCheck) metaCols.push("check_no AS checkNo", "DATE_FORMAT(check_date, '%Y-%m-%d') AS checkDate");
  if (cfg.hasPaymentMethod) metaCols.push("payment_method AS paymentMethod", "bank_account_id AS bankAccountId");
  if (cfg.hasEwt) {
    // Printed straight from the stored, backend-validated columns - never
    // recomputed here, so the printout always matches what was saved.
    metaCols.push(
      "atc_code AS atcCode",
      "tax_type AS taxType",
      "tax_rate AS taxRate",
      "tax_withheld_amount AS taxWithheldAmount",
      "taxable_base AS taxableBase"
    );
  }
  if (cfg.hasPayeeTin) metaCols.push("payee_tin AS payeeTin");
  if (cfg.extraCols) metaCols.push(...cfg.extraCols);

  // extraWhere (e.g. memo_type = 'DEBIT') scopes headerTable to the right
  // subtype when two print modules share one physical table (debitMemo/
  // creditMemo both read memo_headers) - without it, printing a credit
  // memo's id through the debit-memo module would succeed and mislabel it.
  const headerWhere = cfg.extraWhere ? `WHERE id = ? AND company_id = ? AND ${cfg.extraWhere}` : `WHERE id = ? AND company_id = ?`;
  const [headers] = await pool.execute(
    `SELECT ${metaCols.join(", ")} FROM ${cfg.headerTable} h ${headerWhere}`,
    [id, companyId]
  );
  if (headers.length === 0) {
    throw new HttpError(404, "Transaction not found");
  }
  const doc = headers[0];

  const lineCols = ["account_code AS accountCode", "account_title AS accountTitle", "particulars", "debit", "credit", "gen_ref AS genRef", "gen_name AS genName"];
  if (cfg.hasCurrency) lineCols.push("foreign_debit AS foreignDebit", "foreign_credit AS foreignCredit");

  const [lineRows] = await pool.execute(
    `SELECT ${lineCols.join(", ")}
    FROM ${cfg.lineTable}
    WHERE ${cfg.lineIdCol} = ?
    ORDER BY id ASC`,
    [id]
  );

  // Read-only: prints whatever rate/currency was already stored on save
  // (section 33/34) - never calls the resolver or recomputes a rate here.
  // Phase 1 print-completeness checkpoint: now always resolves a display
  // object (base-currency transactions used to leave doc.currency null and
  // print no currency line at all - see resolveCurrencyForDisplay's own
  // comment for why this is a metadata lookup, not a rate re-resolution).
  let currencyDisplay = null;
  if (cfg.hasCurrency) {
    currencyDisplay = await resolveCurrencyForDisplay(companyId, cfg.currencyTxnType, id);
  }
  const isForeign = !!currencyDisplay?.isForeign;

  // Checkpoint 3FX (section 27): the realized FX gain/loss line
  // (server.js's paymentApplicationService.applyForeignSettlementToLines)
  // is a base-currency-only internal adjustment - it has no
  // foreign_debit/foreign_credit (nothing was ever charged to the
  // customer/supplier in their own currency for it), so showing it on the
  // customer-facing "without entries" copy would print a stray ₱0.00 line.
  // The accounting copy still sees it like any other line, unchanged.
  const FX_LINE_PARTICULARS = ["Realized Foreign Exchange Gain", "Realized Foreign Exchange Loss"];
  const printableLineRows = withEntries
    ? lineRows
    : lineRows.filter((l) => !FX_LINE_PARTICULARS.includes(l.particulars));

  const lines = mapLines(printableLineRows, withEntries, isForeign);
  const entriesSummary = withEntries ? buildEntriesSummary(lineRows) : null;
  doc.currency = currencyDisplay;

  let appliedInvoices = null;
  if (cfg.hasAppliedInvoices) {
    appliedInvoices = await getAppliedInvoices(companyId, id);
  }

  let party = null;
  if (cfg.hasParty && doc.partyId) {
    const [partyRows] = await pool.execute(
      `SELECT name, address1, address2, address3, tin, telephone, mobile, email
      FROM general_libraries WHERE id = ?`,
      [doc.partyId]
    );
    party = partyRows[0] || null;
  }

  let bankAccount = null;
  if (cfg.hasPaymentMethod && doc.bankAccountId) {
    const [bankRows] = await pool.execute(
      `SELECT bank_code AS bankCode, bank_name AS bankName, account_no AS accountNo FROM bank_codes WHERE id = ?`,
      [doc.bankAccountId]
    );
    bankAccount = bankRows[0] || null;
  }

  const company = await getCompanyProfile();

  return { doc, lines, entriesSummary, party, bankAccount, company, appliedInvoices };
}

// grouping: "number" | "date" | "due_date" | "check_number" | "reference"
// (flat sort) or "party" | "payment_method" | "bank_account" | "status"
// (subtotal groups).
const FLAT_ORDER_BY = {
  number: "voucher_no ASC",
  date: "transaction_date ASC, voucher_no ASC",
  due_date: "due_date ASC, voucher_no ASC",
  check_number: "check_no ASC, voucher_no ASC",
  reference: "reference_no ASC, voucher_no ASC",
};

const GROUP_ORDER_BY = {
  party: "partyName ASC, transaction_date ASC",
  payment_method: "paymentMethod ASC, transaction_date ASC",
  bank_account: "bankAccountId ASC, transaction_date ASC",
  status: "status ASC, transaction_date ASC",
};

const GROUP_KEY_FIELD = {
  party: { key: "partyId", label: "partyName", fallbackLabel: "(No Party)" },
  payment_method: { key: "paymentMethod", label: "paymentMethod", fallbackLabel: "(No Payment Method)" },
  bank_account: { key: "bankAccountId", label: "bankAccountId", fallbackLabel: "(No Bank Account)" },
  status: { key: "status", label: "status", fallbackLabel: "(No Status)" },
};

async function getTransactionList(transactionType, { from, to, grouping, companyId }) {
  const cfg = getModuleConfig(transactionType);

  const cols = ["id", "voucher_no AS voucherNo"];
  if (cfg.hasParty) cols.push(`${cfg.partyIdCol} AS partyId`, `${cfg.partyNameCol} AS partyName`);
  cols.push(
    "DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transactionDate",
    "reference_no AS referenceNo",
    "status",
    "total_debit AS totalAmount"
  );
  if (cfg.hasPaidBalance) cols.push("paid_amount AS paidAmount", "balance_amount AS balanceAmount");
  if (cfg.hasDueDate) cols.push("DATE_FORMAT(due_date, '%Y-%m-%d') AS dueDate");
  if (cfg.hasCheck) cols.push("check_no AS checkNo");
  if (cfg.hasPaymentMethod) cols.push("payment_method AS paymentMethod", "bank_account_id AS bankAccountId");
  if (cfg.extraCols) cols.push(...cfg.extraCols);

  const params = [companyId];
  let where = "WHERE company_id = ?";
  if (cfg.extraWhere) where += ` AND ${cfg.extraWhere}`;
  if (from) {
    where += " AND transaction_date >= ?";
    params.push(from);
  }
  if (to) {
    where += " AND transaction_date <= ?";
    params.push(to);
  }

  const isGrouped = Object.prototype.hasOwnProperty.call(GROUP_ORDER_BY, grouping);
  const orderBy = isGrouped ? GROUP_ORDER_BY[grouping] : FLAT_ORDER_BY[grouping] || FLAT_ORDER_BY.number;

  const [rows] = await pool.execute(
    `SELECT ${cols.join(", ")} FROM ${cfg.headerTable} h ${where} ORDER BY ${orderBy}`,
    params
  );

  let bankLabels = null;
  if (grouping === "bank_account" || cfg.hasPaymentMethod) {
    const [bankRows] = await pool.execute(
      "SELECT id, bank_code AS bankCode, bank_name AS bankName, account_no AS accountNo FROM bank_codes"
    );
    bankLabels = new Map(bankRows.map((b) => [b.id, `${b.bankCode} - ${b.bankName} (${b.accountNo})`]));
  }

  const company = await getCompanyProfile();

  if (isGrouped) {
    const { key, label, fallbackLabel } = GROUP_KEY_FIELD[grouping];
    const groupsMap = new Map();
    for (const row of rows) {
      const rawKey = row[key];
      const mapKey = rawKey ?? "UNASSIGNED";
      if (!groupsMap.has(mapKey)) {
        let groupLabel = row[label] || fallbackLabel;
        if (grouping === "bank_account") {
          groupLabel = (rawKey && bankLabels?.get(rawKey)) || fallbackLabel;
        }
        groupsMap.set(mapKey, { groupLabel, rows: [], subtotal: 0 });
      }
      const group = groupsMap.get(mapKey);
      group.rows.push(row);
      group.subtotal += Number(row.totalAmount) || 0;
    }
    const groups = [...groupsMap.values()];
    const grandTotal = groups.reduce((s, g) => s + g.subtotal, 0);
    return { company, grouping, groups, grandTotal, count: rows.length };
  }

  const grandTotal = rows.reduce((s, r) => s + (Number(r.totalAmount) || 0), 0);
  return { company, grouping, rows, grandTotal, count: rows.length };
}

module.exports = { getCompanyProfile, getTransactionDocument, getTransactionList, MODULE_CONFIG };
