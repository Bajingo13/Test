import { createPdfKit, COLORS, wrapText, formatMoney } from "./pdfKit";

const STATUS_WATERMARKS = { DRAFT: "DRAFT", CANCELLED: "CANCELLED", VOID: "VOID" };

// Builds one Invoice document PDF - "without entries" (customer-facing,
// description + amount only) or "with entries" (adds the Accounting
// Entries section: account code/title, debit, credit, balanced status).
// mode is enforced server-side too (see transactionPrint.routes.js) - this
// function only ever receives data the backend already decided the caller
// is allowed to see.
export async function buildInvoicePdf({ invoice, lines, entriesSummary, customer, company, mode, generatedBy }) {
  const withEntries = mode === "with_entries";
  const kit = await createPdfKit();
  const { marginX, pageWidth } = kit;
  const contentWidth = pageWidth - marginX * 2;

  // Company header
  kit.drawText(company?.name || "AstreaBlue Accounting System", marginX, { bold: true, size: 14 });
  kit.moveDown(16);
  if (company?.address) {
    kit.drawText(company.address, marginX, { size: 9, color: COLORS.grey });
    kit.moveDown(12);
  }
  if (company?.tin) {
    kit.drawText(`TIN: ${company.tin}`, marginX, { size: 9, color: COLORS.grey });
    kit.moveDown(12);
  }

  kit.drawRight(withEntries ? "INVOICE (ACCOUNTING COPY)" : "INVOICE", marginX + contentWidth, {
    bold: true,
    size: 16,
    y: kit.getY() + 28,
  });
  kit.drawRight(`No. ${invoice.voucherNo || "-"}`, marginX + contentWidth, { size: 10, y: kit.getY() + 14 });

  kit.moveDown(14);
  kit.drawLine({ x1: marginX, x2: marginX + contentWidth, thickness: 1, color: COLORS.accent });
  kit.moveDown(16);

  // Invoice meta (2 columns)
  const metaLeftX = marginX;
  const metaRightX = marginX + contentWidth / 2;
  const metaTopY = kit.getY();

  kit.drawText("Invoice Date", metaLeftX, { size: 8, bold: true, color: COLORS.grey });
  kit.drawText("Due Date", metaRightX, { size: 8, bold: true, color: COLORS.grey });
  kit.moveDown(12);
  kit.drawText(invoice.transactionDate || "-", metaLeftX, { size: 10 });
  kit.drawText(invoice.dueDate || "-", metaRightX, { size: 10 });
  kit.moveDown(16);

  kit.drawText("Reference No.", metaLeftX, { size: 8, bold: true, color: COLORS.grey });
  kit.drawText("Status", metaRightX, { size: 8, bold: true, color: COLORS.grey });
  kit.moveDown(12);
  kit.drawText(invoice.referenceNo || "-", metaLeftX, { size: 10 });
  kit.drawText(invoice.status || "-", metaRightX, { size: 10 });
  kit.moveDown(20);

  // Customer block
  kit.drawRect({ x: marginX, w: contentWidth, h: 2, color: COLORS.lightGrey, yPos: kit.getY() + 6 });
  kit.drawText("Bill To", marginX, { size: 8, bold: true, color: COLORS.grey });
  kit.moveDown(13);
  kit.drawText(customer?.name || invoice.customerName || "-", marginX, { size: 11, bold: true });
  kit.moveDown(13);
  if (customer) {
    const addressParts = [customer.address1, customer.address2, customer.address3].filter(Boolean);
    for (const part of addressParts) {
      kit.drawText(part, marginX, { size: 9, color: COLORS.grey });
      kit.moveDown(12);
    }
    if (customer.tin) {
      kit.drawText(`TIN: ${customer.tin}`, marginX, { size: 9, color: COLORS.grey });
      kit.moveDown(12);
    }
    const contact = customer.telephone || customer.mobile || customer.email;
    if (contact) {
      kit.drawText(contact, marginX, { size: 9, color: COLORS.grey });
      kit.moveDown(12);
    }
  }
  kit.moveDown(10);

  // Line items table
  const col = withEntries
    ? { desc: marginX, acct: marginX + 220, debit: marginX + 340, credit: marginX + 420, right: marginX + contentWidth }
    : { desc: marginX, right: marginX + contentWidth };

  function drawTableHeader() {
    kit.drawRect({ x: marginX, w: contentWidth, h: 20, color: COLORS.accent, yPos: kit.getY() - 15 });
    kit.drawText("Description", col.desc + 6, { size: 8.5, bold: true, color: COLORS.white });
    if (withEntries) {
      kit.drawText("Account", col.acct, { size: 8.5, bold: true, color: COLORS.white });
      kit.drawRight("Debit", col.debit + 60, { size: 8.5, bold: true, color: COLORS.white });
      kit.drawRight("Credit", col.credit + 60, { size: 8.5, bold: true, color: COLORS.white });
    } else {
      kit.drawRight("Amount", col.right - 4, { size: 8.5, bold: true, color: COLORS.white });
    }
    kit.moveDown(20);
  }

  kit.ensureRoom(30);
  drawTableHeader();

  for (const line of lines) {
    const descLines = wrapText(line.particulars || "-", kit.font, 9, withEntries ? 200 : contentWidth - 100);
    const rowHeight = Math.max(16, descLines.length * 11 + 6);
    if (kit.ensureRoom(rowHeight + 4)) {
      drawTableHeader();
    }

    const rowTopY = kit.getY();
    descLines.forEach((dl, idx) => {
      kit.drawText(dl, col.desc + 6, { size: 9, y: rowTopY - 11 - idx * 11 });
    });

    if (withEntries) {
      kit.drawText(line.accountCode || "-", col.acct, { size: 8.5, y: rowTopY - 11 });
      kit.drawText(line.accountTitle || "", col.acct, { size: 7.5, y: rowTopY - 22, color: COLORS.grey });
      kit.drawRight(line.debit ? formatMoney(line.debit) : "", col.debit + 60, { size: 9, y: rowTopY - 11 });
      kit.drawRight(line.credit ? formatMoney(line.credit) : "", col.credit + 60, { size: 9, y: rowTopY - 11 });
    } else {
      kit.drawRight(formatMoney(line.amount), col.right - 4, { size: 9, y: rowTopY - 11 });
    }

    kit.moveDown(rowHeight);
    kit.drawLine({ x1: marginX, x2: marginX + contentWidth, color: COLORS.border });
    kit.moveDown(4);
  }

  kit.moveDown(10);

  // Totals
  kit.ensureRoom(90);
  const totalsLabelX = marginX + contentWidth - 160;
  kit.drawRight("Total Amount", totalsLabelX + 90, { size: 9.5, color: COLORS.grey });
  kit.drawRight(`P ${formatMoney(invoice.totalDebit)}`, marginX + contentWidth, { size: 9.5, bold: true });
  kit.moveDown(14);
  kit.drawRight("Paid", totalsLabelX + 90, { size: 9.5, color: COLORS.grey });
  kit.drawRight(`P ${formatMoney(invoice.paidAmount)}`, marginX + contentWidth, { size: 9.5 });
  kit.moveDown(14);
  kit.drawLine({ x1: totalsLabelX, x2: marginX + contentWidth, color: COLORS.dark });
  kit.moveDown(4);
  kit.drawRight("Balance Due", totalsLabelX + 90, { size: 10.5, bold: true });
  kit.drawRight(`P ${formatMoney(invoice.balanceAmount)}`, marginX + contentWidth, { size: 10.5, bold: true });
  kit.moveDown(24);

  if (invoice.remarks) {
    kit.ensureRoom(30);
    kit.drawText("Remarks", marginX, { size: 8, bold: true, color: COLORS.grey });
    kit.moveDown(12);
    kit.drawText(invoice.remarks, marginX, { size: 9 });
    kit.moveDown(20);
  }

  // Accounting entries section (with_entries only)
  if (withEntries && entriesSummary) {
    kit.ensureRoom(60);
    kit.drawLine({ x1: marginX, x2: marginX + contentWidth, thickness: 1, color: COLORS.accent });
    kit.moveDown(16);
    kit.drawText("Accounting Entries Summary", marginX, { size: 10, bold: true });
    kit.moveDown(16);
    kit.drawText("Total Debit", marginX, { size: 8.5, color: COLORS.grey });
    kit.drawText("Total Credit", marginX + 150, { size: 8.5, color: COLORS.grey });
    kit.drawText("Status", marginX + 300, { size: 8.5, color: COLORS.grey });
    kit.moveDown(12);
    kit.drawText(formatMoney(entriesSummary.totalDebit), marginX, { size: 10, bold: true });
    kit.drawText(formatMoney(entriesSummary.totalCredit), marginX + 150, { size: 10, bold: true });
    kit.drawText(entriesSummary.balanced ? "BALANCED" : "UNBALANCED", marginX + 300, {
      size: 10,
      bold: true,
      color: entriesSummary.balanced ? COLORS.dark : COLORS.danger,
    });
    kit.moveDown(24);
  }

  // Signature section
  kit.ensureRoom(70);
  const sigWidth = contentWidth / 3 - 10;
  const sigLabels = ["Prepared By", "Approved By", "Received By"];
  const sigTopY = kit.getY();
  sigLabels.forEach((label, idx) => {
    const x = marginX + idx * (sigWidth + 15);
    kit.drawLine({ x1: x, x2: x + sigWidth, yPos: sigTopY, color: COLORS.dark });
    kit.drawText(label, x, { size: 8, color: COLORS.grey, y: sigTopY - 12 });
  });
  kit.moveDown(50);

  const watermark = STATUS_WATERMARKS[String(invoice.status || "").toUpperCase()];
  const generatedAt = new Date().toLocaleString("en-PH", { hour12: false });

  return kit.finish({ generatedBy, generatedAt, watermark });
}
