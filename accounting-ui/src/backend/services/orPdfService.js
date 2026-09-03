const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

// Batch 8: server-side render of the customer-facing Official Receipt PDF
// for POST /api/or/:id/email.
//
// The DATA is the existing print framework's
// (transactionPrintDataService.getTransactionDocument("or", id)) - same
// accounting content, company profile, currency, applied invoices and
// Phase 7K.1 reversal linkage the browser print uses. Only the *drawing*
// is done here in CommonJS with pdf-lib directly: the rich browser
// renderer (src/print/pdf/documentPdfBuilder.js) is an ES module inside a
// "type": "module" directory and cannot be required from this CJS server /
// the CJS Jest runtime. Unifying the two renderers is a follow-up once the
// print module is migrated off that .js-in-a-type:module-dir hybrid.
//
// This mirrors documentPdfBuilder's "without entries" copy: header, party,
// a description+amount line table, totals, a status line, and - new for
// Batch 8 - a "REVERSED BY <JV>" note + REVERSED watermark for a
// closed-period-reversed voucher.

const STATUS_WATERMARKS = { DRAFT: "DRAFT", CANCELLED: "CANCELLED", VOID: "VOID" };

// Pure, unit-testable: an explicit status watermark (DRAFT/CANCELLED/VOID)
// wins; a still-Posted-but-reversed document gets "REVERSED"; otherwise no
// watermark. Same rule as src/print/pdf/documentPdfBuilder.js.
function resolveWatermark(status, reversal) {
  return (
    STATUS_WATERMARKS[String(status || "").toUpperCase()] ||
    (reversal && reversal.reversed ? "REVERSED" : null)
  );
}

// Pure: the "Reversed By <JV> on <date>" line, or null.
function reversalNote(reversal) {
  if (!reversal || !reversal.reversed) return null;
  return `${reversal.reversedByVoucher || "-"}${reversal.reversalDate ? ` on ${reversal.reversalDate}` : ""}`;
}

function money(n) {
  const v = Number(n) || 0;
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function buildOrPdf({ doc, lines = [], party, company, reversal = null }) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]); // A4, matching documentPdfBuilder
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const dark = rgb(0.06, 0.09, 0.16);
  const grey = rgb(0.42, 0.45, 0.5);

  const marginX = 40;
  const rightEdge = 595.28 - marginX;
  let y = 841.89 - 50;

  const text = (s, x, yy, opts = {}) =>
    page.drawText(String(s ?? ""), { x, y: yy, size: opts.size || 10, font: opts.bold ? bold : font, color: opts.color || dark });
  const right = (s, xr, yy, opts = {}) => {
    const f = opts.bold ? bold : font;
    const size = opts.size || 10;
    const str = String(s ?? "");
    text(str, xr - f.widthOfTextAtSize(str, size), yy, opts);
  };

  text(company?.name || "OFFICIAL RECEIPT", marginX, y, { size: 14, bold: true });
  right("OFFICIAL RECEIPT", rightEdge, y, { size: 14, bold: true, color: grey });
  y -= 18;
  if (company?.address) { text(company.address, marginX, y, { size: 9, color: grey }); y -= 12; }
  if (company?.tin) { text(`TIN: ${company.tin}`, marginX, y, { size: 9, color: grey }); y -= 12; }
  y -= 8;

  text(`OR No.`, marginX, y, { size: 9, bold: true, color: grey });
  text(doc.voucherNo || "-", marginX + 70, y, { size: 10 });
  right("Date", rightEdge - 120, y, { size: 9, bold: true, color: grey });
  right(doc.transactionDate || "-", rightEdge, y, { size: 10 });
  y -= 16;
  text("Status", marginX, y, { size: 9, bold: true, color: grey });
  text(doc.status || "-", marginX + 70, y, { size: 10 });
  y -= 16;
  const revNote = reversalNote(reversal);
  if (revNote) {
    text("Reversed By", marginX, y, { size: 9, bold: true, color: rgb(0.72, 0.11, 0.11) });
    text(revNote, marginX + 70, y, { size: 10, color: rgb(0.72, 0.11, 0.11) });
    y -= 16;
  }

  if (party) {
    y -= 6;
    text("Received From", marginX, y, { size: 9, bold: true, color: grey });
    y -= 13;
    text(party.name || doc.customerName || "-", marginX, y, { size: 10 });
    y -= 12;
    if (party.tin) { text(`TIN: ${party.tin}`, marginX, y, { size: 9, color: grey }); y -= 12; }
    const addr = [party.address1, party.address2, party.address3].filter(Boolean).join(", ") || party.address;
    if (addr) { text(addr, marginX, y, { size: 9, color: grey }); y -= 12; }
  }

  y -= 14;
  page.drawRectangle({ x: marginX, y: y - 4, width: rightEdge - marginX, height: 20, color: rgb(0.95, 0.95, 0.96) });
  text("Particulars", marginX + 6, y, { size: 9, bold: true });
  right("Amount", rightEdge - 6, y, { size: 9, bold: true });
  y -= 22;

  // "without entries": one customer-facing amount per line (the populated side).
  for (const l of lines) {
    const amt = (Number(l.debit) || 0) + (Number(l.credit) || 0);
    text(l.particulars || l.accountTitle || "-", marginX + 6, y, { size: 9.5 });
    right(money(amt), rightEdge - 6, y, { size: 9.5 });
    y -= 16;
    if (y < 90) { y = 841.89 - 50; pdf.addPage([595.28, 841.89]); }
  }

  y -= 8;
  page.drawLine({ start: { x: rightEdge - 200, y: y + 10 }, end: { x: rightEdge, y: y + 10 }, thickness: 1, color: dark });
  right("Total", rightEdge - 120, y, { size: 11, bold: true });
  right(money(doc.totalDebit ?? doc.totalCredit ?? 0), rightEdge, y, { size: 11, bold: true });

  const watermark = resolveWatermark(doc.status, reversal);
  if (watermark) {
    for (const p of pdf.getPages()) {
      p.drawText(watermark, {
        x: p.getWidth() / 2 - 110, y: p.getHeight() / 2, size: 60, font: bold,
        color: rgb(0.85, 0.1, 0.1), opacity: 0.12, rotate: { type: "degrees", angle: 35 },
      });
    }
  }

  return pdf.save(); // Uint8Array
}

module.exports = { buildOrPdf, resolveWatermark, reversalNote, STATUS_WATERMARKS };
