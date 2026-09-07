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

export function rowsToCsv(rows) {
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

export function downloadCsv(filename, rows) {
  const blob = new Blob([rowsToCsv(rows)], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
