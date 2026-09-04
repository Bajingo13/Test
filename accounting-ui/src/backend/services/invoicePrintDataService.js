const pool = require("../db");
const { HttpError } = require("../lib/httpError");
const TransactionPrintDataService = require("./transactionPrintDataService");
const PrintTemplateService = require("./printTemplateService");

// Standard Letter Invoice print-data adapter (INV only).
//
// This is a thin, additive layer on top of the already-existing,
// company-scoped, read-only print pipeline (transactionPrintDataService +
// printTemplateService) - it never re-derives totals, tax, or currency
// values, and it never touches any of the other 8 transaction modules
// those two shared services also serve. Its only job is to reshape the
// already-authoritative accounting data into the standardized print view
// model the React printable (StandardInvoicePrintPage) consumes, so the
// React page never has to interpret raw SQL columns itself.

// ----------------------------------------------------------------------
// Customer-facing item selection rule
// ----------------------------------------------------------------------
// invoice_lines has no qty/unit/unit-price/discount/tax-code columns of
// its own - every row is a plain double-entry debit/credit line (AR,
// Revenue, Output VAT, EWT, FX gain/loss, etc. all live in the same
// table). The only reliable, non-invented signal for "is this a real
// product/service line the customer is being billed for" is the posted
// account's class in chart_of_accounts: only INCOME-class lines are
// customer-facing revenue. ASSET (Accounts Receivable, EWT receivable),
// LIABILITY (Output VAT payable) and any other class are internal
// accounting lines and are never printed as items.
//
// This runs its own, invoice-only query - transactionPrintDataService.js
// (shared by OR/APV/CV/JV/PO/PettyCash/DebitMemo/CreditMemo) is left
// completely untouched.
async function getCustomerFacingItems(invoiceId, useForeignAmount) {
  const [rows] = await pool.execute(
    `SELECT l.id, l.particulars, l.debit, l.credit,
            l.foreign_debit AS foreignDebit, l.foreign_credit AS foreignCredit,
            coa.account_class AS accountClass
       FROM invoice_lines l
       LEFT JOIN chart_of_accounts coa ON coa.id = l.account_id
      WHERE l.invoice_id = ?
      ORDER BY l.id ASC`,
    [invoiceId]
  );

  return rows
    .filter((r) => r.accountClass === "INCOME")
    .map((r, idx) => {
      const debit = Number(r.debit) || 0;
      const credit = Number(r.credit) || 0;
      const foreignDebit = useForeignAmount ? Number(r.foreignDebit) || 0 : debit;
      const foreignCredit = useForeignAmount ? Number(r.foreignCredit) || 0 : credit;
      // Revenue lines are normally credits; the foreign/base pairing mirrors
      // transactionPrintDataService.mapLines' own "whichever side is
      // populated" rule, just credit-first since these are INCOME rows.
      const amount = useForeignAmount
        ? (foreignCredit > 0 ? foreignCredit : foreignDebit)
        : (credit > 0 ? credit : debit);

      // No source column exists for these - rendered as null so the React
      // table can hide the corresponding header cleanly (never a
      // fabricated 0/blank value pretending to be real data).
      return {
        id: r.id,
        lineNo: idx + 1,
        description: r.particulars || "",
        quantity: null,
        unit: null,
        unitPrice: null,
        discount: null,
        taxCode: null,
        vatAmount: null,
        amount,
      };
    });
}

