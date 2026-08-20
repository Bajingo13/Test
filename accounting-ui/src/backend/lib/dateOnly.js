// Checkpoint 6C: the one safe date-normalization boundary for turning
// anything that represents a calendar date (a MySQL DATE column value read
// back as a JS Date object, a "YYYY-MM-DD" string, an ISO datetime string)
// into a plain "YYYY-MM-DD" string, without ever routing through
// .toISOString() or any other UTC reinterpretation.
//
// Root cause this exists to prevent: mysql2 returns DATE columns as JS
// Date objects constructed at LOCAL midnight for the stored date (e.g. for
// a process running in Asia/Manila / UTC+8, a stored '2026-08-01' comes
// back as a Date whose local wall-clock reads Aug 1 00:00 but whose
// underlying UTC instant is Jul 31 16:00). Calling .toISOString() on that
// object (as JSON.stringify does automatically for any Date value) yields
// "2026-07-31T16:00:00.000Z" - the date has silently shifted backward one
// day, and that raw ISO-with-T-and-Z string is also not valid MySQL DATE
// literal syntax at all, so a later INSERT/UPDATE using it fails outright
// with "Incorrect date value" (Checkpoint 6C's exact reproduced bug in
// transactionCurrencyService.getSnapshot() -> transaction_currency_snapshots.rate_date).
// A string input is passed through by truncation only (never re-parsed
// through a Date), and a Date object's LOCAL getters are used instead of
// UTC ones - this exact logic already existed, independently duplicated,
// in accountingPeriodService.js and exchangeRateResolverService.js before
// this checkpoint; this is the one shared copy going forward for anything
// new that needs it.
function toDateOnly(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.slice(0, 10);
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateOnly(value) {
  if (typeof value !== "string" || !DATE_ONLY_PATTERN.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime());
}

module.exports = { toDateOnly, isValidDateOnly, DATE_ONLY_PATTERN };
