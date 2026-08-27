// dateRangeFilter.mjs is real ESM (see its own header comment); loaded via
// a dynamic import() in beforeAll, same pattern as transactionListFilters.test.js.
let matchesDateRange;

beforeAll(async () => {
  const mod = await import("../dateRangeFilter.mjs");
  ({ matchesDateRange } = mod);
});

describe("matchesDateRange", () => {
  test("no from/to matches everything, including a missing date value", () => {
    expect(matchesDateRange("2026-08-27", {})).toBe(true);
    expect(matchesDateRange(null, {})).toBe(true);
    expect(matchesDateRange(undefined, {})).toBe(true);
  });

  test("a missing date value never matches once a from/to boundary is set", () => {
    expect(matchesDateRange(null, { from: "2026-08-01" })).toBe(false);
    expect(matchesDateRange(undefined, { to: "2026-08-31" })).toBe(false);
  });

  test("from only", () => {
    expect(matchesDateRange("2026-08-15", { from: "2026-08-01" })).toBe(true);
    expect(matchesDateRange("2026-07-31", { from: "2026-08-01" })).toBe(false);
  });

  test("to only", () => {
    expect(matchesDateRange("2026-08-15", { to: "2026-08-31" })).toBe(true);
    expect(matchesDateRange("2026-09-01", { to: "2026-08-31" })).toBe(false);
  });

  test("from and to together", () => {
    expect(matchesDateRange("2026-08-15", { from: "2026-08-01", to: "2026-08-31" })).toBe(true);
    expect(matchesDateRange("2026-07-31", { from: "2026-08-01", to: "2026-08-31" })).toBe(false);
    expect(matchesDateRange("2026-09-01", { from: "2026-08-01", to: "2026-08-31" })).toBe(false);
  });

  test("both boundaries are inclusive", () => {
    expect(matchesDateRange("2026-08-01", { from: "2026-08-01", to: "2026-08-31" })).toBe(true);
    expect(matchesDateRange("2026-08-31", { from: "2026-08-01", to: "2026-08-31" })).toBe(true);
  });

  test("same from/to date matches only that exact day", () => {
    expect(matchesDateRange("2026-08-15", { from: "2026-08-15", to: "2026-08-15" })).toBe(true);
    expect(matchesDateRange("2026-08-14", { from: "2026-08-15", to: "2026-08-15" })).toBe(false);
    expect(matchesDateRange("2026-08-16", { from: "2026-08-15", to: "2026-08-15" })).toBe(false);
  });

  test("from later than to yields no matches for any date, rather than throwing", () => {
    expect(() => matchesDateRange("2026-08-15", { from: "2026-08-31", to: "2026-08-01" })).not.toThrow();
    expect(matchesDateRange("2026-08-15", { from: "2026-08-31", to: "2026-08-01" })).toBe(false);
  });

  test("accepts a TIMESTAMP/ISO-shaped value by comparing only its date portion (no timezone conversion)", () => {
    // Never parsed through new Date() - just string-sliced, so a value like
    // "2026-08-27T00:00:00.000Z" still compares as calendar date 2026-08-27,
    // never silently shifting to the 26th or 28th.
    expect(matchesDateRange("2026-08-27T00:00:00.000Z", { from: "2026-08-27", to: "2026-08-27" })).toBe(true);
    expect(matchesDateRange("2026-08-27T23:59:59.000Z", { from: "2026-08-27", to: "2026-08-27" })).toBe(true);
  });

  test("boundary date at the very edge of a month/year does not shift", () => {
    expect(matchesDateRange("2026-12-31", { from: "2026-12-31", to: "2027-01-01" })).toBe(true);
    expect(matchesDateRange("2027-01-01", { from: "2026-12-31", to: "2027-01-01" })).toBe(true);
    expect(matchesDateRange("2026-12-30", { from: "2026-12-31", to: "2027-01-01" })).toBe(false);
  });
});