async function getInvoicePrintViewModel({ id, companyId, requestedTemplateId }) {
  if (!id) throw new HttpError(400, "Invoice id is required.");

  // Reuses the exact same authoritative, company-scoped data the existing
  // generic print pipeline resolves for every module (header, party,
  // company profile, currency snapshot, Output VAT) - never re-queried or
  // recomputed here.
  const base = await TransactionPrintDataService.getTransactionDocument("invoice", id, {
    withEntries: false,
    companyId,
  });
  const { doc, party, company, outputVat } = base;

  const templateResolution = await PrintTemplateService.resolveEffectiveConfig({
    companyId,
    moduleType: "invoice",
    requestedTemplateId: requestedTemplateId || null,
  });

  const currency = doc.currency || null;
  const isForeign = !!currency?.isForeign;

  const items = await getCustomerFacingItems(id, isForeign);

  const totalDebit = Number(doc.totalDebit) || 0;
  const paidAmount = doc.paidAmount != null ? Number(doc.paidAmount) || 0 : null;
  const balanceAmount = doc.balanceAmount != null ? Number(doc.balanceAmount) || 0 : null;
  const withholdingAmount = doc.taxWithheldAmount != null ? Number(doc.taxWithheldAmount) || 0 : null;

  const document = {
    id: doc.id,
    invoiceNumber: doc.voucherNo,
    invoiceDate: doc.transactionDate || null,
    dueDate: doc.dueDate || null,
    // No terms/payment-terms column exists on invoice_headers today.
    terms: null,
    invoiceType: "Sales Invoice",
    currencyCode: currency?.currencyCode || currency?.baseCurrencyCode || "PHP",
    exchangeRate: currency?.exchangeRate != null ? Number(currency.exchangeRate) : 1,
    accountingStatus: doc.status || null,
    paymentStatus: doc.paymentStatus || null,
    // invoice_headers has no print_count column - always null, and the
    // React copy-label component hides itself whenever this is null.
    printCount: null,
  };

  const seller = {
    name: company?.name || "",
    businessName: company?.name || "",
    address: [company?.address, company?.zip].filter(Boolean).join(" "),
    tin: company?.tin || "",
    // Not present on company_profile today - left null, never invented.
    vatRegistration: null,
    branchCode: null,
    phone: null,
    email: null,
    logoUrl: null,
    atpNumber: null,
    atpDate: null,
    birPermitNumber: null,
    serialNumbers: null,
  };

  const customer = {
    id: doc.partyId || null,
    code: null,
    name: doc.partyName || "",
    address: party ? [party.address1, party.address2, party.address3].filter(Boolean).join(", ") : "",
    tin: party?.tin || "",
    vatRegistration: null,
    phone: party?.telephone || party?.mobile || null,
    email: party?.email || null,
  };

  // Subtotal/VAT buckets: sourced exclusively from the same Output VAT
  // summary the invoice detail screen and Output VAT report already use
  // (TaxEntryService, via transactionPrintDataService.getOutputVatSummary)
  // - never recomputed from the items above. A non-VAT invoice
  // (outputVat === null) simply has no distinct "subtotal before VAT" on
  // file, so those fields stay null/hidden rather than being guessed.
  const totals = {
    subtotal: outputVat ? outputVat.vatableSales + outputVat.zeroRatedSales + outputVat.exemptSales : null,
    // No discount column exists on invoice_headers/invoice_lines today.
    discount: null,
    vatableSales: outputVat ? outputVat.vatableSales : null,
    vatExemptSales: outputVat ? outputVat.exemptSales : null,
    zeroRatedSales: outputVat ? outputVat.zeroRatedSales : null,
    vatAmount: outputVat ? outputVat.vatAmount : null,
    withholdingAmount,
    totalAmountDue: totalDebit,
    paidAmount,
    balanceAmount,
    // No stored foreign-denominated grand total exists on invoice_headers
    // (total_debit is always base-currency, per transactionPrintDataService's
    // own "with_entries is always the base-currency ledger" rule) - left
    // null rather than summed from the (partial, INCOME-only) items list.
    foreignTotal: null,
    baseCurrencyTotal: totalDebit,
  };

  const footer = {
    remarks: doc.remarks || null,
    // No prepared-by/approved-by/signature columns exist on invoice_headers
    // today - left null; the React footer hides these cleanly.
    preparedBy: null,
    approvedBy: null,
    signature: null,
    atpNumber: null,
    atpDate: null,
    birPermitNumber: null,
    serialNumbers: null,
  };

  const layout = {
    configuration: templateResolution.config,
    snapshot: {
      source: templateResolution.source,
      templateId: templateResolution.templateId,
      templateName: templateResolution.templateName,
    },
  };

  return { document, seller, customer, items, totals, footer, layout, currency };
}

module.exports = { getInvoicePrintViewModel, getCustomerFacingItems };
