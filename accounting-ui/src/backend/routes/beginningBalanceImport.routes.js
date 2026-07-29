const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const { templateImportUpload, handleUpload } = require("../lib/uploadMiddleware");
const ctrl = require("../controllers/beginningBalanceImportController");

router.get("/:module/template", authenticateToken, ctrl.getTemplate);
router.post(
  "/:module/import/preview",
  authenticateToken,
  handleUpload(templateImportUpload.single("file")),
  ctrl.previewImport
);
router.post("/:module/import/commit", authenticateToken, ctrl.commitImport);
router.get("/:module/import-history", authenticateToken, ctrl.getImportHistory);
router.get("/:module/import/:batchId/errors", authenticateToken, ctrl.getBatchErrors);

module.exports = router;
