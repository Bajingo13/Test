import { createPdfKit, COLORS, formatMoney, COPY_BADGE_HEIGHT } from "./pdfKit";
import { DEFAULT_COPY_TYPE, MAX_COPIES } from "../copyTypes";

// Shared list/summary PDF builder for every module's "Print List by ..."
// options. `columns` describes which fields to render (see
// printOptionsConfig.js per-module definitions) so OR/APV/CV can each show
// their own relevant columns (Check No., Due Date, etc.) without a
// per-module copy of this function.
export async function buildDocumentListPdf({
  title,
  company,
  grouping,
  rows,
  groups,
  grandTotal,
  columns,
  filters,
  generatedBy,
  copyType = DEFAULT_COPY_TYPE,
  copies = 1,
}) {
  const kit = await createPdfKit();
  const { marginX, pageWidth } = kit;
  const contentWidth = pageWidth - marginX * 2;
  const copyCount = Math.min(Math.max(Number(copies) || 1, 1), MAX_COPIES);

  for (let copyIndex = 0; copyIndex < copyCount; copyIndex++) {
    if (copyIndex > 0) kit.forcePageBreak();
    drawOneCopy();
  }

  const generatedAt = new Date().toLocaleString("en-PH", { hour12: false });
  return kit.finish({ generatedBy, generatedAt });

  // One full copy of the list - called copyCount times above, each
  // starting on its own fresh page via forcePageBreak().
  function drawOneCopy() {
    // Reserve clearance below the copy badge before any title text starts,
    // rather than letting both start at the same Y - guards against a long
    // company/report name reaching far enough right to meet the badge
    // (same coordination issue fixed in documentPdfBuilder.js's header).
    const headerTopY = kit.getY();
    kit.drawCopyBadge(copyType, { topY: headerTopY });
    kit.setY(headerTopY - COPY_BADGE_HEIGHT - 6);

    kit.drawText(company?.name || "AstreaBlue Accounting System", marginX, { bold: true, size: 13 });
    kit.moveDown(16);
    kit.drawText(title, marginX, { size: 11, bold: true, color: COLORS.accent });
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
    for (const c of columns) {
      colX.push(cursor);
      cursor += contentWidth * c.width;
    }

    function drawHeaderRow() {
      kit.drawRect({ x: marginX, w: contentWidth, h: 18, color: COLORS.accent, yPos: kit.getY() - 13 });
      columns.forEach((c, idx) => {
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
      columns.forEach((c, idx) => {
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

    if (groups) {
      for (const group of groups) {
        kit.ensureRoom(20);
        kit.drawText(group.groupLabel, marginX + 2, { size: 9.5, bold: true, y: kit.getY() - 4 });
        kit.moveDown(16);
        for (const row of group.rows) drawDataRow(row);
        drawGrandTotalRow(`Subtotal — ${group.groupLabel}`, group.subtotal, { tight: true });
      }
    } else {
      for (const row of rows || []) drawDataRow(row);
    }

    drawGrandTotalRow("Grand Total", grandTotal);
  }
}
