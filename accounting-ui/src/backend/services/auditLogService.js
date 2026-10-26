const pool = require("../db");
const { HttpError } = require("../lib/httpError");
const UserAccessService = require("./userAccessService");

// Audit Logs retrieval. List, detail and export all go through the same
// two steps - resolveScope() (who may see which companies) and
// buildWhere() (scope + filters as one parameterised WHERE clause) - so
// export and detail can never see more than the list does.
//
// Visibility model:
//   company_id = N    -> users assigned to company N (with ADMIN.AUDIT_LOGS
//                        VIEW, enforced on the route), and Super Admin
//   company_id NULL   -> "system" events (login, users, roles, invitations,
//                        ...): Super Admin only
// Super Admin with no company filter sees everything; it is never narrowed
// to an implicit first / lowest company.

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_EXPORT_ROWS = 5000;
const MAX_SEARCH_LENGTH = 100;

const SELECT_COLUMNS = `
  a.id,
  a.company_id AS companyId,
  c.name AS companyName,
  a.module,
  a.entity_type AS entityType,
  a.entity_id AS entityId,
  a.action,
  a.description,
  a.before_data AS beforeData,
  a.after_data AS afterData,
  a.user_id AS userId,
  a.username,
  a.created_at AS createdAt,
  DATE_FORMAT(a.created_at, '%Y-%m-%d %H:%i:%s') AS cursorTs`;

const DETAIL_EXTRA_COLUMNS = `,
  a.ip_address AS ipAddress,
  a.user_agent AS userAgent`;

const FROM = "FROM audit_logs a LEFT JOIN companies c ON c.id = a.company_id";
const ORDER = "ORDER BY a.created_at DESC, a.id DESC";

// ---------------------------------------------------------------------------
// Sensitive-data sanitisation (API boundary only - stored rows are untouched)

// Keys are compared lower-cased with separators removed, so password /
// password_hash / passwordHash / smtp_pass / api-key all match; "bypass"
// does not (only an exact "pass" key is treated as a password).
const SENSITIVE_KEY_PARTS = ["password", "passwd", "token", "secret", "apikey", "jwt", "smtppass", "encryptionkey", "privatekey", "credential", "authorization", "cookie"];
const SENSITIVE_KEY_EXACT = new Set(["pass", "pwd", "otp", "totp"]);
function isSensitiveKey(key) {
  const k = String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
  return SENSITIVE_KEY_EXACT.has(k) || SENSITIVE_KEY_PARTS.some((part) => k.includes(part));
}
const INVITE_URL = /(accept-invite\?token=)[^\s"'&]+/gi;
const JWT_LIKE = /\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}\b/g;
const BEARER = /(bearer\s+)[\w.~+/-]{12,}=*/gi;
const REDACTED = "[REDACTED]";

function sanitizeString(value) {
  return value
    .replace(INVITE_URL, `$1${REDACTED}`)
    .replace(JWT_LIKE, REDACTED)
    .replace(BEARER, `$1${REDACTED}`);
}

