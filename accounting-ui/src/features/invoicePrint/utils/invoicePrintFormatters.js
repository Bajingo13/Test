// Presentation-only formatters for the Standard Invoice printable. These
// never compute a business value (VAT, totals, currency) - they only
// format numbers/dates the backend view model already resolved.

export function formatMoney(value) {
  const num = Number(value);
  if (value === null || value === undefined || !Number.isFinite(num)) return "";
  return num.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("en-PH");
}

export function formatExchangeRate(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "";
  return num.toLocaleString("en-PH", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

const CURRENCY_NAMES = {
  PHP: "Philippine Peso", USD: "US Dollar", EUR: "Euro", GBP: "British Pound",
  JPY: "Japanese Yen", CNY: "Chinese Yuan", AUD: "Australian Dollar", CAD: "Canadian Dollar",
  SGD: "Singapore Dollar", HKD: "Hong Kong Dollar", AED: "UAE Dirham",
};

export function formatCurrencyLabel(code, name) {
  const cc = String(code || "").toUpperCase();
  const label = name || CURRENCY_NAMES[cc] || "";
  return label ? `${cc} — ${label}` : cc;
}

// print_count -> copy label, mirrors the E-Invoicing replica's mapping
// exactly. Returns null (hide) when print_count isn't tracked at all.
export function resolveCopyLabel(printCount) {
  if (printCount === null || printCount === undefined) return null;
  const n = Number(printCount);
  if (!Number.isFinite(n) || n <= 0) return "ORIGINAL COPY";
  if (n === 1) return "DUPLICATE COPY";
  if (n === 2) return "TRIPLICATE COPY";
  return "REPRINTED COPY";
}
