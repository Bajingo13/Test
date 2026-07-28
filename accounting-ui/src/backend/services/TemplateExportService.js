const ExcelJS = require("exceljs");

// Builds a blank-import .xlsx: a bold header row (with optional cell notes
// for columns that need format guidance, e.g. "semicolon-separated"), one
// italic/gray sample row so users see the expected shape, and dropdown data
// validation on enum columns so a typo can't silently produce an
// unrecognized value. Shared by the COA and General Libraries "Generate
// Template" endpoints so neither duplicates the ExcelJS setup.
//
// columns: [{ key, header, width?, note? }]
// sampleRow: { [key]: value }
// dropdowns: { [key]: string[] } - options list per column key
async function buildXlsxTemplate({ sheetName, columns, sampleRow, dropdowns }) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);

  sheet.columns = columns.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.width || 22,
  }));

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFDBE4F0" },
  };

  columns.forEach((c, idx) => {
    if (c.note) {
      sheet.getCell(1, idx + 1).note = c.note;
    }
  });

  if (sampleRow) {
    const row = sheet.addRow(sampleRow);
    row.font = { italic: true, color: { argb: "FF888888" } };
  }

  const lastDataRow = 500;
  for (const [key, options] of Object.entries(dropdowns || {})) {
    const colIndex = columns.findIndex((c) => c.key === key) + 1;
    if (colIndex === 0) continue;
    const colLetter = sheet.getColumn(colIndex).letter;

    for (let row = 2; row <= lastDataRow; row++) {
      sheet.getCell(`${colLetter}${row}`).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [`"${options.join(",")}"`],
      };
    }
  }

  return workbook.xlsx.writeBuffer();
}

module.exports = { buildXlsxTemplate };
