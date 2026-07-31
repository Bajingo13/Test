import { createPdfKit, COLORS, wrapText, formatMoney } from "./pdfKit";

const STATUS_WATERMARKS = { DRAFT: "DRAFT", CANCELLED: "CANCELLED", VOID: "VOID" };

// Presentation-only lookup (labels), separate from MODULE_CONFIG on the
// backend (which is about tables/columns) - the backend never has to know
// how a module's document is titled or what its party role is called.
const MODULE_META = {
  invoice: { documentLabel: "INVOICE", partyRoleLabel: "Bill To" },
  or: { documentLabel: "OFFICIAL RECEIPT", partyRoleLabel: "Received From" },
  apv: { documentLabel: "AP VOUCHER", partyRoleLabel: "Pay To" },
  cv: { documentLabel: "CHECK VOUCHER", partyRoleLabel: "Payee" },
};

// Builds one transaction document PDF - "without entries" (customer/
// supplier-facing, description + amount only) or "with entries" (adds the
// Accounting Entries section: account code/title, debit, credit, balanced
// status). Shared across every module opted into the printing framework
// (Invoice today, OR/APV/CV added in Phase 2) - which fields exist on
// `doc` (dueDate, paidAmount/balanceAmount, checkNo/checkDate,
// paymentMethod) varies per module and is handled by presence checks, not
// per-module copies of this function.
//
// mode is enforced server-side too (see transactionPrint.routes.js) - this
// function only ever receives data the backend already decided the caller
// is allowed to see.
export async function buildDocumentPdf({ transactionType, doc, lines, entriesSummary, party, bankAccount, company, mode, generatedBy }) {
  const { documentLabel, partyRoleLabel } = MODULE_META[transactionType] || { documentLabel: "TRANSACTION", partyRoleLabel: "Party" };
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

  kit.drawRight(withEntries ? `${documentLabel} (ACCOUNTING COPY)` : documentLabel, marginX + contentWidth, {
    bold: true,
    size: 16,
    y: kit.getY() + 28,
  });
  kit.drawRight(`No. ${doc.voucherNo || "-"}`, marginX + contentWidth, { size: 10, y: kit.getY() + 14 });

  kit.moveDown(14);
  kit.drawLine({ x1: marginX, x2: marginX + contentWidth, thickness: 1, color: COLORS.accent });
  kit.moveDown(16);

  // Meta block - built from whichever optional fields this module's `doc` has
  const metaPairs = [["Date", doc.transactionDate || "-"]];
  if (doc.dueDate) metaPairs.push(["Due Date", doc.dueDate]);
  metaPairs.push(["Reference No.", doc.referenceNo || "-"]);
  if (doc.checkNo) metaPairs.push(["Check No.", doc.checkNo]);
  if (doc.checkDate) metaPairs.push(["Check Date", doc.checkDate]);
  if (doc.paymentMethod) metaPairs.push(["Payment Method", doc.paymentMethod]);
  if (bankAccount) metaPairs.push(["Bank Account", `${bankAccount.bankCode} - ${bankAccount.bankName} (${bankAccount.accountNo})`]);
  metaPairs.push(["Status", doc.status || "-"]);

  const metaColWidth = contentWidth / 2;
  for (let i = 0; i < metaPairs.length; i += 2) {
    const [label1, value1] = metaPairs[i];
    const pair2 = metaPairs[i + 1];
    kit.drawText(label1, marginX, { size: 8, bold: true, color: COLORS.grey });
    if (pair2) kit.drawText(pair2[0], marginX + metaColWidth, { size: 8, bold: true, color: COLORS.grey });
    kit.moveDown(12);
    kit.drawText(value1, marginX, { size: 10 });
    if (pair2) kit.drawText(pair2[1], marginX + metaColWidth, { size: 10 });
    kit.moveDown(16);
  }

  // Party block
  kit.drawText(partyRoleLabel, marginX, { size: 8, bold: true, color: COLORS.grey });
  kit.moveDown(13);
  kit.drawText(party?.name || doc.partyName || "-", marginX, { size: 11, bold: true });
  kit.moveDown(13);
  if (party) {
    const addressParts = [party.address1, party.address2, party.address3].filter(Boolean);
    for (const part of addressParts) {
      kit.drawText(part, marginX, { size: 9, color: COLORS.grey });
      kit.moveDown(12);
    }
    if (party.tin) {
      kit.drawText(`TIN: ${party.tin}`, marginX, { size: 9, color: COLORS.grey });
      kit.moveDown(12);
    }
    const contact = party.telephone || party.mobile || party.email;
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
  kit.drawRight(`P ${formatMoney(doc.totalDebit)}`, marginX + contentWidth, { size: 9.5, bold: true });
  kit.moveDown(14);

  if (doc.paidAmount !== undefined) {
    kit.drawRight("Paid", totalsLabelX + 90, { size: 9.5, color: COLORS.grey });
    kit.drawRight(`P ${formatMoney(doc.paidAmount)}`, marginX + contentWidth, { size: 9.5 });
    kit.moveDown(14);
    kit.drawLine({ x1: totalsLabelX, x2: marginX + contentWidth, color: COLORS.dark });
    kit.moveDown(4);
    kit.drawRight("Balance Due", totalsLabelX + 90, { size: 10.5, bold: true });
    kit.drawRight(`P ${formatMoney(doc.balanceAmount)}`, marginX + contentWidth, { size: 10.5, bold: true });
    kit.moveDown(24);
  } else {
    kit.moveDown(10);
  }

  if (doc.remarks) {
    kit.ensureRoom(30);
    kit.drawText("Remarks", marginX, { size: 8, bold: true, color: COLORS.grey });
    kit.moveDown(12);
    kit.drawText(doc.remarks, marginX, { size: 9 });
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

  const watermark = STATUS_WATERMARKS[String(doc.status || "").toUpperCase()];
  const generatedAt = new Date().toLocaleString("en-PH", { hour12: false });

  return kit.finish({ generatedBy, generatedAt, watermark });
}
