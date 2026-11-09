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

// Supporting documents (RFP receipts): same memory storage as the imports,
// one file per request, 10 MB cap. The extension filter here only refuses
// obviously wrong files before their bytes are buffered; the real check is
// on the content (lib/attachmentFileType.js validateAttachmentFile).
const { MAX_ATTACHMENT_BYTES, SUPPORTED_TEXT, isAllowedExtension } = require("./attachmentFileType");

const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  // Browsers send the filename as UTF-8 (multer would read it as Latin-1).
  defParamCharset: "utf8",
  // Busboy stops AT its limit, so allow one byte more here; a file of exactly
  // 10 MB is accepted and anything larger is refused (413) - by multer while
  // streaming, or by validateAttachmentFile.
  limits: { fileSize: MAX_ATTACHMENT_BYTES + 1, files: 1, fields: 5, fieldSize: 1024, parts: 6 },
  fileFilter: (req, file, cb) => {
    if (isAllowedExtension(file.originalname)) cb(null, true);
    else cb(Object.assign(new Error(`Only ${SUPPORTED_TEXT} files can be attached.`), { statusCode: 415 }));
  },
});

// Upload errors as clear 4xx responses: too large -> 413, wrong type -> 415,
// anything else about the multipart body -> 400.
function handleAttachmentUpload(req, res, next) {
  attachmentUpload.single("file")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ message: "The file is larger than the 10 MB limit." });
    if (err.statusCode) return res.status(err.statusCode).json({ message: err.message });
    if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
      return res.status(400).json({ message: "Attach one file at a time, in the \"file\" field." });
    }
    return res.status(400).json({ message: "The upload could not be read." });
  });
}

module.exports = { templateImportUpload, coaImportUpload, handleUpload, attachmentUpload, handleAttachmentUpload };
