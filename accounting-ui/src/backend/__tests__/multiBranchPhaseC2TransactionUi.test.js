const fs = require("fs");
const path = require("path");

// Multi-Branch Phase C-2B transaction UI - branch picker, branch-aware account /
// party pickers and payment application from the AP / AR amount field. The
// repo's jest config is node-only: the pure rules (transactionBranch.mjs) are
// exercised directly and the wiring is checked at source level; the screens
// are verified in a real browser separately, the server by the *.http suites.

const SRC = path.join(__dirname, "../..");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8").replace(/\r\n/g, "\n");
let TB;
beforeAll(async () => {
  TB = await import("../../pages/TRANSACTIONS/transactionBranch.mjs");
});

const BA = { id: 1, name: "Branch A", status: "ACTIVE" };
const BB = { id: 2, name: "Branch B", status: "ACTIVE" };
const BX = { id: 3, name: "Closed", status: "INACTIVE" };

describe("branch selection rules", () => {
  test("no branches: legacy entry (no Branch field, nothing preselected)", () => {
    expect(TB.branchFieldMode([])).toBe("none");
    expect(TB.defaultTransactionBranch([])).toBe("");
  });
  test("exactly one ACTIVE branch: selected automatically (inactive ones never offered)", () => {
    expect(TB.branchFieldMode([BA, BX])).toBe("auto");
    expect(TB.defaultTransactionBranch([BA, BX])).toBe("1");
    expect(TB.activeBranches([BA, BX]).map((b) => b.id)).toEqual([1]);
  });
  test("several ACTIVE branches: the user must choose - no silent default", () => {
    expect(TB.branchFieldMode([BA, BB])).toBe("choose");
    expect(TB.defaultTransactionBranch([BA, BB])).toBe("");
  });
});

describe("branch-aware accounts and parties", () => {
  const accounts = [{ id: 10, code: "1000", title: "Cash", branchId: null }, { id: 11, code: "1100", title: "AR", branchId: 1 }, { id: 12, code: "1100", title: "AR", branchId: 2 }];
  test("Branch A shows the shared account and Branch A's account, never Branch B's", () => {
    expect(accounts.filter((a) => TB.visibleInBranch(a, "1")).map((a) => a.id)).toEqual([10, 11]);
    expect(accounts.filter((a) => TB.visibleInBranch(a, "2")).map((a) => a.id)).toEqual([10, 12]);
    expect(accounts.filter((a) => TB.visibleInBranch(a, "")).map((a) => a.id)).toEqual([10]); // no branch chosen yet
  });
  test("labels: '— Shared' / '— Branch A' only when the company has branches", () => {
    expect(TB.ownershipSuffix(accounts[0], [BA, BB])).toBe(" — Shared");
    expect(TB.ownershipSuffix(accounts[1], [BA, BB])).toBe(" — Branch A");
    expect(TB.ownershipSuffix(accounts[1], [])).toBe("");
  });
});

describe("payment application from the amount field", () => {
  test("CV: Accounts Payable DEBIT opens APVs; OR: Accounts Receivable CREDIT opens Invoices; nothing else does", () => {
    expect(TB.applicationTrigger({ code: "CV", side: "debit", isControlLine: true })).toBe("APV");
    expect(TB.applicationTrigger({ code: "OR", side: "credit", isControlLine: true })).toBe("INV");
    for (const c of [
      { code: "CV", side: "credit", isControlLine: true }, { code: "OR", side: "debit", isControlLine: true },
      { code: "CV", side: "debit", isControlLine: false }, { code: "APV", side: "debit", isControlLine: true }, { code: "JV", side: "debit", isControlLine: true },
    ]) expect(TB.applicationTrigger(c)).toBeNull();
  });
  test("in-modal validation: amount above zero and within the outstanding balance (partial allowed)", () => {
    expect(TB.applicationAmountError([{ voucherNo: "APV-1", amount: 8000, balanceAmount: 20000 }])).toBe("");
    expect(TB.applicationAmountError([{ voucherNo: "APV-1", amount: 12000, balanceAmount: 12000 }])).toBe("");
    expect(TB.applicationAmountError([{ voucherNo: "APV-1", amount: 12001, balanceAmount: 12000 }])).toMatch(/APV-1: the amount to apply \(12001\.00\) exceeds its outstanding balance \(12000\.00\)/);
    expect(TB.applicationAmountError([{ voucherNo: "APV-2", amount: 0, balanceAmount: 500 }])).toMatch(/Enter an amount to apply for APV-2/);
  });
});

