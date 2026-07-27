// Pass the active transaction's `conn` (not the pool) when called inside a
// transaction so a logging failure rolls back the action it's documenting
// instead of silently leaving no trail.
async function logAudit(
  db,
  { module, entityType, entityId, action, description, beforeData = null, afterData = null, user = null }
) {
  await db.execute(
    `INSERT INTO audit_logs(module, entity_type, entity_id, action, description, before_data, after_data, user_id, username)
     VALUES (?,?,?,?,?,?,?,?,?)`,
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
    ]
  );
}

module.exports = { logAudit };
