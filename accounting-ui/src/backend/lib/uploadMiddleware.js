const multer = require("multer");
const path = require("path");

// Shared multer config for the COA/GenLib bulk-import uploads - same shape
// (memory storage, 10MB cap, csv/xls/xlsx only) as the bank-statement
// importer in services/StatementImportService.js, kept as its own small
// instance here rather than reusing that one so this file has no reason to
// change if the bank-recon import ever evolves independently.
const templateImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if ([".csv", ".xls", ".xlsx"].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only .csv, .xls, or .xlsx files are supported"));
    }
  },
});

function handleUpload(uploadMiddleware) {
  return (req, res, next) => {
    uploadMiddleware(req, res, (err) => {
      if (err) {
        return res.status(400).json({ message: err.message || "File upload failed" });
      }
      next();
    });
  };
}

module.exports = { templateImportUpload, handleUpload };
