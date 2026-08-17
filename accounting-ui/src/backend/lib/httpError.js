class HttpError extends Error {
  constructor(statusCode, message, code) {
    super(message);
    this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

module.exports = { HttpError };
