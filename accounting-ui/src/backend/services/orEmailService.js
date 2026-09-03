// Batch 8: pure helpers for the Official Receipt email endpoint
// (POST /api/or/:id/email). No DB, no SMTP - just recipient precedence,
// subject/body text, and a safe attachment filename. Unit-tested directly.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(value) {
  return typeof value === "string" && EMAIL_RE.test(value.trim());
}

// Recipient precedence (Batch 8 spec):
//   1. explicit request-body override (`to`)
//   2. the customer's general_libraries.email
//   3. otherwise -> null  (caller returns 400 EMAIL_RECIPIENT_REQUIRED)
// A syntactically invalid override is a client error - it does NOT
// silently fall through to the library address.
function resolveRecipient({ requestTo, customerEmail }) {
  const override = requestTo == null ? "" : String(requestTo).trim();
  if (override) {
    return { email: isValidEmail(override) ? override : null, source: "request", valid: isValidEmail(override) };
  }
  const lib = customerEmail == null ? "" : String(customerEmail).trim();
  if (lib) {
    return { email: isValidEmail(lib) ? lib : null, source: "general_library", valid: isValidEmail(lib) };
  }
  return { email: null, source: "none", valid: false };
}

// Cross-platform-safe filename: replace any run of whitespace, path
// separator, reserved char (\ / : * ? " < > |), space or dot with a
// single "-", trim leading/trailing "-", cap length. Always ends ".pdf".
function safePdfFilename(base) {
  const cleaned = String(base == null ? "" : base)
    .replace(/[\s\\/:*?"<>|. -]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
    .replace(/-+$/g, "");
  return `${cleaned || "document"}.pdf`;
}

function orEmailSubject(voucherNo, companyName) {
  const co = companyName ? `${companyName} - ` : "";
  return `${co}Official Receipt ${voucherNo || ""}`.trim();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function orEmailBody({ voucherNo, customerName, companyName, transactionDate, amountText, customMessage }) {
  const lines = [`Dear ${customerName || "Customer"},`, ""];
  if (customMessage && String(customMessage).trim()) {
    lines.push(String(customMessage).trim(), "");
  }
  lines.push(
    `Please find attached Official Receipt ${voucherNo || ""}` +
      (transactionDate ? ` dated ${transactionDate}` : "") +
      (amountText ? ` for ${amountText}` : "") +
      "."
  );
  lines.push("", "Regards,", companyName || "Accounting");
  const text = lines.join("\n");
  const paragraphs = text
    .split("\n\n")
    .map((p) => `<p>${p.split("\n").map(escapeHtml).join("<br>")}</p>`)
    .join("");
  return { text, html: paragraphs };
}

module.exports = { isValidEmail, resolveRecipient, safePdfFilename, orEmailSubject, orEmailBody };
