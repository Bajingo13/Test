const fs = require("fs");
const path = require("path");

// TC-FS-COA-UI-001 / TC-FS-GENLIB-UI-001 - File Setup > Chart of Accounts and
// General Libraries UI/UX pass. The repo's jest config is node-only (no
// jsdom), so - as in groupCodesUi.test.js - the screens are covered by the
// pure helpers they use (pages/FILESETUP/fileSetupRecords.mjs) plus source
// guards. Rendering, contrast and the six viewport widths are verified in a
// real browser separately; the server-side import is genLibImport.http.test.js.

const FILESETUP = path.join(__dirname, "../../pages/FILESETUP");
const read = (f) => fs.readFileSync(path.join(FILESETUP, f), "utf8");
const coa = read("COA.jsx");
const coaCss = read("COA.css");
const gl = read("GenLib.jsx");
const glCss = read("GenLib.css");

let M;
beforeAll(async () => {
  M = await import("../../pages/FILESETUP/fileSetupRecords.mjs");
});

// Rules added by this pass must be page-scoped: the generic selectors in these
// stylesheets reach other screens through the global bundle.
function addedBlock(css, marker) {
  const at = css.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  return css.slice(css.lastIndexOf("/*", at)); // from the start of the marker comment
}
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

// ==========================================================================
describe("TC-FS-COA-UI-001 - Chart of Accounts", () => {
  describe("account code ordering (H9)", () => {
    test("natural account-code order", () => {
      const rows = [{ id: 1, code: "2000" }, { id: 2, code: "1010-02" }, { id: 3, code: "1010" }, { id: 4, code: "10" }, { id: 5, code: "1010-01" }, { id: 6, code: "2" }];
      expect(M.sortAccountsByCode(rows).map((r) => r.code)).toEqual(["2", "10", "1010", "1010-01", "1010-02", "2000"]);
    });

    test("returns a new array - the loaded list (Previous / Next) is not reordered", () => {
      const rows = [{ id: 9, code: "5000" }, { id: 8, code: "1000" }];
      const sorted = M.sortAccountsByCode(rows);
      expect(sorted).not.toBe(rows);
      expect(rows.map((r) => r.id)).toEqual([9, 8]);
    });

    test("codes equal apart from letter case keep a stable id order; bad input is safe", () => {
      expect(M.sortAccountsByCode([{ id: 7, code: "ab" }, { id: 3, code: "AB" }]).map((r) => r.id)).toEqual([3, 7]);
      expect(M.sortAccountsByCode(null)).toEqual([]);
    });

    // Post-File-Setup (Task 5): `accounts` itself is kept in the selected
    // display order (default Code ascending), so Previous / Next and the
    // account opened first follow it - never the API's newest-first order,
    // which put an imported file's last row (an expense account) first.
    test("the View dialog and Previous / Next follow the selected sort (default Code ascending)", () => {
      expect(coa).toMatch(/const \[sortKey, setSortKey\] = useState\(DEFAULT_SORT\);/);
      expect(coa).toMatch(/const ordered = sortRecords\(data, sortKey\);\s*setAccounts\(ordered\);/);
      expect(coa).toMatch(/setAccounts\(\(prev\) => sortRecords\(prev, sortKey\)\);/);
      expect(coa).toMatch(/const viewAccounts = useMemo\(\(\) => sortRecords\(filteredAccounts, sortKey\)/);
      expect(coa).toMatch(/records=\{viewAccounts\}/);
      expect(coa).toMatch(/loadAccount\(accounts\[currentIndex - 1\]\)/);
      expect(coa).toMatch(/loadAccount\(accounts\[currentIndex \+ 1\]\)/);
      expect(coa).toMatch(/const currentIndex = accounts\.findIndex/);
      expect(coa).toMatch(/await loadAccounts\(data\.id \|\| form\.id \|\| null\);/); // stay on the saved account
      expect(coa).toMatch(/sortOptions\("Title"\)/);
      expect(gl).toMatch(/const ordered = sortRecords\(data, sortKey, \{ titleField: "name" \}\);/);
      expect(gl).toMatch(/sortOptions\("Name"\)/);
      expect(gl).toMatch(/sortRecords\(filterGenLibRecords\(records, \{ search, type: typeFilter, status: statusFilter \}\), sortKey, \{ titleField: "name" \}\)/);
    });

    describe("sortRecords (Task 5)", () => {
      const rows = [
        { id: 1, code: "100", title: "Zeta", createdAt: "2026-11-01 08:00:00" },
        { id: 2, code: "9", title: "alpha", createdAt: "2026-11-03 08:00:00" },
        { id: 3, code: "11", title: "Mid", createdAt: "2026-11-02 08:00:00" },
        { id: 4, code: "2", title: "beta", createdAt: null },
        { id: 5, code: "0010", title: "Leading zero", createdAt: "2026-11-02 08:00:00" },
        { id: 6, code: "1", title: "One", createdAt: "2026-11-02 08:00:00" },
        { id: 7, code: "20", title: "Twenty", createdAt: "2026-11-04 08:00:00" },
        { id: 8, code: "3", title: "Three", createdAt: "2026-11-04 08:00:00" },
        { id: 9, code: "10", title: "Ten", createdAt: "2026-11-04 08:00:00" },
      ];
      const codes = (list) => list.map((r) => r.code);
      test("default is Code ascending, natural/numeric: 1, 2, 3, 9, 10, 11, 20, 100 (codes kept as strings)", () => {
        expect(M.DEFAULT_SORT).toBe("code-asc");
        const asc = codes(M.sortRecords(rows));
        expect(asc.filter((c) => c !== "0010")).toEqual(["1", "2", "3", "9", "10", "11", "20", "100"]);
        expect(asc).toContain("0010"); // never converted to 10
        expect(codes(M.sortRecords(rows, "code-desc"))[0]).toBe("100");
      });
      test("Title / Name A-Z and Z-A (case-insensitive)", () => {
        expect(M.sortRecords(rows, "title-asc").map((r) => r.title).slice(0, 2)).toEqual(["alpha", "beta"]);
        expect(M.sortRecords(rows, "title-desc")[0].title).toBe("Zeta");
        expect(M.sortRecords([{ id: 1, code: "B", name: "b" }, { id: 2, code: "A", name: "A" }], "title-asc", { titleField: "name" }).map((r) => r.code)).toEqual(["A", "B"]);
      });
      test("Date Created newest / oldest, unknown dates last, ties stable by id", () => {
        expect(M.sortRecords(rows, "created-desc").map((r) => r.id)).toEqual([9, 8, 7, 2, 6, 5, 3, 1, 4]);
        expect(M.sortRecords(rows, "created-asc").map((r) => r.id)).toEqual([1, 3, 5, 6, 2, 7, 8, 9, 4]);
      });
      test("returns a new array; never mutates records; unknown key falls back to Code ascending", () => {
        const copy = rows.map((r) => ({ ...r }));
        const out = M.sortRecords(rows, "nonsense");
        expect(out).not.toBe(rows);
        expect(rows).toEqual(copy);
        expect(codes(out).slice(0, 3)).toEqual(["1", "2", "3"]);
        expect(M.sortRecords(null)).toEqual([]);
      });
      test("six options with the screen's own title label", () => {
        expect(M.sortOptions("Name").map((o) => o.label)).toEqual(["Code: Ascending", "Code: Descending", "Name: A-Z", "Name: Z-A", "Date Created: Newest", "Date Created: Oldest"]);
      });
    });

    test("account search still covers code / title / class (unchanged)", () => {
      expect(coa).toMatch(/\[account\.code, account\.title, account\.accountClass\]/);
    });
  });

  describe("long account title (H3)", () => {
    test("Title uses the shared AutoResizeTextarea (full value visible)", () => {
      expect(coa).toMatch(/import AutoResizeTextarea from "\.\.\/\.\.\/components\/AutoResizeTextarea"/);
      expect(coa).toMatch(/<AutoResizeTextarea\s+id="coa-title"[\s\S]*?value=\{form\.title\}/);
    });
  });

  describe("labels, required fields, chips (H10 / H2)", () => {
    test("every field label is linked to its control", () => {
      for (const id of ["coa-code", "coa-date", "coa-title", "coa-class"]) {
        expect(coa).toContain(`htmlFor="${id}"`);
        expect(coa).toContain(`id="${id}"`);
      }
      expect(coa).not.toMatch(/<label>[^<]/);
      expect(coa).toMatch(/aria-labelledby="coa-description-label"/);
      expect(coa).toMatch(/aria-label="Group Code"/);
    });

    test("Code and Title are marked required (client check unchanged)", () => {
      expect((coa.match(/className="fs-required"/g) || []).length).toBe(2);
      expect((coa.match(/aria-required="true"/g) || []).length).toBe(2);
      expect(coa).toMatch(/if \(!form\.code\.trim\(\) \|\| !form\.title\.trim\(\)\)/);
    });

    test("validation chips expose their selected state and keep their labels", () => {
      expect(coa).toMatch(/aria-pressed=\{checked\}/);
      expect(coaCss).toMatch(/\.coa-page \.validation-chip\.active::before \{\s*content: "\\2713\\00a0";/);
      expect(coaCss).toMatch(/\.coa-page \.validation-chip:disabled \{\s*opacity: 1;/);
      for (const v of ["BANK / CASH", "INPUT VAT", "OUTPUT VAT", "EXPANDED TAX"]) expect(coa).toContain(`"${v}"`);
    });
  });

  describe("toolbar states (H10)", () => {
    test("toolbarState disables exactly the no-op actions", () => {
      expect(M.toolbarState({ index: 0, total: 3, hasRecord: true })).toEqual({ canEdit: true, canDelete: true, canPrevious: false, canNext: true, canImport: true });
      expect(M.toolbarState({ index: 2, total: 3, hasRecord: true })).toMatchObject({ canPrevious: true, canNext: false });
      expect(M.toolbarState({ index: -1, total: 0, hasRecord: false })).toMatchObject({ canEdit: false, canDelete: false, canPrevious: false, canNext: false });
      expect(M.toolbarState({ index: 1, total: 3, hasRecord: true, isEditing: true })).toMatchObject({ canEdit: false, canImport: false, canPrevious: true, canNext: true });
      expect(M.toolbarState({ index: 1, total: 3, hasRecord: true, busy: true })).toMatchObject({ canImport: false });
    });

    test("Add mode (no selection) can still step to the first record with Next, as before", () => {
      expect(M.toolbarState({ index: -1, total: 3, hasRecord: false })).toMatchObject({ canNext: true, canPrevious: false });
    });

    test("COA toolbar buttons use those states; handlers unchanged", () => {
      expect(coa).toMatch(/onClick=\{handleEdit\} disabled=\{!toolbar\.canEdit\}/);
      expect(coa).toMatch(/onClick=\{handleDelete\} disabled=\{!toolbar\.canDelete\}/);
      expect(coa).toMatch(/onClick=\{handlePrevious\} disabled=\{!toolbar\.canPrevious\}/);
      expect(coa).toMatch(/onClick=\{handleNext\} disabled=\{!toolbar\.canNext\}/);
      expect(coa).toMatch(/onClick=\{triggerImport\} disabled=\{!toolbar\.canImport\}/);
      expect(coa).toMatch(/if \(currentIndex > 0\) \{\s*loadAccount/);
    });
  });

  describe("import UI (unchanged flow)", () => {
    test("file choice still only calls the read-only preview; Confirm resubmits the same file", () => {
      expect(coa).toMatch(/\/api\/coa\/import\/preview/);
      expect(coa).toMatch(/formData\.append\("file", previewFile\)/);
    });
    test("issue lists are keyboard-scrollable and labelled", () => {
      expect((coa.match(/className="coa-import-preview-list" tabIndex=\{0\} aria-label="(Skipped rows|Warnings)"/g) || []).length).toBe(4);
    });
  });

  describe("styles: dark mode, overflow, scope (H1 / H4 / H11 / H12)", () => {
    const block = addedBlock(coaCss, "COA UI/UX pass");
    test("every new rule is scoped to .coa-page", () => {
      const sels = selectorsOf(block);
      expect(sels.length).toBeGreaterThan(20);
      for (const s of sels) expect(s).toMatch(/^(\[data-theme="dark"\] )?\.coa-page\b/);
    });
    test("field text uses the theme text colour (dark-mode fix)", () => {
      expect(block).toMatch(/\.coa-page \.field input,[\s\S]*?\{\s*color: var\(--text-primary\);/);
    });
    test("overflow fixes: shrinkable fields, border-box Description, wrapping group cells", () => {
      expect(block).toMatch(/min-width: 0;/);
      expect(block).toMatch(/\.coa-page \.coa-card textarea \{\s*box-sizing: border-box;/);
      expect(block).toMatch(/\.coa-page \.coa-table td \{\s*overflow-wrap: anywhere;/);
    });
    test("Insert Group Code is a normal-width button next to a wider select", () => {
      expect(block).toMatch(/grid-template-columns: minmax\(0, 420px\) auto;/);
    });
    test("dark-mode details and the import hint override stay page-scoped", () => {
      expect(block).toMatch(/\[data-theme="dark"\] \.coa-page \.coa-mini-label/);
      expect(block).toMatch(/\[data-theme="dark"\] \.coa-page \.section-title-row span/);
      expect(block).toMatch(/\.coa-page \.rtm-hint \{\s*color: var\(--text-secondary\);/);
    });
    test("the original generic rules (shared with other screens) are untouched", () => {
      expect(coaCss).toMatch(/^\.btn \{/m);
      expect(coaCss).toMatch(/^textarea \{\s*width: 100%;/m);
    });
  });
});

// ==========================================================================
describe("TC-FS-GENLIB-UI-001 - General Libraries", () => {
  const recs = [
    { id: 1, code: "CUST-001", name: "Acme Retail Philippines Inc.", type: "CUSTOMER", status: "ACTIVE", tin: "123-456-789-000", telephone: "(02) 8123-4567", email: "ap@acme.example", mobile: "0917 111 2222", category: "REGULAR" },
    { id: 2, code: "SUPP-001", name: "Globe Office Supplies", type: "SUPPLIER", status: "ACTIVE", tin: "987-654-321-000", telephone: "(02) 8999-0000", email: "", mobile: "", category: "VIP" },
    { id: 3, code: "SUPP-002", name: "Old Trading Corp", type: "SUPPLIER", status: "INACTIVE", tin: null, telephone: null, email: null, mobile: null, category: "REGULAR" },
    { id: 4, code: "EMP-001", name: "Juan Dela Cruz", type: "EMPLOYEE", status: "ACTIVE" },
  ];
  const ids = (rows) => rows.map((r) => r.id);

  describe("party type / status filters (H7)", () => {
    test("Customer and Supplier filters", () => {
      expect(ids(M.filterGenLibRecords(recs, { type: "CUSTOMER" }))).toEqual([1]);
      expect(ids(M.filterGenLibRecords(recs, { type: "SUPPLIER" }))).toEqual([2, 3]);
      expect(ids(M.filterGenLibRecords(recs, { type: "supplier" }))).toEqual([2, 3]);
    });
    test("ACTIVE never matches INACTIVE (exact status match)", () => {
      expect(ids(M.filterGenLibRecords(recs, { status: "ACTIVE" }))).toEqual([1, 2, 4]);
      expect(ids(M.filterGenLibRecords(recs, { status: "INACTIVE" }))).toEqual([3]);
      expect(ids(M.filterGenLibRecords(recs, { type: "SUPPLIER", status: "ACTIVE" }))).toEqual([2]);
    });
    test("empty filters return every record", () => {
      expect(ids(M.filterGenLibRecords(recs, {}))).toEqual([1, 2, 3, 4]);
      expect(M.filterGenLibRecords(null, {})).toEqual([]);
    });
  });

  describe("search (H7)", () => {
    test("searches code, name, email, mobile and still works with filters", () => {
      expect(ids(M.filterGenLibRecords(recs, { search: "acme" }))).toEqual([1]);
      expect(ids(M.filterGenLibRecords(recs, { search: "supp-" }))).toEqual([2, 3]);
      expect(ids(M.filterGenLibRecords(recs, { search: "0917 111" }))).toEqual([1]);
      expect(ids(M.filterGenLibRecords(recs, { search: "supp", status: "INACTIVE" }))).toEqual([3]);
    });
    test("TIN and telephone are searchable", () => {
      expect(ids(M.filterGenLibRecords(recs, { search: "987-654" }))).toEqual([2]);
      expect(ids(M.filterGenLibRecords(recs, { search: "8123-4567" }))).toEqual([1]);
      expect(M.GENLIB_SEARCH_FIELDS).toEqual(expect.arrayContaining(["tin", "telephone", "code", "name", "email", "mobile"]));
    });
    test("no invented fields; null values are ignored", () => {
      expect(M.GENLIB_SEARCH_FIELDS).not.toContain("address1");
      expect(M.filterGenLibRecords(recs, { search: "null" })).toEqual([]);
    });
    test("the page wires search + both filters into the View dialog", () => {
      expect(gl).toMatch(/filterGenLibRecords\(records, \{ search, type: typeFilter, status: statusFilter \}\)/);
      expect(gl).toMatch(/aria-label="Filter by party type"/);
      expect(gl).toMatch(/aria-label="Filter by status"/);
      expect(gl).toMatch(/Clear Filters/);
    });
  });

  describe("status badge (H8)", () => {
    test("ACTIVE / INACTIVE labels and tones", () => {
      expect(M.statusBadge("ACTIVE")).toEqual({ label: "ACTIVE", tone: "active" });
      expect(M.statusBadge("inactive")).toEqual({ label: "INACTIVE", tone: "inactive" });
      expect(M.statusBadge(undefined)).toEqual({ label: "ACTIVE", tone: "active" });
    });
    test("badge shows beside the Name in view mode only, and in the View dialog list", () => {
      expect(gl).toMatch(/\{mode === "view" && form\.id \? \(\s*<span className=\{`gl-status-badge gl-status-badge--\$\{badge\.tone\}`\}/);
      expect(gl).toMatch(/key: "status",\s*label: "Status",\s*render:/);
    });
  });

  describe("Notes shown once (H5)", () => {
    test("one Notes field, no Billing Notes; still bound to form.notes", () => {
      expect(gl).not.toMatch(/Billing Notes/);
      expect((gl.match(/value=\{form\.notes \|\| ""\}/g) || []).length).toBe(1);
      expect(gl).toMatch(/htmlFor="gl-notes">Notes</);
    });
    test("Save still sends the whole form (notes column unchanged)", () => {
      expect(gl).toMatch(/body: JSON\.stringify\(form\)/);
      expect(gl).toMatch(/notes: "",/);
    });
  });

  describe("long name / address (H3)", () => {
    test("Name and Address Lines 1-3 use AutoResizeTextarea", () => {
      expect(gl).toMatch(/<AutoResizeTextarea\s+id="gl-name"/);
      for (const n of [1, 2, 3]) expect(gl).toMatch(new RegExp(`<AutoResizeTextarea\\s+id="gl-address${n}"[\\s\\S]*?value=\\{form\\.address${n} \\|\\| ""\\}`));
    });
  });

  describe("labels, required fields, tabs, toolbar (H10)", () => {
    test("no unlinked labels; every htmlFor has a matching id", () => {
      expect(gl).not.toMatch(/<label>[^<]/);
      const fors = [...gl.matchAll(/htmlFor="([^"]+)"/g)].map((m) => m[1]);
      expect(fors.length).toBeGreaterThanOrEqual(20);
      for (const id of fors) expect(gl).toContain(`id="${id}"`);
    });
    test("Code, Name and Type are marked required; client check unchanged", () => {
      expect((gl.match(/className="fs-required"/g) || []).length).toBe(3);
      expect(gl).toMatch(/if \(!form\.code\.trim\(\) \|\| !form\.name\.trim\(\)\)/);
    });
    test("tabs have tab / tabpanel semantics with a selected state", () => {
      expect(gl).toMatch(/role="tablist"/);
      expect(gl).toMatch(/role="tab"\s+aria-selected=\{activeTab === key\}/);
      expect((gl.match(/role="tabpanel"/g) || []).length).toBe(3);
    });
    test("toolbar buttons use the shared states; Import disabled while editing", () => {
      for (const [h, s] of [["handleEdit", "canEdit"], ["handleDelete", "canDelete"], ["handlePrevious", "canPrevious"], ["handleNext", "canNext"], ["triggerImport", "canImport"]]) {
        expect(gl).toMatch(new RegExp(`onClick=\\{${h}\\} disabled=\\{!toolbar\\.${s}\\}`));
      }
    });
  });

  describe("import UI (H6)", () => {
    test("file choice only calls the read-only preview; Confirm resubmits the same file", () => {
      expect(gl).toMatch(/\/api\/genlib\/import\/preview/);
      expect(gl).toMatch(/formData\.append\("file", importFile\)/);
      expect(gl).not.toMatch(/alert\(lines\.join/);
    });
    test("rows as 'Row X | Code | reason' and an Imported / Skipped / Warnings summary, scrolling lists", () => {
      expect(gl).toMatch(/Row \{s\.row\} \| \{s\.code \|\| "-"\} \| \{s\.reason\}/);
      expect(gl).toMatch(/Imported: <strong>\{importResult\.imported\}<\/strong> &nbsp;\|&nbsp; Skipped:/);
      expect(glCss).toMatch(/\.gl-page \.gl-import-list \{[\s\S]*?max-height: 180px;\s*overflow-y: auto;/);
      expect(gl).toMatch(/accept="\.csv,\.xls,\.xlsx"/);
    });
  });

  describe("styles (H1 / H4 / H11)", () => {
    const block = addedBlock(glCss, "General Libraries UI/UX pass");
    test("every new rule is scoped to .gl-page", () => {
      const sels = selectorsOf(block);
      expect(sels.length).toBeGreaterThan(20);
      for (const s of sels) expect(s).toMatch(/^(\[data-theme="dark"\] )?\.gl-page\b/);
    });
    test("field text uses the theme text colour; overflow fixes present", () => {
      expect(block).toMatch(/\.gl-page \.field input,[\s\S]*?\{\s*color: var\(--text-primary\);/);
      expect(block).toMatch(/min-width: 0;/);
      expect(block).toMatch(/\.gl-page \.rtm-hint \{\s*color: var\(--text-secondary\);/);
    });
  });
});
