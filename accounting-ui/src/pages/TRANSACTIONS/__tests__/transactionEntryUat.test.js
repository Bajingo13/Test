// Transaction-entry UAT regression suite (Accountant maker workflow, Demo
// UAT 2026-11). jest here is node-only (no jsdom), so pure helpers are unit
// tested and component wiring is asserted from source - same style as
// searchableAccountSelect.test.js / transactionHeaderLayout.test.js.
//   A  Check Voucher / OR payment amount = the voucher's bank movement
//   B  Payment Details fields lose focus after one character
//   C  Customer / supplier filtering per module
//   D  account dropdown too narrow / names truncated
//   E  account search box unreadable in dark mode
const fs = require("fs");
const path = require("path");

const TX = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(TX, f), "utf8");
let pay, party, acct;
beforeAll(async () => {
  pay = await import("../../../utils/paymentAmount.mjs");
  party = await import("../../../utils/partyFilter.mjs");
  acct = await import("../accountSearch.mjs");
});

// ---------------------------------------------------------------------------
describe("A - payment amount follows the bank line (same rule as bank reconciliation)", () => {
  const bank = { id: 7, coaAccountId: 20 };
  test("CV: credit - debit of the lines on the bank account's GL account, not the gross credit total", () => {
    const lines = [
      { accountId: 30, debit: 1000, credit: 0 }, // Dr AP
      { accountId: 20, debit: 0, credit: 980 }, // Cr Bank
      { accountId: 40, debit: 0, credit: 20 }, // Cr EWT payable
    ];
    expect(pay.paymentAmount({ code: "CV", lines, bankAccount: bank })).toEqual({ amount: 980, source: "BANK_LINE" });
  });
  test("OR: debit - credit on the bank account (money in)", () => {
    const lines = [{ accountId: "20", debit: 980, credit: 0 }, { accountId: 50, debit: 20, credit: 0 }, { accountId: 60, debit: 0, credit: 1000 }];
    expect(pay.paymentAmount({ code: "OR", lines, bankAccount: bank })).toEqual({ amount: 980, source: "BANK_LINE" });
  });
  test("several bank lines are netted; ids compare as strings", () => {
    const lines = [{ accountId: "20", debit: 0, credit: 600 }, { accountId: 20, debit: 100, credit: 400 }, { accountId: 30, debit: 900, credit: 0 }];
    expect(pay.paymentAmount({ code: "CV", lines, bankAccount: { coaAccountId: "20" } }).amount).toBe(900);
  });
  test("no line on the bank GL (or no bank / no GL link) -> gross (total debit) less tax withheld", () => {
    const lines = [{ accountId: 30, debit: 1000, credit: 0 }, { accountId: 99, debit: 0, credit: 1000 }];
    expect(pay.paymentAmount({ code: "CV", lines, bankAccount: bank, taxWithheld: "20" })).toEqual({ amount: 980, source: "GROSS_LESS_WITHHOLDING" });
    expect(pay.paymentAmount({ code: "CV", lines, bankAccount: null }).source).toBe("GROSS_LESS_WITHHOLDING");
    expect(pay.paymentAmount({ code: "CV", lines, bankAccount: { id: 1, coaAccountId: null } }).amount).toBe(1000);
  });
  test("empty voucher -> 0, never NaN", () => {
    expect(pay.paymentAmount({ code: "CV", lines: [], bankAccount: bank })).toEqual({ amount: 0, source: "GROSS_LESS_WITHHOLDING" });
    expect(pay.paymentAmount({ code: "OR", lines: [{ accountId: 20, debit: "", credit: undefined }], bankAccount: bank }).amount).toBe(0);
  });
  test("the form passes the helper's amount + source to the modal (no gross totals)", () => {
    const src = read("TransactionFormLayout.jsx");
    expect(src).toMatch(/import \{ paymentAmount \} from "..\/..\/utils\/paymentAmount.mjs"/);
    expect(src).toMatch(/amount=\{paymentDetailsAmount\.amount\}/);
    expect(src).toMatch(/amountSource=\{paymentDetailsAmount\.source\}/);
    expect(src).not.toMatch(/amount=\{code === "OR" \? totals\.totalDebit : totals\.totalCredit\}/);
  });
  test("the modal explains where the amount comes from", () => {
    const src = read("CashCheckDetailsModal.jsx");
    expect(src).toMatch(/data-testid="payment-amount-source"/);
  });
});

// ---------------------------------------------------------------------------
describe("B - Payment Details keeps focus while typing", () => {
  const src = read("CashCheckDetailsModal.jsx");
  test("the autofocus effect runs only when the modal opens (depends on [open], not onClose)", () => {
    const effect = src.slice(src.indexOf("useEffect(() => {"), src.indexOf("if (!open) return null;"));
    expect(effect).toMatch(/firstRef\.current\?\.focus\(\);/);
    expect(effect).toMatch(/\}, \[open\]\);/);
    expect(effect).not.toMatch(/\[open, onClose\]/);
  });
  test("Escape still closes through the latest onClose (ref), without re-running the effect", () => {
    expect(src).toMatch(/const onCloseRef = useRef\(onClose\);/);
    expect(src).toMatch(/onCloseRef\.current = onClose;/);
    expect(src).toMatch(/e\.key === "Escape" && onCloseRef\.current\(\)/);
  });
  test("the parent still passes an inline onClose (so the ref is what keeps focus stable)", () => {
    expect(read("TransactionFormLayout.jsx")).toMatch(/onClose=\{\(\) => setShowCashCheckModal\(false\)\}/);
  });
});

