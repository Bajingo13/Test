// Canonical, tested implementation of the shared currency-formatting
// logic. Mirrored in accounting-ui/src/utils/currencyFormat.js as ESM for
// frontend use - see that file's header comment for why this is two files
// instead of one: Vite's dev server (unlike its production build) serves
// local .js files straight to the browser's native ESM loader, so a
// CommonJS `module.exports` file fails there with "does not provide an
// export named ..." even though it works fine in a production `vite
// build` (which does bundle/interop CJS). Jest here has no Babel/ESM
// transform configured, so the reverse is also true - this file must stay
// CommonJS to be testable. Keep both copies' logic in sync.
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

// Formats the numeric magnitude only (no sign, no symbol) - e.g.
// 1250 -> "1,250.00", 1250 with decimalPlaces=0 -> "1,250".
function formatMagnitude(amount, { decimalPlaces, decimalSeparator, thousandSeparator }) {
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

function formatCurrency(amount, currencyConfig) {
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

module.exports = { formatCurrency, formatMagnitude, DEFAULT_CONFIG };
