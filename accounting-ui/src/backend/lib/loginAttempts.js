// Failed-login counter for POST /api/login - one counter per ACCOUNT (users.id),
// whichever identifier (username or e-mail) was typed.
//
// Atomic: the row is locked (SELECT ... FOR UPDATE) and incremented inside one
// transaction, so simultaneous wrong passwords for the same account are counted
// one by one - none is lost, exactly one request observes each count (so the
// 3rd-failure alert fires once and the 5th failure locks).
//
// Reset policy:
//   - a successful login resets the counter to 0 (POST /api/login, unchanged);
//   - an administrator unlock resets it (userService, unchanged);
//   - NEW: when a temporary lockout has EXPIRED, the stale count no longer carries
//     over - the next wrong password starts a fresh streak at 1 (so it neither
//     re-locks the account at once nor suppresses the 3rd-failure alert of the
//     new streak). The 5-attempt / 15-minute lockout applies to that streak again.
//   - while a lockout is ACTIVE nothing is counted (the request is refused as
//     locked), exactly as before.
// The audit history is never modified here.
async function recordFailedLogin(pool, userId, { maxAttempts, lockoutMinutes }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      `SELECT failed_login_count AS n,
              (locked_until IS NOT NULL AND locked_until > NOW()) AS locked,
              (locked_until IS NOT NULL AND locked_until <= NOW()) AS lock_expired
         FROM users WHERE id = ? FOR UPDATE`,
      [userId]
    );
    const row = rows[0];
    if (!row) {
      await conn.rollback();
      return { count: 0, lockingNow: false, alreadyLocked: false, streakReset: false };
    }
    if (Number(row.locked)) {
      // locked by a concurrent request after this one read the account
      await conn.commit();
      return { count: Number(row.n) || 0, lockingNow: false, alreadyLocked: true, streakReset: false };
    }
    const streakReset = Boolean(Number(row.lock_expired));
    const count = (streakReset ? 0 : Number(row.n) || 0) + 1;
    const lockingNow = count >= maxAttempts;
    await conn.execute(
      `UPDATE users SET failed_login_count = ?, locked_until = ${lockingNow ? "DATE_ADD(NOW(), INTERVAL ? MINUTE)" : "NULL"} WHERE id = ?`,
      lockingNow ? [count, lockoutMinutes, userId] : [count, userId]
    );
    await conn.commit();
    return { count, lockingNow, alreadyLocked: false, streakReset };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { recordFailedLogin };
