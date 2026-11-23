const fs = require("fs");
const path = require("path");

// Pending Invitations responsive layout (source guards; node-only jest, no
// jsdom - the six widths and both themes are verified in a real browser).
// The App layout's <main> is a flex item with min-width: auto, so without
// containment the invitations table's min-content width (~888px) widened the
// whole page on narrow screens (122 / 378 / 716px at 1024 / 768 / 390).
// The wrapper now contains its inline size, exactly like UserList.css.

const ADMIN = path.join(__dirname, "../../pages/ADMIN");
const css = fs.readFileSync(path.join(ADMIN, "PendingInvitations.css"), "utf8");
const jsx = fs.readFileSync(path.join(ADMIN, "PendingInvitations.jsx"), "utf8");
const rule = (sel) => {
  const m = css.replace(/\/\*[\s\S]*?\*\//g, "").match(new RegExp(`(^|\\n)\\${sel}\\s*\\{([^}]*)\\}`));
  return m ? m[2] : null;
};

describe("Pending Invitations: the table scrolls inside its wrapper, never the page", () => {
  test("the table wrapper scrolls horizontally and contains its inline size", () => {
    const wrap = rule(".pi-table-wrap");
    expect(wrap).not.toBeNull();
    expect(wrap).toMatch(/overflow-x:\s*auto;/);
    expect(wrap).toMatch(/max-width:\s*100%;/);
    expect(wrap).toMatch(/contain:\s*inline-size;/);
  });
  test("the table itself keeps its natural width (columns are not squeezed)", () => {
    const table = rule(".pi-table");
    expect(table).toMatch(/width:\s*100%;/);
    expect(table).not.toMatch(/table-layout:\s*fixed/);
    expect(table).not.toMatch(/max-width/);
  });
  test("the header wraps and narrow screens get tighter gutters (fits next to the 110px sidebar at 390px)", () => {
    expect(rule(".pi-header")).toMatch(/flex-wrap:\s*wrap;/);
    const narrow = (css.match(/@media \(max-width: 600px\) \{([\s\S]*?)\n\}/) || [])[1] || "";
    expect(narrow).toMatch(/\.pi-page \{\s*padding: 16px;/);
    expect(narrow).toMatch(/\.pi-header h1 \{\s*font-size: 22px;/);
    expect(narrow).toMatch(/\.pi-card \{\s*padding: 14px;/);
  });
  test("the table is rendered inside the scrolling wrapper", () => {
    expect(jsx).toMatch(/<div className="pi-table-wrap">\s*<table className="pi-table">/);
  });
  test("the shared App layout is not changed by this fix (no global min-width rule needed)", () => {
    const app = fs.readFileSync(path.join(__dirname, "../../App.jsx"), "utf8");
    expect(app).toMatch(/<main\s+style=\{\{[\s\S]*?flex: 1,/);
  });
});
