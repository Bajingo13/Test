const {
  isValidEmail,
  resolveRecipient,
  safePdfFilename,
  orEmailSubject,
  orEmailBody,
} = require("../services/orEmailService");

// Batch 8: pure helpers for POST /api/or/:id/email. No DB / SMTP.

describe("orEmailService.isValidEmail", () => {
  test.each([
    ["a@b.co", true],
    ["first.last@sub.domain.com", true],
    ["  spaced@x.io  ", true],
    ["no-at-sign", false],
    ["a@b", false],
    ["a@@b.co", false],
    ["", false],
    [null, false],
    [123, false],
  ])("%p -> %p", (v, expected) => {
    expect(isValidEmail(v)).toBe(expected);
  });
});

describe("orEmailService.resolveRecipient - precedence", () => {
  test("request override wins over the library address", () => {
    const r = resolveRecipient({ requestTo: "override@x.io", customerEmail: "lib@y.io" });
    expect(r).toMatchObject({ email: "override@x.io", source: "request", valid: true });
  });

  test("falls back to the customer library email when no override", () => {
    const r = resolveRecipient({ requestTo: "", customerEmail: "lib@y.io" });
    expect(r).toMatchObject({ email: "lib@y.io", source: "general_library", valid: true });
  });

  test("no override and no library email -> null / source none", () => {
    const r = resolveRecipient({ requestTo: null, customerEmail: null });
    expect(r).toEqual({ email: null, source: "none", valid: false });
  });

  test("an INVALID override is a client error - it does NOT fall through to the library", () => {
    const r = resolveRecipient({ requestTo: "garbage", customerEmail: "lib@y.io" });
    expect(r).toEqual({ email: null, source: "request", valid: false });
  });

  test("an invalid library email yields null (source general_library)", () => {
    const r = resolveRecipient({ requestTo: "", customerEmail: "not-an-email" });
    expect(r).toEqual({ email: null, source: "general_library", valid: false });
  });

  test("whitespace-only override is treated as absent", () => {
    const r = resolveRecipient({ requestTo: "   ", customerEmail: "lib@y.io" });
    expect(r.source).toBe("general_library");
    expect(r.email).toBe("lib@y.io");
  });
});

describe("orEmailService.safePdfFilename", () => {
  test("normal voucher", () => {
    expect(safePdfFilename("OR-2026-000123")).toBe("OR-2026-000123.pdf");
  });
  test("strips path separators and reserved characters", () => {
    expect(safePdfFilename("OR/2026\\00:1*2?3")).toBe("OR-2026-00-1-2-3.pdf");
  });
  test("collapses spaces and trims edge punctuation", () => {
    expect(safePdfFilename("  OR   123 .. ")).toBe("OR-123.pdf");
  });
  test("empty -> document.pdf", () => {
    expect(safePdfFilename("")).toBe("document.pdf");
    expect(safePdfFilename(null)).toBe("document.pdf");
  });
  test("always ends .pdf and is length-capped", () => {
    const out = safePdfFilename("x".repeat(500));
    expect(out.endsWith(".pdf")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(124);
  });
});

describe("orEmailService.orEmailSubject / orEmailBody", () => {
  test("subject includes company + voucher", () => {
    expect(orEmailSubject("OR-1", "Acme Inc")).toBe("Acme Inc - Official Receipt OR-1");
    expect(orEmailSubject("OR-1", "")).toBe("Official Receipt OR-1");
  });

  test("body mentions the voucher, customer, date and an optional custom message", () => {
    const { text, html } = orEmailBody({
      voucherNo: "OR-9",
      customerName: "Jane",
      companyName: "Acme",
      transactionDate: "2026-09-03",
      customMessage: "Thanks for your payment.",
    });
    expect(text).toContain("Dear Jane,");
    expect(text).toContain("Thanks for your payment.");
    expect(text).toContain("Official Receipt OR-9");
    expect(text).toContain("2026-09-03");
    expect(text).toContain("Acme");
    expect(html).toContain("<p>");
    // no secrets, no raw script
    expect(html).not.toMatch(/<script/i);
  });

  test("html-escapes user content", () => {
    const { html } = orEmailBody({ voucherNo: "OR-1", customerName: "<b>x</b>", companyName: "C", customMessage: "<script>" });
    expect(html).not.toContain("<b>x</b>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;");
  });
});
