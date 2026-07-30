const pool = require("../db");
const { logAudit, requestMeta } = require("../lib/audit");
const DataService = require("../services/transactionPrintDataService");

const PRINT_ACTIONS = { preview: "PRINT_PREVIEW", print: "PRINT_DOCUMENT", export_pdf: "PRINT_EXPORT_PDF" };
const LIST_ACTIONS = { preview: "PRINT_LIST_PREVIEW", print: "PRINT_LIST", export_pdf: "PRINT_LIST_EXPORT_PDF" };

exports.getInvoiceDocument = async (req, res) => {
  try {
    const { id } = req.params;
    const mode = req.query.mode === "with_entries" ? "with_entries" : "without_entries";
    const intent = PRINT_ACTIONS[req.query.intent] ? req.query.intent : "preview";

    const result = await DataService.getInvoiceDocument(id, { withEntries: mode === "with_entries" });

    await logAudit(pool, {
      module: "TRANSACTIONS.INVOICE",
      entityType: "INVOICE",
      entityId: Number(id),
      action: PRINT_ACTIONS[intent],
      description: `Invoice #${result.invoice.voucherNo} print (mode=${mode}, intent=${intent})`,
      user: req.user,
      ...requestMeta(req),
    });

    res.json(result);
  } catch (err) {
    console.error("PRINT INVOICE DOCUMENT ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to load invoice print data" });
  }
};

exports.getInvoiceList = async (req, res) => {
  try {
    const { from, to, customerId, grouping } = req.body || {};
    const safeGrouping = ["number", "date", "customer"].includes(grouping) ? grouping : "number";
    const intent = LIST_ACTIONS[req.body?.intent] ? req.body.intent : "preview";

    const result = await DataService.getInvoiceList({ from, to, customerId, grouping: safeGrouping });

    await logAudit(pool, {
      module: "TRANSACTIONS.INVOICE",
      entityType: "INVOICE_LIST",
      action: LIST_ACTIONS[intent],
      description: `Invoice list print (grouping=${safeGrouping}, from=${from || ""}, to=${to || ""}, customerId=${customerId || ""}, records=${result.count})`,
      user: req.user,
      ...requestMeta(req),
    });

    res.json(result);
  } catch (err) {
    console.error("PRINT INVOICE LIST ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to load invoice list print data" });
  }
};
