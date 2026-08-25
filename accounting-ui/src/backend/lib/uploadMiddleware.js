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

// COA-specific import instance (audit checkpoint): the shared
// templateImportUpload above still accepts .xls because /api/genlib/import
// also uses it and is out of scope for this fix - changing that instance
// would silently change GenLib's accepted formats too. COA's own parser
// (ExcelJS's workbook.xlsx.load()) never actually supported legacy binary
// .xls despite the old shared filter advertising it, so COA gets its own
// narrower instance instead of quietly breaking or widening GenLib.
const coaImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if ([".csv", ".xlsx"].includes(ext)) {
      cb(null, true);
    } else if (ext === ".xls") {
      cb(new Error("Legacy .xls files are not supported. Please save the file as .xlsx or .csv and try again."));
    } else {
      cb(new Error("Only .csv or .xlsx files are supported"));
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

module.exports = { templateImportUpload, coaImportUpload, handleUpload };
