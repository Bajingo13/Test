const fs = require("fs");
const path = require("path");

// Phase H - File Setup > Group Codes master-data UI modernization
// (toolbar workflow + Add/View/Edit modes + Previous/Next + dynamic Report
// Section). The repo's jest config is node-only (no jsdom), so the React
// screen is covered by source-structure guards; the pure classification
// mapping is exercised directly via its .mjs module. No accounting /
// financial-statement / backend behavior is touched by this phase.

const FILESETUP = path.join(__dirname, "../../pages/FILESETUP");
const read = (f) => fs.readFileSync(path.join(FILESETUP, f), "utf8");

// --------------------------------------------------------------------------
// PART G / H - dynamic Report Section constrained by Account Class
// --------------------------------------------------------------------------

describe("groupCodeSections.mjs - Report Section options follow Account Class", () => {
  let M;
  beforeAll(async () => {
    M = await import("../../pages/FILESETUP/groupCodeSections.mjs");
  });

  const codesFor = (cls) => M.sectionsForClass(cls).map((s) => s.code);

  test("ASSET -> Current Asset / Non-Current Asset only", () => {
    expect(codesFor("ASSET")).toEqual(["CURRENT_ASSET", "NON_CURRENT_ASSET"]);
  });

  test("LIABILITY -> Current Liability / Non-Current Liability only", () => {
    expect(codesFor("LIABILITY")).toEqual(["CURRENT_LIABILITY", "NON_CURRENT_LIABILITY"]);
  });

  test("EQUITY -> Equity only", () => {
    expect(codesFor("EQUITY")).toEqual(["EQUITY"]);
  });

  test("INCOME -> Revenue / Other Income only", () => {
    expect(codesFor("INCOME")).toEqual(["REVENUE", "OTHER_INCOME"]);
  });

  test("EXPENSE -> Direct Cost / Operating Expense / Other Expense / Tax Expense only", () => {
    expect(codesFor("EXPENSE")).toEqual([
      "DIRECT_COST",
      "OPERATING_EXPENSE",
      "OTHER_EXPENSE",
      "TAX_EXPENSE",
    ]);
  });

  test("an unknown / blank Account Class yields no sections (Unclassified only)", () => {
    expect(codesFor("")).toEqual([]);
    expect(codesFor("MYSTERY")).toEqual([]);
  });

  test("persisted canonical section codes are unchanged (display wording only in labels)", () => {
    expect(M.ALLOWED_SECTIONS_BY_CLASS).toEqual({
      ASSET: ["CURRENT_ASSET", "NON_CURRENT_ASSET"],
      LIABILITY: ["CURRENT_LIABILITY", "NON_CURRENT_LIABILITY"],
      EQUITY: ["EQUITY"],
      INCOME: ["REVENUE", "OTHER_INCOME"],
      EXPENSE: ["DIRECT_COST", "OPERATING_EXPENSE", "OTHER_EXPENSE", "TAX_EXPENSE"],
    });
    // labels may be friendlier, codes must not drift
    expect(M.sectionLabel("CURRENT_ASSET")).toBe("Current Assets");
    expect(M.sectionLabel("NON_CURRENT_LIABILITY")).toBe("Non-Current Liabilities");
  });

  test("Unclassified (null / '' / undefined) is always a legal choice for every class", () => {
    for (const cls of ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"]) {
      expect(M.isSectionValidForClass(cls, "")).toBe(true);
      expect(M.isSectionValidForClass(cls, null)).toBe(true);
      expect(M.isSectionValidForClass(cls, undefined)).toBe(true);
    }
  });

  test("changing Account Class makes an incompatible Report Section invalid", () => {
    // ASSET / CURRENT_ASSET -> switch class to EXPENSE: old section no longer valid
    expect(M.isSectionValidForClass("ASSET", "CURRENT_ASSET")).toBe(true);
    expect(M.isSectionValidForClass("EXPENSE", "CURRENT_ASSET")).toBe(false);
    expect(M.isSectionValidForClass("INCOME", "OPERATING_EXPENSE")).toBe(false);
    expect(M.isSectionValidForClass("EQUITY", "REVENUE")).toBe(false);
  });

  test("no automatic guessing: the module exposes only validation, no class->section remap", () => {
    const src = read("groupCodeSections.mjs");
    // there must be no lookup that turns one section into a 'best guess'
    // replacement when the class changes
    expect(src).not.toMatch(/guess|autoMap|remap|coerceSection|fallbackSection/i);
    expect(typeof M.sectionsForClass).toBe("function");
    expect(typeof M.isSectionValidForClass).toBe("function");
  });
});

