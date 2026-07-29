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

// ---- Multi-sheet templates (Beginning Balance imports) ----
// Extends the single-sheet pattern above with an Instructions sheet and
// read-only Reference sheets (Account/Customer/Supplier lookups), frozen
// header + autofilter on the import sheet. Additive - buildXlsxTemplate
// above is untouched, so COA/GenLib templates are unaffected.

function addImportSheet(workbook, { name, columns, sampleRow, dropdowns }) {
  const sheet = workbook.addWorksheet(name);

  sheet.columns = columns.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.width || 22,
  }));

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.height = 20;
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDBE4F0" } };

  columns.forEach((c, idx) => {
    const noteParts = [];
    if (c.required) noteParts.push("REQUIRED");
    if (c.note) noteParts.push(c.note);
    if (noteParts.length) sheet.getCell(1, idx + 1).note = noteParts.join("\n\n");
  });

  if (sampleRow) {
    const row = sheet.addRow(sampleRow);
    row.font = { italic: true, color: { argb: "FF888888" } };
  }

  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };

  const lastDataRow = 1000;
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

  return sheet;
}

function addReferenceSheet(workbook, { name, columns, rows }) {
  const sheet = workbook.addWorksheet(name);

  sheet.columns = columns.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.width || 20,
  }));

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };

  for (const row of rows) sheet.addRow(row);

  sheet.views = [{ state: "frozen", ySplit: 1 }];
  return sheet;
}

function addInstructionsSheet(workbook, { name, title, meta, sections }) {
  const sheet = workbook.addWorksheet(name);
  sheet.getColumn(1).width = 100;

  let r = 1;
  const titleCell = sheet.getCell(r, 1);
  titleCell.value = title;
  titleCell.font = { bold: true, size: 16 };
  r += 1;

  for (const line of meta || []) {
    const cell = sheet.getCell(r, 1);
    cell.value = line;
    cell.font = { italic: true, color: { argb: "FF666666" } };
    r += 1;
  }
  r += 1;

  for (const section of sections) {
    const headingCell = sheet.getCell(r, 1);
    headingCell.value = section.heading;
    headingCell.font = { bold: true, size: 12 };
    r += 1;

    for (const line of section.body) {
      const cell = sheet.getCell(r, 1);
      cell.value = `• ${line}`;
      cell.alignment = { wrapText: true };
      r += 1;
    }
    r += 1;
  }

  return sheet;
}

// sheets: [{ type: "import"|"reference"|"instructions", ...defTypeSpecificFields }]
async function buildMultiSheetXlsxTemplate({ sheets }) {
  const workbook = new ExcelJS.Workbook();

  for (const def of sheets) {
    if (def.type === "import") addImportSheet(workbook, def);
    else if (def.type === "reference") addReferenceSheet(workbook, def);
    else if (def.type === "instructions") addInstructionsSheet(workbook, def);
  }

  return workbook.xlsx.writeBuffer();
}

module.exports = { buildXlsxTemplate, buildMultiSheetXlsxTemplate };
