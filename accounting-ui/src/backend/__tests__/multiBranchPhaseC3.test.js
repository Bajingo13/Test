const fs = require("fs");
const path = require("path");

// Multi-Branch Phase C-3 - source-level checks for the UI wiring and the
// guard rails the *.http suite cannot see (the repo's jest config is
// node-only; the screens are verified in a real browser separately).
const SRC = path.join(__dirname, "../..");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8").replace(/\r\n/g, "\n");

describe("Beginning Balance screens", () => {
  const field = read("components/BeginningBalanceBranchField.jsx");
  const gl = read("pages/FILESETUP/BeginningBalanceGL.jsx");
  const arap = read("pages/FILESETUP/ARAPBeginningBalance.jsx");
  const modal = read("components/BeginningBalanceImportModal.jsx");

  test("the Branch field follows the transaction rules (none / auto read-only / choose)", () => {
    expect(field).toContain('if (mode === "none") return null;');
    expect(field).toContain('mode === "choose" ? (');
    expect(field).toContain('<option value="">Select branch...</option>');
    expect(field).toContain("readOnly");
  });

  test("GL: branch sent on save / template / import; branch errors stay in the page", () => {
    expect(gl).toContain("header: { ...header, branchId: branchId ? Number(branchId) : undefined }, rows");
    expect(gl).toContain("template?format=xlsx${branchQuery}");
    expect(gl).toContain("branchId={branchId}");
    expect((gl.match(/setBranchError\("Select the branch this beginning balance belongs to\."\)/g) || []).length).toBe(3);
  });

  test("AR / AP: branch on save, branch-filtered pickers, Branch list column, branch on template / import", () => {
    expect(arap).toContain("branchId: !selectedId && branchId ? Number(branchId) : undefined,");
    expect(arap).toContain("const branchAccounts = accounts.filter((a) => visibleInBranch(a, formBranchId));");
    expect(arap).toContain("const branchParties = parties.filter((p) => visibleInBranch(p, formBranchId));");
    expect(arap).toContain("{showBranchColumn ? <th>Branch</th> : null}");
    expect(arap).toContain("branchId={branchId}");
  });

  test("import modal posts the branch on preview and commit and shows the pinned branch", () => {
    expect(modal).toContain('if (branchId) formData.append("branchId", String(branchId));');
    expect(modal).toContain("body: JSON.stringify({ batchId: previewResult.batchId, ...(branchId ? { branchId: Number(branchId) } : {}) }),");
    expect(modal).toContain("Importing into branch:");
  });
});

describe("Recurring", () => {
  test("Make Recurring sends the source transaction's branch; the list shows a Branch column", () => {
    expect(read("components/RecurringTemplateModal.jsx")).toContain("...(bootstrap.sourceBranchId != null ? { branchId: bootstrap.sourceBranchId } : {}),");
    expect(read("pages/TRANSACTIONS/RecurringTransactions.jsx")).toContain("{showBranch ? <th>Branch</th> : null}");
  });

  test("generation stamps the template's branch in the same transaction and never guesses a multi-branch one", () => {
    const gen = read("backend/services/recurringGenerationService.js");
    expect(gen).toContain("await TransactionBranchEnforcement.assign(conn, genCfg.headerTable, generatedId, generationBranchId);");
    expect(gen).toContain('throw new HttpError(422, "This recurring template has no branch. Assign its branch before generating.", "BRANCH_REQUIRED");');
    // numbering is untouched
    expect(gen).toContain("const voucherNo = await NumberingService.generateVoucherNumber(conn, moduleType, occurrenceDate);");
  });
});

describe("Printing", () => {
  test("every print entry point applies the branch scope", () => {
    const tp = read("backend/controllers/transactionPrint.controller.js");
    expect((tp.match(/TransactionBranchEnforcement\.printScope\(req\.user, companyId\)/g) || []).length).toBe(2);
    const ip = read("backend/controllers/invoicePrint.controller.js");
    expect((ip.match(/await printBranchContext\(req, companyId\)/g) || []).length).toBe(2);
    expect((ip.match(/TransactionBranchEnforcement\.printScope\(req\.user, companyId\)/g) || []).length).toBe(3);
    expect(read("backend/controllers/printTemplate.controller.js")).toContain("TransactionBranchEnforcement.printScope(req.user, companyId)");
  });

  test("public verification is unchanged: its render token is not branch-scoped", () => {
    const ip = read("backend/controllers/invoicePrint.controller.js");
    expect(ip).toContain("if (token.public === true) return { branchScope: null, expectBranchId: undefined };");
    const tokenSvc = read("backend/services/invoicePrintRenderTokenService.js");
    expect(tokenSvc).toMatch(/function signPublicVerifiedInvoiceRenderToken\(\{ invoiceId, companyId \}\)/);
  });

  test("the list PDF route is registered before /:id/pdf", () => {
    const routes = read("backend/routes/invoicePrint.routes.js");
    expect(routes.indexOf('router.get("/list/pdf"')).toBeLessThan(routes.indexOf('router.get("/:id/pdf"'));
  });
});

describe("Beginning-balance header lookup", () => {
  test("find-or-create is a locking read under the per-company lock (no duplicate header under concurrency)", () => {
    const svc = read("backend/services/beginningBalanceBranchService.js");
    expect((svc.match(/ORDER BY id LIMIT 1 FOR UPDATE/g) || []).length).toBe(2);
    expect(svc).toContain('"SELECT GET_LOCK(?, ?) AS ok"');
  });
});
