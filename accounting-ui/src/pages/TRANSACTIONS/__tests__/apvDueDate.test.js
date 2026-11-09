// The transaction form keeps an APV's due date: it is shown, loaded from the
// saved record and sent back on save (it used to be replaced by the APV date
// on every save, which reset a converted RFP's due date). Every other module
// except Invoice still sends dueDate === transactionDate. The server side is
// in backend/__tests__/apvDueDatePreservation.http.test.js.
const fs = require("fs");
const path = require("path");

const layout = fs.readFileSync(path.join(__dirname, "..", "TransactionFormLayout.jsx"), "utf8");

describe("APV due date in the transaction form", () => {
  test("Invoice and APV are the modules with a due date", () => {
    expect(layout).toMatch(/const HAS_DUE_DATE = code === "INV" \|\| code === "APV";/);
  });

  test("the saved due date is loaded for an existing APV and marked as intentional", () => {
    expect(layout).toMatch(/if \(HAS_DUE_DATE\) \{\s*setDueDate\(data\.dueDate \|\| data\.transactionDate \|\| ""\);\s*setDueDateTouched\(true\);\s*\}/);
  });

  test("the save payload sends the form's due date for APV; other modules keep the transaction date", () => {
    expect(layout).toMatch(/dueDate: HAS_DUE_DATE \? \(dueDate \|\| updatedForm\.date\) : updatedForm\.date,/);
    expect(layout).not.toMatch(/dueDate: code === "INV" \?/);
  });

  test("APV shows the Due Date field, and a new APV's due date follows its date until edited", () => {
    expect(layout).toMatch(/showDueDate=\{HAS_DUE_DATE\}/);
    expect(layout).toMatch(/onDateChange=\{HAS_DUE_DATE \? handleInvoiceDateChange :/);
  });

  test("terms stay Invoice-only", () => {
    expect(layout).toMatch(/showTerms=\{code === "INV"\}/);
    expect(layout).toMatch(/if \(code === "INV"\) \{\s*setTerms\(data\.terms \|\| ""\);\s*\}/);
  });
});
