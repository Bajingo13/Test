// Phase 7L Part D: the frontend preview mirror (utils/ewtCalculations.mjs)
// and the backend authority (backend/services/ewtCalculationService.js)
// must agree on VAT-line identity, EWT base, rounding and treatment
// behavior. This suite loads BOTH and asserts identical results for the
// same inputs, plus the concrete acceptance vectors from the phase spec.
//
// ewtCalculationService.js is a pure module (no ../db require), so it is
// safe to require() directly in a unit test.
const be = require("../../backend/services/ewtCalculationService");
let fe;

beforeAll(async () => {
  fe = await import("../ewtCalculations.mjs");
});

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Structured Input VAT line as the modern APV modal builds it.
function structuredInputVatLine({ gross, rate = 12, mode = "INCLUSIVE" }) {
  let net;
  let vat;
  if (mode === "EXCLUSIVE") {
    net = r2(gross); // caller passed the base as `gross` for the exclusive case
    vat = r2((net * rate) / 100);
  } else {
    net = r2(gross / (1 + rate / 100));
    vat = r2(gross - net);
  }
  return {
    accountId: 500,
    accountTitle: "Input VAT Receivable",
    debit: vat,
    credit: 0,
    taxEntry: {
      entryType: "INPUT_VAT",
      netAmount: net,
      grossAmount: mode === "EXCLUSIVE" ? r2(net + vat) : r2(gross),
      vatAmount: vat,
      vatRate: rate,
    },
  };
}

function zeroTreatmentLine({ base, treatment }) {
  return {
    accountId: 500,
    accountTitle: "Input VAT Receivable",
    debit: 0,
    credit: 0,
    taxEntry: {
      entryType: "INPUT_VAT",
      netAmount: r2(base),
      grossAmount: r2(base),
      vatAmount: 0,
      vatRate: 0,
      vatTreatment: treatment,
    },
  };
}

// Run the same call on both implementations and assert equality.
function bothBase(args) {
  const b = be.computeEwtTaxableBase(args);
  const f = fe.computeEwtTaxableBase(args);
  expect(f).toBe(b);
  return b;
}
function bothAmount(args) {
  const b = be.computeEwtAmount(args);
  const f = fe.computeEwtAmount(args);
  expect(f).toBe(b);
  return b;
}

