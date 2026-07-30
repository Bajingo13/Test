import { createPdfKit, COLORS, formatMoney } from "./pdfKit";

const GROUPING_LABELS = {
  number: "Invoice List — By Invoice Number",
  date: "Invoice List — By Invoice Date",
  customer: "Invoice List — By Customer",
};

const COLS = [
  { key: "voucherNo", label: "Invoice #", width: 0.14 },
  { key: "transactionDate", label: "Date", width: 0.12 },
  { key: "customerName", label: "Customer", width: 0.26 },
  { key: "referenceNo", label: "Reference", width: 0.14 },
  { key: "status", label: "Status", width: 0.1 },
  { key: "totalAmount", label: "Total", width: 0.08, money: true },
  { key: "paidAmount", label: "Paid", width: 0.08, money: true },
  { key: "balanceAmount", label: "Balance", width: 0.08, money: true },
];

export async function buildInvoiceListPdf({ company, grouping, rows, groups, grandTotal, filters, generatedBy }) {
  const kit = await createPdfKit();
  const { marginX, pageWidth } = kit;
  const contentWidth = pageWidth - marginX * 2;

  kit.drawText(company?.name || "AstreaBlue Accounting System", marginX, { bold: true, size: 13 });
  kit.moveDown(16);
  kit.drawText(GROUPING_LABELS[grouping] || "Invoice List", marginX, { size: 11, bold: true, color: COLORS.accent });
  kit.moveDown(13);
  if (filters?.from || filters?.to) {
    kit.drawText(`Period: ${filters.from || "-"} to ${filters.to || "-"}`, marginX, { size: 9, color: COLORS.grey });
    kit.moveDown(12);
  }
  kit.moveDown(6);
  kit.drawLine({ x1: marginX, x2: marginX + contentWidth, thickness: 1, color: COLORS.accent });
  kit.moveDown(16);

  const colX = [];
  let cursor = marginX;
  for (const c of COLS) {
    colX.push(cursor);
    cursor += contentWidth * c.width;
  }

  function drawHeaderRow() {
    kit.drawRect({ x: marginX, w: contentWidth, h: 18, color: COLORS.accent, yPos: kit.getY() - 13 });
    COLS.forEach((c, idx) => {
      if (c.money) {
        kit.drawRight(c.label, colX[idx] + contentWidth * c.width - 4, { size: 8, bold: true, color: COLORS.white, y: kit.getY() - 8 });
      } else {
        kit.drawText(c.label, colX[idx] + 4, { size: 8, bold: true, color: COLORS.white, y: kit.getY() - 8 });
      }
    });
    kit.moveDown(18);
  }

  function drawDataRow(row) {
    if (kit.ensureRoom(16)) drawHeaderRow();
    const rowY = kit.getY();
    COLS.forEach((c, idx) => {
      const raw = row[c.key];
      const value = c.money ? formatMoney(raw) : raw ?? "-";
      if (c.money) {
        kit.drawRight(value, colX[idx] + contentWidth * c.width - 4, { size: 8.5, y: rowY - 11 });
      } else {
        kit.drawText(String(value), colX[idx] + 4, { size: 8.5, y: rowY - 11 });
      }
    });
    kit.moveDown(15);
    kit.drawLine({ x1: marginX, x2: marginX + contentWidth, color: COLORS.border });
    kit.moveDown(3);
  }

  function drawGrandTotalRow(label, amount, opts = {}) {
    kit.ensureRoom(20);
    kit.drawLine({ x1: marginX, x2: marginX + contentWidth, thickness: 1, color: COLORS.dark });
    kit.moveDown(4);
    kit.drawRight(label, marginX + contentWidth * 0.66 - 4, { size: 9.5, bold: true, y: kit.getY() - 10 });
    kit.drawRight(`P ${formatMoney(amount)}`, marginX + contentWidth - 4, { size: 9.5, bold: true, y: kit.getY() - 10 });
    kit.moveDown(opts.tight ? 14 : 22);
  }

  kit.ensureRoom(18);
  drawHeaderRow();

  if (grouping === "customer" && groups) {
    for (const group of groups) {
      kit.ensureRoom(20);
      kit.drawText(group.customerName, marginX + 2, { size: 9.5, bold: true, y: kit.getY() - 4 });
      kit.moveDown(16);
      for (const row of group.rows) drawDataRow(row);
      drawGrandTotalRow(`Subtotal — ${group.customerName}`, group.subtotal, { tight: true });
    }
  } else {
    for (const row of rows || []) drawDataRow(row);
  }

  drawGrandTotalRow("Grand Total", grandTotal);

  const generatedAt = new Date().toLocaleString("en-PH", { hour12: false });
  return kit.finish({ generatedBy, generatedAt });
}
