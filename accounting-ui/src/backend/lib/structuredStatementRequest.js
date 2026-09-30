// Reports Phase B: pure request parsing / period derivation / strict-mode
// evaluation for the STRUCTURED financial-statement endpoints. No Express,
// no DB - unit-testable in isolation. The Express route in server.js is a
// thin adapter around these functions plus
// financialStatementStructureService.buildIncomeStatement(). All financial
// math stays in that service; nothing here groups by name or sums balances.

const { isValidDateOnly } = require("./dateOnly");

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const fail = (status, code, message, extra) => ({ ok: false, status, body: { code, message, ...(extra || {}) } });

// Query flags: "0"/"false"/"no"/"off" -> false, "1"/"true"/"yes"/"on" -> true,
// absent/blank/unrecognised -> the supplied default.
function flag(value, dflt) {
  if (value === undefined || value === null || value === "") return dflt;
  const s = String(value).trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(s)) return false;
  if (["1", "true", "yes", "on"].includes(s)) return true;
  return dflt;
}

function lastDayOfMonth(year, month1) {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

function monthLabel(dateStr) {
  const [y, m] = String(dateStr).split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

// True only when [from, to] is exactly one whole calendar month
// (first day .. last day of the same month/year).
function isWholeCalendarMonth(from, to) {
  const [fy, fm, fd] = String(from).split("-").map(Number);
  const [ty, tm, td] = String(to).split("-").map(Number);
  if (fd !== 1) return false;
  if (fy !== ty || fm !== tm) return false;
  return td === lastDayOfMonth(fy, fm);
}

// The calendar month immediately before the month that `from` starts -
// crosses the year boundary (January -> previous December).
function previousMonthRange(from) {
  const [fy, fm] = String(from).split("-").map(Number);
  const d = new Date(Date.UTC(fy, fm - 2, 1)); // month before `fm` (Date month is 0-based)
  const py = d.getUTCFullYear();
  const pm = d.getUTCMonth() + 1;
  const mm = String(pm).padStart(2, "0");
  const last = String(lastDayOfMonth(py, pm)).padStart(2, "0");
  return { from: `${py}-${mm}-01`, to: `${py}-${mm}-${last}` };
}

// Parse + validate the structured Income Statement query. Returns
// { ok:true, value:{ mode, from, to, comparePrev, ytd, strict, wholeMonth, periods[] } }
// or { ok:false, status, body:{ code, message } }.
//
// periods[] entries: { key, bandLabel, periodLabel, from, to }
//   key       - column key used by the model's node values (current/previous/ytd)
//   bandLabel - template band header ("FOR THE MONTH" / "TOTAL TO DATE")
//   periodLabel - date-specific label derived from the actual dates
function parseIncomeStatementParams(query) {
  const q = query || {};
  const from = q.from;
  const to = q.to;

  if (!from || !to) {
    return fail(400, "INVALID_DATE_RANGE", "Both 'from' and 'to' (YYYY-MM-DD) are required.");
  }
  if (!isValidDateOnly(from) || !isValidDateOnly(to)) {
    return fail(400, "INVALID_DATE_RANGE", "'from' and 'to' must be valid YYYY-MM-DD dates.");
  }
  if (String(from) > String(to)) {
    return fail(400, "INVALID_DATE_RANGE", "'from' must be on or before 'to'.");
  }

  const mode = q.mode === undefined || q.mode === "" ? "condensed" : String(q.mode).trim().toLowerCase();
  if (mode !== "condensed" && mode !== "detailed") {
    return fail(400, "INVALID_REPORT_MODE", `'mode' must be 'condensed' or 'detailed' (got '${q.mode}').`);
  }

  const comparePrev = flag(q.comparePrev, true);
  const ytd = flag(q.ytd, true);
  const strict = flag(q.strict, false);

  const wholeMonth = isWholeCalendarMonth(from, to);
  if (comparePrev && !wholeMonth) {
    return fail(
      400,
      "COMPARISON_REQUIRES_FULL_MONTH",
      "comparePrev=1 currently requires 'from'/'to' to span one whole calendar month " +
        "(e.g. 2027-06-01 to 2027-06-30). Pass comparePrev=0 to use an arbitrary date range."
    );
  }

  const periods = [
    {
      key: "current",
      bandLabel: "FOR THE MONTH",
      periodLabel: wholeMonth ? monthLabel(from) : `${from} to ${to}`,
      from,
      to,
    },
  ];
  if (comparePrev) {
    const pr = previousMonthRange(from);
    periods.push({
      key: "previous",
      bandLabel: "FOR THE MONTH",
      periodLabel: monthLabel(pr.from),
      from: pr.from,
      to: pr.to,
    });
  }
  if (ytd) {
    const ytdFrom = `${String(to).slice(0, 4)}-01-01`;
    periods.push({
      key: "ytd",
      bandLabel: "TOTAL TO DATE",
      periodLabel: monthLabel(to),
      from: ytdFrom,
      to,
    });
  }

  return { ok: true, value: { mode, from, to, comparePrev, ytd, strict, wholeMonth, periods } };
}

// "<Month> <D>, <YYYY>" - a single as-of date label, derived from the date
// (never a hard-coded sample).
function asOfLabel(dateStr) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

// Parse + validate the structured Balance Sheet query. Returns
// { ok:true, value:{ mode, to, compareTo, strict, withDifference, columns[] } }
// or { ok:false, status, body:{ code, message } }.
//
// columns[] entries: { key, bandLabel, periodLabel, date }
//   'current'  - as-of `to`
//   'comparative' - only when compareTo is supplied (any valid date; NOT
//                   required to be earlier than `to` - the sample has
//                   unusual chronology and we compute current - comparative
//                   exactly as given, never reordering).
// The DIFFERENCE column itself is produced by the canonical builder (it owns
// current - comparative); it is not represented here.
function parseBalanceSheetParams(query) {
  const q = query || {};
  const to = q.to;
  const compareTo = q.compareTo === undefined || q.compareTo === "" ? null : q.compareTo;

  if (!to) return fail(400, "INVALID_DATE_RANGE", "'to' (YYYY-MM-DD) is required.");
  if (!isValidDateOnly(to)) return fail(400, "INVALID_DATE_RANGE", "'to' must be a valid YYYY-MM-DD date.");
  if (compareTo !== null && !isValidDateOnly(compareTo)) {
    return fail(400, "INVALID_DATE_RANGE", "'compareTo' must be a valid YYYY-MM-DD date.");
  }

  const mode = q.mode === undefined || q.mode === "" ? "condensed" : String(q.mode).trim().toLowerCase();
  if (mode !== "condensed" && mode !== "detailed") {
    return fail(400, "INVALID_REPORT_MODE", `'mode' must be 'condensed' or 'detailed' (got '${q.mode}').`);
  }

  const strict = flag(q.strict, false);
  const withDifference = compareTo !== null;

  const columns = [
    { key: "current", bandLabel: "AS OF", periodLabel: asOfLabel(to), date: to },
  ];
  if (compareTo !== null) {
    columns.push({ key: "comparative", bandLabel: "AS OF", periodLabel: asOfLabel(compareTo), date: compareTo });
  }

  return { ok: true, value: { mode, to, compareTo, strict, withDifference, columns } };
}

// Shared statement-scoped classification reasons for a built model. The
// gate is evaluated at STATEMENT scope (diagnostics for the accounts this
// report actually touches), NOT on the catalog-wide readiness.ready boolean
// - that global flag stays in the response body for the UI, but gating one
// company's report on every other group code in a shared multi-tenant
// catalog being classified would make strict mode unusable. Tightening it
// to also require the global flag is a one-line change if ever wanted.
//
// unclassifiedKeys: which model.unclassified.* buckets to check
//   (["INCOME","EXPENSE"] for IS, ["ASSET","LIABILITY","EQUITY"] for BS).
function classificationStrictReasons(model, unclassifiedKeys) {
  const r = (model && model.readiness) || {};
  const u = (model && model.unclassified) || {};
  const anyNonZero = (obj) => !!obj && Object.values(obj).some((n) => Math.abs(Number(n) || 0) > 0.005);
  const nonEmpty = (arr) => Array.isArray(arr) && arr.length > 0;
  const reasons = [];

  for (const k of unclassifiedKeys) {
    if (anyNonZero(u[k])) reasons.push(`an unclassified ${k.toLowerCase()} balance is present`);
  }
  if (nonEmpty(r.ungroupedAccountsWithBalance)) {
    reasons.push("an account with a balance has no group code");
  }
  if (nonEmpty(r.groupUnclassifiedAccounts)) {
    reasons.push("a group code used by this report has no report section");
  }
  if (nonEmpty(r.invalidSectionMappings)) {
    reasons.push("a group code used by this report carries a report section invalid for its account class");
  }
  if (nonEmpty(r.unmappedAccountCodesWithBalance)) {
    reasons.push("transaction account codes with no chart-of-accounts row carry a balance");
  }
  return reasons;
}

// Income Statement strict gate. Returns { blocked:false } or
// { blocked:true, status:409, body:{ code, message, reasons, readiness } }.
function evaluateStrict(model) {
  const reasons = classificationStrictReasons(model, ["INCOME", "EXPENSE"]);
  if (reasons.length === 0) return { blocked: false };
  return {
    blocked: true,
    status: 409,
    body: {
      code: "REPORT_CLASSIFICATION_INCOMPLETE",
      message: `Structured report withheld (strict mode): ${reasons.join("; ")}.`,
      reasons,
      readiness: model.readiness,
    },
  };
}

// Balance Sheet strict gate. Precedence (documented): a CLASSIFICATION
// failure is reported first (409 REPORT_CLASSIFICATION_INCOMPLETE); only if
// classification is clean but the accounting equation fails do we report
// 409 BALANCE_SHEET_OUT_OF_BALANCE. Both bodies carry readiness; the
// out-of-balance body also carries balanceCheck.
function evaluateBalanceSheetStrict(model) {
  const reasons = classificationStrictReasons(model, ["ASSET", "LIABILITY", "EQUITY"]);
  if (reasons.length > 0) {
    return {
      blocked: true,
      status: 409,
      body: {
        code: "REPORT_CLASSIFICATION_INCOMPLETE",
        message: `Structured balance sheet withheld (strict mode): ${reasons.join("; ")}.`,
        reasons,
        readiness: model.readiness,
      },
    };
  }

  const bc = model && model.balanceCheck;
  if (bc && bc.balanced === false) {
    return {
      blocked: true,
      status: 409,
      body: {
        code: "BALANCE_SHEET_OUT_OF_BALANCE",
        message:
          "Structured balance sheet withheld (strict mode): total assets do not equal total liabilities + equity. " +
          "This is surfaced, not hidden - typically prior-year profit not yet closed to retained earnings.",
        balanceCheck: bc,
        readiness: model.readiness,
      },
    };
  }

  return { blocked: false };
}

module.exports = {
  parseIncomeStatementParams,
  parseBalanceSheetParams,
  evaluateStrict,
  evaluateBalanceSheetStrict,
  isWholeCalendarMonth,
  previousMonthRange,
  monthLabel,
  asOfLabel,
};
