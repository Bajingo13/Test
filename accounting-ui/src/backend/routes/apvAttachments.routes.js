const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const authorizePermission = require("../middleware/authorizePermission");
const ctrl = require("../controllers/rfp.controller");

// Supporting documents of an APV created from a Request for Payment: read
// through rfp_headers.converted_apv_id (the file stays with the RFP; nothing
// is copied). Read-only, APV VIEW, scoped to the APV's company.
router.get("/:id/attachments", authenticateToken, authorizePermission("TRANSACTIONS.APV", "VIEW"), ctrl.listApvAttachments);
router.get("/:id/attachments/:attachmentId/download", authenticateToken, authorizePermission("TRANSACTIONS.APV", "VIEW"), ctrl.downloadApvAttachment);

module.exports = router;