describe("TransactionFormLayout wiring", () => {
  const tfl = read("pages/TRANSACTIONS/TransactionFormLayout.jsx");
  const grid = read("pages/TRANSACTIONS/AccountingEntriesGrid.jsx");
  const header = read("pages/TRANSACTIONS/TransactionVoucherHeader.jsx");

  test("the amount fields call the trigger; the modal opens from it, never from Post", () => {
    expect(grid).toContain('onFocus={() => onAmountFocus && onAmountFocus(line, "debit")}');
    expect(grid).toContain('onFocus={() => onAmountFocus && onAmountFocus(line, "credit")}');
    expect(tfl).toContain("onAmountFocus={handleAmountFocus}");
    expect(tfl).toMatch(/async function handlePostTransactionClick\(\) \{\n {4}handleSave\("Posted"\);\n {2}\}/);
    expect(tfl).toContain("const kind = applicationTrigger({ code, side, isControlLine: isAPorARAccount(line.accountId) });");
  });

  test("Apply fills the line and returns to the voucher: no auto-post, in-page validation, no native alert", () => {
    expect(tfl).not.toContain("setPendingAutoPost(true)");
    expect((tfl.match(/const problem = applicationAmountError\(/g) || []).length).toBe(2);
    expect((tfl.match(/\{applicationError \? <div className="transaction-error-box" role="alert">/g) || []).length).toBe(2);
    expect(tfl).not.toContain('alert(data.message || "Failed to load unpaid APV records")');
    expect((tfl.match(/^ {2}Apply$/gm) || []).length).toBe(2);
  });

  test("the lookups send the transaction's branch; the modal shows party + branch + document date", () => {
    expect((tfl.match(/if \(txBranchId\) query\.append\("branchId", txBranchId\);/g) || []).length).toBe(2);
    expect((tfl.match(/className="apv-modal-context"/g) || []).length).toBe(2);
    expect(tfl).toContain("<td>{apv.transactionDate || \"—\"}</td>");
    expect(tfl).toContain("<td>{invoice.transactionDate || \"—\"}</td>");
  });

  test("a new transaction sends its branch; an existing one never changes it; branch errors stay in the form", () => {
    expect(tfl).toContain("branchId: !selectedTransaction?.id && branchId ? Number(branchId) : undefined,");
    expect(tfl).toContain('if (!selectedTransaction?.id && branchFieldMode(userBranches) === "choose" && !branchId) return "Select the branch this transaction belongs to.";');
    expect(tfl).toMatch(/BRANCH_\|ACCOUNT_BRANCH\|ACCOUNT_NOT_FOUND\|PARTY_BRANCH\|PARTY_NOT_FOUND\|APV_NOT_PAYABLE\|INVOICE_NOT_PAYABLE\|APPLICATION_EXCEEDS_BALANCE/);
    expect(tfl).toContain("accountOptions={branchAccountOptions}");
    expect(tfl).toContain("partyOptions={branchPartyOptions}");
  });

  test("Branch column in the list; Branch field in the header (select / read-only) and view", () => {
    expect(tfl).toContain("{userBranches.length ? <th>Branch</th> : null}");
    expect(header).toContain('{branchField?.label ? <ViewField label="Branch" value={branchField.label} /> : null}');
    expect(header).toContain('branchField.mode === "choose" ? (');
    expect(header).toContain('<option value="">Select branch...</option>');
  });

  test("layout containment: wide tables / intrinsic-width controls scroll in place instead of widening the page", () => {
    const css = read("pages/TRANSACTIONS/TransactionFormLayout.css");
    expect(css).toMatch(/\.transaction-table-container \{\n {2}overflow-x: auto;\n {2}width: 0;\n {2}min-width: 100%;/);
    expect(css).toContain("grid-template-columns: repeat(auto-fit, minmax(min(230px, 100%), 1fr));");
    expect(css).toContain("grid-template-columns: repeat(2, minmax(0, 1fr));");
    expect(css).toMatch(/@media \(max-width: 640px\) \{\n {2}\.transaction-page \.transaction-input \{\n {4}width: 100%;\n {4}min-width: 0;/);
    const qcss = read("pages/TRANSACTIONS/Quotation.css");
    expect(qcss).toMatch(/\.quo-account-label \{\n {4}white-space: normal;/);
  });

  test("Quotation follows the same branch rules", () => {
    const q = read("pages/TRANSACTIONS/Quotation.jsx");
    expect(q).toContain("branchId: !selected?.id && branchId ? Number(branchId) : undefined,");
    expect(q).toContain("customers.filter((c) => visibleInBranch(c, quotationBranchId))");
    expect(q).toContain('setBranchError("Select the branch this quotation belongs to.");');
  });
});
