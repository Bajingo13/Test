// Company Branch Management - master data only (ONE company -> MANY branches).
// Reuses the existing `branches` table. Not used by any transaction, report or
// numbering path yet (that integration is a separate, later task).
//
// Company isolation is enforced HERE, server-side, on every call:
//   - reads/writes are limited to the caller's companies (user_companies) via
//     the shared CurrencyService.resolveCompanyIdForRead/Write helpers;
//     SUPER_ADMIN bypasses, exactly like every other company-scoped module;
//   - a branch of another company is answered exactly like an unknown id (404),
//     so its existence is never revealed;
//   - a branch's company is fixed at creation.
const pool = require("../db");
const { HttpError } = require("../lib/httpError");
const { logAudit } = require("../lib/audit");
const UserAccessService = require("./userAccessService");
const CurrencyService = require("./currencyService");

const MODULE = "FILESETUP.BRANCHES";
const STATUSES = ["ACTIVE", "INACTIVE"];
const CODE_RE = /^[A-Z0-9][A-Z0-9_-]*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LIMITS = { code: 50, name: 255, address: 255, telephone: 50, email: 255 };
const NOT_FOUND = () => new HttpError(404, "Branch not found.", "BRANCH_NOT_FOUND");

const SELECT_SQL = `
  SELECT b.id, b.company_id AS companyId, c.name AS companyName, UPPER(c.status) AS companyStatus,
         b.code, b.name, b.address, b.telephone, b.email, b.status,
         b.created_at AS createdAt, b.updated_at AS updatedAt
  FROM branches b
  JOIN companies c ON c.id = b.company_id`;

const text = (v) => (v === undefined || v === null ? "" : String(v).trim());
const optional = (v) => (text(v) === "" ? null : text(v));

// Validates and normalises the editable fields. Every message is a 400 with a code.
function validateFields(body) {
  const code = text(body?.code).toUpperCase();
  const name = text(body?.name);
  if (!code) throw new HttpError(400, "Branch Code is required.", "BRANCH_CODE_REQUIRED");
  if (code.length > LIMITS.code) throw new HttpError(400, `Branch Code must be at most ${LIMITS.code} characters.`, "BRANCH_CODE_TOO_LONG");
  if (!CODE_RE.test(code)) throw new HttpError(400, "Branch Code may contain only letters, numbers, hyphens and underscores, and must start with a letter or number.", "BRANCH_CODE_INVALID");
  if (!name) throw new HttpError(400, "Branch Name is required.", "BRANCH_NAME_REQUIRED");
  if (name.length > LIMITS.name) throw new HttpError(400, `Branch Name must be at most ${LIMITS.name} characters.`, "BRANCH_NAME_TOO_LONG");
  const out = { code, name, address: optional(body?.address), telephone: optional(body?.telephone), email: optional(body?.email) };
  for (const f of ["address", "telephone", "email"]) {
    if (out[f] && out[f].length > LIMITS[f]) throw new HttpError(400, `${f[0].toUpperCase()}${f.slice(1)} must be at most ${LIMITS[f]} characters.`, `BRANCH_${f.toUpperCase()}_TOO_LONG`);
  }
  if (out.email && !EMAIL_RE.test(out.email)) throw new HttpError(400, "Email is not a valid email address.", "BRANCH_EMAIL_INVALID");
  return out;
}

function parseId(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw NOT_FOUND();
  return n;
}

// The branch, if (and only if) the user may see it; otherwise 404.
async function loadAccessible(db, user, id, { forUpdate = false } = {}) {
  const [rows] = await db.execute(`${SELECT_SQL} WHERE b.id = ?${forUpdate ? " FOR UPDATE" : ""}`, [parseId(id)]);
  const branch = rows[0];
  if (!branch) throw NOT_FOUND();
  if (user.roleCode !== "SUPER_ADMIN" && !(await UserAccessService.userHasCompanyAccess(user.id, branch.companyId))) throw NOT_FOUND();
  return branch;
}

async function assertCompanyUsable(db, companyId) {
  const [rows] = await db.execute("SELECT id, UPPER(status) AS status FROM companies WHERE id = ?", [companyId]);
  if (!rows.length) throw new HttpError(400, "Company does not exist.", "COMPANY_NOT_FOUND");
  if (rows[0].status !== "ACTIVE") throw new HttpError(400, "Branches cannot be added to or changed in an inactive company.", "COMPANY_INACTIVE");
}

function duplicate(err) {
  if (err && err.code === "ER_DUP_ENTRY") return new HttpError(400, "This Branch Code already exists in this company.", "BRANCH_CODE_DUPLICATE");
  return err;
}

const auditShape = (b) => b && { companyId: b.companyId, code: b.code, name: b.name, address: b.address, telephone: b.telephone, email: b.email, status: b.status };

