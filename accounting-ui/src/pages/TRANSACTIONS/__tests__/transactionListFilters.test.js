// transactionListFilters.mjs is real ESM (required for Vite dev-server
// compatibility - see its header comment); loaded via a dynamic import()
// in beforeAll, same pattern as voucherToolbarRules.test.js.
let matchesSearch, matchesStatus, filterTransactions, deriveStatusOptions, sortTransactions;

beforeAll(async () => {
  const mod = await import("../transactionListFilters.mjs");
  ({ matchesSearch, matchesStatus, filterTransactions, deriveStatusOptions, sortTransactions } = mod);
});

const sample = [
  { id: 1, referenceNo: "INV-000001", party: "Acme Corp", status: "Draft", date: "2026-08-01", form: { description: "Sales invoice" } },
  { id: 2, referenceNo: "INV-000002", party: "Beta Industries", status: "Posted", date: "2026-08-15", form: { description: "Consulting services" } },
  { id: 3, referenceNo: "INV-000003", party: "Acme Corp", status: "Paid", date: "2026-08-31", form: { description: "" } },
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

  // Phase 5: date-range composition - the date filter must combine with
  // search/status (AND), never silently override or clear them.
  describe("date-range composition (Phase 5)", () => {
    test("no date filter preserves current search/status results", () => {
      const result = filterTransactions(sample, { searchQuery: "acme", statusFilter: "All Status" });
      expect(result.map((t) => t.id)).toEqual([1, 3]);
    });

    test("dateFrom only", () => {
      const result = filterTransactions(sample, { statusFilter: "All Status", dateFrom: "2026-08-15" });
      expect(result.map((t) => t.id)).toEqual([2, 3]);
    });

    test("dateTo only", () => {
      const result = filterTransactions(sample, { statusFilter: "All Status", dateTo: "2026-08-15" });
      expect(result.map((t) => t.id)).toEqual([1, 2]);
    });

    test("dateFrom + dateTo range", () => {
      const result = filterTransactions(sample, { statusFilter: "All Status", dateFrom: "2026-08-05", dateTo: "2026-08-20" });
      expect(result.map((t) => t.id)).toEqual([2]);
    });

    test("same-day From/To range matches only that day", () => {
      const result = filterTransactions(sample, { statusFilter: "All Status", dateFrom: "2026-08-15", dateTo: "2026-08-15" });
      expect(result.map((t) => t.id)).toEqual([2]);
    });

    test("record exactly on From boundary is included (inclusive)", () => {
      const result = filterTransactions(sample, { statusFilter: "All Status", dateFrom: "2026-08-01" });
      expect(result.map((t) => t.id)).toContain(1);
    });

    test("record exactly on To boundary is included (inclusive)", () => {
      const result = filterTransactions(sample, { statusFilter: "All Status", dateTo: "2026-08-31" });
      expect(result.map((t) => t.id)).toContain(3);
    });

    test("From later than To yields a safe empty result, not a thrown error", () => {
      const result = filterTransactions(sample, { statusFilter: "All Status", dateFrom: "2026-08-31", dateTo: "2026-08-01" });
      expect(result).toEqual([]);
    });

    test("date filter composes with search AND status (all three at once)", () => {
      const result = filterTransactions(sample, { searchQuery: "acme", statusFilter: "Paid", dateFrom: "2026-08-01" });
      expect(result.map((t) => t.id)).toEqual([3]);
    });

    test("date filter does not clear or override an unrelated status filter", () => {
      const result = filterTransactions(sample, { statusFilter: "Draft", dateFrom: "2026-01-01", dateTo: "2026-12-31" });
      expect(result.map((t) => t.id)).toEqual([1]);
    });
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

describe("sortTransactions (Phase 7B)", () => {
  test("no sortBy returns the array in its ORIGINAL order, unchanged (default order preserved)", () => {
    const result = sortTransactions(sample, { sortBy: null, sortDirection: "asc" });
    expect(result.map((t) => t.id)).toEqual([1, 2, 3]);
  });

  test("unrecognized sortBy also returns original order (safe no-op)", () => {
    const result = sortTransactions(sample, { sortBy: "nonsense", sortDirection: "asc" });
    expect(result.map((t) => t.id)).toEqual([1, 2, 3]);
  });

  test("does not mutate the input array", () => {
    const copy = [...sample];
    sortTransactions(sample, { sortBy: "date", sortDirection: "desc" });
    expect(sample).toEqual(copy);
  });

  describe("date", () => {
    test("ascending sorts chronologically via plain 'YYYY-MM-DD' string comparison", () => {
      const result = sortTransactions(sample, { sortBy: "date", sortDirection: "asc" });
      expect(result.map((t) => t.date)).toEqual(["2026-08-01", "2026-08-15", "2026-08-31"]);
    });

    test("descending reverses it", () => {
      const result = sortTransactions(sample, { sortBy: "date", sortDirection: "desc" });
      expect(result.map((t) => t.date)).toEqual(["2026-08-31", "2026-08-15", "2026-08-01"]);
    });
  });

  describe("amount", () => {
    const withAmounts = [
      { id: 1, referenceNo: "INV-1", party: "A", status: "Draft", date: "2026-01-01", amount: 500 },
      { id: 2, referenceNo: "INV-2", party: "B", status: "Draft", date: "2026-01-02", amount: 50 },
      { id: 3, referenceNo: "INV-3", party: "C", status: "Draft", date: "2026-01-03", amount: 5000 },
    ];

    test("ascending sorts numerically, not as strings (50 < 500 < 5000)", () => {
      const result = sortTransactions(withAmounts, { sortBy: "amount", sortDirection: "asc" });
      expect(result.map((t) => t.amount)).toEqual([50, 500, 5000]);
    });

    test("descending reverses it", () => {
      const result = sortTransactions(withAmounts, { sortBy: "amount", sortDirection: "desc" });
      expect(result.map((t) => t.amount)).toEqual([5000, 500, 50]);
    });
  });

  describe("party (customer/text)", () => {
    test("ascending is case-insensitive locale-safe", () => {
      const mixed = [
        { id: 1, party: "banana" },
        { id: 2, party: "Apple" },
        { id: 3, party: "cherry" },
      ];
      const result = sortTransactions(mixed, { sortBy: "party", sortDirection: "asc" });
      expect(result.map((t) => t.id)).toEqual([2, 1, 3]);
    });
  });

  describe("status", () => {
    test("ascending sorts case-insensitively", () => {
      const result = sortTransactions(sample, { sortBy: "status", sortDirection: "asc" });
      expect(result.map((t) => t.status)).toEqual(["Draft", "Paid", "Posted"]);
    });
  });

  describe("referenceNo (natural comparison)", () => {
    test("zero-padded numbering sorts correctly with plain comparison too", () => {
      const result = sortTransactions(sample, { sortBy: "referenceNo", sortDirection: "asc" });
      expect(result.map((t) => t.referenceNo)).toEqual(["INV-000001", "INV-000002", "INV-000003"]);
    });

    test("unpadded numbers sort NUMERICALLY, not lexically (INV-2 before INV-10)", () => {
      const unpadded = [
        { id: 1, referenceNo: "INV-10" },
        { id: 2, referenceNo: "INV-2" },
        { id: 3, referenceNo: "INV-1" },
      ];
      const result = sortTransactions(unpadded, { sortBy: "referenceNo", sortDirection: "asc" });
      expect(result.map((t) => t.referenceNo)).toEqual(["INV-1", "INV-2", "INV-10"]);
    });

    test("mixed/free-text reference numbers do not throw and produce a stable order", () => {
      const freeform = [
        { id: 1, referenceNo: "B-Special" },
        { id: 2, referenceNo: "" },
        { id: 3, referenceNo: null },
        { id: 4, referenceNo: "A-100" },
      ];
      expect(() => sortTransactions(freeform, { sortBy: "referenceNo", sortDirection: "asc" })).not.toThrow();
    });
  });

  describe("filter + sort composition", () => {
    test("sorting is applied AFTER filtering - filtered-out rows never appear", () => {
      const filtered = filterTransactions(sample, { statusFilter: "Draft" });
      const result = sortTransactions(filtered, { sortBy: "date", sortDirection: "desc" });
      expect(result.map((t) => t.id)).toEqual([1]);
    });

    test("changing sort does not remove any row search/status/date filtering already excluded", () => {
      const filtered = filterTransactions(sample, { searchQuery: "acme" });
      const sorted = sortTransactions(filtered, { sortBy: "party", sortDirection: "asc" });
      expect(sorted.map((t) => t.id).sort()).toEqual([1, 3]);
    });
  });
});
