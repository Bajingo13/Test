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

// R5: APPROVED -> CONVERTED with a new Draft APV in the RFP's own company.
exports.convert = async (req, res) => {
  try {
    res.json(await RfpService.convertRfp({ id: req.params.id, body: req.body, user: { ...req.user, ...requestMeta(req) } }));
  } catch (err) {
    sendError(res, err, "Failed to convert the Request for Payment to an APV", "RFP CONVERT ERROR");
  }
};

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

// --- supporting documents -------------------------------------------------

const RfpAttachmentService = require("../services/rfpAttachmentService");
const { contentDisposition } = require("../lib/attachmentFileType");

// Sends a stored attachment: its verified type, always as a download, never
// cached, never sniffed into another type, and sandboxed if opened directly.
function sendAttachment(res, file) {
  res.set({
    "Content-Type": file.mimeType,
    "Content-Length": String(file.buffer.length),
    "Content-Disposition": contentDisposition(file.filename),
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "private, no-store",
    "X-Attachment-SHA256": file.sha256,
  });
  res.end(file.buffer);
}

exports.sendAttachment = sendAttachment;

exports.listAttachments = async (req, res) => {
  try {
    res.json(await RfpAttachmentService.listRfpAttachments({ id: req.params.id, user: req.user }));
  } catch (err) {
    sendError(res, err, "Failed to load the attachments", "RFP ATTACHMENT LIST ERROR");
  }
};

exports.uploadAttachment = async (req, res) => {
  try {
    const result = await RfpAttachmentService.uploadRfpAttachment({
      id: req.params.id,
      user: { ...req.user, ...requestMeta(req) },
      file: req.file,
      body: req.body || {},
    });
    res.status(201).json(result);
  } catch (err) {
    sendError(res, err, "Failed to attach the file", "RFP ATTACHMENT UPLOAD ERROR");
  }
};

exports.downloadAttachment = async (req, res) => {
  try {
    sendAttachment(res, await RfpAttachmentService.downloadRfpAttachment({ id: req.params.id, attachmentId: req.params.attachmentId, user: req.user }));
  } catch (err) {
    sendError(res, err, "Failed to download the attachment", "RFP ATTACHMENT DOWNLOAD ERROR");
  }
};

exports.removeAttachment = async (req, res) => {
  try {
    res.json(await RfpAttachmentService.removeRfpAttachment({ id: req.params.id, attachmentId: req.params.attachmentId, user: { ...req.user, ...requestMeta(req) } }));
  } catch (err) {
    sendError(res, err, "Failed to remove the attachment", "RFP ATTACHMENT REMOVE ERROR");
  }
};

// The APV page reads its source RFP's documents through the conversion link.
exports.listApvAttachments = async (req, res) => {
  try {
    res.json(await RfpAttachmentService.listApvAttachments({ apvId: req.params.id, user: req.user }));
  } catch (err) {
    sendError(res, err, "Failed to load the supporting documents", "APV ATTACHMENT LIST ERROR");
  }
};

exports.downloadApvAttachment = async (req, res) => {
  try {
    sendAttachment(res, await RfpAttachmentService.downloadApvAttachment({ apvId: req.params.id, attachmentId: req.params.attachmentId, user: req.user }));
  } catch (err) {
    sendError(res, err, "Failed to download the supporting document", "APV ATTACHMENT DOWNLOAD ERROR");
  }
};
