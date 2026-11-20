// P1 transaction-entry regressions (TEST CASE 1). node-only jest: pure helpers
// are unit tested and component wiring is asserted from source, the same
// style as transactionEntryUat.test.js.
//   TC1-086   every module lists / opens / saves its document by voucher_no;
//             reference_no is kept as the supporting reference (the rule APV
//             already used), so an edit can never overwrite the number
//   TC1-090b  a Save Draft / Post validation message is scrolled into view
//   readability  the journal grid's selected account wraps (full CODE - NAME)
const fs = require("fs");
const path = require("path");

const TX = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(TX, f), "utf8");
let M;
beforeAll(async () => {
  M = await import("../transactionListFilters.mjs");
});

describe("TC1-086 - document number = voucher_no in every module", () => {
  test.each([
    ["CV", { voucherNo: "CV-0001", referenceNo: "SI-UAT-0001" }],
    ["DM", { voucherNo: "DM-0001", referenceNo: "INV-0003" }],
    ["CM", { voucherNo: "CM-0001", referenceNo: "INV-0003" }],
    ["INV", { voucherNo: "INV-0001", referenceNo: "PO-CUST-77" }],
  ])("%s: number is voucher_no, the reference stays separate", (_mod, item) => {
    expect(M.apvNumberFields(item)).toEqual({ referenceNo: item.voucherNo, supportingReference: item.referenceNo });
  });

  test("no list row or loaded record maps the number from reference_no any more", () => {
    const src = read("TransactionFormLayout.jsx");
    expect(src).not.toMatch(/referenceNo:\s*item\.referenceNo\s*\|\|\s*item\.voucherNo/);
    expect(src).not.toMatch(/referenceNo:\s*data\.referenceNo\s*\|\|\s*data\.voucherNo/);
    expect((src.match(/\.\.\.apvNumberFields\(item\)/g) || []).length).toBeGreaterThanOrEqual(14);
    expect(src).toMatch(/\.\.\.apvNumberFields\(data\)/);
  });

  test("saving sends voucher_no as the number and the supporting reference as the reference", () => {
    const src = read("TransactionFormLayout.jsx");
    expect(src).toMatch(/voucherNo:\s*updatedForm\.referenceNo/);
    expect(src).toMatch(/referenceNo:\s*updatedForm\.supportingReference\s*\|\|\s*updatedForm\.referenceNo/);
  });
});

describe("TC1-090b - Save Draft never fails silently", () => {
  test("the error box is an alert and is scrolled into view whenever a message is set", () => {
    const src = read("TransactionFormLayout.jsx");
    expect(src).toMatch(/className="transaction-error-box" role="alert" ref=\{errorBoxRef\}/);
    expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(error && errorBoxRef\.current[\s\S]{0,160}scrollIntoView/);
  });
});

describe("account selector readability (shared SearchableAccountSelect)", () => {
  test("the journal grid opts into the wrapping trigger and a wider Account column", () => {
    const grid = read("AccountingEntriesGrid.jsx");
    expect(grid).toMatch(/ariaLabel="Line account"\s*\n\s*wrapSelectedLabel/);
    expect(grid).toMatch(/<th className="transaction-account-col">Account<\/th>/);
    expect(read("TransactionFormLayout.css")).toMatch(/th\.transaction-account-col \{\s*width: 30%;\s*min-width: 260px;/);
  });
  test("the wrapping trigger is a read-only textarea with the full label as its tooltip; other uses stay single-line", () => {
    const src = read("SearchableAccountSelect.jsx");
    expect(src).toMatch(/wrapSelectedLabel = false/);
    expect(src).toMatch(/const TriggerTag = wrapSelectedLabel \? "textarea" : "input"/);
    expect(src).toMatch(/title=\{shownLabel \|\| undefined\}/);
    expect(read("SearchableAccountSelect.css")).toMatch(/\.searchable-account-input-wrap \{[\s\S]*height: auto;[\s\S]*white-space: normal;/);
  });
});
