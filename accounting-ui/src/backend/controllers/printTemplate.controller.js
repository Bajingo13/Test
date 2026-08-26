const pool = require("../db");
const { logAudit, requestMeta } = require("../lib/audit");
const Service = require("../services/printTemplateService");
const CurrencyService = require("../services/currencyService");
const DataService = require("../services/transactionPrintDataService");
const { HttpError } = require("../lib/httpError");

async function resolveCompanyId(req) {
  return CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId || req.body?.companyId);
}

exports.list = async (req, res) => {
  try {
    const companyId = await resolveCompanyId(req);
    const templates = await Service.listTemplates({ companyId, moduleType: req.query.moduleType });
    res.json(templates);
  } catch (err) {
    console.error("PRINT TEMPLATE LIST ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to list print templates" });
  }
};

exports.getOne = async (req, res) => {
  try {
    const companyId = await resolveCompanyId(req);
    const template = await Service.getTemplateById(req.params.id, companyId);
    res.json(template);
  } catch (err) {
    console.error("PRINT TEMPLATE GET ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to load print template" });
  }
};

exports.create = async (req, res) => {
  try {
    const companyId = await resolveCompanyId(req);
    const template = await Service.createTemplate(req.body, req.user.id, companyId);

    await logAudit(pool, {
      module: "PRINT.DOCUMENT_TEMPLATES",
      entityType: "PRINT_TEMPLATE",
      entityId: template.id,
      action: "CREATE",
      description: `Created print template "${template.templateName}" (${template.moduleType}/${template.documentVariant})`,
      user: req.user,
      afterData: template,
      ...requestMeta(req),
    });

    res.status(201).json(template);
  } catch (err) {
    console.error("PRINT TEMPLATE CREATE ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to create print template" });
  }
};

exports.update = async (req, res) => {
  try {
    const companyId = await resolveCompanyId(req);
    const before = await Service.getTemplateById(req.params.id, companyId);
    const template = await Service.updateTemplate(req.params.id, req.body, req.user.id, companyId);

    await logAudit(pool, {
      module: "PRINT.DOCUMENT_TEMPLATES",
      entityType: "PRINT_TEMPLATE",
      entityId: template.id,
      action: "EDIT",
      description: `Updated print template "${template.templateName}"`,
      user: req.user,
      beforeData: before,
      afterData: template,
      ...requestMeta(req),
    });

    res.json(template);
  } catch (err) {
    console.error("PRINT TEMPLATE UPDATE ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to update print template" });
  }
};

exports.setDefault = async (req, res) => {
  try {
    const companyId = await resolveCompanyId(req);
    const template = await Service.setDefault(req.params.id, companyId, req.user.id);

    await logAudit(pool, {
      module: "PRINT.DOCUMENT_TEMPLATES",
      entityType: "PRINT_TEMPLATE",
      entityId: template.id,
      action: "SET_DEFAULT",
      description: `Set "${template.templateName}" as the default ${template.moduleType} print template`,
      user: req.user,
      ...requestMeta(req),
    });

    res.json(template);
  } catch (err) {
    console.error("PRINT TEMPLATE SET DEFAULT ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to set default print template" });
  }
};

exports.activate = async (req, res) => {
  try {
    const companyId = await resolveCompanyId(req);
    const template = await Service.setActive(req.params.id, true, companyId, req.user.id);

    await logAudit(pool, {
      module: "PRINT.DOCUMENT_TEMPLATES",
      entityType: "PRINT_TEMPLATE",
      entityId: template.id,
      action: "ACTIVATE",
      description: `Activated print template "${template.templateName}"`,
      user: req.user,
      ...requestMeta(req),
    });

    res.json(template);
  } catch (err) {
    console.error("PRINT TEMPLATE ACTIVATE ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to activate print template" });
  }
};

// Phase 3B: read-only preview of an UNSAVED template config against a real
// transaction's real accounting data. Never writes anything - no template
// row, no transaction change. Config is validated through the exact same
// mergeAndValidateConfig() create/update already use, so a preview can
// never accept a shape create/update would reject (and can never be used
// to smuggle a wider config surface in through a side door). Accounting
// data comes entirely from DataService.getTransactionDocument() - the same
// read-only path the real /api/print/:type/:id endpoint uses - so nothing
// in the response's doc/lines/entriesSummary/appliedInvoices/currency was
// ever influenced by the client-supplied config.
exports.preview = async (req, res) => {
  try {
    const { moduleType, transactionId, config } = req.body || {};
    if (!transactionId) {
      throw new HttpError(400, "transactionId is required.");
    }
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.body?.companyId);

    const normalizedConfig = Service.mergeAndValidateConfig(moduleType, config);
    const result = await DataService.getTransactionDocument(moduleType, transactionId, { withEntries: false, companyId });

    result.templateConfig = normalizedConfig;
    result.templateMeta = { source: "preview", templateId: null, templateName: null };

    await logAudit(pool, {
      module: "PRINT.DOCUMENT_TEMPLATES",
      entityType: moduleType.toUpperCase(),
      entityId: Number(transactionId),
      action: "PREVIEW",
      description: `Previewed unsaved ${moduleType} print template config against ${moduleType} #${result.doc.voucherNo}`,
      user: req.user,
      ...requestMeta(req),
    });

    res.json(result);
  } catch (err) {
    console.error("PRINT TEMPLATE PREVIEW ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to generate preview" });
  }
};

// Phase 3B: exposes printTemplateService's own builtInDefaultConfig() -
// the exact same function resolveEffectiveConfig() falls back to when no
// DB template exists - so the Builder's "Reset to System Default" and
// built-in preview can never drift from what an unconfigured company
// actually gets printed today. Never a second copy of this object.
exports.getBuiltIn = async (req, res) => {
  try {
    const moduleType = req.query.moduleType;
    if (!Service.SUPPORTED_MODULE_TYPES.includes(moduleType)) {
      throw new HttpError(400, `Unsupported print-template module type: ${moduleType}. Supported: ${Service.SUPPORTED_MODULE_TYPES.join(", ")}.`);
    }
    const config = Service.builtInDefaultConfig(moduleType);
    res.json({ moduleType, config, source: "built_in", templateId: null, templateName: null });
  } catch (err) {
    console.error("PRINT TEMPLATE BUILT-IN ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to load built-in default" });
  }
};

exports.deactivate = async (req, res) => {
  try {
    const companyId = await resolveCompanyId(req);
    const template = await Service.setActive(req.params.id, false, companyId, req.user.id);

    await logAudit(pool, {
      module: "PRINT.DOCUMENT_TEMPLATES",
      entityType: "PRINT_TEMPLATE",
      entityId: template.id,
      action: "DEACTIVATE",
      description: `Deactivated print template "${template.templateName}"`,
      user: req.user,
      ...requestMeta(req),
    });

    res.json(template);
  } catch (err) {
    console.error("PRINT TEMPLATE DEACTIVATE ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to deactivate print template" });
  }
};
