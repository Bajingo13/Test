const pool = require("../db");
const { logAudit, requestMeta } = require("../lib/audit");
const DataService = require("../services/transactionPrintDataService");
const CurrencyService = require("../services/currencyService");
const PrintTemplateService = require("../services/printTemplateService");

const PRINT_ACTIONS = { preview: "PRINT_PREVIEW", print: "PRINT_DOCUMENT", export_pdf: "PRINT_EXPORT_PDF" };
const LIST_ACTIONS = { preview: "PRINT_LIST_PREVIEW", print: "PRINT_LIST", export_pdf: "PRINT_LIST_EXPORT_PDF" };
const MAX_COPIES = 5;

// Copy type/count only affect client-side PDF rendering (see
// documentPdfBuilder.js) - the backend's only involvement is recording
// them in the audit trail, per the spec's "Copy type" audit field.
function sanitizeCopies(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), MAX_COPIES) : 1;
}

exports.getDocument = async (req, res) => {
  try {
    const { transactionType, id } = req.params;
    const mode = req.query.mode === "with_entries" ? "with_entries" : "without_entries";
    const intent = PRINT_ACTIONS[req.query.intent] ? req.query.intent : "preview";
    const copyType = req.query.copyType || "Original";
    const copies = sanitizeCopies(req.query.copies);
    const moduleKey = DataService.MODULE_CONFIG[transactionType]?.moduleKey || transactionType;
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);

    const result = await DataService.getTransactionDocument(transactionType, id, { withEntries: mode === "with_entries", companyId });

    // Phase 2 (Document Print Template Infrastructure): presentation-only
    // config, resolved and attached alongside the accounting data DataService
    // already built above - never merged into doc/lines/entriesSummary, so a
    // template can never influence an accounting value, only how the PDF
    // draws the values DataService already decided. Only invoice/or are in
    // scope for this phase (PrintTemplateService.SUPPORTED_MODULE_TYPES) -
    // every other module keeps templateConfig: null, which
    // documentPdfBuilder.js treats identically to "no template resolved":
    // its own built-in defaults, unchanged from before this checkpoint.
    let templateResolution = null;
    if (PrintTemplateService.SUPPORTED_MODULE_TYPES.includes(transactionType)) {
      templateResolution = await PrintTemplateService.resolveEffectiveConfig({
        companyId,
        moduleType: transactionType,
        requestedTemplateId: req.query.templateId || null,
      });
    }
    result.templateConfig = templateResolution?.config || null;
    result.templateMeta = templateResolution
      ? { source: templateResolution.source, templateId: templateResolution.templateId, templateName: templateResolution.templateName }
      : null;

    await logAudit(pool, {
      module: moduleKey,
      entityType: transactionType.toUpperCase(),
      entityId: Number(id),
      action: PRINT_ACTIONS[intent],
      description: `${transactionType.toUpperCase()} #${result.doc.voucherNo} print (mode=${mode}, intent=${intent}, copyType=${copyType}, copies=${copies})`,
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
    const { from, to, grouping, copyType } = req.body || {};
    const intent = LIST_ACTIONS[req.body?.intent] ? req.body.intent : "preview";
    const copies = sanitizeCopies(req.body?.copies);
    const moduleKey = DataService.MODULE_CONFIG[transactionType]?.moduleKey || transactionType;
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.body?.companyId);

    const result = await DataService.getTransactionList(transactionType, { from, to, grouping, companyId });

    await logAudit(pool, {
      module: moduleKey,
      entityType: `${transactionType.toUpperCase()}_LIST`,
      action: LIST_ACTIONS[intent],
      description: `${transactionType.toUpperCase()} list print (grouping=${grouping}, from=${from || ""}, to=${to || ""}, records=${result.count}, copyType=${copyType || "Original"}, copies=${copies})`,
      user: req.user,
      ...requestMeta(req),
    });

    res.json(result);
  } catch (err) {
    console.error("PRINT LIST ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to load print list data" });
  }
};
