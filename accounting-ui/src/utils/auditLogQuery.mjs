// Pure helpers for the Audit Logs page (pages/ADMIN/AuditLogs.jsx).
// No React, no fetch - unit-tested in utils/__tests__/auditLogQuery.test.js.
// The backend (GET /api/audit-logs) is the security boundary: these helpers
// only shape requests and present what the server already scoped and
// sanitised.

export const SCOPE_ALL = "all";
export const SCOPE_SYSTEM = "system";
export const companyScope = (id) => `company:${id}`;

export const EMPTY_FILTERS = Object.freeze({
  scope: SCOPE_ALL,
  q: "",
  from: "",
  to: "",
  userId: "",
  module: "",
  action: "",
  entityType: "",
  entityId: "",
});

const TEXT_FILTERS = ["q", "from", "to", "userId", "module", "action", "entityType", "entityId"];

export function hasActiveFilters(filters) {
  return TEXT_FILTERS.some((k) => String(filters[k] ?? "").trim() !== "") || (filters.scope && filters.scope !== SCOPE_ALL);
}

// Builds the query string for list / export. Only non-empty filters are
// sent. Scope: "all" sends nothing (Super Admin: every company + system
// events; others: all of their own companies), "system" sends
// scope=system (Super Admin only - the option is never offered to anyone
// else), "company:<id>" sends companyId=<id> (only ids the server listed
// for this user are ever offered).
export function buildAuditQuery(filters = {}, { cursor = null, limit = null, isSuperAdmin = false } = {}) {
  const params = new URLSearchParams();
  const scope = filters.scope || SCOPE_ALL;
  if (scope === SCOPE_SYSTEM) {
    if (isSuperAdmin) params.set("scope", "system");
  } else if (scope.startsWith("company:")) {
    const id = scope.slice("company:".length);
    if (/^\d+$/.test(id)) params.set("companyId", id);
  }
  for (const key of TEXT_FILTERS) {
    const value = String(filters[key] ?? "").trim();
    if (value) params.set(key, value);
  }
  if (limit) params.set("limit", String(limit));
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

// X-Next-Cursor / X-Has-More / X-Page-Limit (exposed by the API).
export function readPageHeaders(headers) {
  const get = (name) => (typeof headers?.get === "function" ? headers.get(name) : headers?.[name.toLowerCase()]) || null;
  const nextCursor = get("X-Next-Cursor");
  const hasMore = get("X-Has-More") === "true" && Boolean(nextCursor);
  const limit = Number(get("X-Page-Limit")) || null;
  return { nextCursor: hasMore ? nextCursor : null, hasMore, limit };
}

// Appends a page without duplicating rows already shown.
export function appendPage(existing, incoming) {
  const seen = new Set(existing.map((r) => r.id));
  return [...existing, ...incoming.filter((r) => !seen.has(r.id))];
}

export const EMPTY_VALUE = "—";

export function formatTimestamp(value) {
  if (!value) return EMPTY_VALUE;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

export function describeEntity(entityType, entityId) {
  const hasType = entityType !== null && entityType !== undefined && String(entityType).trim() !== "";
  const hasId = entityId !== null && entityId !== undefined && String(entityId).trim() !== "";
  if (!hasType && !hasId) return EMPTY_VALUE;
  if (hasType && hasId) return `${humanizeKey(entityType)} #${entityId}`;
  return hasType ? humanizeKey(entityType) : `#${entityId}`;
}

// "ACCESS_UPDATED" -> "Access updated", "bypass_reason" -> "Bypass reason",
// "companyIds" -> "Company ids". Display only - values sent to the server
// are never re-cased.
export function humanizeKey(key) {
  const words = String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : String(key);
}

// Badge tone for an action name (visual only).
export function actionTone(action) {
  const a = String(action || "").toUpperCase();
  if (/DELETE|REMOVE|VOID|CANCEL|REVOKE|REJECT|DEACTIVATE|SUSPEND|DENIED|FAIL/.test(a)) return "danger";
  if (/LOGIN|LOGOUT|ACCESS|PERMISSION|ROLE|RESTRICTION|SESSION|UNLOCK|TEMPLATE_APPLIED|INVITE|INVITATION/.test(a)) return "security";
  if (/CREATE|ADD|POST|APPROVE|ACTIVATE|ACCEPT|GENERATE|IMPORT|COMMIT|FINALIZE/.test(a)) return "create";
  if (/EDIT|UPDATE|CHANGE|MATCH|REOPEN|CONFIG|SET_|REVERSE|APPLIED|EXPORT|EMAIL|PRINT/.test(a)) return "update";
  return "neutral";
}

export function formatScalar(value) {
  if (value === null || value === undefined) return EMPTY_VALUE;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return value.trim() === "" ? EMPTY_VALUE : value;
  if (typeof value === "number") return String(value);
  return String(value);
}

// Flattens before/after data into readable rows: [{ path, label, value }].
// Nested objects become "Parent › Child"; arrays of scalars are joined;
// arrays of objects are numbered. Depth and row count are capped so one
// huge payload cannot flood the drawer.
export function flattenForDisplay(data, { maxDepth = 4, maxRows = 200 } = {}) {
  const rows = [];
  let truncated = false;
  function push(path, labelParts, value) {
    if (rows.length >= maxRows) {
      truncated = true;
      return;
    }
    rows.push({ path, label: labelParts.join(" › ") || "Value", value: formatScalar(value) });
  }
  function walk(value, path, labelParts, depth) {
    if (rows.length >= maxRows) {
      truncated = true;
      return;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) return push(path, labelParts, null);
      if (value.every((v) => v === null || typeof v !== "object")) {
        return push(path, labelParts, value.map((v) => formatScalar(v)).join(", "));
      }
      value.forEach((item, i) => walk(item, `${path}[${i}]`, [...labelParts, `#${i + 1}`], depth + 1));
      return;
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length === 0) return push(path, labelParts, null);
      if (depth >= maxDepth) return push(path, labelParts, JSON.stringify(value));
      for (const [k, v] of entries) walk(v, path ? `${path}.${k}` : k, [...labelParts, humanizeKey(k)], depth + 1);
      return;
    }
    push(path, labelParts, value);
  }
  if (data === null || data === undefined) return { rows: [], truncated: false };
  if (typeof data !== "object") return { rows: [{ path: "", label: "Value", value: formatScalar(data) }], truncated: false };
  walk(data, "", [], 0);
  return { rows, truncated };
}

