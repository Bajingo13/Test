describe("computeEwtSummary (Phase 6A)", () => {
  let computeEwtSummary;

  beforeAll(async () => {
    ({ computeEwtSummary } = await import("../ewtSummary.mjs"));
  });

  test("empty array yields all-zero summary", () => {
    expect(computeEwtSummary([])).toEqual({ total: 0, active: 0, inactive: 0 });
  });

  test("counts total/active/inactive correctly", () => {
    const records = [
      { status: "ACTIVE" },
      { status: "ACTIVE" },
      { status: "INACTIVE" },
    ];
    expect(computeEwtSummary(records)).toEqual({ total: 3, active: 2, inactive: 1 });
  });

  test("all-active records", () => {
    const records = [{ status: "ACTIVE" }, { status: "ACTIVE" }];
    expect(computeEwtSummary(records)).toEqual({ total: 2, active: 2, inactive: 0 });
  });

  test("all-inactive records", () => {
    const records = [{ status: "INACTIVE" }, { status: "INACTIVE" }];
    expect(computeEwtSummary(records)).toEqual({ total: 2, active: 0, inactive: 2 });
  });

  test("unrecognized status values count as inactive (not silently dropped)", () => {
    const records = [{ status: "ACTIVE" }, { status: "SOMETHING_ELSE" }, { status: null }];
    expect(computeEwtSummary(records)).toEqual({ total: 3, active: 1, inactive: 2 });
  });

  test("non-array input is treated as empty, not a crash", () => {
    expect(computeEwtSummary(null)).toEqual({ total: 0, active: 0, inactive: 0 });
    expect(computeEwtSummary(undefined)).toEqual({ total: 0, active: 0, inactive: 0 });
  });
});
