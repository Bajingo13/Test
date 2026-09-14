const fs = require("fs");
const path = require("path");

// Phase M.1 - File Setup > Report Sections master-data page + Group Code's
// switch from a hard-coded Report Section dropdown to a live one. Node-only
// jest config (no jsdom), so this is a source-structure guard suite, same
// convention as groupCodesUi.test.js. No accounting/financial-statement/
// transaction-module behavior is touched by this phase.

const FILESETUP = path.join(__dirname, "../../pages/FILESETUP");
const COMPONENTS = path.join(__dirname, "../../components");
const SIDEBAR = path.join(__dirname, "../../components/sidebar");
const readFileset = (f) => fs.readFileSync(path.join(FILESETUP, f), "utf8");
const readComponent = (f) => fs.readFileSync(path.join(COMPONENTS, f), "utf8");

describe("ReportSections.jsx - master-data page", () => {
  const src = readFileset("ReportSections.jsx");

  test("uses its own permission module, not Group Code's", () => {
    expect(src).toMatch(/const MODULE_KEY = "FILESETUP\.REPORT_SECTIONS"/);
  });

  test("fetches from GET /api/report-sections, not a hard-coded array", () => {
    expect(src).toMatch(/fetch\(`\$\{API_BASE\}\/api\/report-sections`/);
    // code-shaped only - the explanatory header comment naming
    // groupCodeSections.mjs in prose (documenting what this page replaces)
    // is fine, an actual import of it is not.
    expect(src).not.toMatch(/from ["']\.?\/?groupCodeSections\.mjs["']/);
  });

  test("exposes the required fields: Code, Name, Account Class, Display Order, Status", () => {
    expect(src).toMatch(/Report Section Code/);
    expect(src).toMatch(/Report Section Name/);
    expect(src).toMatch(/Account Class/);
    expect(src).toMatch(/Display Order/);
    expect(src).toMatch(/>Status</);
  });

  test("table lists Code, Name, Account Class, Order, Status columns", () => {
    expect(src).toMatch(/<th>Code<\/th>/);
    expect(src).toMatch(/<th>Name<\/th>/);
    expect(src).toMatch(/<th>Account Class<\/th>/);
    expect(src).toMatch(/<th>Order<\/th>/);
    expect(src).toMatch(/<th>Status<\/th>/);
  });

  test("has the same toolbar actions as Group Code: Add/Edit/Delete/View/Print/Previous/Next", () => {
    for (const label of ["Add", "Edit", "Delete", "View", "Print", "Previous", "Next"]) {
      expect(src).toMatch(new RegExp(`>\\s*${label}\\s*<`));
    }
  });

  test("Add/Edit/Delete are gated by CONFIGURE, list/view by VIEW - same pattern as Group Code", () => {
    expect(src).toMatch(/can\(MODULE_KEY, "VIEW"\)/);
    expect(src).toMatch(/can\(MODULE_KEY, "CONFIGURE"\)/);
  });

  test("save posts code/name/accountClass/displayOrder/status - no extra fields invented", () => {
    const start = src.indexOf("async function handleSave");
    const end = src.indexOf("\n  }", start);
    const body = src.slice(start, end);
    expect(body).toMatch(/code: form\.code\.trim\(\)/);
    expect(body).toMatch(/name: form\.name\.trim\(\)/);
    expect(body).toMatch(/accountClass: form\.accountClass/);
    expect(body).toMatch(/displayOrder: form\.displayOrder/);
    expect(body).toMatch(/status: form\.status/);
  });

  test("delete confirms before calling the API", () => {
    const start = src.indexOf("async function handleDelete");
    const end = src.indexOf("\n  }", start);
    const body = src.slice(start, end);
    expect(body).toMatch(/window\.confirm/);
  });
});

describe("GroupCodes.jsx - Report Section dropdown is now dynamic, not hard-coded", () => {
  const src = readFileset("GroupCodes.jsx");

  test("no longer imports from the old hard-coded groupCodeSections.mjs", () => {
    expect(src).not.toMatch(/from "\.\/groupCodeSections\.mjs"/);
  });

  test("loads sections from GET /api/report-sections on mount", () => {
    expect(src).toMatch(/fetch\(`\$\{API_BASE\}\/api\/report-sections`/);
    expect(src).toMatch(/loadReportSections\(\)/);
  });

  test("sectionsForClass/sectionLabel/isSectionValidForClass are now local functions backed by fetched state, not static imports", () => {
    expect(src).toMatch(/function sectionsForClass\(accountClass\)/);
    expect(src).toMatch(/function sectionLabel\(code\)/);
    expect(src).toMatch(/function isSectionValidForClass\(accountClass, section\)/);
    // still ACTIVE-only for the dropdown, same rule as before.
    expect(src).toMatch(/s\.status === "ACTIVE"/);
  });

  test("the Report Section dropdown is still driven by sectionsForClass(form.accountClass) - unchanged call site, new implementation", () => {
    expect(src).toMatch(/sectionsForClass\(form\.accountClass\)\.map\(\(s\) =>/);
  });

  test("a '+' button opens the quick-add modal, inheriting the currently selected Account Class", () => {
    expect(src).toMatch(/import ReportSectionQuickAddModal from "\.\.\/\.\.\/components\/ReportSectionQuickAddModal"/);
    expect(src).toMatch(/className="group-section-add-btn"/);
    expect(src).toMatch(/onClick=\{\(\) => setShowSectionModal\(true\)\}/);
    expect(src).toMatch(/<ReportSectionQuickAddModal/);
    expect(src).toMatch(/accountClass=\{form\.accountClass\}/);
  });

  test("a successful quick-add refreshes the list and selects the new section immediately", () => {
    const start = src.indexOf("function handleSectionCreated");
    const end = src.indexOf("\n  }", start);
    const body = src.slice(start, end);
    expect(body).toMatch(/loadReportSections\(\)/);
    expect(body).toMatch(/updateField\("reportSection", created\.code\)/);
  });

  test("class-change-resets-section-to-Unclassified logic is unchanged (still no auto-guess)", () => {
    expect(src).toMatch(
      /key === "accountClass" && !isSectionValidForClass\(value, next\.reportSection\)/
    );
  });
});

describe("ReportSectionQuickAddModal.jsx - quick-add from Group Code", () => {
  const src = readComponent("ReportSectionQuickAddModal.jsx");

  test("posts to the same /api/report-sections endpoint the full page uses - no separate recognition logic", () => {
    expect(src).toMatch(/fetch\(`\$\{API_BASE\}\/api\/report-sections`, \{\s*method: "POST"/);
  });

  test("the Account Class field is inherited and fixed, not user-editable", () => {
    expect(src).toMatch(/<input value=\{form\.accountClass\} disabled \/>/);
  });

  test("requires Code and Name before saving", () => {
    const start = src.indexOf("function validate()");
    const end = src.indexOf("\n  }", start);
    const body = src.slice(start, end);
    expect(body).toMatch(/if \(!form\.code\.trim\(\)\)/);
    expect(body).toMatch(/if \(!form\.name\.trim\(\)\)/);
  });

  test("dirty form prompts before a discarded close (Escape/backdrop/Cancel), same UX contract as PartyQuickAddModal", () => {
    expect(src).toMatch(/function requestClose\(\)/);
    expect(src).toMatch(/if \(dirty && !window\.confirm/);
    expect(src).toMatch(/document\.addEventListener\("keydown", handleKeyDown\)/);
  });

  test("on success, calls onCreated with the new section (code/id) so the caller can select it immediately", () => {
    const start = src.indexOf("async function handleSave");
    const end = src.indexOf("\n  }", start);
    const body = src.slice(start, end);
    expect(body).toMatch(/onCreated\(created\)/);
  });
});

describe("menu / route / permission wiring", () => {
  test("File Setup menu has a Report Sections entry next to Group Code", () => {
    const src = fs.readFileSync(path.join(SIDEBAR, "fileSetupMenuConfig.js"), "utf8");
    expect(src).toMatch(
      /\{ id: "report-sections", label: "Report Sections", icon: Layers, path: "\/report-sections" \}/
    );
  });

  test("App.jsx routes /report-sections to ReportSections", () => {
    const appSrc = fs.readFileSync(path.join(__dirname, "../../App.jsx"), "utf8");
    expect(appSrc).toMatch(/import ReportSections from "\.\/pages\/FILESETUP\/ReportSections"/);
    expect(appSrc).toMatch(/<Route path="\/report-sections" element={<ReportSections \/>} \/>/);
  });

  test("pathPermissionMap maps /report-sections to FILESETUP.REPORT_SECTIONS VIEW", () => {
    const mapSrc = fs.readFileSync(path.join(SIDEBAR, "pathPermissionMap.js"), "utf8");
    expect(mapSrc).toMatch(/"\/report-sections": \["FILESETUP\.REPORT_SECTIONS", "VIEW"\]/);
  });

  test("permission catalog rows exist and are additive-only (INSERT IGNORE, ADMIN-only grant, mirrors Group Code)", () => {
    const migSrc = fs.readFileSync(
      path.join(__dirname, "../migrations/report_sections_permissions_migration.sql"),
      "utf8"
    );
    expect(migSrc).toMatch(/INSERT IGNORE INTO permissions/);
    expect(migSrc).toMatch(/'FILESETUP\.REPORT_SECTIONS', 'VIEW'/);
    expect(migSrc).toMatch(/'FILESETUP\.REPORT_SECTIONS', 'CONFIGURE'/);
    expect(migSrc).toMatch(/WHERE r\.code = 'ADMIN'/);
    // deliberately not granted to ACCOUNTANT, mirroring FILESETUP.GROUP_CODES.
    expect(migSrc).not.toMatch(/WHERE r\.code = 'ACCOUNTANT'/);
  });
});

describe("groupCodeSections.mjs remains unchanged (legacy/parity reference only, no longer the live wiring)", () => {
  test("still exports the exact same static catalog the backend parity test checks", () => {
    const src = fs.readFileSync(path.join(FILESETUP, "groupCodeSections.mjs"), "utf8");
    expect(src).toMatch(/export const SECTION_LABELS/);
    expect(src).toMatch(/export const ALLOWED_SECTIONS_BY_CLASS/);
    expect(src).toMatch(/CURRENT_ASSET: "Current Assets"/);
  });
});
