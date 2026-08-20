const { toDateOnly, isValidDateOnly } = require("../dateOnly");

// Checkpoint 6C: pure, no-DB unit tests for the exact value-shape matrix
// that caused the reproduced bug - a MySQL DATE column read back as a JS
// Date object, then serialized through JSON (which calls .toISOString()
// internally), then echoed back verbatim by a client. toDateOnly() is the
// single boundary meant to prevent every step of that chain from ever
// reaching an INSERT/UPDATE with a corrupted value.

describe("toDateOnly", () => {
  test("1. a plain YYYY-MM-DD string passes through unchanged", () => {
    expect(toDateOnly("2026-08-01")).toBe("2026-08-01");
  });

  test("2. an ISO datetime string is truncated to its date portion by slicing, never re-parsed through a Date", () => {
    // This is exactly the shape a raw Date object becomes after
    // JSON.stringify() serializes it (Date.prototype.toJSON calls
    // .toISOString()) - the reproduced bug's frontend->backend payload.
    expect(toDateOnly("2026-08-01T16:00:00.000Z")).toBe("2026-08-01");
  });

  test("3. a JS Date object uses LOCAL getters, not UTC - the exact fix for the reproduced day-shift", () => {
    // Constructed at local midnight for Aug 1, exactly how mysql2 builds a
    // Date object from a stored DATE column value (matching a value read
    // back from the database, not a value received over the network).
    const localMidnightAug1 = new Date(2026, 7, 1); // month is 0-indexed
    expect(toDateOnly(localMidnightAug1)).toBe("2026-08-01");
  });

  test("4. timezone-boundary case: a local-midnight Date on Jan 1 must never roll back into the previous YEAR", () => {
    const localMidnightJan1 = new Date(2026, 0, 1);
    expect(toDateOnly(localMidnightJan1)).toBe("2026-01-01");
  });

  test("5. null and undefined pass through unchanged (rate_date has no legitimate NULL case, but this helper is shared)", () => {
    expect(toDateOnly(null)).toBe(null);
    expect(toDateOnly(undefined)).toBe(undefined);
  });

  test("6. an unparseable Date input returns null rather than throwing or producing 'Invalid Date'", () => {
    expect(toDateOnly(new Date("not a date"))).toBe(null);
  });
});

describe("isValidDateOnly", () => {
  test("7. a well-formed YYYY-MM-DD string is valid", () => {
    expect(isValidDateOnly("2026-08-01")).toBe(true);
  });

  test("8. an ISO datetime string (with T/Z) is NOT valid - exactly what must never reach the database", () => {
    expect(isValidDateOnly("2026-08-01T16:00:00.000Z")).toBe(false);
  });

  test("9. null, undefined, empty string, and garbage are all invalid", () => {
    expect(isValidDateOnly(null)).toBe(false);
    expect(isValidDateOnly(undefined)).toBe(false);
    expect(isValidDateOnly("")).toBe(false);
    expect(isValidDateOnly("not-a-date")).toBe(false);
    expect(isValidDateOnly("2026-13-45")).toBe(false);
  });

  test("10. a raw Date object (never expected here, but must not throw) is invalid", () => {
    expect(isValidDateOnly(new Date())).toBe(false);
  });
});
