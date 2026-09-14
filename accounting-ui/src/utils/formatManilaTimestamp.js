// Display-only "generated on" footer timestamp, fixed to Asia/Manila
// regardless of the viewer's/server's own local timezone, formatted as
// MM/DD/YYYY hh:mm:ss AM/PM. Deliberately kept separate from every
// database/report date serializer (e.g. the plain YYYY-MM-DD
// DATE_FORMAT(...) convention used for atp_date, transaction_date, etc.
// throughout the backend) - this value is never stored, never audited,
// and never compared against anything; it exists purely so a human
// reading a printed page knows roughly when it was produced.
//
// Shared by both PDF-generation code paths in this codebase: the
// pdfkit-based OR/APV/CV/etc. builders (src/print/pdf/documentPdfBuilder.js,
// documentListPdfBuilder.js) and the Puppeteer-rendered Standard Invoice
// printable (StandardInvoicePrintPage.jsx) - previously each used its own
// unlocalized `toLocaleString()`/`toLocaleString("en-PH", {hour12:false})`
// call, so the two footers could show different timezones/formats for the
// same instant.
export function formatManilaTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  // Intl's dayPeriod for en-US is already "AM"/"PM" (no lowercase
  // variant), but normalized defensively since this string is hardcoded
  // into printed/legal-adjacent documents.
  const period = get("dayPeriod").toUpperCase();

  return `${get("month")}/${get("day")}/${get("year")} ${get("hour")}:${get("minute")}:${get("second")} ${period}`;
}
