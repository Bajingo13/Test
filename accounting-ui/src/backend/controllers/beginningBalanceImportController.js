const TemplateService = require("../services/beginningBalanceTemplateService");
const ImportService = require("../services/beginningBalanceImportService");

const SUPPORTED_MODULES = ["gl", "ar", "ap"];

function checkModule(req, res) {
  const { module } = req.params;
  if (!SUPPORTED_MODULES.includes(module)) {
    res.status(400).json({ message: `Unsupported module "${module}"` });
    return null;
  }
  return module;
}

exports.getTemplate = async (req, res) => {
  const module = checkModule(req, res);
  if (!module) return;

  try {
    const format = req.query.format === "csv" ? "csv" : "xlsx";
    const output = await TemplateService.buildTemplate(module, format);
    const filenameBase = `${module.toUpperCase()}_Beginning_Balance_Template`;

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filenameBase}.csv"`);
      res.send(output);
    } else {
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader("Content-Disposition", `attachment; filename="${filenameBase}.xlsx"`);
      res.send(Buffer.from(output));
    }
  } catch (err) {
    console.error("BEGINNING BALANCE TEMPLATE ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to generate template" });
  }
};

exports.previewImport = async (req, res) => {
  const module = checkModule(req, res);
  if (!module) return;

  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const duplicateMode = req.body.duplicateMode === "SKIP_EXISTING" ? "SKIP_EXISTING" : "REJECT";

    const result = await ImportService.previewImport({
      module,
      buffer: req.file.buffer,
      filename: req.file.originalname,
      duplicateMode,
      user: req.user,
    });

    res.json({ success: true, ...result });
  } catch (err) {
    console.error("BEGINNING BALANCE PREVIEW ERROR:", err);
    res
      .status(err.statusCode || 500)
      .json({ message: err.message || "Failed to preview import", headers: err.headers });
  }
};

exports.commitImport = async (req, res) => {
  const module = checkModule(req, res);
  if (!module) return;

  try {
    const { batchId } = req.body;
    if (!batchId) {
      return res.status(400).json({ message: "batchId is required" });
    }

    const result = await ImportService.commitImport({ module, batchId, user: req.user });
    res.json(result);
  } catch (err) {
    console.error("BEGINNING BALANCE COMMIT ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to commit import" });
  }
};
