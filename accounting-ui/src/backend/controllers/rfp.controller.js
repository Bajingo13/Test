const RfpService = require("../services/rfpService");
const { requestMeta } = require("../lib/audit");

// Known errors carry a statusCode (400/403/404/409) and a safe message;
// anything else is an unexpected server error and its details (SQL text,
// stack) are logged, never returned.
function sendError(res, err, fallback, tag) {
  if (err.statusCode) return res.status(err.statusCode).json({ message: err.message });
  console.error(`${tag}:`, err);
  return res.status(500).json({ message: fallback });
}

exports.list = async (req, res) => {
  try {
    res.json(await RfpService.listRfps({ user: req.user, query: req.query }));
  } catch (err) {
    sendError(res, err, "Failed to load Requests for Payment", "RFP LIST ERROR");
  }
};

exports.get = async (req, res) => {
  try {
    res.json(await RfpService.getRfp({ id: req.params.id, user: req.user }));
  } catch (err) {
    sendError(res, err, "Failed to load the Request for Payment", "RFP GET ERROR");
  }
};

exports.create = async (req, res) => {
  try {
    const result = await RfpService.createRfp({ body: req.body, user: { ...req.user, ...requestMeta(req) } });
    res.status(201).json(result);
  } catch (err) {
    sendError(res, err, "Failed to create the Request for Payment", "RFP CREATE ERROR");
  }
};

exports.update = async (req, res) => {
  try {
    res.json(await RfpService.updateRfp({ id: req.params.id, body: req.body, user: { ...req.user, ...requestMeta(req) } }));
  } catch (err) {
    sendError(res, err, "Failed to update the Request for Payment", "RFP UPDATE ERROR");
  }
};

exports.remove = async (req, res) => {
  try {
    res.json(await RfpService.deleteRfp({ id: req.params.id, user: { ...req.user, ...requestMeta(req) } }));
  } catch (err) {
    sendError(res, err, "Failed to delete the Request for Payment", "RFP DELETE ERROR");
  }
};

// Workflow actions (R3): the route names the action, the service decides
// the target status. Only an optional / required "note" is accepted.
function workflow(action, fallback) {
  return async (req, res) => {
    try {
      res.json(await RfpService.transitionRfp({ id: req.params.id, action, body: req.body, user: { ...req.user, ...requestMeta(req) } }));
    } catch (err) {
      sendError(res, err, fallback, `RFP ${action} ERROR`);
    }
  };
}

exports.submit = workflow("SUBMIT", "Failed to submit the Request for Payment");
exports.approve = workflow("APPROVE", "Failed to approve the Request for Payment");
exports.return = workflow("RETURN", "Failed to return the Request for Payment");
exports.reject = workflow("REJECT", "Failed to reject the Request for Payment");
exports.cancel = workflow("CANCEL", "Failed to cancel the Request for Payment");

exports.history = async (req, res) => {
  try {
    res.json(await RfpService.getRfpHistory({ id: req.params.id, user: req.user }));
  } catch (err) {
    sendError(res, err, "Failed to load the Request for Payment history", "RFP HISTORY ERROR");
  }
};

exports.lookups = async (req, res) => {
  try {
    res.json(await RfpService.getLookups({ user: req.user, query: req.query }));
  } catch (err) {
    sendError(res, err, "Failed to load the Request for Payment form options", "RFP LOOKUPS ERROR");
  }
};
