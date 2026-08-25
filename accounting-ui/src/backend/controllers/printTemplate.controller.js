const pool = require("../db");
const { logAudit, requestMeta } = require("../lib/audit");
const Service = require("../services/printTemplateService");
const CurrencyService = require("../services/currencyService");

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
