const RestrictionService = require("../services/restrictionService");

exports.listRestrictions = async (req, res) => {
  try {
    res.json(await RestrictionService.listRestrictions());
  } catch (err) {
    console.error("LIST RESTRICTIONS ERROR:", err.message);
    res.status(500).json({ message: "Failed to load access restrictions" });
  }
};

exports.createRestriction = async (req, res) => {
  try {
    const { userId, permissionId, granted, reason } = req.body;
    res.status(201).json(await RestrictionService.createRestriction({ userId, permissionId, granted, reason, actingUser: req.user }));
  } catch (err) {
    console.error("CREATE RESTRICTION ERROR:", err.message);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to create restriction" });
  }
};

exports.deleteRestriction = async (req, res) => {
  try {
    res.json(await RestrictionService.deleteRestriction(req.params.id, req.user));
  } catch (err) {
    console.error("DELETE RESTRICTION ERROR:", err.message);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to delete restriction" });
  }
};
