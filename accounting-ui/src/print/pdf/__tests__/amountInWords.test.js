import { amountToWords } from "../amountInWords";

describe("amountToWords", () => {
  test("whole peso amount with no centavos", () => {
    expect(amountToWords(150000, { currencyLabel: "Pesos", singularCurrencyLabel: "Peso" })).toBe(
      "One Hundred Fifty Thousand Pesos Only"
    );
  });

  test("amount with centavos", () => {
    expect(amountToWords(159934.10, { currencyLabel: "Pesos", singularCurrencyLabel: "Peso" })).toBe(
      "One Hundred Fifty-Nine Thousand Nine Hundred Thirty-Four Pesos and 10/100 Only"
    );
  });

  test("singular currency label for exactly 1", () => {
    expect(amountToWords(1, { currencyLabel: "Pesos", singularCurrencyLabel: "Peso" })).toBe("One Peso Only");
  });

  test("zero amount", () => {
    expect(amountToWords(0, { currencyLabel: "Pesos", singularCurrencyLabel: "Peso" })).toBe("Zero Pesos Only");
  });

  test("hyphenates compound tens (twenty-one, not twenty one)", () => {
    expect(amountToWords(21, { currencyLabel: "Pesos" })).toBe("Twenty-One Pesos Only");
    expect(amountToWords(99, { currencyLabel: "Pesos" })).toBe("Ninety-Nine Pesos Only");
  });

  test("millions grouping", () => {
    expect(amountToWords(1000000, { currencyLabel: "Pesos" })).toBe("One Million Pesos Only");
    expect(amountToWords(1234567.89, { currencyLabel: "Pesos" })).toBe(
      "One Million Two Hundred Thirty-Four Thousand Five Hundred Sixty-Seven Pesos and 89/100 Only"
    );
  });

  test("centavo rounding avoids floating-point drift", () => {
    // 150000.1 - 150000 = 0.09999999999... in raw floating point
    expect(amountToWords(150000.1, { currencyLabel: "Pesos" })).toBe("One Hundred Fifty Thousand Pesos and 10/100 Only");
  });

  test("defaults to 'Pesos' when no currencyLabel is given", () => {
    expect(amountToWords(100)).toBe("One Hundred Pesos Only");
  });

  test("negative amounts are treated as their absolute value", () => {
    expect(amountToWords(-500, { currencyLabel: "Pesos" })).toBe("Five Hundred Pesos Only");
  });
});
