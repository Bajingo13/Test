// Global report date standard: every report's period is a RANGE or a
// DATE / AS OF. Pure helpers - no React, no fetch - shared by useReportPeriod,
// the printed labels and CSV headers. The server re-validates every selection
// and applies each report's meaning of the mode (backend/lib/reportPeriod.js).

export const RANGE = "range";
export const AS_OF = "asof";

// Earliest date an AS OF activity report reads from: "everything recorded up
// to the date". Matches BEGINNING_OF_RECORDS in backend/lib/reportPeriod.js.
export const BEGINNING_OF_RECORDS = "1900-01-01";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function isValidDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// "June 1, 2026" - built from the date's own parts, so a report's label can
// never shift a day with the browser's time zone.
export function formatLongDate(value) {
  if (!isValidDate(value)) return "";
  const [year, month, day] = String(value).split("-").map(Number);
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

// The first problem with a selection, or null when it can be generated.
export function validatePeriod({ mode, from, to, asOf }) {
  if (mode === AS_OF) {
    if (!isValidDate(asOf)) return { code: "AS_OF_REQUIRED", message: "As Of Date is required." };
    return null;
  }
  if (!isValidDate(from)) return { code: "FROM_REQUIRED", message: "Date From is required." };
  if (!isValidDate(to)) return { code: "TO_REQUIRED", message: "Date To is required." };
  if (from > to) return { code: "FROM_AFTER_TO", message: "Date From cannot be later than Date To." };
  return null;
}

// A validated selection as one snapshot: `params` is what is sent to the
// server; fromDate/toDate/asOfDate are the dates that selection reads, for
// drill-downs and file names. `asOfStart: "year"` is the Income Statement's
// calendar-year-to-date reading of an AS OF date.
export function resolvePeriod({ mode, from, to, asOf }, { asOfStart = "beginning" } = {}) {
  if (mode === AS_OF) {
    return {
      mode: AS_OF,
      from: "",
      to: "",
      asOf,
      fromDate: asOfStart === "year" ? `${String(asOf).slice(0, 4)}-01-01` : BEGINNING_OF_RECORDS,
      toDate: asOf,
      asOfDate: asOf,
      params: { dateMode: AS_OF, asOf },
    };
  }
  return {
    mode: RANGE,
    from,
    to,
    asOf: "",
    fromDate: from,
    toDate: to,
    asOfDate: to,
    params: { dateMode: RANGE, from, to },
  };
}

// The printed / PDF identification of a report's period.
export function reportPeriodLines(period) {
  if (!period) return { primary: "", secondary: "" };
  if (period.mode === AS_OF) {
    return { primary: `AS OF: ${formatLongDate(period.asOf)}`, secondary: "" };
  }
  const from = formatLongDate(period.from);
  const to = formatLongDate(period.to);
  return {
    primary: `REPORT PERIOD: ${from} - ${to}`,
    secondary: `DATE FROM: ${from.toUpperCase()} | DATE TO: ${to.toUpperCase()}`,
  };
}

export function reportPeriodText(period) {
  return reportPeriodLines(period).primary;
}

// The label as a list of lines, for reports that render lines from a model.
export function reportPeriodLineList(period) {
  const { primary, secondary } = reportPeriodLines(period);
  return [primary, secondary].filter(Boolean);
}

// The selection a drill-down link stands for: a link opened from an AS OF
// report reads from the beginning of records, so it reopens as AS OF.
export function selectionFromLink(from, to) {
  return from === BEGINNING_OF_RECORDS ? { mode: AS_OF, asOf: to } : { mode: RANGE, from, to };
}

// File-name part for a period: Range_2026-06-01_to_2026-06-30 or AsOf_2026-06-30.
export function periodFileSlug(period) {
  if (!period) return "";
  return period.mode === AS_OF ? `AsOf_${period.asOf}` : `Range_${period.from}_to_${period.to}`;
}

function filePart(value) {
  return String(value ?? "").trim().replace(/[^0-9A-Za-z_-]+/g, "_").replace(/^_+|_+$/g, "");
}

// Report_Name[_Qualifier]_Range_2026-06-01_to_2026-06-30, without an extension.
export function reportFileStem(reportName, period, ...qualifiers) {
  const parts = [reportName, ...qualifiers].map(filePart).filter(Boolean);
  return [...parts, periodFileSlug(period)].filter(Boolean).join("_");
}

export function reportCsvFilename(reportName, period, ...qualifiers) {
  return `${reportFileStem(reportName, period, ...qualifiers)}.csv`;
}

// The CSV header rows naming the selected period, as typed text cells: a
// readable line plus machine-readable ISO dates.
export function periodCsvRows(period) {
  if (!period) return [];
  const T = (v) => ({ t: "text", v });
  if (period.mode === AS_OF) {
    return [
      [T("Report Period"), T(`As of ${formatLongDate(period.asOf)}`)],
      [T("Period Type"), T("As Of")],
      [T("As Of"), T(period.asOf)],
    ];
  }
  return [
    [T("Report Period"), T(`${formatLongDate(period.from)} - ${formatLongDate(period.to)}`)],
    [T("Period Type"), T("Range")],
    [T("Date From"), T(period.from)],
    [T("Date To"), T(period.to)],
  ];
}

// The mode to append to a query that already carries the period's from/to.
// The server reads an AS OF request's date from asOf, not from those.
export function periodModeQuery(period) {
  const { from, to, ...mode } = period.params;
  return new URLSearchParams(mode).toString();
}
