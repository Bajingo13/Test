// Audit Logs frontend: pure helpers (auditLogQuery.mjs, real ESM loaded via
// dynamic import like the other utils tests) plus source checks for the
// page wiring (route, menu, permission map, export, paging, console use).
const fs = require("fs");
const path = require("path");

let q;
beforeAll(async () => {
  q = await import("../auditLogQuery.mjs");
});

const SRC = path.join(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), "utf8");
const params = (s) => Object.fromEntries(new URLSearchParams(s));

describe("filter / scope construction", () => {
  test("empty filters send nothing", () => {
    expect(q.buildAuditQuery(q.EMPTY_FILTERS, { isSuperAdmin: true })).toBe("");
    expect(q.buildAuditQuery({ ...q.EMPTY_FILTERS, q: "   " })).toBe("");
  });

  test("text, date and id filters map to the exact API parameter names, trimmed", () => {
    const s = q.buildAuditQuery({
      ...q.EMPTY_FILTERS,
      q: " needle ",
      from: "2026-01-01",
      to: "2026-01-31",
      userId: "7",
      module: "USERS",
      action: "ACCESS_UPDATED",
      entityType: "USER",
      entityId: "42",
    });
    expect(params(s)).toEqual({ q: "needle", from: "2026-01-01", to: "2026-01-31", userId: "7", module: "USERS", action: "ACCESS_UPDATED", entityType: "USER", entityId: "42" });
  });

  test("Super Admin scope: All -> nothing, System -> scope=system, company -> companyId", () => {
    expect(params(q.buildAuditQuery({ ...q.EMPTY_FILTERS, scope: q.SCOPE_ALL }, { isSuperAdmin: true }))).toEqual({});
    expect(params(q.buildAuditQuery({ ...q.EMPTY_FILTERS, scope: q.SCOPE_SYSTEM }, { isSuperAdmin: true }))).toEqual({ scope: "system" });
    expect(params(q.buildAuditQuery({ ...q.EMPTY_FILTERS, scope: q.companyScope(12) }, { isSuperAdmin: true }))).toEqual({ companyId: "12" });
  });

  test("non-Super-Admins never send scope=system; malformed company scopes are dropped", () => {
    expect(params(q.buildAuditQuery({ ...q.EMPTY_FILTERS, scope: q.SCOPE_SYSTEM }, { isSuperAdmin: false }))).toEqual({});
    expect(params(q.buildAuditQuery({ ...q.EMPTY_FILTERS, scope: "company:1 OR 1=1" }))).toEqual({});
    expect(params(q.buildAuditQuery({ ...q.EMPTY_FILTERS, scope: q.companyScope(3) }))).toEqual({ companyId: "3" });
  });

  test("cursor and limit are appended for paging; export uses the same filter string", () => {
    const f = { ...q.EMPTY_FILTERS, module: "JV" };
    const page2 = params(q.buildAuditQuery(f, { cursor: "abc", limit: 50 }));
    expect(page2).toEqual({ module: "JV", cursor: "abc", limit: "50" });
    expect(params(q.buildAuditQuery(f))).toEqual({ module: "JV" });
  });

  test("hasActiveFilters", () => {
    expect(q.hasActiveFilters(q.EMPTY_FILTERS)).toBe(false);
    expect(q.hasActiveFilters({ ...q.EMPTY_FILTERS, action: "X" })).toBe(true);
    expect(q.hasActiveFilters({ ...q.EMPTY_FILTERS, scope: q.SCOPE_SYSTEM })).toBe(true);
  });
});

describe("keyset pagination headers", () => {
  const headers = (h) => ({ get: (k) => h[k] ?? null });

  test("reads cursor / has-more / limit from the response headers", () => {
    expect(q.readPageHeaders(headers({ "X-Next-Cursor": "c1", "X-Has-More": "true", "X-Page-Limit": "50" }))).toEqual({ nextCursor: "c1", hasMore: true, limit: 50 });
  });

  test("no more pages when X-Has-More is false or the cursor is missing", () => {
    expect(q.readPageHeaders(headers({ "X-Has-More": "false", "X-Page-Limit": "50" }))).toEqual({ nextCursor: null, hasMore: false, limit: 50 });
    expect(q.readPageHeaders(headers({ "X-Has-More": "true" })).hasMore).toBe(false);
  });

  test("appending a page keeps order and skips rows already shown", () => {
    expect(q.appendPage([{ id: 3 }, { id: 2 }], [{ id: 2 }, { id: 1 }]).map((r) => r.id)).toEqual([3, 2, 1]);
  });
});

