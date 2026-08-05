import { createPdfKit, COLORS, wrapText, formatMoney, COPY_BADGE_HEIGHT } from "./pdfKit";
import { DEFAULT_COPY_TYPE, MAX_COPIES } from "../copyTypes";

const STATUS_WATERMARKS = { DRAFT: "DRAFT", CANCELLED: "CANCELLED", VOID: "VOID" };

// Presentation-only lookup (labels), separate from MODULE_CONFIG on the
// backend (which is about tables/columns) - the backend never has to know
// how a module's document is titled or what its party role is called.
const MODULE_META = {
  invoice: { documentLabel: "INVOICE", partyRoleLabel: "Bill To" },
  or: { documentLabel: "OFFICIAL RECEIPT", partyRoleLabel: "Received From" },
  apv: { documentLabel: "AP VOUCHER", partyRoleLabel: "Pay To" },
  cv: { documentLabel: "CHECK VOUCHER", partyRoleLabel: "Payee" },
  // JV has no party role at all - see partyRoleLabel: null handling below.
  jv: { documentLabel: "JOURNAL VOUCHER", partyRoleLabel: null },
  po: { documentLabel: "PURCHASE ORDER", partyRoleLabel: "Supplier" },
};

// Builds one transaction document PDF - "without entries" (customer/
// supplier-facing, description + amount only) or "with entries" (adds the
// Accounting Entries section: account code/title, debit, credit, balanced
// status). Shared across every module opted into the printing framework -
// which fields exist on `doc` (dueDate, paidAmount/balanceAmount,
// checkNo/checkDate, paymentMethod) varies per module and is handled by
// presence checks, not per-module copies of this function.
//
// mode is enforced server-side too (see transactionPrint.routes.js) - this
// function only ever receives data the backend already decided the caller
// is allowed to see.
export async function buildDocumentPdf({
  transactionType,
  doc,
  lines,
  entriesSummary,
  party,
  bankAccount,
  company,
  mode,
  generatedBy,
  copyType = DEFAULT_COPY_TYPE,
  copies = 1,
}) {
  const { documentLabel, partyRoleLabel } = MODULE_META[transactionType] || { documentLabel: "TRANSACTION", partyRoleLabel: "Party" };
  const withEntries = mode === "with_entries";
  const kit = await createPdfKit();
  const { marginX, pageWidth } = kit;
  const contentWidth = pageWidth - marginX * 2;
  const rightEdge = marginX + contentWidth;
  const copyCount = Math.min(Math.max(Number(copies) || 1, 1), MAX_COPIES);

  for (let copyIndex = 0; copyIndex < copyCount; copyIndex++) {
    if (copyIndex > 0) kit.forcePageBreak();
    drawOneCopy();
  }

  const watermark = STATUS_WATERMARKS[String(doc.status || "").toUpperCase()];
  const generatedAt = new Date().toLocaleString("en-PH", { hour12: false });
  return kit.finish({ generatedBy, generatedAt, watermark });

  // Draws `text` (word-wrapped to maxWidth) starting at the CURRENT cursor,
  // advances the cursor past every line it drew, and returns how many
  // lines it used. Shared by every long-text field below (company name,
  // party name, address lines) so wrapping/line-advancing logic isn't
  // repeated per field.
  function drawWrappedBlock(text, x, { size = 9.5, bold = false, color = COLORS.dark, maxWidth = contentWidth, lineHeight } = {}) {
    if (!text) return 0;
    const useFont = bold ? kit.boldFont : kit.font;
    const wrapped = wrapText(text, useFont, size, maxWidth);
    const step = lineHeight || size + 3;
    const topY = kit.getY();
    wrapped.forEach((ln, idx) => {
      kit.drawText(ln, x, { size, bold, color, y: topY - idx * step });
    });
    kit.setY(topY - wrapped.length * step);
    return wrapped.length;
  }

  // One full copy of the document - called copyCount times above, each
  // starting on its own fresh page via forcePageBreak().
  function drawOneCopy() {
    // ---- Header: two independently-flowing columns reconciled at the end,
    // so neither can overlap the other regardless of how many lines either
    // side needs (long company address vs. short one, long title vs. short). ----
    const headerTopY = kit.getY();

    // Right column: copy badge -> title -> (accounting-copy qualifier) -> voucher number.
    kit.drawCopyBadge(copyType, { topY: headerTopY });
    let rightY = headerTopY - COPY_BADGE_HEIGHT - 17;
    kit.drawRight(documentLabel, rightEdge, { bold: true, size: 16, y: rightY });
    rightY -= 18;
    if (withEntries) {
      kit.drawRight("ACCOUNTING COPY — INTERNAL USE", rightEdge, { size: 7.5, bold: true, color: COLORS.danger, y: rightY });
      rightY -= 13;
    }
    kit.drawRight(`No. ${doc.voucherNo || "-"}`, rightEdge, { size: 10, color: COLORS.grey, y: rightY });
    rightY -= 6;
    const rightColumnBottomY = rightY;

    // Left column: company name/address/TIN, flowing normally from the same top anchor.
    kit.setY(headerTopY);
    drawWrappedBlock(company?.name || "AstreaBlue Accounting System", marginX, { bold: true, size: 14, maxWidth: contentWidth * 0.55, lineHeight: 16 });
    kit.moveDown(2);
    if (company?.address) {
      drawWrappedBlock(company.address, marginX, { size: 9, color: COLORS.grey, maxWidth: contentWidth * 0.55, lineHeight: 12 });
      kit.moveDown(2);
    }
    if (company?.tin) {
      kit.drawText(`TIN: ${company.tin}`, marginX, { size: 9, color: COLORS.grey });
      kit.moveDown(12);
    }
    const leftColumnBottomY = kit.getY();

    // Reconcile: continue from whichever column ran deeper, plus a clear gap.
    kit.setY(Math.min(leftColumnBottomY, rightColumnBottomY) - 14);
    kit.drawLine({ x1: marginX, x2: rightEdge, thickness: 1, color: COLORS.accent });
    kit.moveDown(18);

    // ---- Document info: clean two-column grid ----
    const metaPairs = [["Date", doc.transactionDate || "-"]];
    if (doc.dueDate) metaPairs.push(["Due Date", doc.dueDate]);
    metaPairs.push(["Reference No.", doc.referenceNo || "-"]);
    if (doc.checkNo) metaPairs.push(["Check No.", doc.checkNo]);
    if (doc.checkDate) metaPairs.push(["Check Date", doc.checkDate]);
    if (doc.paymentMethod) metaPairs.push(["Payment Method", doc.paymentMethod]);
    if (bankAccount) metaPairs.push(["Bank Account", `${bankAccount.bankCode} - ${bankAccount.bankName} (${bankAccount.accountNo})`]);
    if (doc.preparedFor) metaPairs.push(["Prepared For", doc.preparedFor]);
    metaPairs.push(["Status", doc.status || "-"]);

    const metaColWidth = contentWidth / 2;
    const metaColGap = 16;
    for (let i = 0; i < metaPairs.length; i += 2) {
      const [label1, value1] = metaPairs[i];
      const pair2 = metaPairs[i + 1];
      kit.drawText(label1, marginX, { size: 8, bold: true, color: COLORS.grey });
      if (pair2) kit.drawText(pair2[0], marginX + metaColWidth, { size: 8, bold: true, color: COLORS.grey });
      kit.moveDown(12);
      const rowTop = kit.getY();
      const linesUsed1 = drawWrappedBlock(value1, marginX, { size: 10, maxWidth: metaColWidth - metaColGap, lineHeight: 13 });
      let linesUsed2 = 0;
      if (pair2) {
        kit.setY(rowTop);
        linesUsed2 = drawWrappedBlock(pair2[1], marginX + metaColWidth, { size: 10, maxWidth: metaColWidth - metaColGap, lineHeight: 13 });
      }
      kit.setY(rowTop - Math.max(linesUsed1, linesUsed2, 1) * 13 - 6);
    }
    kit.moveDown(6);

    // ---- Party block (Bill To / Pay To / Payee / Received From) - full
    // width below the date grid, skipped entirely for modules with no
    // party role (JV). ----
    if (partyRoleLabel) {
      kit.drawText(partyRoleLabel, marginX, { size: 8, bold: true, color: COLORS.grey });
      kit.moveDown(13);
      drawWrappedBlock(party?.name || doc.partyName || "-", marginX, { size: 11, bold: true, lineHeight: 13 });
      kit.moveDown(2);
      if (party) {
        const addressParts = [party.address1, party.address2, party.address3].filter(Boolean);
        for (const part of addressParts) {
          drawWrappedBlock(part, marginX, { size: 9, color: COLORS.grey, lineHeight: 11 });
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
      kit.moveDown(8);
    }

    // ---- Line items table - explicit proportional column widths ----
    const col = withEntries
      ? {
          descX: marginX,
          descWidth: contentWidth * 0.40 - 10,
          acctX: marginX + contentWidth * 0.42,
          acctWidth: contentWidth * 0.26 - 8,
          debitRight: marginX + contentWidth * 0.74,
          creditRight: marginX + contentWidth * 0.90,
        }
      : {
          descX: marginX,
          descWidth: contentWidth * 0.76,
        };

    function drawTableHeader() {
      kit.drawRect({ x: marginX, w: contentWidth, h: 20, color: COLORS.accent, yPos: kit.getY() - 15 });
      kit.drawText("Description", col.descX + 6, { size: 8.5, bold: true, color: COLORS.white });
      if (withEntries) {
        kit.drawText("Account", col.acctX, { size: 8.5, bold: true, color: COLORS.white });
        kit.drawRight("Debit", col.debitRight, { size: 8.5, bold: true, color: COLORS.white });
        kit.drawRight("Credit", col.creditRight, { size: 8.5, bold: true, color: COLORS.white });
      } else {
        kit.drawRight("Amount", rightEdge - 4, { size: 8.5, bold: true, color: COLORS.white });
      }
      kit.moveDown(20);
    }

    kit.ensureRoom(30);
    drawTableHeader();

    const LINE_STEP = 11;
    for (const line of lines) {
      const descLines = wrapText(line.particulars || "-", kit.font, 9, col.descWidth);
      const hasAcctTitle = withEntries && !!line.accountTitle;
      const acctTitleLines = hasAcctTitle ? wrapText(line.accountTitle, kit.font, 7.5, col.acctWidth) : [];
      const acctLineCount = withEntries ? 1 + acctTitleLines.length : 0;
      const contentLineCount = Math.max(descLines.length, acctLineCount, 1);
      const rowHeight = Math.max(16, contentLineCount * LINE_STEP + 6);

      if (kit.ensureRoom(rowHeight + 4)) drawTableHeader();

      const rowTopY = kit.getY();
      descLines.forEach((dl, idx) => {
        kit.drawText(dl, col.descX + 6, { size: 9, y: rowTopY - LINE_STEP - idx * LINE_STEP });
      });

      if (withEntries) {
        kit.drawText(line.accountCode || "-", col.acctX, { size: 8.5, y: rowTopY - LINE_STEP });
        acctTitleLines.forEach((tl, idx) => {
          kit.drawText(tl, col.acctX, { size: 7.5, y: rowTopY - LINE_STEP * (2 + idx), color: COLORS.grey });
        });
        kit.drawRight(line.debit ? formatMoney(line.debit) : "", col.debitRight, { size: 9, y: rowTopY - LINE_STEP });
        kit.drawRight(line.credit ? formatMoney(line.credit) : "", col.creditRight, { size: 9, y: rowTopY - LINE_STEP });
      } else {
        kit.drawRight(formatMoney(line.amount), rightEdge - 4, { size: 9, y: rowTopY - LINE_STEP });
      }

      kit.moveDown(rowHeight);
      kit.drawLine({ x1: marginX, x2: rightEdge, color: COLORS.border });
      kit.moveDown(4);
    }

    kit.moveDown(10);

    // ---- Totals - dedicated right-aligned block ----
    kit.ensureRoom(100);
    const totalsLabelRight = marginX + contentWidth * 0.72;

    kit.drawRight("Total Amount", totalsLabelRight, { size: 9.5, color: COLORS.grey });
    kit.drawRight(`P ${formatMoney(doc.totalDebit)}`, rightEdge, { size: 9.5, bold: true });
    kit.moveDown(16);

    if (doc.paidAmount !== undefined) {
      kit.drawRight("Paid", totalsLabelRight, { size: 9.5, color: COLORS.grey });
      kit.drawRight(`P ${formatMoney(doc.paidAmount)}`, rightEdge, { size: 9.5 });
      kit.moveDown(12);
      kit.drawLine({ x1: totalsLabelRight - 100, x2: rightEdge, color: COLORS.dark });
      kit.moveDown(14);
      kit.drawRight("Balance Due", totalsLabelRight, { size: 11, bold: true });
      kit.drawRight(`P ${formatMoney(doc.balanceAmount)}`, rightEdge, { size: 11, bold: true });
      kit.moveDown(26);
    } else {
      kit.moveDown(10);
    }

    if (doc.remarks) {
      kit.ensureRoom(30);
      kit.drawText("Remarks", marginX, { size: 8, bold: true, color: COLORS.grey });
      kit.moveDown(12);
      drawWrappedBlock(doc.remarks, marginX, { size: 9, lineHeight: 12 });
      kit.moveDown(10);
    }

    // ---- Accounting entries summary - evenly spaced 3-column layout ----
    if (withEntries && entriesSummary) {
      kit.ensureRoom(60);
      kit.drawLine({ x1: marginX, x2: rightEdge, thickness: 1, color: COLORS.accent });
      kit.moveDown(18);
      kit.drawText("Accounting Entries Summary", marginX, { size: 10, bold: true });
      kit.moveDown(18);

      const summaryColX = [marginX, marginX + contentWidth * 0.34, marginX + contentWidth * 0.67];
      kit.drawText("Total Debit", summaryColX[0], { size: 8.5, color: COLORS.grey });
      kit.drawText("Total Credit", summaryColX[1], { size: 8.5, color: COLORS.grey });
      kit.drawText("Status", summaryColX[2], { size: 8.5, color: COLORS.grey });
      kit.moveDown(14);
      kit.drawText(formatMoney(entriesSummary.totalDebit), summaryColX[0], { size: 10.5, bold: true });
      kit.drawText(formatMoney(entriesSummary.totalCredit), summaryColX[1], { size: 10.5, bold: true });
      kit.drawText(entriesSummary.balanced ? "BALANCED" : "UNBALANCED", summaryColX[2], {
        size: 10.5,
        bold: true,
        color: entriesSummary.balanced ? COLORS.dark : COLORS.danger,
      });
      kit.moveDown(26);
    }

    // ---- Signatures - equal-width 3-column grid ----
    kit.ensureRoom(70);
    const sigGap = 15;
    const sigWidth = (contentWidth - sigGap * 2) / 3;
    const sigLabels = ["Prepared By", "Approved By", "Received By"];
    const sigTopY = kit.getY();
    sigLabels.forEach((label, idx) => {
      const x = marginX + idx * (sigWidth + sigGap);
      kit.drawLine({ x1: x, x2: x + sigWidth, yPos: sigTopY, color: COLORS.dark });
      kit.drawText(label, x, { size: 8, color: COLORS.grey, y: sigTopY - 12 });
    });
    kit.moveDown(50);
  }
}
