const fs = require("fs");
const path = require("path");

// Reports Phase G: the separate "Export PDF" / "Export CSV" toolbar buttons
// on the Income Statement and Balance Sheet are replaced by one unified
// <ReportExportMenu> ("Print / Export"). The repo's jest config is
// node-only (no jsdom), so these are source-structure guards; the runtime
// serializer / print / CSV behaviour is covered by
// statementSerializerCsv / statementPrintView / statementScreenControls.

const REPORTS = path.join(__dirname, "../../pages/REPORTS");
const read = (f) => fs.readFileSync(path.join(REPORTS, f), "utf8");

describe("ReportExportMenu component", () => {
  const src = read("ReportExportMenu.jsx");

  test("exposes exactly the three options: Print Report, Save as PDF, Export CSV", () => {
    expect(src).toMatch(/>\s*Print Report\s*</);
    expect(src).toMatch(/>\s*Save as PDF\s*</);
    expect(src).toMatch(/>\s*Export CSV\s*</);
    expect(src).toMatch(/Print \/ Export/);
  });

  test("Print Report and Save as PDF both use the browser print flow (onPrint); Export CSV uses onExportCsv", () => {
    // both print items -> choose(onPrint); the CSV item -> choose(onExportCsv)
    expect(src.match(/choose\(onPrint\)/g) || []).toHaveLength(2);
    expect(src.match(/choose\(onExportCsv\)/g) || []).toHaveLength(1);
  });

  test("accessible menu: haspopup, expanded state, roles, keyboard/outside close", () => {
    expect(src).toMatch(/aria-haspopup="menu"/);
    expect(src).toMatch(/aria-expanded=\{open\}/);
    expect(src).toMatch(/role="menu"/);
    expect(src).toMatch(/role="menuitem"/);
    expect(src).toMatch(/e\.key === "Escape"/); // Escape closes
    expect(src).toMatch(/rootRef\.current\.contains\(e\.target\)/); // click-outside closes
    expect(src).toMatch(/setOpen\(false\)/); // closes on selection (inside choose())
  });

  test("disabled prop gates the trigger and force-closes the menu", () => {
    expect(src).toMatch(/disabled=\{disabled\}/);
    expect(src).toMatch(/if \(disabled && open\) setOpen\(false\)/);
    expect(src).toMatch(/\{open && !disabled \?/);
  });

  test("no fetch / no backend call / no heavy PDF dependency in the menu", () => {
    expect(src).not.toMatch(/fetch\(|axios|XMLHttpRequest/);
    expect(src).not.toMatch(/jsPDF|html2canvas|pdf-lib|@react-pdf|puppeteer/i);
  });

  test("menu is hidden from print output", () => {
    const css = read("ReportExportMenu.css");
    expect(css).toMatch(/@media print[\s\S]*\.rem[\s\S]*display:\s*none/);
  });
});

describe("IS / BS toolbars use the unified menu (old buttons removed)", () => {
  for (const f of ["IncomeStatement.jsx", "BalanceSheet.jsx"]) {
    describe(f, () => {
      const src = read(f);

      test("imports and renders <ReportExportMenu> with disabled + onPrint + onExportCsv", () => {
        expect(src).toMatch(/import ReportExportMenu from "\.\/ReportExportMenu\.jsx"/);
        expect(src).toMatch(/<ReportExportMenu[\s\S]*disabled=\{!model\}[\s\S]*onPrint=\{\(\) => window\.print\(\)\}[\s\S]*onExportCsv=\{exportCSV\}[\s\S]*\/>/);
      });

      test("the separate Export PDF / Export CSV / Print / PDF buttons are gone", () => {
        expect(src).not.toMatch(/onClick=\{exportCSV\}/); // was: <button className="dark" onClick={exportCSV}>
        expect(src).not.toMatch(/>\s*Export PDF\s*</);
        expect(src).not.toMatch(/>\s*Export CSV\s*</); // the label now lives only in the menu
        expect(src).not.toMatch(/onClick=\{\(\) => window\.print\(\)\}/); // was the Print / PDF button
      });

      test("Generate Report and Clear Filters stay as their own buttons", () => {
        expect(src).toMatch(/onClick=\{generateReport\}/);
        expect(src).toMatch(/>\s*Clear Filters\s*</);
        expect(src).toMatch(/Generate Report/);
      });

      test("CSV export still serialises the shown model with no refetch", () => {
        // exportCSV(): downloadCsvText(statementFilename(model), statementToCsv(model))
        const fn = src.slice(src.indexOf("function exportCSV"), src.indexOf("function exportCSV") + 320);
        expect(fn).toMatch(/statementToCsv\(model\)/);
        expect(fn).not.toMatch(/fetch\(/);
      });

      test("print still renders <StatementPrintView model={model}> (structured model, no refetch)", () => {
        expect(src).toMatch(/<StatementPrintView model=\{model\} \/>/);
      });
    });
  }
});

describe("print template fidelity (StatementPrintView.css / .jsx)", () => {
  const css = read("StatementPrintView.css");
  const jsx = read("StatementPrintView.jsx");

  test("A4 portrait, no app chrome, repeating header, serif, centered header block", () => {
    expect(css).toMatch(/@page\s*\{[^}]*size:\s*A4 portrait/);
    expect(css).toMatch(/body\.printing-statement > \*:not\(#statement-print-root\)\s*\{\s*display:\s*none/);
    expect(css).toMatch(/thead\s*\{\s*display:\s*table-header-group/);
    expect(css).toMatch(/\.spv\s*\{[^}]*serif/);
    expect(css).toMatch(/\.spv-head\s*\{[^}]*text-align:\s*center/);
  });

  test("accounting rules: rule above subtotals, heavier rule above computed totals, double rule under grand total", () => {
    expect(css).toMatch(/\.spv-subtotal td[\s\S]*?border-top:\s*0\.5pt solid/);
    expect(css).toMatch(/\.spv-computed-total td[\s\S]*?border-top:\s*1pt solid/);
    expect(css).toMatch(/\.spv-grand-total td[\s\S]*?border-bottom:\s*3pt double/);
  });

  test("BS super-heading is spaced-out caps; grand-total class only on the final total", () => {
    expect(css).toMatch(/\.spv-statement-heading \.spv-desc\s*\{[^}]*letter-spacing:\s*0\.2/);
    expect(jsx).toMatch(/row\.id === "NET_INCOME" \|\| row\.id === "TOTAL_LIABILITIES_AND_EQUITY"/);
    expect(jsx).toMatch(/isGrandTotal \? "spv-grand-total" : ""/);
  });

  test("CYE synthetic line rendered once, not expanded, not marked grand-total", () => {
    // synthetic rows come straight from the serializer; grand-total is a
    // separate, disjoint class (computed-total id check)
    expect(jsx).toMatch(/row\.synthetic \? "spv-synthetic" : ""/);
    expect(css).toMatch(/\.spv-synthetic .spv-desc/);
  });

  test("Unclassified + out-of-balance print notes and stacked signature area retained", () => {
    expect(jsx).toMatch(/statementPrintNotes/);
    expect(jsx).toMatch(/s\.signatures\.map/);
    expect(css).toMatch(/\.spv-notes/);
    expect(css).toMatch(/\.spv-sig-line\s*\{[^}]*border-bottom/);
    expect(css).toMatch(/\.spv-signatures\s*\{[^}]*break-inside:\s*avoid/);
  });

  test("no hard-coded sample company / dates / amounts", () => {
    for (const f of ["StatementPrintView.jsx", "StatementPrintView.css", "ReportExportMenu.jsx", "ReportExportMenu.css"]) {
      const s = read(f);
      expect(s).not.toMatch(/CARGOHAUS/i);
      expect(s).not.toMatch(/\b20(23|24)\b/);
      expect(s).not.toMatch(/39234323|51301516/);
    }
  });
});

describe("Phase G.1 - compact Income Statement comparison control", () => {
  const jsx = read("IncomeStatement.jsx");
  const css = read("IncomeStatement.css");

  test("compact inline checkbox markup replaces the old full-field block", () => {
    expect(jsx).toMatch(/className="is-compare-field"/);
    expect(jsx).toMatch(/className=\{`is-compare-check\$\{!req\.wholeMonth \? " is-compare-check--disabled" : ""\}`\}/);
    expect(jsx).toMatch(/<span>Previous Month<\/span>/);
    // old oversized markup gone
    expect(jsx).not.toMatch(/className="stmt-check"/);
    expect(jsx).not.toMatch(/className="stmt-hint"/);
    expect(jsx).not.toMatch(/<label htmlFor="is-compare">Comparison<\/label>/);
    expect(jsx).not.toMatch(/<span>Compare Previous Month<\/span>/);
  });

  test("business rule unchanged: checkbox checked = comparePrevActive, disabled unless wholeMonth", () => {
    expect(jsx).toMatch(/checked=\{req\.comparePrevActive\}/);
    expect(jsx).toMatch(/disabled=\{!req\.wholeMonth\}/);
    expect(jsx).toMatch(/onChange=\{\(e\) => setComparePrevWanted\(e\.target\.checked\)\}/);
    // no new fetch / recompute
    const seg = jsx.slice(jsx.indexOf("is-compare-field"), jsx.indexOf("is-compare-field") + 700);
    expect(seg).not.toMatch(/fetch\(|generateReport\(/);
  });

  test("disabled-state helper text is rendered and associated for a11y", () => {
    expect(jsx).toMatch(/req\.comparePrevDisabledReason \?/);
    expect(jsx).toMatch(/id="is-compare-hint"/);
    expect(jsx).toMatch(/aria-describedby=\{req\.comparePrevDisabledReason \? "is-compare-hint" : undefined\}/);
    expect(jsx).toMatch(/className="is-compare-hint"/);
  });

  test("CSS de-bloats the checkbox (no 52px bordered box) and keeps it compact + aligned", () => {
    expect(css).toMatch(/\.is-grid input\[type="checkbox"\]\s*\{[^}]*width:\s*16px !important/);
    expect(css).toMatch(/\.is-grid input\[type="checkbox"\]\s*\{[^}]*height:\s*16px !important/);
    expect(css).toMatch(/\.is-grid \.is-compare-check\s*\{[^}]*font-weight:\s*400/);
    expect(css).toMatch(/\.is-grid \.is-compare-check--disabled[\s\S]*?cursor:\s*not-allowed/);
    expect(css).toMatch(/\.is-grid \.is-compare-hint\s*\{[^}]*font-size:\s*11px/);
    // grid still responsive
    expect(css).toMatch(/@media \(max-width: 900px\)[\s\S]*?grid-template-columns:\s*1fr/);
  });

  test("helper wording matches the approved compact string", () => {
    expect(read("statementModel.mjs")).toMatch(/"Previous-month comparison requires a full calendar month\."/);
  });
});
