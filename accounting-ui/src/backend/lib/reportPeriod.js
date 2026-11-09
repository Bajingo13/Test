// Global report date standard: a report is requested either as a RANGE
// (dateMode=range&from&to) or as a DATE / AS OF (dateMode=asof&asOf). This is
// the one place that validates a selection and translates it into the
// from/to/asOf/date parameters each report route already reads, so the
// routes and their services keep a single query path. A request WITHOUT
// dateMode passes through untouched - existing API callers see no change.
//
// What each mode means depends on the kind of report:
//
//   Activity reports (ledgers, books, tax reports, statements of account):
//     RANGE  - activity dated from..to.
//     AS OF  - everything recorded up to and including the date.
//   Income Statement:
//     AS OF  - calendar year to date, the same period Current Year Earnings
//              uses on the Balance Sheet (no fiscal-year setup exists).
//   Balance Sheet:
//     AS OF  - balances at the date.
//     RANGE  - balances at Date To, compared with the balances just before
//              Date From, so the DIFFERENCE column is the period's movement.
//   Open-item and register reports (aging, overdue, fixed assets, prepaids):
//     AS OF  - position at the date.
//     RANGE  - position at Date To, limited to documents dated from..to.
//   Daily Cash Position:
//     AS OF  - that day's movement.
//     RANGE  - beginning balance before Date From, movement over the range.

const { isValidDateOnly } = require("./dateOnly");

const BEGINNING_OF_RECORDS = "1900-01-01";

const DOCUMENT_PERIOD_REPORTS = new Set([
  "/ar-aging",
  "/ar-aging-summary",
  "/ar-overdue-accounts",
  "/ap-aging",
  "/ap-aging-summary",
  "/ap-overdue-accounts",
  "/fixed-asset-register",
  "/prepaid-list",
  "/lapsed-prepayments",
  "/prepayment-lapsing",
  "/prepaid-subsidiary",
]);

const fail = (code, message) => ({ ok: false, status: 400, body: { code, message } });

function dayBefore(dateStr) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

// isValidDateOnly accepts any date Date can parse, which rolls 2026-02-31
// over to March. A report period has to be a date that exists.
function isRealDate(value) {
  if (!isValidDateOnly(value)) return false;
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function parseSelection(query) {
  const mode = String(query.dateMode).trim().toLowerCase();

  if (mode === "range") {
    const { from, to } = query;
    if (!from) return fail("INVALID_DATE_RANGE", "Date From is required.");
    if (!to) return fail("INVALID_DATE_RANGE", "Date To is required.");
    if (!isRealDate(from) || !isRealDate(to)) {
      return fail("INVALID_DATE_RANGE", "Date From and Date To must be valid YYYY-MM-DD dates.");
    }
    if (String(from) > String(to)) {
      return fail("INVALID_DATE_RANGE", "Date From cannot be later than Date To.");
    }
    return { ok: true, value: { mode, from: String(from), to: String(to) } };
  }

  if (mode === "asof") {
    const { asOf } = query;
    if (!asOf) return fail("INVALID_AS_OF_DATE", "As Of Date is required.");
    if (!isRealDate(asOf)) return fail("INVALID_AS_OF_DATE", "As Of Date must be a valid YYYY-MM-DD date.");
    return { ok: true, value: { mode, asOf: String(asOf) } };
  }

  return fail("INVALID_DATE_MODE", "dateMode must be 'range' or 'asof'.");
}

// The route parameters for a validated selection on one report path.
function routeParams(reportPath, selection) {
  const isRange = selection.mode === "range";

  if (reportPath === "/balance-sheet") {
    return isRange ? { to: selection.to, compareTo: dayBefore(selection.from) } : { to: selection.asOf };
  }
  if (reportPath === "/daily-cash-position") {
    return isRange ? { from: selection.from, to: selection.to } : { date: selection.asOf };
  }
  if (DOCUMENT_PERIOD_REPORTS.has(reportPath)) {
    return isRange
      ? { asOf: selection.to, documentFrom: selection.from, documentTo: selection.to }
      : { asOf: selection.asOf };
  }
  if (!isRange && reportPath === "/income-statement") {
    return { from: `${selection.asOf.slice(0, 4)}-01-01`, to: selection.asOf };
  }
  return isRange
    ? { from: selection.from, to: selection.to }
    : { from: BEGINNING_OF_RECORDS, to: selection.asOf };
}

// Rewrites the query before the report route runs. Every date parameter is
// dropped first, so the rewritten values are the only ones a route can read.
function reportPeriodMiddleware(req, res, next) {
  const query = req.query;
  if (query.dateMode === undefined) return next();

  const parsed = parseSelection(query);
  if (!parsed.ok) return res.status(parsed.status).json(parsed.body);

  const rest = { ...query };
  for (const key of ["dateMode", "from", "to", "asOf", "date", "documentFrom", "documentTo"]) delete rest[key];
  if (parsed.value.mode === "range" && req.path === "/balance-sheet") delete rest.compareTo;

  // Express 5 exposes req.query as a getter that re-parses the URL.
  Object.defineProperty(req, "query", {
    value: { ...rest, ...routeParams(req.path, parsed.value) },
    configurable: true,
    writable: true,
  });
  next();
}

// Keeps the rows dated inside a RANGE's document period. With no document
// period (an AS OF request, or no dateMode at all) rows pass through.
function filterByDocumentPeriod(rows, { documentFrom, documentTo } = {}, dateField) {
  if (!documentFrom || !documentTo) return rows;
  return rows.filter((row) => {
    const value = row[dateField];
    return Boolean(value) && value >= documentFrom && value <= documentTo;
  });
}

module.exports = {
  BEGINNING_OF_RECORDS,
  dayBefore,
  filterByDocumentPeriod,
  parseSelection,
  reportPeriodMiddleware,
  routeParams,
};
