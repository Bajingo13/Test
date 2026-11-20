const fs = require("fs");
const path = require("path");

// TC-REPORT-013 (source guards) - report page layout / accessibility pass.
// The repo's jest config is node-only (no jsdom), so - as in groupCodesUi /
// fileSetupCoaGenLibUi - the pages are covered by source guards here; the six
// viewport widths, both themes, export, print, empty and error states are
// verified in a real browser separately.

const REPORTS = path.join(__dirname, "../../pages/REPORTS");
const read = (f) => fs.readFileSync(path.join(REPORTS, f), "utf8");

function selectorsOf(cssBlock) {
  const noComments = cssBlock.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  const re = /([^{}]+)\{/g;
  let m;
  while ((m = re.exec(noComments))) {
    const sel = m[1].trim();
    if (!sel || sel.startsWith("@media")) continue;
    out.push(...sel.split(",").map((s) => s.trim()).filter(Boolean));
  }
  return out;
}
function passBlock(css) {
  const at = css.indexOf("Report UI pass (TC-REPORT-013)");
  expect(at).toBeGreaterThan(-1);
  return css.slice(css.lastIndexOf("/*", at));
}

describe("TC-REPORT-013 report filters: every visible label is linked to its control", () => {
  const PAGES = {
    "ARAging.jsx": ["ara-customer", "ara-currency", "ara-bucket", "ara-status"],
    "APAging.jsx": ["apa-supplier", "apa-currency", "apa-bucket", "apa-status"],
    "GeneralLedger.jsx": ["gl-account"],
    "SubsidiaryLedger.jsx": ["sl-ledger", "sl-party"],
    "AccountAnalysis.jsx": ["aa-account", "aa-company"],
    "InputVAT.jsx": ["ivat-account", "ivat-company"],
    "OutputVAT.jsx": ["ovat-account"],
    "PrepaidSubsidiary.jsx": ["pps-account"],
    "TrialBalance.jsx": ["tb-company", "tb-branch", "tb-status"],
  };
  for (const [file, ids] of Object.entries(PAGES)) {
    test(`${file}: no bare <label> before a <select>; htmlFor / id pairs present`, () => {
      const src = read(file);
      expect(src).not.toMatch(/<label>[^<]*<\/label>\s*<select/);
      for (const id of ids) {
        expect(src).toContain(`htmlFor="${id}"`);
        expect(src).toContain(`id="${id}"`);
      }
    });
  }
});

describe("TC-REPORT-013 report layout CSS (scoped, responsive, dark mode, print)", () => {
  for (const [file, p] of [["TrialBalance.css", "tb"], ["LedgerReport.css", "lgr"], ["AccountAnalysis.css", "aa"]]) {
    describe(file, () => {
      const block = passBlock(read(file));
      test("every rule in the pass is scoped to the report page root", () => {
        const sels = selectorsOf(block);
        expect(sels.length).toBeGreaterThan(8);
        for (const s of sels) expect(s).toMatch(new RegExp(`^(\\[data-theme="dark"\\] )?\\.${p}-page\\b`));
      });
      test("wide tables scroll inside the report card instead of widening the page", () => {
        expect(block).toMatch(new RegExp(`\\.${p}-page \\{\\s*contain: inline-size;`));
        expect(block).toMatch(new RegExp(`\\.${p}-page \\.${p}-report-card \\{\\s*overflow-x: auto;`));
      });
      test("filter grid shrinks: minmax(0, 1fr) tracks, 2 columns <= 900px, 1 column <= 600px", () => {
        expect(block).toMatch(new RegExp(`\\.${p}-page \\.${p}-filter-grid \\{\\s*grid-template-columns: repeat\\(3, minmax\\(0, 1fr\\)\\);`));
        expect(block).toMatch(/@media \(max-width: 900px\)[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/);
        expect(block).toMatch(/@media \(max-width: 600px\)[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/);
      });
      test("action buttons wrap as a row but keep their labels on one line", () => {
        expect(block).toMatch(new RegExp(`\\.${p}-page \\.${p}-actions \\{\\s*flex-wrap: wrap;`));
        expect(block).toMatch(new RegExp(`\\.${p}-page \\.${p}-actions button \\{\\s*white-space: nowrap;`));
      });
      test("dark-mode primary button keeps >= 4.5:1 (light accent #2563eb)", () => {
        expect(block).toMatch(new RegExp(`\\[data-theme="dark"\\] \\.${p}-page \\.${p}-actions \\.primary \\{\\s*background: #2563eb;`));
      });
      test("print keeps the full table (no clipping)", () => {
        expect(block).toMatch(new RegExp(`@media print \\{[\\s\\S]*?\\.${p}-page \\{\\s*contain: none;[\\s\\S]*?\\.${p}-page \\.${p}-report-card \\{\\s*overflow: visible;`));
      });
    });
  }

  test("GL summary grid shrinks too", () => {
    const block = passBlock(read("LedgerReport.css"));
    expect(block).toMatch(/\.lgr-page \.lgr-summary-grid \{\s*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
  });

  test("period filter legend / error use theme tokens (readable in dark mode)", () => {
    const css = read("ReportPeriodFilter.css");
    expect(css).not.toMatch(/color: #111827/);
    expect(css).not.toMatch(/color: #b91c1c/);
    expect(css).toMatch(/\.rpf-legend \{[\s\S]*?color: var\(--text-primary\)/);
    expect(css).toMatch(/\.rpf-error \{[\s\S]*?color: var\(--danger-text\)/);
    expect(css).toMatch(/\.rpl-primary \{[\s\S]*?color: var\(--text-primary\)/);
    expect(css).toMatch(/\.rpl-secondary \{[\s\S]*?color: var\(--neutral-text\)/);
    expect(css).toMatch(/@media print \{\s*\.rpl-primary,\s*\.rpl-secondary \{\s*color: #000;/); // print unchanged
  });

  test("Print / Export trigger stays on one line", () => {
    expect(read("ReportExportMenu.css")).toMatch(/\.rem-trigger \{[\s\S]*?white-space: nowrap;/);
  });

  test("Form 2307 page is intentionally not touched by this pass", () => {
    expect(read("Form2307.css")).not.toMatch(/TC-REPORT-013/);
  });
});
