const TemplateService = require("../services/templateService");

exports.listTemplates = async (req, res) => {
  try {
    res.json(await TemplateService.listTemplates());
  } catch (err) {
    console.error("LIST TEMPLATES ERROR:", err.message);
    res.status(500).json({ message: "Failed to load permission templates" });
  }
};

exports.getTemplate = async (req, res) => {
  try {
    res.json(await TemplateService.getTemplateItems(req.params.id));
  } catch (err) {
    console.error("GET TEMPLATE ERROR:", err.message);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to load template" });
  }
};

exports.createTemplate = async (req, res) => {
  try {
    const { name, description, grants } = req.body;
    res.status(201).json(await TemplateService.createTemplate({ name, description, grants, actingUser: req.user }));
  } catch (err) {
    console.error("CREATE TEMPLATE ERROR:", err.message);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to create template" });
  }
};

exports.updateTemplate = async (req, res) => {
  try {
    const { name, description, grants } = req.body;
    res.json(await TemplateService.updateTemplate(req.params.id, { name, description, grants }, req.user));
  } catch (err) {
    console.error("UPDATE TEMPLATE ERROR:", err.message);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to update template" });
  }
};

exports.deleteTemplate = async (req, res) => {
  try {
    res.json(await TemplateService.deleteTemplate(req.params.id, req.user));
  } catch (err) {
    console.error("DELETE TEMPLATE ERROR:", err.message);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to delete template" });
  }
};

exports.applyTemplate = async (req, res) => {
  try {
    res.json(await TemplateService.applyTemplateToUser(req.params.id, req.body.userId, req.user));
  } catch (err) {
    console.error("APPLY TEMPLATE ERROR:", err.message);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to apply template" });
  }
};
