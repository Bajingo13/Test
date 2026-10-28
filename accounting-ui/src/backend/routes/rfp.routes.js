const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const authorizePermission = require("../middleware/authorizePermission");
const ctrl = require("../controllers/rfp.controller");

// Request for Payment (RFP): draft CRUD (R2) and workflow actions (R3).
// Conversion to APV is R5. APPROVE covers every decision (approve /
// return / reject); SUBMIT covers the requester side (submit / cancel).
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

module.exports = router;
