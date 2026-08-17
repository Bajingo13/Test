const { formatCurrency } = require("../currencyFormatService");

const PHP = { currencySymbol: "₱", symbolPosition: "BEFORE", spaceAfterSymbol: false, decimalPlaces: 2, decimalSeparator: ".", thousandSeparator: "," };
const USD = { currencySymbol: "$", symbolPosition: "BEFORE", spaceAfterSymbol: false, decimalPlaces: 2, decimalSeparator: ".", thousandSeparator: "," };
const JPY = { currencySymbol: "¥", symbolPosition: "BEFORE", spaceAfterSymbol: false, decimalPlaces: 0, decimalSeparator: ".", thousandSeparator: "," };
const EUR_AFTER = { currencySymbol: "€", symbolPosition: "AFTER", spaceAfterSymbol: true, decimalPlaces: 2, decimalSeparator: ",", thousandSeparator: "." };

describe("formatCurrency", () => {
  test("18. formats PHP: 1250 -> P1,250.00", () => {
    expect(formatCurrency(1250, PHP)).toBe("₱1,250.00");
  });

  test("19. formats USD: 1250 -> $1,250.00", () => {
    expect(formatCurrency(1250, USD)).toBe("$1,250.00");
  });

  test("20. formats JPY (0 decimals): 1250 -> ¥1,250", () => {
    expect(formatCurrency(1250, JPY)).toBe("¥1,250");
  });

  test("symbol AFTER with space and European separators: 1000 -> 1.000,00 €", () => {
    expect(formatCurrency(1000, EUR_AFTER)).toBe("1.000,00 €");
  });

  test("negative amounts keep the sign before the formatted body", () => {
    expect(formatCurrency(-1250, PHP)).toBe("-₱1,250.00");
  });

  test("zero formats cleanly, not as -0 or blank", () => {
    expect(formatCurrency(0, PHP)).toBe("₱0.00");
    expect(formatCurrency(-0, PHP)).toBe("₱0.00");
  });

  test("non-numeric/undefined amount falls back to zero instead of NaN", () => {
    expect(formatCurrency(undefined, PHP)).toBe("₱0.00");
    expect(formatCurrency("not a number", PHP)).toBe("₱0.00");
  });

  test("missing currencyConfig falls back to sane defaults (no symbol, 2 decimals)", () => {
    expect(formatCurrency(1250)).toBe("1,250.00");
  });

  test("large amounts group thousands correctly at every digit boundary", () => {
    expect(formatCurrency(1234567.89, PHP)).toBe("₱1,234,567.89");
  });

  test("spaceAfterSymbol adds a space between symbol and amount when BEFORE", () => {
    expect(formatCurrency(1000, { ...USD, spaceAfterSymbol: true })).toBe("$ 1,000.00");
  });
});
