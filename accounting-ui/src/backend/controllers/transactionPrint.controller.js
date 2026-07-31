const pool = require("../db");
const { logAudit, requestMeta } = require("../lib/audit");
const DataService = require("../services/transactionPrintDataService");

const PRINT_ACTIONS = { preview: "PRINT_PREVIEW", print: "PRINT_DOCUMENT", export_pdf: "PRINT_EXPORT_PDF" };
const LIST_ACTIONS = { preview: "PRINT_LIST_PREVIEW", print: "PRINT_LIST", export_pdf: "PRINT_LIST_EXPORT_PDF" };

exports.getDocument = async (req, res) => {
  try {
    const { transactionType, id } = req.params;
    const mode = req.query.mode === "with_entries" ? "with_entries" : "without_entries";
    const intent = PRINT_ACTIONS[req.query.intent] ? req.query.intent : "preview";
    const moduleKey = DataService.MODULE_CONFIG[transactionType]?.moduleKey || transactionType;

    const result = await DataService.getTransactionDocument(transactionType, id, { withEntries: mode === "with_entries" });

    await logAudit(pool, {
      module: moduleKey,
      entityType: transactionType.toUpperCase(),
      entityId: Number(id),
      action: PRINT_ACTIONS[intent],
      description: `${transactionType.toUpperCase()} #${result.doc.voucherNo} print (mode=${mode}, intent=${intent})`,
      user: req.user,
      ...requestMeta(req),
    });

    res.json(result);
  } catch (err) {
    console.error("PRINT DOCUMENT ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to load print data" });
  }
};

exports.getList = async (req, res) => {
  try {
    const { transactionType } = req.params;
    const { from, to, grouping } = req.body || {};
    const intent = LIST_ACTIONS[req.body?.intent] ? req.body.intent : "preview";
    const moduleKey = DataService.MODULE_CONFIG[transactionType]?.moduleKey || transactionType;

    const result = await DataService.getTransactionList(transactionType, { from, to, grouping });

    await logAudit(pool, {
      module: moduleKey,
      entityType: `${transactionType.toUpperCase()}_LIST`,
      action: LIST_ACTIONS[intent],
      description: `${transactionType.toUpperCase()} list print (grouping=${grouping}, from=${from || ""}, to=${to || ""}, records=${result.count})`,
      user: req.user,
      ...requestMeta(req),
    });

    res.json(result);
  } catch (err) {
    console.error("PRINT LIST ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to load print list data" });
  }
};
