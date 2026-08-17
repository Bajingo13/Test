const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const authorizePermission = require("../middleware/authorizePermission");
const { templateImportUpload, handleUpload } = require("../lib/uploadMiddleware");
const ctrl = require("../controllers/exchangeRate.controller");

const MODULE_KEY = "FILESETUP.CURRENCY_SETUP";
const requirePerm = (action) => authorizePermission(MODULE_KEY, action);

// Normal transaction users may select a currency and view its rate
// (section 44) - gated on VIEW, not REFRESH_RATE, since this never
// persists anything (see the handler's own comment).
router.post("/resolve", authenticateToken, requirePerm("VIEW"), ctrl.resolve);
router.post("/refresh", authenticateToken, requirePerm("REFRESH_RATE"), ctrl.refresh);
router.post("/refresh-all", authenticateToken, requirePerm("REFRESH_RATE"), ctrl.refreshAll);
router.post("/official-rate", authenticateToken, requirePerm("ENTER_OFFICIAL_RATE"), ctrl.officialRateEntry);
router.post("/import/preview", authenticateToken, requirePerm("IMPORT_RATES"), handleUpload(templateImportUpload.single("file")), ctrl.importPreview);
router.post("/import/confirm", authenticateToken, requirePerm("IMPORT_RATES"), ctrl.importConfirm);
router.get("/policy/:companyId", authenticateToken, requirePerm("VIEW"), ctrl.getPolicy);
router.put("/policy/:companyId", authenticateToken, requirePerm("CONFIGURE_PROVIDER"), ctrl.updatePolicy);
router.get("/provider-status", authenticateToken, requirePerm("VIEW_PROVIDER_STATUS"), ctrl.providerStatus);
router.get("/derivation/:rateId", authenticateToken, requirePerm("RATE_HISTORY"), ctrl.getDerivation);
router.patch("/:rateId/approve", authenticateToken, requirePerm("APPROVE_RATE"), ctrl.approveRate);

module.exports = router;
