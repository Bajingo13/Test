const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const authorizePermission = require("../middleware/authorizePermission");
const ctrl = require("../controllers/rfp.controller");
const { handleAttachmentUpload } = require("../lib/uploadMiddleware");

// Request for Payment (RFP): draft CRUD (R2), workflow actions (R3) and
// conversion of an APPROVED request into a Draft APV (R5, CONVERT). APPROVE
// covers every decision (approve / return / reject); SUBMIT covers the
// requester side (submit / cancel).
router.get("/", authenticateToken, authorizePermission("TRANSACTIONS.RFP", "VIEW"), ctrl.list);
// Before /:id so "lookups" is never read as an RFP id.
router.get("/lookups", authenticateToken, authorizePermission("TRANSACTIONS.RFP", "VIEW"), ctrl.lookups);
router.get("/:id", authenticateToken, authorizePermission("TRANSACTIONS.RFP", "VIEW"), ctrl.get);
router.post("/", authenticateToken, authorizePermission("TRANSACTIONS.RFP", "CREATE"), ctrl.create);
router.put("/:id", authenticateToken, authorizePermission("TRANSACTIONS.RFP", "EDIT"), ctrl.update);
router.delete("/:id", authenticateToken, authorizePermission("TRANSACTIONS.RFP", "DELETE"), ctrl.remove);
router.get("/:id/history", authenticateToken, authorizePermission("TRANSACTIONS.RFP", "VIEW"), ctrl.history);
router.post("/:id/submit", authenticateToken, authorizePermission("TRANSACTIONS.RFP", "SUBMIT"), ctrl.submit);
router.post("/:id/cancel", authenticateToken, authorizePermission("TRANSACTIONS.RFP", "SUBMIT"), ctrl.cancel);
router.post("/:id/approve", authenticateToken, authorizePermission("TRANSACTIONS.RFP", "APPROVE"), ctrl.approve);
router.post("/:id/return", authenticateToken, authorizePermission("TRANSACTIONS.RFP", "APPROVE"), ctrl.return);
router.post("/:id/reject", authenticateToken, authorizePermission("TRANSACTIONS.RFP", "APPROVE"), ctrl.reject);
router.post("/:id/convert", authenticateToken, authorizePermission("TRANSACTIONS.RFP", "CONVERT"), ctrl.convert);

// Supporting documents (receipt images / PDFs). The upload is only read after
// authentication and the EDIT check; the service adds the company scope and
// the DRAFT / RETURNED rule.
router.get("/:id/attachments", authenticateToken, authorizePermission("TRANSACTIONS.RFP", "VIEW"), ctrl.listAttachments);
router.post("/:id/attachments", authenticateToken, authorizePermission("TRANSACTIONS.RFP", "EDIT"), handleAttachmentUpload, ctrl.uploadAttachment);
router.get("/:id/attachments/:attachmentId/download", authenticateToken, authorizePermission("TRANSACTIONS.RFP", "VIEW"), ctrl.downloadAttachment);
router.delete("/:id/attachments/:attachmentId", authenticateToken, authorizePermission("TRANSACTIONS.RFP", "EDIT"), ctrl.removeAttachment);

module.exports = router;