describe("Phase 7L - modern structured EWT base (balance-independent)", () => {
  test("Inclusive 11,200 @12% -> net 10,000 -> EWT base 10,000 -> EWT@10% 1,000", () => {
    const vatLine = structuredInputVatLine({ gross: 11200, rate: 12 });
    expect(vatLine.taxEntry.netAmount).toBe(10000);
    expect(vatLine.taxEntry.vatAmount).toBe(1200);

    const lines = [
      { accountId: 1, accountTitle: "Purchases", debit: 10000, credit: 0 },
      vatLine,
      // deliberately UNBALANCED payable - base must NOT depend on it:
      { accountId: 2, accountTitle: "Accounts Payable", debit: 0, credit: 10000 },
    ];
    const base = bothBase({ grossAmount: 10000, lines });
    expect(base).toBe(10000);
    expect(bothAmount({ taxableBase: base, ewtRate: 10 })).toBe(1000);
    // The wrong pre-7L answer (totalCredit 10000 - VAT 1200 = 8800) is gone.
    expect(base).not.toBe(8800);
  });

  test("Inclusive 10,000 @12% -> net 8,928.57 -> VAT 1,071.43 -> EWT@10% 892.86", () => {
    const vatLine = structuredInputVatLine({ gross: 10000, rate: 12 });
    expect(vatLine.taxEntry.netAmount).toBe(8928.57);
    expect(vatLine.taxEntry.vatAmount).toBe(1071.43);
    const lines = [
      { accountId: 1, accountTitle: "Purchases", debit: 8928.57, credit: 0 },
      vatLine,
      { accountId: 2, accountTitle: "Accounts Payable", debit: 0, credit: 10000 },
    ];
    const base = bothBase({ grossAmount: 8928.57, lines });
    expect(base).toBe(8928.57);
    expect(bothAmount({ taxableBase: base, ewtRate: 10 })).toBe(892.86);
  });

  test("Exclusive base 10,000 @12% -> gross 11,200 -> EWT base 10,000 -> EWT@10% 1,000", () => {
    const vatLine = structuredInputVatLine({ gross: 10000, rate: 12, mode: "EXCLUSIVE" });
    expect(vatLine.taxEntry.netAmount).toBe(10000);
    expect(vatLine.taxEntry.vatAmount).toBe(1200);
    expect(vatLine.taxEntry.grossAmount).toBe(11200);
    const lines = [
      { accountId: 1, accountTitle: "Purchases", debit: 10000, credit: 0 },
      vatLine,
      { accountId: 2, accountTitle: "Accounts Payable", debit: 0, credit: 11200 },
    ];
    const base = bothBase({ grossAmount: 10000, lines });
    expect(base).toBe(10000);
    expect(bothAmount({ taxableBase: base, ewtRate: 10 })).toBe(1000);
  });

  test("ZERO_RATED 10,000 -> base 10,000, no 1.12 division", () => {
    const lines = [
      { accountId: 1, accountTitle: "Purchases", debit: 10000, credit: 0 },
      zeroTreatmentLine({ base: 10000, treatment: "ZERO_RATED" }),
      { accountId: 2, accountTitle: "Accounts Payable", debit: 0, credit: 10000 },
    ];
    expect(bothBase({ grossAmount: 10000, lines })).toBe(10000);
  });

  test("EXEMPT 10,000 -> base 10,000, no VAT extraction", () => {
    const lines = [
      { accountId: 1, accountTitle: "Purchases", debit: 10000, credit: 0 },
      zeroTreatmentLine({ base: 10000, treatment: "EXEMPT" }),
      { accountId: 2, accountTitle: "Accounts Payable", debit: 0, credit: 10000 },
    ];
    expect(bothBase({ grossAmount: 10000, lines })).toBe(10000);
  });

  test("multiple structured VAT lines sum their net amounts", () => {
    const lines = [
      structuredInputVatLine({ gross: 11200, rate: 12 }), // net 10000
      structuredInputVatLine({ gross: 5600, rate: 12 }), // net 5000
    ];
    expect(bothBase({ grossAmount: 0, lines })).toBe(15000);
  });
});

describe("Phase 7L - legacy fallback: VAT line identified by validated account id, not title", () => {
  // A control account whose TITLE is 'Taxes Recoverable' but which is
  // validation-tagged INPUT VAT (id 77). No structured taxEntry metadata.
  const nonStandardVatLine = {
    accountId: 77,
    accountTitle: "Taxes Recoverable",
    debit: 1200,
    credit: 0,
  };
  const standardVatLine = {
    accountId: 77,
    accountTitle: "Input VAT",
    debit: 1200,
    credit: 0,
  };
  const rest = [
    { accountId: 1, accountTitle: "Purchases", debit: 10000, credit: 0 },
    { accountId: 2, accountTitle: "Accounts Payable", debit: 0, credit: 11200 },
  ];

  test("validation-tagged 'Taxes Recoverable' gives the SAME base as a literal 'Input VAT' title", () => {
    const withNonStandard = bothBase({
      grossAmount: 11200,
      lines: [rest[0], nonStandardVatLine, rest[1]],
      vatAccountIds: [77],
      vatKeyword: "input vat",
    });
    const withStandard = bothBase({
      grossAmount: 11200,
      lines: [rest[0], standardVatLine, rest[1]],
      vatAccountIds: [77],
      vatKeyword: "input vat",
    });
    expect(withNonStandard).toBe(10000);
    expect(withStandard).toBe(10000);
    expect(withNonStandard).toBe(withStandard);
  });

  test("without the id set, the legacy title keyword still works (back-compat)", () => {
    const base = bothBase({
      grossAmount: 11200,
      lines: [rest[0], standardVatLine, rest[1]],
      vatKeyword: "input vat",
    });
    expect(base).toBe(10000);
  });

  test("id set present but title non-standard and NOT in id set -> VAT line not subtracted", () => {
    // (documents the behavior: identity is authoritative; a mis-tagged
    // account is simply not treated as the VAT line)
    const base = bothBase({
      grossAmount: 11200,
      lines: [rest[0], nonStandardVatLine, rest[1]],
      vatAccountIds: [999],
      vatKeyword: "input vat",
    });
    expect(base).toBe(11200);
  });
});

