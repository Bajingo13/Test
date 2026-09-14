// Pure unit tests for the HMAC signing/classification logic - no database
// involved (findByToken/issueVerification/reSignVerification are thin SQL
// wrappers around this same logic and are exercised instead by the manual
// HTTP verification steps in the implementation report, since this repo's
// test DB isn't available in this environment). db.js is mocked purely so
// requiring the service module never tries to open a real pool.
jest.mock("../../db", () => ({ execute: jest.fn() }));

const ORIGINAL_HMAC_SECRET = process.env.HMAC_SECRET;

beforeAll(() => {
  process.env.HMAC_SECRET = "test-only-hmac-secret-do-not-use-in-prod";
});

afterAll(() => {
  process.env.HMAC_SECRET = ORIGINAL_HMAC_SECRET;
});

const InvoiceVerificationService = require("../invoiceVerificationService");

function issuedRow(overrides = {}) {
  const base = {
    id: 1,
    companyId: 10,
    voucherNo: "INV-000123",
    customerId: 55,
    customerName: "Acme Corp",
    transactionDate: "2026-01-15",
    totalDebit: 11200,
    totalCredit: 11200,
    currencyId: 1,
    status: "POSTED",
    verificationToken: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
  const row = { ...base, ...overrides };
  row.verificationSignature = InvoiceVerificationService.computeSignature({
    voucherNo: row.voucherNo,
    transactionDate: row.transactionDate,
    customerId: row.customerId,
    customerName: row.customerName,
    totalDebit: row.totalDebit,
    totalCredit: row.totalCredit,
    currencyId: row.currencyId,
    companyId: row.companyId,
    verificationToken: row.verificationToken,
  });
  return row;
}

describe("invoiceVerificationService.generateVerificationToken", () => {
  test("produces a 32-char hex token, unique per call", () => {
    const a = InvoiceVerificationService.generateVerificationToken();
    const b = InvoiceVerificationService.generateVerificationToken();
    expect(a).toMatch(/^[a-f0-9]{32}$/);
    expect(b).toMatch(/^[a-f0-9]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe("invoiceVerificationService.classifyInvoice", () => {
  test("nonexistent record -> not_found, invalid", () => {
    expect(InvoiceVerificationService.classifyInvoice(null)).toEqual({ valid: false, reason: "not_found" });
  });

  test("a row that predates this feature (no token/signature) -> not_issued, invalid", () => {
    const row = issuedRow({ verificationToken: null, verificationSignature: null });
    expect(InvoiceVerificationService.classifyInvoice(row)).toEqual({ valid: false, reason: "not_issued" });
  });

  test("a correctly-signed, POSTED invoice -> valid", () => {
    const row = issuedRow();
    expect(InvoiceVerificationService.classifyInvoice(row)).toEqual({ valid: true, reason: "valid" });
  });

  test.each(["Void", "VOID", "Cancelled", "CANCELLED"])(
    "status=%s -> voided, invalid even though the signature itself is intact",
    (status) => {
      const row = issuedRow({ status });
      expect(InvoiceVerificationService.classifyInvoice(row)).toEqual({ valid: false, reason: "voided" });
    }
  );

  test("a protected field changed after signing (totalDebit tampered) -> altered, invalid", () => {
    const row = issuedRow();
    row.totalDebit = 999999; // signature no longer matches this value
    expect(InvoiceVerificationService.classifyInvoice(row)).toEqual({ valid: false, reason: "altered" });
  });

  test("customerName changed after signing -> altered, invalid", () => {
    const row = issuedRow();
    row.customerName = "Someone Else Inc.";
    expect(InvoiceVerificationService.classifyInvoice(row)).toEqual({ valid: false, reason: "altered" });
  });

  test("a corrupted/truncated signature -> altered, invalid (never throws)", () => {
    const row = issuedRow();
    row.verificationSignature = row.verificationSignature.slice(0, 10); // wrong length
    expect(() => InvoiceVerificationService.classifyInvoice(row)).not.toThrow();
    expect(InvoiceVerificationService.classifyInvoice(row)).toEqual({ valid: false, reason: "altered" });
  });

  test("volatile fields (paid/balance amount, remarks) are not part of the signed payload, so they can never trigger a false 'altered'", () => {
    const row = issuedRow();
    // classifyInvoice/computeSignature never read paidAmount/balanceAmount/
    // remarks/status off the row for signing purposes (status is checked
    // separately, see the voided tests above) - simulating a payment
    // application or remark edit by adding unrelated fields must not
    // change the classification.
    const withVolatileChanges = { ...row, paidAmount: 5000, balanceAmount: 6200, remarks: "partial payment applied" };
    expect(InvoiceVerificationService.classifyInvoice(withVolatileChanges)).toEqual({ valid: true, reason: "valid" });
  });
});

describe("invoiceVerificationService.computeSignature", () => {
  test("is deterministic for identical protected-field input", () => {
    const fields = {
      voucherNo: "INV-000999", transactionDate: "2026-02-01", customerId: 2, customerName: "X",
      totalDebit: 100, totalCredit: 100, currencyId: 1, companyId: 1, verificationToken: "b".repeat(32),
    };
    expect(InvoiceVerificationService.computeSignature(fields)).toBe(InvoiceVerificationService.computeSignature(fields));
  });

  test("throws a clear error when HMAC_SECRET is not configured, instead of signing with an empty secret", () => {
    const saved = process.env.HMAC_SECRET;
    delete process.env.HMAC_SECRET;
    try {
      expect(() => InvoiceVerificationService.computeSignature({ voucherNo: "X" })).toThrow(/HMAC_SECRET/);
    } finally {
      process.env.HMAC_SECRET = saved;
    }
  });
});
