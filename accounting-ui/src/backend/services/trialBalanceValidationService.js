// Decimal-safe helpers for the Unbalanced Trial Balance Checker. MySQL
// SUM()/subtraction over DECIMAL columns is exact and comes back from
// mysql2 as a string (no decimalNumbers option set on the pool) - these
// helpers keep that exactness through the balanced/unbalanced decision by
// working in integer cents parsed from the string, never via
// parseFloat/Number subtraction of two similarly-sized totals.
// Some source columns (arap/gl beginning-balance) carry 4 decimal places,
// which widens SUM()/subtraction results in the union to 4dp too - round
// (half-up, not truncate) to the nearest centavo here so a genuine
// sub-centavo remainder (e.g. "0.0050") isn't silently discarded as if it
// were exactly zero. Sub-centavo remainders themselves are surfaced
// separately as Rounding Differences findings, not lost here.
function toCents(decimalValue) {
  if (decimalValue === null || decimalValue === undefined) return 0;

  const str = String(decimalValue).trim();
  const negative = str.startsWith("-");
  const unsigned = negative ? str.slice(1) : str;
  const [wholePartRaw, fracPartRaw = ""] = unsigned.split(".");
  const wholePart = wholePartRaw || "0";
  const paddedFrac = (fracPartRaw + "000").slice(0, 3);
  const twoDecimals = paddedFrac.slice(0, 2);
  const roundingDigit = parseInt(paddedFrac.slice(2, 3) || "0", 10);

  let cents = parseInt(wholePart + twoDecimals, 10) || 0;
  if (roundingDigit >= 5) cents += 1;

  return negative ? -cents : cents;
}

function centsToDecimalString(cents) {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

// BALANCED: exactly zero. WITHIN_TOLERANCE: nonzero but <= tolerance
// (shown as "balanced within rounding tolerance", never auto-adjusted).
// UNBALANCED: exceeds tolerance.
function evaluateBalance({ difference, tolerance }) {
  const differenceCents = toCents(difference);
  const absDifferenceCents = Math.abs(differenceCents);
  const toleranceCents = Math.abs(toCents(tolerance ?? "0"));

  let status;
  if (absDifferenceCents === 0) status = "BALANCED";
  else if (absDifferenceCents <= toleranceCents) status = "WITHIN_TOLERANCE";
  else status = "UNBALANCED";

  return {
    status,
    differenceCents,
    absDifferenceCents,
    toleranceCents,
    differenceFormatted: centsToDecimalString(differenceCents),
  };
}

module.exports = { toCents, centsToDecimalString, evaluateBalance };