// ---------------------------------------------------------------------------
describe("C - party filtering is driven by the module's partyType", () => {
  const all = [
    { id: 1, type: "CUSTOMER" }, { id: 2, type: "SUPPLIER" }, { id: 3, type: "EMPLOYEE" }, { id: 4, type: "AFFILIATE" }, { id: 5, type: "supplier" },
  ];
  const ids = (list) => list.map((p) => p.id);
  test("SUPPLIER -> suppliers only, even when the label says 'Payee' (Check Voucher)", () => {
    expect(ids(party.filterPartiesForModule(all, { partyType: "SUPPLIER", partyLabel: "Payee" }))).toEqual([2, 5]);
  });
  test("CUSTOMER -> customers only; BOTH -> customers + suppliers", () => {
    expect(ids(party.filterPartiesForModule(all, { partyType: "CUSTOMER", partyLabel: "Customer" }))).toEqual([1]);
    expect(ids(party.filterPartiesForModule(all, { partyType: "BOTH", partyLabel: "Customer / Supplier" }))).toEqual([1, 2, 5]);
  });
  test("no partyType: label fallback; a neutral label (JV 'Prepared For', PCV 'Payee') allows every type", () => {
    expect(ids(party.filterPartiesForModule(all, { partyLabel: "Supplier" }))).toEqual([2, 5]);
    expect(ids(party.filterPartiesForModule(all, { partyLabel: "Prepared For" }))).toEqual([1, 2, 3, 4, 5]);
    expect(ids(party.filterPartiesForModule(all, { partyLabel: "Payee" }))).toEqual([1, 2, 3, 4, 5]);
    expect(party.filterPartiesForModule(null, {})).toEqual([]);
  });
  test("loadParties uses the shared filter with the partyType prop (header list + line Gen Ref share partyOptions)", () => {
    const src = read("TransactionFormLayout.jsx");
    expect(src).toMatch(/filterPartiesForModule\(data, \{ partyType, partyLabel \}\)/);
    expect(src).not.toMatch(/const wantsSupplier = partyLabel\.toLowerCase\(\)/);
  });
  test.each([["APV", "SUPPLIER"], ["CV", "SUPPLIER"], ["PurchaseOrder", "SUPPLIER"], ["Invoice", "CUSTOMER"], ["OR", "CUSTOMER"], ["DebitMemo", "BOTH"], ["CreditMemo", "BOTH"]])(
    "%s declares partyType=%s", (mod, type) => {
      expect(read(`${mod}.jsx`)).toMatch(new RegExp(`partyType="${type}"`));
    }
  );
});

// ---------------------------------------------------------------------------
describe("G - Invoice list shows Draft for a Draft invoice (not its payment status)", () => {
  let L;
  beforeAll(async () => { L = await import("../transactionListFilters.mjs"); });
  test("Draft -> Draft whatever the payment status; posted -> payment status", () => {
    expect(L.payableListStatus({ status: "Draft", paymentStatus: "Unpaid" })).toBe("Draft");
    expect(L.payableListStatus({ status: "DRAFT", paymentStatus: "Unpaid" })).toBe("Draft");
    expect(L.payableListStatus({ status: "Posted", paymentStatus: "Partially Paid" })).toBe("Partially Paid");
    expect(L.payableListStatus({ status: "Posted" })).toBe("Posted");
    expect(L.apvListStatus).toBe(L.payableListStatus);
  });
  test("the Invoice list mapping uses the shared rule", () => {
    const src = read("TransactionFormLayout.jsx");
    const inv = src.slice(src.indexOf('if (code === "INV") {'), src.indexOf('if (code === "INV") {') + 900);
    expect(inv).toMatch(/status: payableListStatus\(item\),/);
    expect(inv).not.toMatch(/status: item\.paymentStatus \|\| item\.status,/);
  });
});

// ---------------------------------------------------------------------------
describe("D/E - account dropdown is readable", () => {
  test("narrow cell -> at least 440px wide, kept inside the viewport", () => {
    expect(acct.dropdownGeometry({ left: 180, width: 206 }, 1440)).toEqual({ left: 180, width: 440 });
    expect(acct.dropdownGeometry({ left: 1200, width: 206 }, 1440)).toEqual({ left: 1440 - 8 - 440, width: 440 });
  });
  test("a wide trigger keeps its own width; a small viewport caps the width and margin", () => {
    expect(acct.dropdownGeometry({ left: 100, width: 600 }, 1920)).toEqual({ left: 100, width: 600 });
    expect(acct.dropdownGeometry({ left: 30, width: 206 }, 390)).toEqual({ left: 8, width: 374 });
    expect(acct.dropdownGeometry({ left: -50, width: 100 }, 1440).left).toBe(8);
  });
  test("the component uses the geometry and gives each option a full-name tooltip", () => {
    const src = read("SearchableAccountSelect.jsx");
    expect(src).toMatch(/const \{ left, width \} = dropdownGeometry\(anchorRect, window\.innerWidth\);/);
    expect(src).not.toMatch(/width: anchorRect\.width,/);
    expect(src).toMatch(/title=\{accountLabel\(account\)\}/);
  });
  test("options wrap instead of being cut with an ellipsis; search box is theme-aware", () => {
    const css = read("SearchableAccountSelect.css");
    const opt = css.slice(css.indexOf(".searchable-account-option {"), css.indexOf("}", css.indexOf(".searchable-account-option {")));
    expect(opt).toMatch(/white-space:\s*normal/);
    expect(opt).not.toMatch(/text-overflow:\s*ellipsis/);
    expect(css).not.toMatch(/\.searchable-account-search-input\s*\{[^}]*background:\s*#ffffff;/s);
  });
});
