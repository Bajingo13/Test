const fs = require("fs");
const path = require("path");

// TC-FS-012 (source guards; node-only jest - the screens are verified in a real
// browser separately). File Setup pages REFLECT the permissions the API enforces:
// write controls are shown only with the matching permission, and a page the
// user cannot view shows an in-page message instead of a native alert. The API
// stays the security boundary (fileSetupRbac.http.test.js).

const DIR = path.join(__dirname, "../../pages/FILESETUP");
const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8").replace(/\r\n/g, "\n");
const HOOK = 'import usePermissions from "../../hooks/usePermissions";';

describe("COA / General Libraries toolbars", () => {
  for (const [file, key] of [["COA.jsx", "FILESETUP.COA"], ["GenLib.jsx", "FILESETUP.GENLIB"]]) {
    test(`${file}: Add / Import need CREATE, Edit needs EDIT, Delete needs DELETE; View / Print / navigation stay for everyone`, () => {
      const src = read(file);
      expect(src).toContain(HOOK);
      expect(src).toContain(`const canCreate = can("${key}", "CREATE");`);
      expect(src).toContain(`const canEditPerm = can("${key}", "EDIT");`);
      expect(src).toContain(`const canDeletePerm = can("${key}", "DELETE");`);
      expect(src).toMatch(/\{canCreate \? \(?\s*<button type="button" className="btn btn-primary" onClick=\{handleAdd\}>/);
      expect(src).toMatch(/\{canEditPerm \? \(?\s*<button type="button" className="btn" onClick=\{handleEdit\} disabled=\{!toolbar\.canEdit\}>/);
      expect(src).toMatch(/\{canDeletePerm \? \(?\s*<button type="button" className="btn btn-danger" onClick=\{handleDelete\} disabled=\{!toolbar\.canDelete\}>/);
      expect(src).toMatch(/onClick=\{handlePrevious\} disabled=\{!toolbar\.canPrevious\}/);
    });
  }
  test("Import is CREATE-gated on both pages (the import APIs require CREATE)", () => {
    expect(read("COA.jsx")).toMatch(/\{canCreate \? \(\s*<button type="button" className="btn" onClick=\{triggerImport\}/);
    expect(read("GenLib.jsx")).toMatch(/\{canCreate \? \(\s*<button type="button" className="btn" onClick=\{triggerImport\}/);
  });
  test("COA: a view-only user (no Group Codes VIEW) gets no native alert for the editor's group-code list", () => {
    expect(read("COA.jsx")).toMatch(/if \(res\.status === 403\) return;\n\s*alert\(data\.message \|\| "Failed to load group codes"\);/);
  });
});

describe("Tax Setup pages (EWT / VAT): read-only without FILESETUP.TAX_SETUP CONFIGURE", () => {
  for (const file of ["EWTLibrary.jsx", "VatRateLibrary.jsx"]) {
    test(`${file}: add button, action column and the form card need CONFIGURE`, () => {
      const src = read(file);
      expect(src).toContain(HOOK);
      expect(src).toContain('const canConfigure = can("FILESETUP.TAX_SETUP", "CONFIGURE");');
      expect(src).toMatch(/\{canConfigure \? \(\s*<button className="fs-btn primary" onClick=\{handleNew\}>/);
      expect(src).toContain("{canConfigure ? <th>Action</th> : null}");
      expect(src).toMatch(/\{canConfigure \? \(\s*<div className="fs-card">\s*<h2>\{mode === "add"/);
    });
  }
});

describe("Prepaid / Fixed Assets / Company Profile", () => {
  for (const [file, key, what] of [
    ["PrepaidAccountSetup.jsx", "FILESETUP.PREPAID_ACCOUNTS", "Prepaid Accounts"],
    ["FixedAssetSetup.jsx", "FILESETUP.FIXED_ASSETS", "Fixed Assets"],
  ]) {
    test(`${file}: no-permission message, CREATE / EDIT / DELETE gating, no native alert on 403`, () => {
      const src = read(file);
      expect(src).toContain(HOOK);
      expect(src).toContain(`const canView = permsLoading || can("${key}", "VIEW");`);
      expect(src).toContain(`<div className="group-card" role="alert">You do not have permission to view ${what}.</div>`);
      expect(src).toMatch(/if \(res\.status === 403\) return; \/\/ the page shows its no-permission message\n\s*alert\(/);
      expect(src).toMatch(/\{canCreate \? \(\s*<button type="button" onClick=\{handleNew\}>/);
      expect(src).toMatch(/\{canWrite && \(mode === "add" \? canCreate : canEditPerm\) \? \(\s*<section className="group-card">/);
      expect(src).toContain("{canEditPerm ? <button type=\"button\" onClick={() => handleEdit(item)}>Edit</button> : null}");
      expect(src).toMatch(/\{canDeletePerm \? \(\s*<button\s+type="button"\s+className="danger-btn"/);
    });
  }
  test("CompanyProfile.jsx: no-permission message; Save needs FILESETUP.COMPANY_SETUP CONFIGURE", () => {
    const src = read("CompanyProfile.jsx");
    expect(src).toContain('const canConfigure = can("FILESETUP.COMPANY_SETUP", "CONFIGURE");');
    expect(src).toContain('<div className="group-card" role="alert">You do not have permission to view the Company Profile.</div>');
    expect(src).toMatch(/\{canConfigure \? \(\s*<button className="primary-btn" type="button" onClick=\{handleSave\}/);
  });
  test("ReportSections.jsx: the 403 on load no longer adds a native alert on top of the in-page message", () => {
    const src = read("ReportSections.jsx");
    expect(src).toMatch(/if \(res\.status === 403\) return; \/\/ the page shows its no-permission message\n\s*alert\(data\.message \|\| "Failed to load report sections\."\);/);
    expect(src).toContain("You do not have permission to view Report Sections.");
  });
});

describe("Bank Codes / Currency keep their existing gating (reference pattern)", () => {
  test("BankCodes.jsx gates configuration on FILESETUP.BANK_CODES CONFIGURE", () => {
    expect(read("BankCodes.jsx")).toContain('const canConfigure = can("FILESETUP.BANK_CODES", "CONFIGURE");');
  });
});

describe("layout: no page-level horizontal scroll from File Setup toolbars / tables", () => {
  test("File Setup toolbars wrap and the date filters do not inherit the 320px search width", () => {
    const css = fs.readFileSync(path.join(DIR, "FileSetupPages.css"), "utf8");
    expect(css).toMatch(/\.fs-toolbar \{\s*display: flex;\s*flex-wrap: wrap;/);
    expect(css).toMatch(/\.fs-toolbar \.fs-filter-date-label input \{\s*width: auto;\s*\}/);
  });
  test("AR / AP beginning-balance tables scroll inside their card", () => {
    const css = fs.readFileSync(path.join(DIR, "ARAPBeginningBalance.css"), "utf8");
    expect(css).toMatch(/\.arap-entry-table-wrap,\s*\.arap-table-wrap \{\s*overflow-x: auto;[\s\S]*?contain: inline-size;/);
    expect(css).toMatch(/\.arap-page \{\s*contain: inline-size;\s*\}/);
  });
  test("390px: page roots never widen <main>; wide tables scroll inside their card; form columns fit", () => {
    const fsCss = fs.readFileSync(path.join(DIR, "FileSetupPages.css"), "utf8");
    expect(fsCss).toMatch(/\.fs-page \{\s*contain: inline-size;\s*\}/);
    expect(fsCss).toMatch(/\.fs-card \{\s*overflow-x: auto;\s*\}/);
    expect(fsCss).toMatch(/minmax\(min\(220px, 100%\), 1fr\)/);
    expect(fs.readFileSync(path.join(DIR, "GroupCodes.css"), "utf8")).toMatch(/\.group-page \{\s*contain: inline-size;\s*\}/);
    expect(fs.readFileSync(path.join(DIR, "BeginningBalanceGL.css"), "utf8")).toMatch(/\.glbb-page,\s*\.glbb-table-wrap \{\s*contain: inline-size;/);
  });
});

describe("dark mode: typed values readable on the group-page layout", () => {
  test("fields use the theme text colour (were browser-default black, ~1.3:1 on the dark card)", () => {
    const css = fs.readFileSync(path.join(DIR, "GroupCodes.css"), "utf8");
    expect(css).toMatch(/\.group-page \.group-form input,\s*\.group-page \.group-form select,\s*\.group-page \.group-form textarea \{\s*color: var\(--text-primary\);/);
    expect(css).toMatch(/\.group-page \.group-form input::placeholder,[\s\S]*?color: var\(--text-secondary\);/);
  });
});
