const pool = require("../db");
const { logAudit, requestMeta } = require("../lib/audit");
const InvoicePrintDataService = require("../services/invoicePrintDataService");
const InvoicePrintPdfService = require("../services/invoicePrintPdfService");
const CurrencyService = require("../services/currencyService");

const INTENTS = { preview: "PRINT_PREVIEW", print: "PRINT_DOCUMENT", export_pdf: "PRINT_EXPORT_PDF" };

// Read-only view-model endpoint for the Standard Letter Invoice React
// printable (StandardInvoicePrintPage). Viewing/generating this document
// never mutates invoice_headers/invoice_lines, never posts, never changes
// status, and never re-derives totals/tax/currency - it only reshapes
// values invoicePrintDataService already resolved from existing,
// company-scoped accounting data.
exports.getInvoicePrintDocument = async (req, res) => {
  try {
    const { id } = req.params;
    const intent = INTENTS[req.query.intent] ? req.query.intent : "preview";
    // A render-token request already carries its (server-resolved, trusted)
    // companyId baked into the token - never re-resolved from a real user's
    // roleCode/company assignments, since req.user is a minimal capability
    // context in that case (see authenticateInvoicePrintAccess.js).
    const companyId = req.printRenderToken
      ? req.printRenderToken.companyId
      : await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);

    const viewModel = await InvoicePrintDataService.getInvoicePrintViewModel({
      id,
      companyId,
      requestedTemplateId: req.query.templateId || null,
    });

    await logAudit(pool, {
      module: "TRANSACTIONS.INVOICE",
      entityType: "INVOICE",
      entityId: Number(id),
      action: INTENTS[intent],
      description: `INVOICE #${viewModel.document.invoiceNumber} print-view (intent=${intent})`,
      user: req.user,
      ...requestMeta(req),
    });

    res.json(viewModel);
  } catch (err) {
    console.error("INVOICE PRINT VIEW-MODEL ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to load invoice print data" });
  }
};

// PDF export/preview. Always called by a real logged-in user's own session
// (authenticateToken + authorizePermission, wired in invoicePrint.routes.js)
// - this is the ONLY place that mints a render token, and only after
// confirming the invoice exists/is in this user's company scope through
// the exact same read-only view-model path used for on-screen preview.
// Generating this PDF never mutates the invoice; print_count does not
// exist in this system (see invoicePrintDataService.js), so there is
// nothing to increment here.
exports.exportInvoicePrintPdf = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);

    const viewModel = await InvoicePrintDataService.getInvoicePrintViewModel({
      id,
      companyId,
      requestedTemplateId: req.query.templateId || null,
    });

    const pdfBuffer = await InvoicePrintPdfService.renderInvoicePdf({
      invoiceId: id,
      userId: req.user.id,
      username: req.user.username,
      companyId,
    });

    const disposition = req.query.disposition === "attachment" ? "attachment" : "inline";
    const safeInvoiceNo = String(viewModel.document.invoiceNumber || id).replace(/[^A-Za-z0-9_-]/g, "");
    const filename = `Invoice-${safeInvoiceNo}.pdf`;

    await logAudit(pool, {
      module: "TRANSACTIONS.INVOICE",
      entityType: "INVOICE",
      entityId: Number(id),
      action: "PRINT_EXPORT_PDF",
      description: `INVOICE #${viewModel.document.invoiceNumber} PDF export (disposition=${disposition})`,
      user: req.user,
      ...requestMeta(req),
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `${disposition}; filename="${filename}"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error("INVOICE PDF EXPORT ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to generate invoice PDF" });
  }
};
