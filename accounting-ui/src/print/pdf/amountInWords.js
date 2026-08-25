// Reusable amount-to-words formatter for printable monetary totals - built
// for OR's "Amount in Words" line (E-Invoicing reference checkpoint), kept
// generic so a future Invoice/receipt print can reuse it. Pure formatting
// only: takes an already-resolved printed amount and a currency label -
// never recomputes or touches the underlying accounting value.

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
const TEENS = ["Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
// Philippine business documents conventionally group in short-scale
// thousand/million/billion/trillion, same as standard English.
const SCALES = ["", "Thousand", "Million", "Billion", "Trillion"];

function threeDigitsToWords(n) {
  const parts = [];
  const hundreds = Math.floor(n / 100);
  const remainder = n % 100;

  if (hundreds > 0) parts.push(`${ONES[hundreds]} Hundred`);

  if (remainder >= 10 && remainder < 20) {
    parts.push(TEENS[remainder - 10]);
  } else {
    const tens = Math.floor(remainder / 10);
    const ones = remainder % 10;
    // Standard compound-number hyphenation (e.g. "Twenty-One"), the
    // conventional form on formal/legal documents like checks and receipts.
    if (tens > 0 && ones > 0) parts.push(`${TENS[tens]}-${ONES[ones]}`);
    else if (tens > 0) parts.push(TENS[tens]);
    else if (ones > 0) parts.push(ONES[ones]);
  }

  return parts.join(" ");
}

// Converts a non-negative integer to English words, grouped by thousand.
function integerToWords(value) {
  const n = Math.trunc(Math.abs(Number(value) || 0));
  if (n === 0) return "Zero";

  const groups = [];
  let remaining = n;
  while (remaining > 0) {
    groups.push(remaining % 1000);
    remaining = Math.floor(remaining / 1000);
  }

  const words = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i] === 0) continue;
    const groupWords = threeDigitsToWords(groups[i]);
    words.push(SCALES[i] ? `${groupWords} ${SCALES[i]}` : groupWords);
  }

  return words.join(" ");
}

// amountToWords(159934.10, { currencyLabel: "Pesos", centavoLabel: "Centavos" })
// -> "One Hundred Fifty-Nine Thousand Nine Hundred Thirty-Four Pesos and 10/100 Only"
// amountToWords(150000, ...) -> "One Hundred Fifty Thousand Pesos Only" (no
// centavos clause at all when the fractional part is exactly zero, matching
// the E-Invoicing reference's own convention).
export function amountToWords(amount, { currencyLabel = "Pesos", singularCurrencyLabel } = {}) {
  const value = Math.abs(Number(amount) || 0);
  const wholePesos = Math.trunc(value);
  // Round to avoid floating-point centavo drift (e.g. 150000.1 - 150000 = 0.09999...).
  const centavos = Math.round((value - wholePesos) * 100);

  const label = wholePesos === 1 && singularCurrencyLabel ? singularCurrencyLabel : currencyLabel;
  const wholeWords = `${integerToWords(wholePesos)} ${label}`;

  if (centavos === 0) {
    return `${wholeWords} Only`;
  }

  const centavoStr = String(centavos).padStart(2, "0");
  return `${wholeWords} and ${centavoStr}/100 Only`;
}
