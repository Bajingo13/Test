const SystemSettingsService = require("../services/systemSettingsService");

exports.getRequire2faGlobally = async (req, res) => {
  try {
    const enabled = await SystemSettingsService.isRequire2faGloballyEnabled();
    res.json({ key: SystemSettingsService.REQUIRE_2FA_GLOBALLY_KEY, enabled });
  } catch (err) {
    console.error("GET SYSTEM SETTING ERROR:", err);
    res.status(500).json({ message: "Failed to load setting." });
  }
};

// Authorization is enforced by requireSuperAdmin on the route
// (systemSettings.routes.js), not here or in any frontend guard - a
// non-superadmin request never reaches this handler at all.
exports.setRequire2faGlobally = async (req, res) => {
  try {
    const enabled = req.body?.enabled;
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ message: "enabled (boolean) is required." });
    }

    const result = await SystemSettingsService.setRequire2faGlobally(enabled, {
      user: req.user,
      ipAddress: req.ip,
      userAgent: req.get?.("user-agent"),
    });

    res.json(result);
  } catch (err) {
    console.error("SET SYSTEM SETTING ERROR:", err);
    res.status(500).json({ message: "Failed to update setting." });
  }
};
