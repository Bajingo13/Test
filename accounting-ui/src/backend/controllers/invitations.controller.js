const InvitationService = require("../services/invitationService");

exports.createInvitation = async (req, res) => {
  try {
    const { email, fullName, roleId, companyIds, branchIds, expiresInDays } = req.body;
    const result = await InvitationService.createInvitation({
      email, fullName, roleId, companyIds, branchIds, expiresInDays,
      actingUser: req.user,
    });
    res.status(201).json({ success: true, ...result });
  } catch (err) {
    console.error("CREATE INVITATION ERROR:", err.message);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to create invitation" });
  }
};

exports.listInvitations = async (req, res) => {
  try {
    res.json(await InvitationService.listInvitations(req.user));
  } catch (err) {
    console.error("LIST INVITATIONS ERROR:", err.message);
    res.status(500).json({ message: "Failed to load invitations" });
  }
};

exports.resendInvitation = async (req, res) => {
  try {
    res.json({ success: true, ...(await InvitationService.resendInvitation(req.params.id, req.user)) });
  } catch (err) {
    console.error("RESEND INVITATION ERROR:", err.message);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to resend invitation" });
  }
};

exports.revokeInvitation = async (req, res) => {
  try {
    res.json({ success: true, ...(await InvitationService.revokeInvitation(req.params.id, req.user)) });
  } catch (err) {
    console.error("REVOKE INVITATION ERROR:", err.message);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to revoke invitation" });
  }
};

// Public - the invited user isn't logged in yet.
exports.validateToken = async (req, res) => {
  try {
    res.json(await InvitationService.validateToken(req.params.token));
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to validate invitation" });
  }
};

// Public.
exports.acceptInvitation = async (req, res) => {
  try {
    const { token, password, acceptedTerms } = req.body;
    const result = await InvitationService.acceptInvitation({ token, password, acceptedTerms });

    const jwt = require("jsonwebtoken");
    const authToken = jwt.sign(
      { id: result.userId, username: result.username, role: "user", tv: 0 },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.status(201).json({
      success: true,
      message: "Account activated successfully",
      token: authToken,
      user: { id: result.userId, username: result.username },
    });
  } catch (err) {
    console.error("ACCEPT INVITATION ERROR:", err.message);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to accept invitation" });
  }
};