describe("display helpers", () => {
  test("entity, timestamps and empty values", () => {
    expect(q.describeEntity("BANK_RECON_SESSION", 9)).toBe("Bank recon session #9");
    expect(q.describeEntity(null, null)).toBe("—");
    expect(q.describeEntity("", 4)).toBe("#4");
    expect(q.formatTimestamp(null)).toBe("—");
    expect(q.formatScalar("")).toBe("—");
    expect(q.formatScalar(false)).toBe("No");
  });

  test("action tones are visual only (the action text is never changed)", () => {
    expect(q.actionTone("DELETE")).toBe("danger");
    expect(q.actionTone("ACCESS_UPDATED")).toBe("security");
    expect(q.actionTone("CREATE")).toBe("create");
    expect(q.actionTone("EXPORT")).toBe("update");
    expect(q.actionTone("SOMETHING_ELSE")).toBe("neutral");
  });

  test("before/after become readable field rows, changed fields first", () => {
    const { rows, changedCount } = q.buildChangeRows(
      { status: "PENDING", roleCode: "ACCOUNTANT", companyIds: [1, 2], meta: { note: "same" } },
      { status: "APPROVED", roleCode: "ADMIN", companyIds: [1, 2], meta: { note: "same" }, added: true }
    );
    expect(changedCount).toBe(3);
    expect(rows.slice(0, 3).map((r) => r.label)).toEqual(["Status", "Role code", "Added"]);
    expect(rows.find((r) => r.label === "Status")).toMatchObject({ before: "PENDING", after: "APPROVED", changed: true });
    expect(rows.find((r) => r.label === "Added")).toMatchObject({ before: "—", after: "Yes" });
    expect(rows.find((r) => r.label === "Company ids")).toMatchObject({ before: "1, 2", after: "1, 2", changed: false });
    expect(rows.find((r) => r.label === "Meta › Note")).toMatchObject({ changed: false });
  });

  test("arrays of objects are numbered, nesting and row count are capped", () => {
    const { rows } = q.flattenForDisplay({ permissions: [{ permission: "A.VIEW", granted: true }, { permission: "B.EDIT", granted: false }] });
    expect(rows.map((r) => r.label)).toEqual(["Permissions › #1 › Permission", "Permissions › #1 › Granted", "Permissions › #2 › Permission", "Permissions › #2 › Granted"]);
    const big = q.flattenForDisplay(Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i])), { maxRows: 50 });
    expect(big.rows).toHaveLength(50);
    expect(big.truncated).toBe(true);
    expect(q.flattenForDisplay(null).rows).toEqual([]);
  });

  test("error messages per status; no server internals", () => {
    expect(q.errorMessageFor(404, { detail: true })).toBe("Audit log not found.");
    expect(q.errorMessageFor(403)).toMatch(/permission/);
    expect(q.errorMessageFor(403, { serverMessage: "You do not have access to this company" })).toBe("You do not have access to this company");
    expect(q.errorMessageFor(400, { serverMessage: "from is not a valid date." })).toBe("from is not a valid date.");
    expect(q.errorMessageFor(500, { serverMessage: "ER_BAD_FIELD at /srv/app.js:12" })).not.toMatch(/ER_BAD|app\.js/);
    expect(q.errorMessageFor(0)).toMatch(/Unable to reach the server/);
    expect(q.filenameFromDisposition('attachment; filename="audit-logs-2026-10-26.csv"')).toBe("audit-logs-2026-10-26.csv");
  });
});

describe("page wiring (source checks)", () => {
  const page = read("pages", "ADMIN", "AuditLogs.jsx");

  test("route, Administration menu entry and permission mapping exist", () => {
    expect(read("App.jsx")).toMatch(/<Route path="\/admin\/audit-logs" element=\{<AuditLogs \/>\} \/>/);
    expect(read("components", "sidebar", "administrationMenuConfig.js")).toMatch(/id: "audit-logs", label: "Audit Logs", icon: ScrollText, path: "\/admin\/audit-logs"/);
    expect(read("components", "sidebar", "pathPermissionMap.js")).toMatch(/"\/admin\/audit-logs": \["ADMIN\.AUDIT_LOGS", "VIEW"\]/);
  });

  test("the page checks ADMIN.AUDIT_LOGS and offers System Events only to Super Admin", () => {
    expect(page).toMatch(/granted\("ADMIN\.AUDIT_LOGS", "VIEW"\)/);
    expect(page).toMatch(/\{access\.isSuperAdmin && <option value=\{SCOPE_SYSTEM\}>System Events<\/option>\}/);
    expect(page).toMatch(/fetch\(`\$\{API_URL\}\/api\/companies`/);
  });

  test("paging uses the server cursor; export calls the secured endpoint with the current filters", () => {
    expect(page).toMatch(/readPageHeaders\(res\.headers\)/);
    expect(page).toMatch(/cursor, limit: PAGE_SIZE/);
    expect(page).toMatch(/\/api\/audit-logs\/export\?\$\{queryString\}/);
    expect(page).not.toMatch(/toCsv|text\/csv|new Blob\(\[/);
  });

  test("stale responses are dropped and the detail view is cached per id", () => {
    expect(page).toMatch(/seq !== requestSeq\.current/);
    expect(page).toMatch(/detailCache\.current\.has\(id\)/);
  });

  test("loading, empty, error and retry states are distinct", () => {
    expect(page).toMatch(/Loading audit records\.\.\./);
    expect(page).toMatch(/listState\.status === "ready" && rows\.length === 0/);
    expect(page).toMatch(/No audit records found\./);
    expect(page).toMatch(/Try adjusting your filters\./);
    expect(page).toMatch(/listState\.retryable && <button/);
    expect(page).toMatch(/You do not have permission to view audit logs\./);
  });

  test("audit data is never written to the console", () => {
    const calls = page.match(/console\.\w+\([^;]*\);/g) || [];
    for (const c of calls) {
      expect(c).toMatch(/^console\.error\("[A-Z ]+ERROR:", err\?\.message \|\| "network error"\);$/);
    }
    expect(page).not.toMatch(/console\.log/);
  });
});
