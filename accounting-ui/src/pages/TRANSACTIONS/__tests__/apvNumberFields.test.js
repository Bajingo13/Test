// An APV converted from an RFP has voucher_no APV-RFP26-00002 and reference_no
// SI-7781. The APV list must show the APV's own number, and saving must keep
// both values, so a second APV from the same invoice cannot collide.

describe("APV number fields", () => {
  let M;
  beforeAll(async () => {
    M = await import("../transactionListFilters.mjs");
  });

  test("a converted APV shows its own number and keeps the supporting reference", () => {
    expect(M.apvNumberFields({ voucherNo: "APV-RFP26-00002", referenceNo: "SI-7781" })).toEqual({
      referenceNo: "APV-RFP26-00002",
      supportingReference: "SI-7781",
    });
  });

  test("a manual APV, where both hold the same value, has no separate reference", () => {
    expect(M.apvNumberFields({ voucherNo: "APV-0001", referenceNo: "APV-0001" })).toEqual({
      referenceNo: "APV-0001",
      supportingReference: "",
    });
    expect(M.apvNumberFields({ voucherNo: "APV-0001", referenceNo: null })).toEqual({
      referenceNo: "APV-0001",
      supportingReference: "",
    });
  });

  test("a Draft APV is listed as Draft; a posted one keeps its payment status", () => {
    expect(M.apvListStatus({ status: "Draft", paymentStatus: "Unpaid" })).toBe("Draft");
    expect(M.apvListStatus({ status: "Posted", paymentStatus: "Unpaid" })).toBe("Unpaid");
    expect(M.apvListStatus({ status: "Posted", paymentStatus: "Paid" })).toBe("Paid");
    expect(M.apvListStatus({ status: "Posted" })).toBe("Posted");
  });

  test("search finds a converted APV by its number and by its supporting reference", () => {
    const row = {
      ...M.apvNumberFields({ voucherNo: "APV-RFP26-00002", referenceNo: "SI-7781" }),
      party: "Sample Supplier Co.",
      form: { ...M.apvNumberFields({ voucherNo: "APV-RFP26-00002", referenceNo: "SI-7781" }), description: "Office chairs" },
    };
    expect(M.matchesSearch(row, "APV-RFP26")).toBe(true);
    expect(M.matchesSearch(row, "SI-7781")).toBe(true);
    expect(M.matchesSearch(row, "nothing-like-this")).toBe(false);
  });

  test("the status filter offers Draft when a Draft APV is listed", () => {
    expect(M.deriveStatusOptions([{ status: "Draft" }, { status: "Unpaid" }])).toEqual(["All Status", "Draft", "Unpaid"]);
  });
});
