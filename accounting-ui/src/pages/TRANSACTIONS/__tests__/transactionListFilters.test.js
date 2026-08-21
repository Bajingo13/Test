// transactionListFilters.mjs is real ESM (required for Vite dev-server
// compatibility - see its header comment); loaded via a dynamic import()
// in beforeAll, same pattern as voucherToolbarRules.test.js.
let matchesSearch, matchesStatus, filterTransactions, deriveStatusOptions;

beforeAll(async () => {
  const mod = await import("../transactionListFilters.mjs");
  ({ matchesSearch, matchesStatus, filterTransactions, deriveStatusOptions } = mod);
});

const sample = [
  { id: 1, referenceNo: "INV-000001", party: "Acme Corp", status: "Draft", form: { description: "Sales invoice" } },
  { id: 2, referenceNo: "INV-000002", party: "Beta Industries", status: "Posted", form: { description: "Consulting services" } },
  { id: 3, referenceNo: "INV-000003", party: "Acme Corp", status: "Paid", form: { description: "" } },
];

describe("matchesSearch", () => {
  test("empty query matches everything", () => {
    expect(matchesSearch(sample[0], "")).toBe(true);
    expect(matchesSearch(sample[0], "   ")).toBe(true);
    expect(matchesSearch(sample[0], undefined)).toBe(true);
  });

  test("matches by reference number, case-insensitive", () => {
    expect(matchesSearch(sample[0], "inv-000001")).toBe(true);
    expect(matchesSearch(sample[0], "000002")).toBe(false);
  });

  test("matches by party name", () => {
    expect(matchesSearch(sample[0], "acme")).toBe(true);
    expect(matchesSearch(sample[1], "acme")).toBe(false);
  });

  test("matches by description/particulars", () => {
    expect(matchesSearch(sample[1], "consulting")).toBe(true);
  });

  test("does not throw when description is missing", () => {
    expect(() => matchesSearch(sample[2], "anything")).not.toThrow();
    expect(matchesSearch({ referenceNo: "X", party: "Y" }, "x")).toBe(true);
  });
});

describe("matchesStatus", () => {
  test("'All Status' or empty matches everything", () => {
    expect(matchesStatus(sample[0], "All Status")).toBe(true);
    expect(matchesStatus(sample[0], "")).toBe(true);
    expect(matchesStatus(sample[0], undefined)).toBe(true);
  });

  test("matches exact status", () => {
    expect(matchesStatus(sample[0], "Draft")).toBe(true);
    expect(matchesStatus(sample[0], "Posted")).toBe(false);
  });

  test("correctly distinguishes payment-status values (Invoice/APV) from Draft/Posted", () => {
    expect(matchesStatus(sample[2], "Paid")).toBe(true);
    expect(matchesStatus(sample[2], "Posted")).toBe(false);
  });
});

describe("filterTransactions", () => {
  test("combines search and status filters (AND, not OR)", () => {
    const result = filterTransactions(sample, { searchQuery: "acme", statusFilter: "Draft" });
    expect(result.map((t) => t.id)).toEqual([1]);
  });

  test("no filters returns everything unchanged", () => {
    const result = filterTransactions(sample, { searchQuery: "", statusFilter: "All Status" });
    expect(result).toHaveLength(3);
  });

  test("a filter matching nothing returns an empty array, not undefined/null", () => {
    const result = filterTransactions(sample, { searchQuery: "nonexistent-party", statusFilter: "All Status" });
    expect(result).toEqual([]);
  });

  test("handles an empty transactions array safely", () => {
    expect(filterTransactions([], { searchQuery: "x", statusFilter: "All Status" })).toEqual([]);
    expect(filterTransactions(undefined, { searchQuery: "x", statusFilter: "All Status" })).toEqual([]);
  });
});

describe("deriveStatusOptions", () => {
  test("derives distinct, sorted status values from the actual data, always leading with All Status", () => {
    expect(deriveStatusOptions(sample)).toEqual(["All Status", "Draft", "Paid", "Posted"]);
  });

  test("an empty list still returns just All Status", () => {
    expect(deriveStatusOptions([])).toEqual(["All Status"]);
  });

  test("never fabricates a status value that isn't actually present (e.g. no hardcoded 'Cancelled')", () => {
    const noCancelled = [{ status: "Draft" }, { status: "Posted" }];
    expect(deriveStatusOptions(noCancelled)).not.toContain("Cancelled");
  });
});
