// Public invoice QR verification - canonical signature input (pure, no DB).
// QR-002 / QR-007 normalization, representation-independence of the
// signature, field-tamper sensitivity, and the strict legacy (v1) path.
jest.mock("../../db", () => ({ execute: jest.fn() }));

const crypto = require("crypto");
const ORIGINAL_HMAC_SECRET = process.env.HMAC_SECRET;
const SECRET = "test-only-qr-canonical-secret";
// Set at load time: some fixtures below are signed while describe blocks are collected.
process.env.HMAC_SECRET = SECRET;
afterAll(() => { process.env.HMAC_SECRET = ORIGINAL_HMAC_SECRET; });

const S = require("../invoiceVerificationService");

const TOKEN = "c".repeat(32);
// A row exactly as mysql2 returns it from SIGNED_ROW_COLUMNS
// (DECIMAL -> string, INT -> number, DATE_FORMAT -> string).
function dbRow(overrides = {}) {
  return {
    id: 7, companyId: 1, voucherNo: "INV-QR-0001", customerId: 55, customerName: "Acme Corp",
    transactionDate: "2026-11-20", totalDebit: "9000.00", totalCredit: "9000.00", currencyId: 1,
    status: "POSTED", verificationToken: TOKEN, ...overrides,
  };
}
function signed(row) { return { ...row, verificationSignature: S.computeSignature(row) }; }

describe("QR-002 canonical money: 9000 / 9000.00 / mysql2 '9000.00' are one value", () => {
  test.each([[9000], ["9000"], ["9000.0"], ["9000.00"], [9000.0], ["09000.00"], [" 9000.00 "]])("%p -> '9000.00'", (v) => {
    expect(S.canonicalMoney(v)).toBe("9000.00");
  });
  test("the signature is identical whichever representation the totals arrive in", () => {
    const sigs = new Set([9000, "9000", "9000.0", "9000.00"].map((v) => S.computeSignature(dbRow({ totalDebit: v, totalCredit: v }))));
    expect(sigs.size).toBe(1);
  });
  test("a numeric-total row and the mysql2 string-total row verify against each other", () => {
    const issued = signed(dbRow({ totalDebit: 9000, totalCredit: 9000 }));
    expect(S.classifyInvoice({ ...issued, totalDebit: "9000.00", totalCredit: "9000.00" })).toEqual({ valid: true, reason: "valid" });
  });
});

describe("QR-007 deterministic normalization", () => {
  test.each([
    [0, "0.00"], ["0", "0.00"], ["0.00", "0.00"], ["-0", "0.00"], ["-0.00", "0.00"],
    [100.5, "100.50"], ["100.50", "100.50"], ["100.5", "100.50"],
    [1000.1, "1000.10"], ["1000.10", "1000.10"],
    [1000000, "1000000.00"], ["1000000.00", "1000000.00"],
    ["0.01", "0.01"], [0.01, "0.01"], ["-25.5", "-25.50"], ["+12", "12.00"],
    ["9999999999999.99", "9999999999999.99"], // DECIMAL(15,2) max - exact, no float rounding
    ["1234567890123.45", "1234567890123.45"],
    ["9000.000", "9000.00"], // only zero digits beyond scale
  ])("%p -> %p", (input, expected) => {
    expect(S.canonicalMoney(input)).toBe(expected);
  });
  test("repeated calls are stable", () => {
    for (const v of [0, "100.50", 1000.1, "1000000.00"]) expect(S.canonicalMoney(v)).toBe(S.canonicalMoney(S.canonicalMoney(v)));
  });
  test("null / undefined / empty -> null", () => {
    expect(S.canonicalMoney(null)).toBeNull();
    expect(S.canonicalMoney(undefined)).toBeNull();
    expect(S.canonicalMoney("")).toBeNull();
  });
  test.each([["1e3"], [1e21], [NaN], [Infinity], ["abc"], ["9000.001"], [0.1 + 0.2], ["1,000.00"], ["0x10"], [true], [{}]])(
    "refuses (never rounds) %p", (bad) => {
      expect(() => S.canonicalMoney(bad)).toThrow(S.CanonicalValueError);
    }
  );
  test("integers and dates canonicalize to one form", () => {
    expect(S.canonicalInteger(55)).toBe("55");
    expect(S.canonicalInteger("55")).toBe("55");
    expect(S.canonicalInteger("055")).toBe("55");
    expect(S.canonicalInteger(null)).toBeNull();
    expect(() => S.canonicalInteger(5.5)).toThrow(S.CanonicalValueError);
    expect(S.canonicalDate("2026-11-20")).toBe("2026-11-20");
    expect(() => S.canonicalDate("11/20/2026")).toThrow(S.CanonicalValueError);
  });
  test("the canonical payload is versioned and fixed-order", () => {
    expect(S.buildCanonicalPayload(dbRow())).toBe(
      '{"v":2,"voucherNo":"INV-QR-0001","transactionDate":"2026-11-20","customerId":"55","customerName":"Acme Corp",' +
      '"totalDebit":"9000.00","totalCredit":"9000.00","currencyId":"1","companyId":"1","verificationToken":"' + TOKEN + '"}'
    );
  });
});