function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 20) return REDACTED;
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  if (typeof value === "object" && !(value instanceof Date)) {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? REDACTED : sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

function parseJsonColumn(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function presentRow(row, { detail = false } = {}) {
  const out = {
    id: row.id,
    companyId: row.companyId,
    companyName: row.companyName || null,
    scope: row.companyId ? "COMPANY" : "SYSTEM",
    module: row.module,
    entityType: row.entityType,
    entityId: row.entityId,
    action: row.action,
    description: sanitize(row.description),
    beforeData: sanitize(parseJsonColumn(row.beforeData)),
    afterData: sanitize(parseJsonColumn(row.afterData)),
    userId: row.userId,
    username: row.username,
    createdAt: row.createdAt,
  };
  if (detail) {
    out.ipAddress = row.ipAddress || null;
    out.userAgent = row.userAgent || null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scope

function toPositiveInt(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || String(value).trim() !== String(n)) {
    throw new HttpError(400, `${label} must be a positive whole number.`);
  }
  return n;
}

// Returns { companyIds: null | number[], includeSystem, systemOnly }.
async function resolveScope(user, query = {}) {
  const isSuper = user?.roleCode === "SUPER_ADMIN";
  const scope = query.scope ? String(query.scope).toLowerCase() : "";
  if (scope && !["all", "system", "company"].includes(scope)) {
    throw new HttpError(400, "scope must be all, company or system.");
  }
  const requestedCompany =
    query.companyId !== undefined && query.companyId !== "" ? toPositiveInt(query.companyId, "companyId") : null;

  if (isSuper) {
    if (scope === "system") {
      if (requestedCompany) throw new HttpError(400, "System events have no company - remove companyId.");
      return { companyIds: [], includeSystem: true, systemOnly: true };
    }
    if (requestedCompany) return { companyIds: [requestedCompany], includeSystem: false, systemOnly: false };
    if (scope === "company") return { companyIds: null, includeSystem: false, systemOnly: false };
    return { companyIds: null, includeSystem: true, systemOnly: false };
  }

  if (scope === "system") {
    throw new HttpError(403, "System audit events are only available to the Super Admin.");
  }
  const accessible = await UserAccessService.getAccessibleCompanyIds(user.id);
  if (accessible.length === 0) throw new HttpError(403, "You are not assigned to any company.");
  if (requestedCompany) {
    if (!accessible.includes(requestedCompany)) throw new HttpError(403, "You do not have access to this company");
    return { companyIds: [requestedCompany], includeSystem: false, systemOnly: false };
  }
  return { companyIds: accessible, includeSystem: false, systemOnly: false };
}

function scopeClause(scope) {
  if (scope.systemOnly) return { sql: "a.company_id IS NULL", params: [] };
  if (scope.companyIds === null) {
    return scope.includeSystem ? { sql: "1 = 1", params: [] } : { sql: "a.company_id IS NOT NULL", params: [] };
  }
  if (scope.companyIds.length === 0) return { sql: "1 = 0", params: [] };
  return { sql: "a.company_id IN (?)", params: [scope.companyIds] };
}

// ---------------------------------------------------------------------------
// Filters (all optional; every one is applied on top of the scope clause)

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/;

function parseDateBound(value, label, isEnd) {
  const v = String(value).trim();
  if (DATE_RE.test(v)) {
    if (Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new HttpError(400, `${label} is not a valid date.`);
    // date-only "to" includes the whole day
    return isEnd ? { op: "<", value: nextDay(v) } : { op: ">=", value: `${v} 00:00:00` };
  }
  if (DATETIME_RE.test(v)) {
    const normalized = v.replace("T", " ").padEnd(19, ":00").slice(0, 19);
    if (Number.isNaN(Date.parse(normalized.replace(" ", "T") + "Z"))) throw new HttpError(400, `${label} is not a valid date.`);
    return { op: isEnd ? "<=" : ">=", value: normalized };
  }
  throw new HttpError(400, `${label} must be a date (YYYY-MM-DD) or date-time (YYYY-MM-DD HH:MM[:SS]).`);
}

function nextDay(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return `${d.toISOString().slice(0, 10)} 00:00:00`;
}

function shortText(value, label, max = 60) {
  const v = String(value).trim();
  if (!v || v.length > max) throw new HttpError(400, `${label} is not valid.`);
  return v;
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function parseFilters(query = {}) {
  const f = {};
  if (query.userId !== undefined && query.userId !== "") f.userId = toPositiveInt(query.userId, "userId");
  if (query.entityId !== undefined && query.entityId !== "") f.entityId = toPositiveInt(query.entityId, "entityId");
  if (query.module) f.module = shortText(query.module, "module", 30);
  if (query.action) f.action = shortText(query.action, "action", 40);
  if (query.entityType) f.entityType = shortText(query.entityType, "entityType", 40);
  if (query.from) f.from = parseDateBound(query.from, "from", false);
  if (query.to) f.to = parseDateBound(query.to, "to", true);
  if (query.q !== undefined && query.q !== "") {
    const q = String(query.q).trim();
    if (q.length > MAX_SEARCH_LENGTH) throw new HttpError(400, `Search text is limited to ${MAX_SEARCH_LENGTH} characters.`);
    if (q) f.q = q;
  }
  return f;
}

function buildWhere(scope, filters) {
  const s = scopeClause(scope);
  const clauses = [s.sql];
  const params = [...s.params];
  const eq = (col, val) => {
    clauses.push(`${col} = ?`);
    params.push(val);
  };
  if (filters.userId) eq("a.user_id", filters.userId);
  if (filters.entityId) eq("a.entity_id", filters.entityId);
  if (filters.module) eq("a.module", filters.module);
  if (filters.action) eq("a.action", filters.action);
  if (filters.entityType) eq("a.entity_type", filters.entityType);
  if (filters.from) {
    clauses.push(`a.created_at ${filters.from.op} ?`);
    params.push(filters.from.value);
  }
  if (filters.to) {
    clauses.push(`a.created_at ${filters.to.op} ?`);
    params.push(filters.to.value);
  }
  if (filters.q) {
    // Searches only the human-readable columns - never before/after JSON.
    const like = `%${escapeLike(filters.q)}%`;
    clauses.push("(a.description LIKE ? OR a.username LIKE ? OR a.action LIKE ? OR a.module LIKE ? OR a.entity_type LIKE ?)");
    params.push(like, like, like, like, like);
  }
  return { sql: clauses.join(" AND "), params };
}

// ---------------------------------------------------------------------------
// Keyset pagination on (created_at DESC, id DESC)

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ t: row.cursorTs, id: row.id })).toString("base64url");
}

function decodeCursor(value) {
  try {
    const { t, id } = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (typeof t !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t) || !Number.isInteger(id) || id <= 0) throw new Error("bad");
    return { t, id };
  } catch {
    throw new HttpError(400, "Invalid cursor.");
  }
}