// --------------------------------------------------------------------------
// GroupCodes.jsx - toolbar workflow + modes
// --------------------------------------------------------------------------

describe("GroupCodes.jsx - master-data toolbar workflow", () => {
  const src = read("GroupCodes.jsx");

  test("header matches the General Libraries concept (mini label / title / subtitle)", () => {
    expect(src).toMatch(/className="group-mini"[^>]*>\s*Astrea Blue/);
    expect(src).toMatch(/<h1>\s*Group Codes\s*<\/h1>/);
    expect(src).toMatch(/Maintain account grouping and financial statement classification\./);
  });

  test("toolbar exposes Add / Edit / Delete / View / Print / Previous / Next", () => {
    const toolbar = src.slice(
      src.indexOf('className="group-toolbar'),
      src.indexOf("</div>", src.indexOf('className="group-toolbar')) + 6
    );
    for (const label of ["Add", "Edit", "Delete", "View", "Print", "Previous", "Next"]) {
      expect(src).toMatch(new RegExp(`>\\s*${label}\\s*<`));
    }
    expect(toolbar).toMatch(/onClick=\{handleAdd\}/);
    expect(toolbar).toMatch(/onClick=\{handleEdit\}/);
    expect(toolbar).toMatch(/onClick=\{handleDelete\}/);
    expect(toolbar).toMatch(/onClick=\{handleView\}/);
    expect(toolbar).toMatch(/onClick=\{handlePrint\}/);
    expect(toolbar).toMatch(/onClick=\{handlePrevious\}/);
    expect(toolbar).toMatch(/onClick=\{handleNext\}/);
  });

  test("three explicit modes: view / add / edit", () => {
    expect(src).toMatch(/useState\("view"\)/);
    expect(src).toMatch(/setMode\("add"\)/);
    expect(src).toMatch(/setMode\("edit"\)/);
    expect(src).toMatch(/const isEditing = mode === "add" \|\| mode === "edit"/);
    // editable fields are gated on the mode
    expect(src).toMatch(/disabled=\{!isEditing\}/);
  });

  test("Add prepares a blank record without mutating the selected one", () => {
    const fn = src.slice(src.indexOf("function handleAdd"), src.indexOf("function handleView"));
    expect(fn).toMatch(/setSelectedId\(null\)/);
    expect(fn).toMatch(/setForm\(\{ \.\.\.EMPTY_FORM \}\)/);
    expect(fn).toMatch(/setMode\("add"\)/);
  });

  test("View shows the selected record read-only (restores from persisted list)", () => {
    const fn = src.slice(src.indexOf("function handleView"), src.indexOf("function handleEdit"));
    expect(fn).toMatch(/records\.find\(\(r\) => r\.id === selectedId\)/);
    expect(fn).toMatch(/setMode\("view"\)/);
  });

  test("Edit requires a selected record and keeps existing validation on Save", () => {
    const fn = src.slice(src.indexOf("function handleEdit"), src.indexOf("function handleCancel"));
    expect(fn).toMatch(/if \(!form\.id\)/);
    expect(fn).toMatch(/setMode\("edit"\)/);
    const save = src.slice(src.indexOf("async function handleSave"), src.indexOf("async function handleDelete"));
    expect(save).toMatch(/if \(!form\.groupCode\.trim\(\) \|\| !form\.groupDescription\.trim\(\)\)/);
    expect(save).toMatch(/mode === "add"\s*\?\s*`\$\{API_BASE\}\/api\/group-codes`/);
    expect(save).toMatch(/method = mode === "add" \? "POST" : "PUT"/);
  });

  test("Cancel discards edits and restores the persisted selected record", () => {
    const fn = src.slice(src.indexOf("function handleCancel"), src.indexOf("function handlePrevious"));
    expect(fn).toMatch(/records\.find\(\(r\) => r\.id === selectedId\)/);
    expect(fn).toMatch(/setForm\(toForm\(original\)\)/);
    expect(fn).toMatch(/setForm\(\{ \.\.\.EMPTY_FORM \}\)/);
    expect(fn).toMatch(/setMode\("view"\)/);
  });

  test("row click selects the record (no per-row action button needed)", () => {
    expect(src).toMatch(/onClick=\{\(\) => selectRecord\(item\)\}/);
    expect(src).toMatch(/selectedId === item\.id \? "group-row selected-row" : "group-row"/);
    const sel = src.slice(src.indexOf("function selectRecord"), src.indexOf("function handleAdd"));
    expect(sel).toMatch(/confirmDiscardIfEditing\(\)/);
    expect(sel).toMatch(/applySelection\(item\)/);
  });

  test("Previous / Next walk the FILTERED visible list in deterministic order", () => {
    expect(src).toMatch(/const currentIndex = filteredRecords\.findIndex\(\(r\) => r\.id === selectedId\)/);
    const prev = src.slice(src.indexOf("function handlePrevious"), src.indexOf("function handleNext"));
    expect(prev).toMatch(/currentIndex > 0/);
    expect(prev).toMatch(/applySelection\(filteredRecords\[currentIndex - 1\]\)/);
    const next = src.slice(src.indexOf("function handleNext"), src.indexOf("function handlePrint"));
    expect(next).toMatch(/currentIndex < filteredRecords\.length - 1/);
    expect(next).toMatch(/applySelection\(filteredRecords\[currentIndex \+ 1\]\)/);
  });

  test("a narrowing search that hides the selection clears it (no stale hidden edit/delete target)", () => {
    expect(src).toMatch(/!filteredRecords\.some\(\(r\) => r\.id === selectedId\)/);
    expect(src).toMatch(/setSelectedId\(null\)/);
  });

  test("Previous / Next / row-select guard unsaved edits with a confirm", () => {
    expect(src).toMatch(/function confirmDiscardIfEditing\(\)/);
    expect(src).toMatch(/window\.confirm\("Discard unsaved changes to this Group Code\?"\)/);
  });

  test("Delete acts on the selected record and keeps an explicit confirmation", () => {
    const fn = src.slice(src.indexOf("async function handleDelete"), src.indexOf("const modeLabel"));
    expect(fn).toMatch(/if \(!form\.id\)/);
    expect(fn).toMatch(/window\.confirm\(\s*`Delete group code "\$\{form\.groupCode\}"\?/);
    expect(fn).toMatch(/method: "DELETE"/);
    expect(fn).toMatch(/\/api\/group-codes\/\$\{form\.id\}/);
    // no invented cascade / bulk delete
    expect(fn).not.toMatch(/cascade|forEach|Promise\.all/i);
  });

  test("Print is a plain browser print - no backend, no PDF dependency", () => {
    expect(src).toMatch(/function handlePrint\(\)\s*\{\s*window\.print\(\);\s*\}/);
    expect(src).not.toMatch(/jsPDF|html2canvas|pdf-lib|@react-pdf|puppeteer/i);
    expect(src).not.toMatch(/\/api\/group-codes[^`"']*print/i);
  });
});

// --------------------------------------------------------------------------
// PART F - per-row action clutter removed
// --------------------------------------------------------------------------

describe("GroupCodes.jsx - per-row Edit/Delete buttons removed", () => {
  const src = read("GroupCodes.jsx");

  test("no per-row action handlers or Action column", () => {
    expect(src).not.toMatch(/onClick=\{\(\) => handleEdit\(item\)\}/);
    expect(src).not.toMatch(/onClick=\{\(\) => handleDelete\(item\.id\)\}/);
    expect(src).not.toMatch(/<th>\s*Action\s*<\/th>/);
    expect(src).not.toMatch(/className="danger-btn"/);
  });

  test("the browsing table has exactly the six data columns", () => {
    const thead = src.slice(src.indexOf("<thead>"), src.indexOf("</thead>"));
    const headers = [...thead.matchAll(/<th>([^<]+)<\/th>/g)].map((m) => m[1].trim());
    expect(headers).toEqual([
      "Group Code",
      "Description",
      "Class",
      "Report Section",
      "Order",
      "Status",
    ]);
  });
});

// --------------------------------------------------------------------------
// PARTS G/H/J/K - form, dynamic section, display order, warning
// --------------------------------------------------------------------------

describe("GroupCodes.jsx - classification form + warning", () => {
  const src = read("GroupCodes.jsx");

  test("Report Section select is driven by sectionsForClass(form.accountClass) with an always-present Unclassified option", () => {
    expect(src).toMatch(/<option value="">— Unclassified —<\/option>/);
    expect(src).toMatch(/sectionsForClass\(form\.accountClass\)\.map\(\(s\) =>/);
    expect(src).toMatch(/<option key=\{s\.code\} value=\{s\.code\}>/);
  });

  test("changing Account Class resets an incompatible Report Section to Unclassified (no guess)", () => {
    const fn = src.slice(src.indexOf("function updateField"), src.indexOf("const unclassifiedCount"));
    expect(fn).toMatch(/key === "accountClass" && !isSectionValidForClass\(value, next\.reportSection\)/);
    expect(fn).toMatch(/next\.reportSection = ""/);
    // it must NOT pick a replacement section
    expect(fn).not.toMatch(/next\.reportSection = "[A-Z_]+"/);
  });

  test("Save persists canonical codes: reportSection or null, integer displayOrder or null", () => {
    const save = src.slice(src.indexOf("async function handleSave"), src.indexOf("async function handleDelete"));
    expect(save).toMatch(/reportSection: form\.reportSection \|\| null/);
    expect(save).toMatch(/displayOrder: form\.displayOrder === "" \? null : Number\(form\.displayOrder\)/);
  });

  test("Display Order is preserved and explained (Part J helper copy)", () => {
    expect(src).toMatch(/id="gc-order"/);
    expect(src).toMatch(/Controls the order of Group Codes within the selected Report Section\. Leave\s+blank for automatic ordering\./);
  });

  test("readiness warning stays dynamic - derived from records, never a hard-coded count", () => {
    expect(src).toMatch(
      /const unclassifiedCount = useMemo\(\s*\(\) => records\.filter\(\(r\) => r\.status === "ACTIVE" && !r\.reportSection\)\.length/
    );
    expect(src).toMatch(/\{unclassifiedCount\} Group Code\{unclassifiedCount === 1 \? "" : "s"\}/);
    // no literal "32 Group Codes" style copy
    expect(src).not.toMatch(/\b32 Group Code/);
  });

  test("warning wording no longer claims the statements cannot be generated", () => {
    const warn = src.slice(src.indexOf("group-warning"), src.indexOf("group-warning") + 400);
    expect(warn).toMatch(/appear under Unclassified/);
    expect(warn).not.toMatch(/cannot be generated|before .* can be generated/i);
  });
});

// --------------------------------------------------------------------------
// PART M - permissions reflected, not reinvented
// --------------------------------------------------------------------------

describe("GroupCodes.jsx - existing permissions honored", () => {
  const src = read("GroupCodes.jsx");

  test("uses the shared usePermissions hook with the existing module key + actions", () => {
    expect(src).toMatch(/import usePermissions from "\.\.\/\.\.\/hooks\/usePermissions"/);
    expect(src).toMatch(/const MODULE_KEY = "FILESETUP\.GROUP_CODES"/);
    expect(src).toMatch(/can\(MODULE_KEY, "VIEW"\)/);
    expect(src).toMatch(/can\(MODULE_KEY, "CONFIGURE"\)/);
  });

  test("write actions are gated on CONFIGURE; view/navigation are not", () => {
    expect(src).toMatch(/onClick=\{handleAdd\}\s*\n\s*disabled=\{!canConfigure\}/);
    expect(src).toMatch(/onClick=\{handleEdit\}\s*\n\s*disabled=\{!canConfigure \|\| !form\.id \|\| isEditing\}/);
    expect(src).toMatch(/onClick=\{handleDelete\}\s*\n\s*disabled=\{!canConfigure \|\| !form\.id \|\| isEditing\}/);
    // no brand-new permission strings
    expect(src).not.toMatch(/GROUP_CODES\.(ADD|CREATE|UPDATE|DELETE|MODERNIZE)/);
  });
});
