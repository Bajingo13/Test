// Reports Final Polish: one shared CSV builder for the report pages that
// gained export parity in this batch - Subsidiary Ledger, Output VAT,
// Input VAT, and the EWT / Final Tax Alphalist (via AlphalistReportBase).
//
// The older report pages (Trial Balance, General Ledger, Account Analysis,
// EWT Audit, the renamed Bank & Cash Movement report, Form 2307) each grew
// their own inline downloadCSV before this helper existed and are left
// untouched - this only exists to prevent five more near-identical copies.
//
// Contract: the caller passes a 2-D array (each row an array of cells) that
// represents EXACTLY what is on screen for the current filters. This helper
// never fetches anything and never re-queries, so nothing hidden by company
// isolation or an unfiltered result can leak into the file. Every cell is
// coerced to a string and fully quoted with embedded quotes doubled, so
// commas / quotes / newlines inside a value stay intact and the file opens
// correctly in Excel and Google Sheets. Numeric precision is the caller's
// responsibility (pass already-formatted strings, e.g. Number(x).toFixed(2))
// - this helper never rounds, truncates, or reformats a value.

export function csvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

// Spreadsheet formula-injection guard for a TEXT cell only. A value whose
// first character is one Excel / Google Sheets treats as a formula lead
// (= + - @, or a leading TAB / CR) is prefixed with a single apostrophe so
// it is shown literally. NEVER pass a numeric cell through this - a negative
// number's leading "-" is data, not a formula lead; numeric cells go
// straight to csvCell (which already produces a spreadsheet-safe quoted
// value). Additive: existing callers of csvCell / rowsToCsv are unchanged.
export function csvTextCell(value) {
  let s = value === null || value === undefined ? "" : String(value);
  // Guard even when the value carries a presentation indent (leading
  // spaces): a cell whose first non-space character is a formula lead
  // (= + - @), or that starts with a raw TAB / CR, is prefixed with a
  // single apostrophe so the spreadsheet shows it literally.
  if (/^[\t\r]/.test(s) || /^ *[=+\-@]/.test(s)) s = `'${s}`;
  return csvCell(s);
}

export function rowsToCsv(rows) {
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

// UTF-8 byte-order mark. The CSV text is already valid UTF-8; without this
// leading BOM Excel on Windows opens a .csv as the legacy ANSI code page
// and mis-decodes multi-byte characters (e.g. an em dash "—" shows as
// "â€""). Prepending the BOM makes Excel read it as UTF-8; Google Sheets,
// LibreOffice and text tools ignore it. It is added only at the download
// boundary - the serializer output (statementToCsv) stays BOM-free.
export const UTF8_BOM = "﻿";

export function withUtf8Bom(text) {
  return UTF8_BOM + String(text ?? "");
}

export function downloadCsv(filename, rows) {
  downloadCsvText(filename, rowsToCsv(rows));
}

// Download an already-assembled CSV string (the statement serializer builds
// its own string so it can apply csvTextCell vs csvCell per cell type).
export function downloadCsvText(filename, csvString) {
  const blob = new Blob([withUtf8Bom(csvString)], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
