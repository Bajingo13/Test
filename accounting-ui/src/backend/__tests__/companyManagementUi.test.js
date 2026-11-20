const fs = require("fs");
const path = require("path");

// Company Management + branch-assignment UI (source guards; node-only jest - the
// screens are verified in a real browser separately).

const SRC = path.join(__dirname, "../..");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8").replace(/\r\n/g, "\n");
const page = read("pages/ADMIN/CompanyManagement.jsx");

describe("Company Management navigation is Super Admin only", () => {
  test("route, Administration menu item, gated by FILESETUP.COMPANIES / CREATE (granted to no role)", () => {
    expect(read("App.jsx")).toMatch(/<Route path="\/company-management" element=\{<CompanyManagement \/>\} \/>/);
    expect(read("components/sidebar/administrationMenuConfig.js")).toContain('{ id: "company-management", label: "Company Management", icon: Building2, path: "/company-management" }');
    expect(read("components/sidebar/pathPermissionMap.js")).toMatch(/"\/company-management": \["FILESETUP\.COMPANIES", "CREATE"\]/);
  });
});

describe("Company Management page", () => {
  test("reflects the permission; uses the company-management API only", () => {
    expect(page).toContain('const canCreate = can("FILESETUP.COMPANIES", "CREATE");');
    expect(page).toContain("You do not have permission to manage companies.");
    expect(page).toContain("/api/company-management");
  });
  test("no native dialogs; in-page validation and messages; no delete", () => {
    expect(page).not.toMatch(/\b(alert|confirm|prompt)\(/);
    expect(page).toMatch(/<span className="fs-field-error" role="alert">\{fieldErrors\[f\]\}<\/span>/);
    expect(page).not.toMatch(/method: "DELETE"|>\s*Delete\s*</);
  });
  test("each company opens its own Company Profile", () => {
    expect(page).toMatch(/to=\{`\/company-profile\?companyId=\$\{c\.id\}`\}/);
    const profile = read("pages/FILESETUP/CompanyProfile.jsx");
    expect(profile).toContain('new URLSearchParams(window.location.search).get("companyId")');
    expect(profile).toMatch(/fetch\(`\$\{API_BASE\}\/api\/company-profile\$\{companyQuery\}`/);
    expect(profile).toMatch(/JSON\.stringify\(companyId \? \{ \.\.\.form, companyId: Number\(companyId\) \} : form\)/);
  });
});

describe("user-access pickers follow the server's branch rule", () => {
  for (const file of ["components/UserAccessDrawer.jsx", "components/InviteUserModal.jsx"]) {
    test(`${file}: only the selected companies' branches are offered; unticking a company drops its branches`, () => {
      const src = read(file);
      expect(src).toContain("const selectableBranches = branches.filter((b) => form.companyIds.includes(Number(b.company_id)));");
      expect(src).toMatch(/branchIds: removing \? prev\.branchIds\.filter\(\(b\) => branchCompany\.get\(b\) !== id\) : prev\.branchIds/);
      expect(src).toContain("{selectableBranches.map((b) => (");
      expect(src).toContain('" · inactive"');
    });
  }
});
