const fs = require("fs");
const path = require("path");

// Company Branch Management - UI permission visibility and wiring (source guards;
// node-only jest - the screens are verified in a real browser separately).

const SRC = path.join(__dirname, "../..");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8").replace(/\r\n/g, "\n");
const page = read("pages/FILESETUP/BranchManagement.jsx");
const panel = read("pages/FILESETUP/CompanyBranchesPanel.jsx");

describe("navigation", () => {
  test("File Setup menu has 'Branches' -> /branch-management, gated by FILESETUP.BRANCHES / VIEW", () => {
    expect(read("components/sidebar/fileSetupMenuConfig.js")).toContain('{ id: "branch-management", label: "Branches", icon: Network, path: "/branch-management" }');
    expect(read("components/sidebar/pathPermissionMap.js")).toMatch(/"\/branch-management": \["FILESETUP\.BRANCHES", "VIEW"\]/);
    expect(read("App.jsx")).toMatch(/<Route path="\/branch-management" element=\{<BranchManagement \/>\} \/>/);
  });
  test("the audit-log screen can filter on the branch module", () => {
    expect(read("pages/ADMIN/AuditLogs.jsx")).toContain('"FILESETUP.BRANCHES"');
  });
});

describe("Branch Management page reflects the permissions", () => {
  test("uses the branch API only (never the user-assignment list)", () => {
    expect(page).toContain("/api/company-branches");
    expect(page).not.toMatch(/\/api\/branches\b/);
  });
  test("each control needs its own permission", () => {
    expect(page).toContain('const canView = permsLoading || can(MODULE_KEY, "VIEW");');
    expect(page).toMatch(/\{canCreate \? \(\s*<button className="fs-btn primary" onClick=\{openAdd\}/);
    expect(page).toMatch(/\{canEdit \? <button className="fs-btn" onClick=\{\(\) => openEdit\(b\)\}/);
    expect(page).toMatch(/canActivate \? <button className="fs-btn" onClick=\{\(\) => setStatus\(b, "ACTIVE"\)\}/);
    expect(page).toMatch(/canDeactivate \? <button className="fs-btn" onClick=\{\(\) => setStatus\(b, "INACTIVE"\)\}/);
    expect(page).toMatch(/\{hasActions \? <th>Actions<\/th> : null\}/);
    expect(page).toContain("You do not have permission to view Branches.");
  });
  test("no native dialogs: validation / failures are in-page (banner or field message)", () => {
    for (const src of [page, panel]) expect(src).not.toMatch(/\b(alert|confirm|prompt)\(/);
    expect(page).toContain('<span className="fs-field-error" role="alert">{fieldErrors.code}</span>');
    expect(page).toMatch(/className=\{notice\.tone === "error" \? "fs-banner-error" : "br-banner-success"\}/);
  });
  test("company is read-only after creation; no delete control", () => {
    expect(page).toContain("A branch's company cannot be changed.");
    expect(page).toMatch(/if \(!editing && form\.companyId\) body\.companyId = Number\(form\.companyId\);/);
    expect(page).not.toMatch(/method: "DELETE"|>\s*Delete\s*</);
  });
  test("status badge for every row; inactive rows identified; empty state", () => {
    expect(page).toMatch(/br-status br-status--\$\{b\.status === "INACTIVE" \? "inactive" : "active"\}/);
    expect(page).toContain('"No branches match your search."');
    expect(page).toContain('"No branches yet."');
  });
  test("badges and fields use theme tokens (readable in light and dark)", () => {
    const css = read("pages/FILESETUP/BranchManagement.css");
    expect(css).toMatch(/\.br-status--active \{\s*background: var\(--success-bg\);\s*color: var\(--success-text\);/);
    expect(css).toMatch(/\.br-status--inactive \{\s*background: var\(--neutral-bg\);\s*color: var\(--neutral-text\);/);
    expect(css).toMatch(/\.br-page \.fs-field input,\s*\.br-page \.fs-field select,\s*\.br-page \.fs-toolbar input \{\s*background: var\(--bg-surface\);\s*color: var\(--text-primary\);/);
  });
});

describe("Company Profile -> Branches section", () => {
  test("Company Profile shows the panel; the panel renders only with FILESETUP.BRANCHES / VIEW and is read-only", () => {
    const profile = read("pages/FILESETUP/CompanyProfile.jsx");
    expect(profile).toContain('import CompanyBranchesPanel from "./CompanyBranchesPanel";');
    expect(profile).toContain("<CompanyBranchesPanel />");
    expect(panel).toContain('const canView = !permsLoading && can("FILESETUP.BRANCHES", "VIEW");');
    expect(panel).toContain("if (!canView) return null;");
    expect(panel).toContain('<Link to="/branch-management" className="br-panel-link">Manage branches</Link>');
    expect(panel).not.toMatch(/method: "(POST|PUT|PATCH|DELETE)"/);
  });
});

describe("scope: master data only", () => {
  test("no transaction page references the branch-management API", () => {
    const dir = path.join(SRC, "pages/TRANSACTIONS");
    for (const f of fs.readdirSync(dir).filter((x) => /\.(jsx?|mjs)$/.test(x))) {
      expect([f, fs.readFileSync(path.join(dir, f), "utf8").includes("/api/company-branches")]).toEqual([f, false]);
    }
  });
});
