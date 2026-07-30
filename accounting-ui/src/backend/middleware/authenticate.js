const jwt = require("jsonwebtoken");
const pool = require("../db");

// Strict superset of the original lib/auth.js authenticateToken: still
// verifies the JWT signature/expiry exactly as before, but additionally
// re-checks the user fresh from the DB on every request (status +
// token_version) so deactivation and "revoke sessions" take effect
// immediately instead of waiting up to 1 day for the JWT to expire on its
// own. req.user gains roleId/roleCode/status on top of the original
// id/username/role claims - nothing existing that reads req.user.id /
// req.user.username / req.user.role is affected.
async function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ message: "Access token required" });
  }

  jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
    if (err) {
      return res.status(403).json({ message: "Invalid or expired token" });
    }

    try {
      const [rows] = await pool.execute(
        `SELECT u.id, u.username, u.status, u.token_version, r.id AS role_id, r.code AS role_code
         FROM users u LEFT JOIN roles r ON r.id = u.role_id
         WHERE u.id = ?`,
        [decoded.id]
      );
      const user = rows[0];

      if (!user) {
        return res.status(403).json({ message: "Invalid or expired token" });
      }
      if (user.status !== "ACTIVE") {
        return res.status(403).json({ message: "Account is not active" });
      }
      // Tokens signed before this middleware existed carry no `tv` claim -
      // treat that as version 0, matching the column's DEFAULT 0, so
      // already-issued tokens for still-current users keep working.
      const tokenVersion = decoded.tv ?? 0;
      if (tokenVersion !== user.token_version) {
        return res.status(403).json({ message: "Session has been revoked - please log in again" });
      }

      req.user = {
        id: user.id,
        username: user.username,
        role: decoded.role,
        roleId: user.role_id,
        roleCode: user.role_code,
        status: user.status,
      };
      next();
    } catch (dbErr) {
      console.error("AUTHENTICATE MIDDLEWARE ERROR:", dbErr);
      res.status(500).json({ message: "Failed to verify session" });
    }
  });
}

module.exports = { authenticateToken };