describe("QR-003/004/006 + security: every signed field invalidates the signature", () => {
  const issued = signed(dbRow());
  test("baseline verifies", () => expect(S.classifyInvoice(issued)).toEqual({ valid: true, reason: "valid" }));
  test.each([
    ["totalDebit", "9000.01"], ["totalCredit", "8999.99"], ["totalDebit", "90000.00"],
    ["voucherNo", "INV-QR-0002"], ["voucherNo", "inv-qr-0001"], ["transactionDate", "2026-11-21"],
    ["customerId", 56], ["customerName", "Acme Corp."], ["currencyId", 2], ["companyId", 2],
    ["verificationToken", "d".repeat(32)],
  ])("%s -> %p is altered", (field, value) => {
    expect(S.classifyInvoice({ ...issued, [field]: value })).toEqual({ valid: false, reason: "altered" });
  });
  test("QR-005 tampered signature (one hex digit flipped) is altered", () => {
    const sig = issued.verificationSignature;
    const flipped = sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0");
    expect(S.classifyInvoice({ ...issued, verificationSignature: flipped })).toEqual({ valid: false, reason: "altered" });
  });
  test("an un-canonicalizable stored value is altered, never a thrown error", () => {
    expect(S.classifyInvoice({ ...issued, totalDebit: "9000.005" })).toEqual({ valid: false, reason: "altered" });
    expect(S.classifyInvoice({ ...issued, transactionDate: "garbage" })).toEqual({ valid: false, reason: "altered" });
  });
  test("a signature made with a different secret is altered", () => {
    const foreign = crypto.createHmac("sha256", "another-secret").update(S.buildCanonicalPayload(issued)).digest("hex");
    expect(S.classifyInvoice({ ...issued, verificationSignature: foreign })).toEqual({ valid: false, reason: "altered" });
  });
});

describe("QR-008 strict legacy (pre-fix, v1) signatures", () => {
  // Exactly what the pre-fix issuance computed: JSON of PROTECTED_FIELDS,
  // totals as the JS number from the request, other fields as passed.
  function legacySign(fields) {
    const ordered = {};
    for (const k of S.PROTECTED_FIELDS) ordered[k] = fields[k] ?? null;
    return crypto.createHmac("sha256", SECRET).update(JSON.stringify(ordered)).digest("hex");
  }
  const preFixIssued = { voucherNo: "INV-OLD-1", transactionDate: "2026-10-01", customerId: 55, customerName: "Acme Corp",
    totalDebit: 1000.1, totalCredit: 1000.1, currencyId: 1, companyId: 1, verificationToken: TOKEN };
  const stored = dbRow({ ...preFixIssued, totalDebit: "1000.10", totalCredit: "1000.10", verificationSignature: legacySign(preFixIssued) });

  test("a pre-fix invoice read back from the DB verifies via the explicit legacy path", () => {
    expect(S.classifyInvoice(stored)).toEqual({ valid: true, reason: "valid_legacy" });
  });
  test("the legacy reconstruction is single and exact - any change still fails", () => {
    expect(S.classifyInvoice({ ...stored, totalDebit: "1000.11" })).toEqual({ valid: false, reason: "altered" });
    expect(S.classifyInvoice({ ...stored, voucherNo: "INV-OLD-2" })).toEqual({ valid: false, reason: "altered" });
    expect(S.classifyInvoice({ ...stored, customerName: "Other" })).toEqual({ valid: false, reason: "altered" });
  });
  test("v1 and v2 payloads can never collide (version field)", () => {
    expect(S.buildCanonicalPayload(stored)).not.toBe(S.buildLegacyPayload(stored));
    expect(S.computeSignature(stored)).not.toBe(S.computeLegacySignature(stored));
  });
  test("new signatures are always v2, never legacy", () => {
    expect(S.classifyInvoice(signed(dbRow()))).toEqual({ valid: true, reason: "valid" });
  });
});

describe("issuance / re-sign sign the PERSISTED row, not caller values", () => {
  function fakeConn(row) {
    const calls = [];
    return {
      calls,
      execute: jest.fn(async (sql, params) => {
        calls.push([sql, params]);
        if (/^UPDATE invoice_headers SET verification_token/.test(sql)) { row.verificationToken = params[0]; return [{}]; }
        if (/^UPDATE invoice_headers SET verification_signature/.test(sql)) { row.verificationSignature = params[0]; return [{}]; }
        if (/^SELECT/.test(sql)) return [[{ ...row }]];
        throw new Error("unexpected SQL " + sql);
      }),
    };
  }
  test("issueVerification ignores request values and signs what was stored", async () => {
    const row = dbRow({ verificationToken: null });
    const conn = fakeConn(row);
    const out = await S.issueVerification(conn, { invoiceId: 7, totalDebit: 123456, voucherNo: "WRONG" });
    expect(out.verificationToken).toMatch(/^[a-f0-9]{32}$/);
    expect(S.classifyInvoice(row)).toEqual({ valid: true, reason: "valid" });
    expect(out.signature).toBe(S.computeSignature(row));
  });
  test("reSignVerification signs the updated persisted row with the same token", async () => {
    const row = signed(dbRow());
    const conn = fakeConn(row);
    row.totalDebit = "9500.00"; row.totalCredit = "9500.00"; // the PUT already updated the header
    expect(S.classifyInvoice(row).valid).toBe(false);
    await S.reSignVerification(conn, { invoiceId: 7, verificationToken: TOKEN, totalDebit: 1 });
    expect(row.verificationToken).toBe(TOKEN);
    expect(S.classifyInvoice(row)).toEqual({ valid: true, reason: "valid" });
  });
  test("reSignVerification without a token is a no-op", async () => {
    const conn = fakeConn(dbRow());
    expect(await S.reSignVerification(conn, { invoiceId: 7, verificationToken: null })).toBeNull();
    expect(conn.execute).not.toHaveBeenCalled();
  });
});
