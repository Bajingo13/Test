const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const authorizePermission = require("../middleware/authorizePermission");
const { templateImportUpload, handleUpload } = require("../lib/uploadMiddleware");
const ctrl = require("../controllers/beginningBalanceImportController");

router.get("/:module/template", authenticateToken, authorizePermission("FILESETUP.BEGINNING_BALANCES", "VIEW"), ctrl.getTemplate);
router.post(
  "/:module/import/preview",
  authenticateToken,
  authorizePermission("FILESETUP.BEGINNING_BALANCES", "CREATE"),
  handleUpload(templateImportUpload.single("file")),
  ctrl.previewImport
);
router.post("/:module/import/commit", authenticateToken, authorizePermission("FILESETUP.BEGINNING_BALANCES", "CREATE"), ctrl.commitImport);
router.get("/:module/import-history", authenticateToken, authorizePermission("FILESETUP.BEGINNING_BALANCES", "VIEW"), ctrl.getImportHistory);
router.get("/:module/import/:batchId/errors", authenticateToken, authorizePermission("FILESETUP.BEGINNING_BALANCES", "VIEW"), ctrl.getBatchErrors);

module.exports = router;