async function listBranches(user, { companyId, status, search } = {}) {
  const scope = await CurrencyService.resolveCompanyIdForRead(user, companyId);
  const where = [];
  const params = [];
  if (Array.isArray(scope)) {
    if (!scope.length) return [];
    where.push(`b.company_id IN (${scope.map(() => "?").join(",")})`);
    params.push(...scope);
  } else if (scope !== null) {
    where.push("b.company_id = ?");
    params.push(scope);
  }
  const st = text(status).toUpperCase();
  if (st && st !== "ALL") {
    if (!STATUSES.includes(st)) throw new HttpError(400, "status must be ACTIVE, INACTIVE or ALL.", "BRANCH_STATUS_INVALID");
    where.push("b.status = ?");
    params.push(st);
  }
  const q = text(search);
  if (q) {
    where.push("(b.code LIKE ? OR b.name LIKE ? OR b.address LIKE ?)");
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    params.push(like, like, like);
  }
  const [rows] = await pool.execute(`${SELECT_SQL}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY c.name, b.code, b.id`, params);
  return rows;
}

async function getBranch(user, id) {
  return loadAccessible(pool, user, id);
}

async function createBranch(user, body) {
  const fields = validateFields(body);
  const requested = body?.companyId;
  if (requested !== undefined && requested !== null && requested !== "" && !(Number.isInteger(Number(requested)) && Number(requested) > 0)) {
    throw new HttpError(400, "Company is invalid.", "BRANCH_COMPANY_INVALID");
  }
  const companyId = await CurrencyService.resolveCompanyIdForWrite(user, requested === "" ? null : requested);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await assertCompanyUsable(conn, companyId);
    const [r] = await conn.execute(
      "INSERT INTO branches (company_id, code, name, address, telephone, email, status) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')",
      [companyId, fields.code, fields.name, fields.address, fields.telephone, fields.email]
    );
    const created = await loadAccessible(conn, user, r.insertId);
    await logAudit(conn, {
      module: MODULE, entityType: "BRANCH", entityId: created.id, action: "CREATE",
      description: `Branch ${created.code} (${created.name}) created`, afterData: auditShape(created), user, companyId,
    });
    await conn.commit();
    return created;
  } catch (err) {
    await conn.rollback();
    throw duplicate(err);
  } finally {
    conn.release();
  }
}

async function updateBranch(user, id, body) {
  const fields = validateFields(body);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const before = await loadAccessible(conn, user, id, { forUpdate: true });
    if (body?.companyId !== undefined && body.companyId !== null && body.companyId !== "" && Number(body.companyId) !== Number(before.companyId)) {
      throw new HttpError(400, "A branch's company cannot be changed.", "BRANCH_COMPANY_READONLY");
    }
    if (body?.status !== undefined && text(body.status).toUpperCase() !== before.status) {
      throw new HttpError(400, "Use Activate / Deactivate to change a branch's status.", "BRANCH_STATUS_READONLY");
    }
    await assertCompanyUsable(conn, before.companyId);
    await conn.execute(
      "UPDATE branches SET code = ?, name = ?, address = ?, telephone = ?, email = ? WHERE id = ?",
      [fields.code, fields.name, fields.address, fields.telephone, fields.email, before.id]
    );
    const after = await loadAccessible(conn, user, before.id);
    await logAudit(conn, {
      module: MODULE, entityType: "BRANCH", entityId: after.id, action: "EDIT",
      description: `Branch ${after.code} (${after.name}) edited`, beforeData: auditShape(before), afterData: auditShape(after), user, companyId: after.companyId,
    });
    await conn.commit();
    return after;
  } catch (err) {
    await conn.rollback();
    throw duplicate(err);
  } finally {
    conn.release();
  }
}

// status: ACTIVE (permission ACTIVATE) or INACTIVE (permission DEACTIVATE) -
// the controller checks the matching permission before calling this.
async function setBranchStatus(user, id, status) {
  const target = text(status).toUpperCase();
  if (!STATUSES.includes(target)) throw new HttpError(400, "status must be ACTIVE or INACTIVE.", "BRANCH_STATUS_INVALID");
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const before = await loadAccessible(conn, user, id, { forUpdate: true });
    if (target === "ACTIVE") await assertCompanyUsable(conn, before.companyId); // deactivating is always allowed
    if (before.status === target) {
      await conn.commit();
      return { branch: before, changed: false };
    }
    await conn.execute("UPDATE branches SET status = ? WHERE id = ?", [target, before.id]);
    const after = await loadAccessible(conn, user, before.id);
    await logAudit(conn, {
      module: MODULE, entityType: "BRANCH", entityId: after.id, action: target === "ACTIVE" ? "ACTIVATE" : "DEACTIVATE",
      description: `Branch ${after.code} (${after.name}) ${target === "ACTIVE" ? "activated" : "deactivated"}`,
      beforeData: { status: before.status }, afterData: { status: after.status }, user, companyId: after.companyId,
    });
    await conn.commit();
    return { branch: after, changed: true };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { MODULE, STATUSES, LIMITS, listBranches, getBranch, createBranch, updateBranch, setBranchStatus, validateFields };
