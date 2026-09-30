// Pass the active transaction's `conn` (not the pool) when called inside a
// transaction so a logging failure rolls back the action it's documenting
// instead of silently leaving no trail.
//
// ipAddress/userAgent are optional and additive (existing call sites that
// don't pass them keep working unchanged) - populate them from the
// Express `req` object (req.ip, req.get("user-agent")) wherever one is
// available, per the spec's requirement that every audit record capture
// IP address and user agent.
//
// companyId is likewise optional and additive - existing call sites that
// don't pass it are UNCHANGED (row is written with company_id = NULL,
// exactly as before this parameter existed). It exists to close a
// confirmed cross-company audit-log exposure: audit_logs.company_id has
// existed since checkpoint4h_company_isolation_migration.sql specifically
// for this purpose, but nothing ever populated it. Callers for a
// company-scoped action (almost every transaction CREATE/EDIT/VOID/etc.)
// should now pass the SAME companyId they already resolved via
// CurrencyService.resolveCompanyIdForWrite()/equivalent earlier in that
// same request - never re-derive or guess one here. A handful of call
// sites are genuinely NOT company-scoped (pre-authentication login/
// lockout events, ewt_library CRUD - that table has no company_id column
// at all, and authorizePermission's ACCESS_DENIED, which fires before any
// company context is resolved/verified) and are deliberately left
// passing no companyId - company_id = NULL for those rows is correct,
// not a gap.
async function logAudit(
  db,
  {
    module,
    entityType = null,
    entityId = null,
    action,
    description,
    beforeData = null,
    afterData = null,
    user = null,
    ipAddress = null,
    userAgent = null,
    companyId = null,
  }
) {
  await db.execute(
    `INSERT INTO audit_logs(module, entity_type, entity_id, action, description, before_data, after_data, user_id, username, ip_address, user_agent, company_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      module,
      entityType,
      entityId,
      action,
      description,
      beforeData ? JSON.stringify(beforeData) : null,
      afterData ? JSON.stringify(afterData) : null,
      user?.id || null,
      user?.username || null,
      // Explicit params win; otherwise fall back to metadata riding along
      // on `user` (controllers attach it via { ...req.user, ...requestMeta(req) }
      // so most call sites get this for free without threading extra
      // params through every service function).
      ipAddress || user?.ipAddress || null,
      userAgent || user?.userAgent || null,
      // Unlike ipAddress/userAgent, companyId has no equivalent
      // "rides along on `user`" convention anywhere in this codebase
      // (a user can belong to multiple companies, so `req.user` never
      // carries a single companyId) - it must be passed explicitly by
      // the caller, resolved the same way that request already resolved
      // one for its own writes. No fallback here on purpose.
      companyId || null,
    ]
  );
}

// Small helper so call sites with a `req` object don't need to know the
// exact field names - req.ip already reflects X-Forwarded-For when
// `app.set("trust proxy", ...)` is configured.
function requestMeta(req) {
  return { ipAddress: req?.ip || null, userAgent: req?.get?.("user-agent") || null };
}

module.exports = { logAudit, requestMeta };