// Side-by-side change rows: [{ path, label, before, after, changed }].
// Unchanged fields are kept (listed after the changed ones) so the full
// before/after state stays visible.
export function buildChangeRows(beforeData, afterData, opts) {
  const before = flattenForDisplay(beforeData, opts);
  const after = flattenForDisplay(afterData, opts);
  const byPath = new Map();
  for (const r of before.rows) byPath.set(r.path, { path: r.path, label: r.label, before: r.value, after: EMPTY_VALUE });
  for (const r of after.rows) {
    const existing = byPath.get(r.path);
    if (existing) existing.after = r.value;
    else byPath.set(r.path, { path: r.path, label: r.label, before: EMPTY_VALUE, after: r.value });
  }
  const all = [...byPath.values()].map((r) => ({ ...r, changed: r.before !== r.after }));
  const changed = all.filter((r) => r.changed);
  const same = all.filter((r) => !r.changed);
  return { rows: [...changed, ...same], changedCount: changed.length, truncated: before.truncated || after.truncated };
}

// User-facing message for a failed request (never a server stack trace).
export function errorMessageFor(status, { detail = false, serverMessage = "" } = {}) {
  if (status === 401) return "Your session has expired. Please sign in again.";
  if (status === 403) return serverMessage && /company|system|super admin/i.test(serverMessage) ? serverMessage : "You do not have permission to view these audit logs.";
  if (status === 404) return detail ? "Audit log not found." : "Not found.";
  if (status === 400) return serverMessage || "Some filters are not valid. Please check them and try again.";
  if (!status) return "Unable to reach the server. Check your connection and try again.";
  return "Something went wrong while loading audit logs. Please try again.";
}

export function filenameFromDisposition(header, fallback = "audit-logs.csv") {
  const m = /filename="?([^";]+)"?/i.exec(header || "");
  return m ? m[1] : fallback;
}
