// Single shared currency-formatting utility for the frontend - every
// component that needs to display a monetary amount should call
// formatCurrency(amount, config) instead of reimplementing
// `"P " + amount.toLocaleString(...)` locally (as ~20 report pages and
// the print/PDF builders currently do - see the Currency Setup Phase 1
// report for the full inventory).
//
// This is an ESM mirror of the canonical, tested implementation in
// accounting-ui/src/backend/services/currencyFormatService.js - kept as
// two files because Vite's dev server serves local .js files straight to
// the browser's native ESM loader (a CommonJS `module.exports` file fails
// there), while Jest here has no Babel/ESM transform configured (an ESM
// `export` file fails there). Keep both copies' logic in sync.
//
// currencyConfig is expected to be a `currencies` row shape (camelCased):
// { currencySymbol, symbolPosition, spaceAfterSymbol, decimalPlaces,
//   decimalSeparator, thousandSeparator }

const DEFAULT_CONFIG = {
  currencySymbol: "",
  symbolPosition: "BEFORE",
  spaceAfterSymbol: false,
  decimalPlaces: 2,
  decimalSeparator: ".",
  thousandSeparator: ",",
};

export function formatMagnitude(amount, { decimalPlaces, decimalSeparator, thousandSeparator }) {
  const fixed = Math.abs(amount).toFixed(decimalPlaces);
  const [intPart, fracPart] = fixed.split(".");

  let grouped = "";
  for (let i = 0; i < intPart.length; i++) {
    const posFromEnd = intPart.length - i;
    if (i > 0 && posFromEnd % 3 === 0) grouped += thousandSeparator;
    grouped += intPart[i];
  }

  return fracPart ? `${grouped}${decimalSeparator}${fracPart}` : grouped;
}

export function formatCurrency(amount, currencyConfig) {
  const cfg = { ...DEFAULT_CONFIG, ...(currencyConfig || {}) };
  const numeric = Number(amount);
  const safeAmount = Number.isFinite(numeric) ? numeric : 0;
  const isNegative = safeAmount < 0;

  const magnitude = formatMagnitude(safeAmount, cfg);
  const symbol = cfg.currencySymbol || "";
  const gap = cfg.spaceAfterSymbol ? " " : "";

  const body = cfg.symbolPosition === "AFTER" ? `${magnitude}${gap}${symbol}` : `${symbol}${gap}${magnitude}`;
  return isNegative ? `-${body}` : body;
}

export { DEFAULT_CONFIG };
