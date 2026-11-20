// Company Branch Management API (master data). Permission checks: route-level
// authorizePermission for VIEW / CREATE / EDIT; the status change checks
// ACTIVATE or DEACTIVATE here because the required action depends on the body
// (same pattern as currency.controller.js). Company isolation lives in
// branchService (server-side, every call).
const pool = require("../db");
const { logAudit, requestMeta } = require("../lib/audit");
const PermissionService = require("../services/permissionService");
const BranchService = require("../services/branchService");

async function requirePermission(req, res, action) {
  const allowed = req.user.roleCode === "SUPER_ADMIN" || (await PermissionService.can(req.user.id, BranchService.MODULE, action));
  if (!allowed) {
    await logAudit(pool, {
      module: "ACCESS_CONTROL",
      entityType: "PERMISSION",
      entityId: null,
      action: "ACCESS_DENIED",
      description: `User ${req.user.username} was denied ${action} on ${BranchService.MODULE}`,
      afterData: { moduleKey: BranchService.MODULE, action, path: req.originalUrl, method: req.method },
      user: req.user,
    });
    res.status(403).json({ message: "You do not have permission to perform this action" });
    return false;
  }
  return true;
}

function handleError(res, err, fallbackMessage) {
  if (!err.statusCode) console.error(fallbackMessage, err);
  res.status(err.statusCode || 500).json(err.statusCode ? { message: err.message, code: err.code } : { message: fallbackMessage });
}

const actor = (req) => ({ ...req.user, ...requestMeta(req) });

exports.list = async (req, res) => {
  try {
    res.json(await BranchService.listBranches(req.user, { companyId: req.query.companyId, status: req.query.status, search: req.query.search }));
  } catch (err) {
    handleError(res, err, "Failed to load branches.");
  }
};

exports.get = async (req, res) => {
  try {
    res.json(await BranchService.getBranch(req.user, req.params.id));
  } catch (err) {
    handleError(res, err, "Failed to load branch.");
  }
};

exports.create = async (req, res) => {
  try {
    const branch = await BranchService.createBranch(actor(req), req.body || {});
    res.status(201).json({ message: "Branch created.", branch });
  } catch (err) {
    handleError(res, err, "Failed to create branch.");
  }
};

exports.update = async (req, res) => {
  try {
    const branch = await BranchService.updateBranch(actor(req), req.params.id, req.body || {});
    res.json({ message: "Branch updated.", branch });
  } catch (err) {
    handleError(res, err, "Failed to update branch.");
  }
};

exports.setStatus = async (req, res) => {
  try {
    const status = String(req.body?.status || "").trim().toUpperCase();
    if (!BranchService.STATUSES.includes(status)) {
      return res.status(400).json({ message: "status must be ACTIVE or INACTIVE.", code: "BRANCH_STATUS_INVALID" });
    }
    if (!(await requirePermission(req, res, status === "ACTIVE" ? "ACTIVATE" : "DEACTIVATE"))) return;
    const { branch, changed } = await BranchService.setBranchStatus(actor(req), req.params.id, status);
    res.json({ message: changed ? `Branch ${status === "ACTIVE" ? "activated" : "deactivated"}.` : `Branch is already ${status}.`, branch, changed });
  } catch (err) {
    handleError(res, err, "Failed to change branch status.");
  }
};
