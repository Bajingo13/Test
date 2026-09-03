let B;

beforeAll(async () => {
  B = await import("../apvJournalBalance.mjs");
});

// isAPorARAccount stub: ids 900 (AP) and 901 (AR) are control accounts.
const isAPorAR = (id) => String(id) === "900" || String(id) === "901";

const L = {
  expense: (amt) => ({ id: "exp", accountId: 1, debit: String(amt), credit: "" }),
  ap: (amt) => ({ id: "ap", accountId: 900, debit: "", credit: amt == null ? "" : String(amt) }),
  inputVat: (amt) => ({
    id: "vat",
    accountId: 500,
    debit: String(amt),
    credit: "",
    taxEntry: { entryType: "INPUT_VAT", netAmount: 10000, vatAmount: amt, vatRate: 12 },
  }),
  ewtPayable: (amt) => ({
    id: "ewt",
    accountId: 600,
    debit: "",
    credit: String(amt),
    taxEntry: { entryType: "EWT", atcCode: "WC010", withheldAmount: amt },
  }),
};

const creditOf = (lines, id) => Number(lines.find((l) => l.id === id).credit);
const totals = (lines) => {
  const d = lines.reduce((s, l) => s + Number(l.debit || 0), 0);
  const c = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
  return { d, c, balanced: Math.round((d - c) * 100) / 100 === 0 };
};

describe("Phase 7L Part E - APV VAT-only auto-balance", () => {
  test("one unambiguous AP line -> AP credit set to gross, journal balances", () => {
    const lines = [L.expense(10000), L.inputVat(1200), L.ap(10000)]; // AP still at net
    const res = B.applyApvTaxBalancing(lines, { isAPorARAccount: isAPorAR });
    expect(res.status).toBe("BALANCED");
    expect(creditOf(res.lines, "ap")).toBe(11200);
    expect(totals(res.lines)).toMatchObject({ d: 11200, c: 11200, balanced: true });
    // the substantive expense base is untouched
    expect(Number(res.lines.find((l) => l.id === "exp").debit)).toBe(10000);
    expect(Number(res.lines.find((l) => l.id === "vat").debit)).toBe(1200);
  });

  test("VAT + EWT -> AP credit = gross - EWT (10,200), EWT Payable 1,000, balances 11,200", () => {
    const lines = [L.expense(10000), L.inputVat(1200), L.ewtPayable(1000), L.ap(10000)];
    const res = B.applyApvTaxBalancing(lines, { isAPorARAccount: isAPorAR });
    expect(res.status).toBe("BALANCED");
    expect(creditOf(res.lines, "ewt")).toBe(1000); // unchanged
    expect(creditOf(res.lines, "ap")).toBe(10200); // gross 11,200 - EWT 1,000
    expect(totals(res.lines)).toMatchObject({ d: 11200, c: 11200, balanced: true });
    // expense base and Input VAT never reduced
    expect(Number(res.lines.find((l) => l.id === "exp").debit)).toBe(10000);
    expect(Number(res.lines.find((l) => l.id === "vat").debit)).toBe(1200);
  });
});

describe("Phase 7L Part E - ambiguity is never guessed", () => {
  test("no AP/control credit line -> AMBIGUOUS, lines unchanged, message shown", () => {
    const lines = [L.expense(10000), L.inputVat(1200), { id: "cash", accountId: 2, debit: "", credit: "10000" }];
    const res = B.applyApvTaxBalancing(lines, { isAPorARAccount: isAPorAR });
    expect(res.status).toBe("AMBIGUOUS");
    expect(res.lines).toBe(lines); // exact same reference - nothing mutated
    expect(res.message).toBe(B.AP_AMBIGUITY_MESSAGE);
  });

  test("two AP/control credit candidates -> AMBIGUOUS, nothing mutated", () => {
    const lines = [
      L.expense(10000),
      L.inputVat(1200),
      { id: "ap1", accountId: 900, debit: "", credit: "5000" },
      { id: "ap2", accountId: 900, debit: "", credit: "5000" },
    ];
    const res = B.applyApvTaxBalancing(lines, { isAPorARAccount: isAPorAR });
    expect(res.status).toBe("AMBIGUOUS");
    expect(res.lines).toBe(lines);
  });

  test("non-payable credits already exceed debits -> AMBIGUOUS (no negative payable invented)", () => {
    const lines = [
      L.expense(1000),
      L.inputVat(1200),
      { id: "other", accountId: 3, debit: "", credit: "9000" },
      L.ap(0),
    ];
    const res = B.applyApvTaxBalancing(lines, { isAPorARAccount: isAPorAR });
    expect(res.status).toBe("AMBIGUOUS");
  });

  test("disabled (non-APV module) -> lines returned verbatim, no message", () => {
    const lines = [L.expense(10000), L.inputVat(1200), L.ap(10000)];
    const res = B.applyApvTaxBalancing(lines, { isAPorARAccount: isAPorAR, enabled: false });
    expect(res.status).toBe("DISABLED");
    expect(res.lines).toBe(lines);
    expect(res.message).toBe("");
  });
});

