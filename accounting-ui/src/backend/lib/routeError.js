// One safe error answer for route handlers (D1).
//   - An error that carries an HTTP status below 500 (an HttpError such as a
//     403 "You do not have access to this company", a 404, a 409) keeps that
//     status, its message and its code - an authorization refusal is never
//     turned into a 500.
//   - Anything else is a genuine server error: a generic message only. The
//     internal detail (SQL text, stack, err.message) goes to the server log,
//     never to the client.
function sendRouteError(res, err, label, fallbackMessage) {
  const status = Number(err && err.statusCode);
  if (status >= 400 && status < 500) {
    return res.status(status).json({ message: err.message, ...(err.code ? { code: err.code } : {}) });
  }
  console.error(`${label}:`, err && err.stack ? err.stack : err);
  return res.status(500).json({ message: fallbackMessage });
}

module.exports = { sendRouteError };
