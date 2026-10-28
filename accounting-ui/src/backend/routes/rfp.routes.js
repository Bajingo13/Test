const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const authorizePermission = require("../middleware/authorizePermission");
const ctrl = require("../controllers/rfp.controller");

// Request for Payment (RFP) - R2: draft CRUD only. Workflow (submit /
// approve / return / reject / cancel) is R3, conversion to APV is R5.
router.get("/", authenticateToken, authorizePermission("TRANSACTIONS.RFP", "VIEW"), ctrl.list);
router.get("/:id", authenticateToken, authorizePermission("TRANSACTIONS.RFP", "VIEW"), ctrl.get);
router.post("/", authenticateToken, authorizePermission("TRANSACTIONS.RFP", "CREATE"), ctrl.create);
router.put("/:id", authenticateToken, authorizePermission("TRANSACTIONS.RFP", "EDIT"), ctrl.update);
router.delete("/:id", authenticateToken, authorizePermission("TRANSACTIONS.RFP", "DELETE"), ctrl.remove);

module.exports = router;
