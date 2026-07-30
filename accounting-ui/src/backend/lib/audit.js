// Pass the active transaction's `conn` (not the pool) when called inside a
// transaction so a logging failure rolls back the action it's documenting
// instead of silently leaving no trail.
//
// ipAddress/userAgent are optional and additive (existing call sites that
// don't pass them keep working unchanged) - populate them from the
// Express `req` object (req.ip, req.get("user-agent")) wherever one is
// available, per the spec's requirement that every audit record capture
// IP address and user agent.
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
  }
) {
  await db.execute(
    `INSERT INTO audit_logs(module, entity_type, entity_id, action, description, before_data, after_data, user_id, username, ip_address, user_agent)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
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