describe("Phase 7L Part E - remove / re-add produces no drift", () => {
  test("add VAT -> add EWT -> remove EWT -> remove VAT restores AP each step", () => {
    // start: Dr Expense 10000 / Cr AP 10000
    let lines = [L.expense(10000), L.ap(10000)];

    // + Input VAT
    lines = [...lines.slice(0, 1), L.inputVat(1200), lines[1]];
    let res = B.applyApvTaxBalancing(lines, { isAPorARAccount: isAPorAR });
    expect(res.status).toBe("BALANCED");
    expect(creditOf(res.lines, "ap")).toBe(11200);
    lines = res.lines;

    // + EWT
    lines = [...lines.slice(0, 2), L.ewtPayable(1000), lines[2]];
    res = B.applyApvTaxBalancing(lines, { isAPorARAccount: isAPorAR });
    expect(creditOf(res.lines, "ap")).toBe(10200);
    lines = res.lines;

    // - EWT
    lines = lines.filter((l) => l.id !== "ewt");
    res = B.applyApvTaxBalancing(lines, { isAPorARAccount: isAPorAR });
    expect(creditOf(res.lines, "ap")).toBe(11200); // back to gross
    lines = res.lines;

    // - VAT
    lines = lines.filter((l) => l.id !== "vat");
    res = B.applyApvTaxBalancing(lines, { isAPorARAccount: isAPorAR });
    expect(creditOf(res.lines, "ap")).toBe(10000); // fully restored, no drift
    expect(totals(res.lines).balanced).toBe(true);
  });

  test("repeated add -> remove -> add of Input VAT never accumulates", () => {
    let lines = [L.expense(10000), L.ap(10000)];
    for (let i = 0; i < 5; i += 1) {
      lines = [lines[0], L.inputVat(1200), lines[lines.length - 1]];
      lines = B.applyApvTaxBalancing(lines, { isAPorARAccount: isAPorAR }).lines;
      expect(creditOf(lines, "ap")).toBe(11200);
      lines = lines.filter((l) => l.id !== "vat");
      lines = B.applyApvTaxBalancing(lines, { isAPorARAccount: isAPorAR }).lines;
      expect(creditOf(lines, "ap")).toBe(10000);
    }
  });
});

describe("Phase 7L Part E - editing VAT rebalances", () => {
  test("changing the VAT amount (rate/mode/treatment edit) re-derives the AP credit", () => {
    let lines = [L.expense(10000), L.inputVat(1200), L.ap(11200)];
    // user edits the VAT entry: now 0% treatment -> VAT 0
    lines = lines.map((l) =>
      l.id === "vat"
        ? { ...l, debit: "0", taxEntry: { entryType: "INPUT_VAT", netAmount: 10000, vatAmount: 0, vatRate: 0 } }
        : l
    );
    const res = B.applyApvTaxBalancing(lines, { isAPorARAccount: isAPorAR });
    expect(creditOf(res.lines, "ap")).toBe(10000);
    expect(totals(res.lines).balanced).toBe(true);
  });
});

describe("Phase 7L Part E - counterparty identification primitives", () => {
  test("identifyCounterpartyCreditLineId: exactly one -> its id; zero -> null; many -> null", () => {
    expect(
      B.identifyCounterpartyCreditLineId([L.expense(10000), L.inputVat(1200), L.ap(10000)], isAPorAR)
    ).toBe("ap");
    expect(
      B.identifyCounterpartyCreditLineId([L.expense(10000), L.inputVat(1200)], isAPorAR)
    ).toBeNull();
    expect(
      B.identifyCounterpartyCreditLineId(
        [L.expense(10000), { id: "ap1", accountId: 900, debit: "", credit: "5000" }, { id: "ap2", accountId: 900, debit: "", credit: "5000" }],
        isAPorAR
      )
    ).toBeNull();
  });

  test("an AP-tagged line that currently carries a DEBIT is not a counterparty-credit candidate", () => {
    // e.g. a CV-style AP settlement debit - must not be picked as the credit to adjust
    const lines = [
      { id: "apdr", accountId: 900, debit: "5000", credit: "" },
      L.inputVat(1200),
      L.ap(6200),
    ];
    expect(B.counterpartyCreditCandidates(lines, isAPorAR).map((l) => l.id)).toEqual(["ap"]);
  });

  test("a tax line is never treated as the counterparty even if its account is AP-tagged", () => {
    const taxOnApAccount = {
      id: "weird",
      accountId: 900,
      debit: "",
      credit: "1000",
      taxEntry: { entryType: "EWT", withheldAmount: 1000 },
    };
    const lines = [L.expense(10000), L.inputVat(1200), taxOnApAccount, L.ap(10200)];
    expect(B.identifyCounterpartyCreditLineId(lines, isAPorAR)).toBe("ap");
    const res = B.applyApvTaxBalancing(lines, { isAPorARAccount: isAPorAR });
    expect(res.status).toBe("BALANCED");
    expect(creditOf(res.lines, "weird")).toBe(1000); // tax line untouched
    expect(creditOf(res.lines, "ap")).toBe(10200);
  });

  test("requiredCounterpartyCredit is pure arithmetic over the current lines", () => {
    const lines = [L.expense(10000), L.inputVat(1200), L.ewtPayable(1000), L.ap(0)];
    expect(B.requiredCounterpartyCredit(lines, "ap")).toBe(10200);
  });
});