describe("Phase 7L - structured VAT line identity survives a non-standard account title", () => {
  test("a structured INPUT_VAT taxEntry is recognized regardless of account title", () => {
    const line = {
      accountId: 500,
      accountTitle: "Taxes Recoverable", // not 'input vat'
      debit: 1200,
      credit: 0,
      taxEntry: { entryType: "INPUT_VAT", netAmount: 10000, vatAmount: 1200, vatRate: 12 },
    };
    const base = bothBase({ grossAmount: 0, lines: [line] });
    expect(base).toBe(10000);
  });

  test("OUTPUT_VAT structured line (Invoice direction) is recognized the same way", () => {
    const line = {
      accountId: 501,
      accountTitle: "VAT on Sales",
      debit: 0,
      credit: 2400,
      taxEntry: { entryType: "OUTPUT_VAT", netAmount: 20000, vatAmount: 2400, vatRate: 12 },
    };
    expect(bothBase({ grossAmount: 0, lines: [line] })).toBe(20000);
  });
});

describe("Phase 7L - the wrong pre-7L answer is never produced", () => {
  test("11,200 inclusive + EWT 10% never yields base 8,800 or amount 880", () => {
    const vatLine = structuredInputVatLine({ gross: 11200, rate: 12 });
    const lines = [
      { accountId: 1, accountTitle: "Purchases", debit: 10000, credit: 0 },
      vatLine,
      { accountId: 2, accountTitle: "Accounts Payable", debit: 0, credit: 10000 }, // unbalanced on purpose
    ];
    const base = bothBase({ grossAmount: 10000, lines });
    expect(base).not.toBe(8800);
    expect(base).toBe(10000);
    expect(bothAmount({ taxableBase: base, ewtRate: 10 })).not.toBe(880);
    expect(bothAmount({ taxableBase: base, ewtRate: 10 })).toBe(1000);
  });
});

describe("Phase 7L - parity of the id-set shape and edge inputs", () => {
  const vatLine = { accountId: 77, accountTitle: "Taxes Recoverable", debit: 1200, credit: 0 };
  const rest = [
    { accountId: 1, accountTitle: "Purchases", debit: 10000, credit: 0 },
    { accountId: 2, accountTitle: "Accounts Payable", debit: 0, credit: 11200 },
  ];

  test("id set given as Array, Set, or single value are all equivalent", () => {
    const asArray = bothBase({ grossAmount: 11200, lines: [rest[0], vatLine, rest[1]], vatAccountIds: [77] });
    const asSet = bothBase({ grossAmount: 11200, lines: [rest[0], vatLine, rest[1]], vatAccountIds: new Set(["77"]) });
    const asSingle = bothBase({ grossAmount: 11200, lines: [rest[0], vatLine, rest[1]], vatAccountId: 77 });
    expect(asArray).toBe(10000);
    expect(asSet).toBe(10000);
    expect(asSingle).toBe(10000);
  });

  test("empty / missing lines are safe on both implementations", () => {
    expect(bothBase({ grossAmount: 0, lines: [] })).toBe(0);
    expect(bothBase({ grossAmount: 5000, lines: undefined, vatKeyword: "input vat" })).toBe(5000);
  });

  test("rounding: computeEwtAmount agrees on a value that needs rounding", () => {
    // base 8,928.57 @ 10% = 892.857 -> 892.86 on both
    expect(bothAmount({ taxableBase: 8928.57, ewtRate: 10 })).toBe(892.86);
  });
});
