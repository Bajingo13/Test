// Who may manage usernames and passwords - a per-deployment policy.
//
// OFF (default; every deployment that does not set the variable) - exactly the
// de8b06a behaviour: only a SUPER_ADMIN may change their own username/password
// (Account Security); nobody can set another user's credentials.
//
// ON  (ADMIN_CREDENTIAL_MANAGEMENT=enabled - set on the ALAS deployment only):
//   SUPER_ADMIN - own credentials (Account Security) and any other user's
//                 (User List -> Reset Password / Change Username).
//   ADMIN       - own credentials, and the users an Admin already manages
//                 (userService MANAGEABLE_ROLES_BY_ACTOR: Accountants who share a
//                 company with them). Never a SUPER_ADMIN.
//   ACCOUNTANT  - none: cannot change their own username or password and cannot
//                 touch anyone else's. Sign-in and first-time invitation setup are
//                 unaffected (they never go through these endpoints).
//
// Read on every request (not cached), so the variable is the single switch.
// The notification e-mail (Account Security) stays SUPER_ADMIN-only either way.

const FLAG = "ADMIN_CREDENTIAL_MANAGEMENT";

function adminCredentialManagementEnabled() {
  return String(process.env[FLAG] || "").trim().toLowerCase() === "enabled";
}

function selfServiceRoles() {
  return adminCredentialManagementEnabled() ? ["SUPER_ADMIN", "ADMIN"] : ["SUPER_ADMIN"];
}

function canChangeOwnCredentials(roleCode) {
  return selfServiceRoles().includes(roleCode);
}

// Administrative changes to ANOTHER user. Which targets are allowed is decided
// by userService's existing manage scope; this is only the actor-role gate.
function canManageOthersCredentials(roleCode) {
  return adminCredentialManagementEnabled() && ["SUPER_ADMIN", "ADMIN"].includes(roleCode);
}

// What the browser is told (GET /api/me/permissions) so it can show the forms.
function capabilitiesFor(roleCode) {
  return {
    changeOwnCredentials: canChangeOwnCredentials(roleCode),
    manageUserCredentials: canManageOthersCredentials(roleCode),
    notificationEmail: roleCode === "SUPER_ADMIN",
  };
}

// Route guard for the self-service endpoints (after authenticateToken).
function requireSelfServiceRole(req, res, next) {
  if (!req.user) return res.status(401).json({ message: "Access token required" });
  if (!canChangeOwnCredentials(req.user.roleCode)) {
    return res.status(403).json({ message: "You are not allowed to change account credentials.", code: "CREDENTIAL_CHANGE_NOT_ALLOWED" });
  }
  next();
}

// Administrative endpoints, first guard (BEFORE authenticateToken): when the
// policy is OFF the endpoints do not exist - 404 for everyone, as in de8b06a.
function requireCredentialAdminEnabled(req, res, next) {
  if (!adminCredentialManagementEnabled()) return res.status(404).json({ message: "Not found" });
  next();
}

// Administrative endpoints, second guard (after authenticateToken): actor role.
function requireCredentialAdmin(req, res, next) {
  if (!adminCredentialManagementEnabled()) return res.status(404).json({ message: "Not found" });
  if (!req.user) return res.status(401).json({ message: "Access token required" });
  if (!canManageOthersCredentials(req.user.roleCode)) {
    return res.status(403).json({ message: "You are not allowed to manage user credentials.", code: "CREDENTIAL_ADMIN_NOT_ALLOWED" });
  }
  next();
}

module.exports = {
  FLAG,
  adminCredentialManagementEnabled,
  selfServiceRoles,
  canChangeOwnCredentials,
  canManageOthersCredentials,
  capabilitiesFor,
  requireSelfServiceRole,
  requireCredentialAdminEnabled,
  requireCredentialAdmin,
};
