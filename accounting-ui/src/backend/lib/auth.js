// Re-exports the enhanced implementation in middleware/authenticate.js
// (adds live status + token_version checks on top of the original
// signature-only verification) so all existing require("../lib/auth")
// call sites keep working unchanged.
module.exports = require("../middleware/authenticate");