function parseLimit(value) {
  if (value === undefined || value === "") return DEFAULT_PAGE_SIZE;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "limit must be a whole number of at least 1.");
  return Math.min(n, MAX_PAGE_SIZE);
}

// ---------------------------------------------------------------------------
// Public API

async function listAuditLogs(user, query = {}) {
  const scope = await resolveScope(user, query);
  const filters = parseFilters(query);
  const limit = parseLimit(query.limit);
  const where = buildWhere(scope, filters);
  const params = [...where.params];
  let sql = where.sql;
  if (query.cursor) {
    const c = decodeCursor(query.cursor);
    sql += " AND (a.created_at < ? OR (a.created_at = ? AND a.id < ?))";
    params.push(c.t, c.t, c.id);
  }
  const [rows] = await pool.query(`SELECT ${SELECT_COLUMNS} ${FROM} WHERE ${sql} ${ORDER} LIMIT ?`, [...params, limit + 1]);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: page.map((r) => presentRow(r)),
    hasMore,
    nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
    limit,
  };
}

// Same scope as the list (any company the caller may see; Super Admin also
// system events). Unknown and out-of-scope ids are the same 404.
async function getAuditLog(user, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, "Audit log not found");
  const scope = await resolveScope(user, {});
  const where = buildWhere(scope, {});
  const [rows] = await pool.query(
    `SELECT ${SELECT_COLUMNS}${DETAIL_EXTRA_COLUMNS} ${FROM} WHERE a.id = ? AND ${where.sql} LIMIT 1`,
    [n, ...where.params]
  );
  if (!rows[0]) throw new HttpError(404, "Audit log not found");
  return presentRow(rows[0], { detail: true });
}

async function exportAuditLogs(user, query = {}) {
  const scope = await resolveScope(user, query);
  const filters = parseFilters(query);
  const where = buildWhere(scope, filters);
  const [rows] = await pool.query(
    `SELECT ${SELECT_COLUMNS} ${FROM} WHERE ${where.sql} ${ORDER} LIMIT ?`,
    [...where.params, MAX_EXPORT_ROWS + 1]
  );
  const truncated = rows.length > MAX_EXPORT_ROWS;
  return {
    items: (truncated ? rows.slice(0, MAX_EXPORT_ROWS) : rows).map((r) => presentRow(r)),
    truncated,
    scope,
    filters,
  };
}

const CSV_COLUMNS = ["id", "createdAt", "scope", "companyId", "companyName", "userId", "username", "module", "action", "entityType", "entityId", "description", "beforeData", "afterData"];

function csvCell(value) {
  if (value === null || value === undefined) return "";
  let s = value instanceof Date ? value.toISOString() : typeof value === "object" ? JSON.stringify(value) : String(value);
  // Spreadsheet formula injection guard
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(items) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const item of items) lines.push(CSV_COLUMNS.map((k) => csvCell(item[k])).join(","));
  return lines.join("\r\n") + "\r\n";
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_EXPORT_ROWS,
  listAuditLogs,
  getAuditLog,
  exportAuditLogs,
  toCsv,
  sanitize,
};
