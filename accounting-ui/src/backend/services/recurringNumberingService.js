const { DateTime } = require("luxon");
const { ZONE } = require("./recurringDateService");

// Atomic, scoped only to recurring-generated transactions - manual entry
// in every module keeps its existing free-text voucher_no behavior,
// completely untouched. Format: {CODE}-REC-{YYYYMM}-{4-digit-seq}, e.g.
// INV-REC-202608-0001 - the -REC- infix makes generated numbers visually
// unmistakable from manually-typed ones.

const MODULE_CODE = {
  invoice: "INV",
  or: "OR",
  apv: "APV",
  cv: "CV",
  jv: "JV",
  po: "PO",
};

// Must be called with the SAME connection the caller's transaction is
// using (not a fresh pool query) so the atomic increment participates in
// - and rolls back with - the surrounding generation transaction.
//
// Explicit row-lock + read-modify-write, rather than the usual MySQL
// INSERT ... ON DUPLICATE KEY UPDATE + LAST_INSERT_ID(expr) trick: that
// trick was tried first but proved unreliable against this specific
// database (confirmed via direct diagnostic) - on a genuinely fresh
// INSERT it returns the counter table's own auto_increment `id` instead
// of the LAST_INSERT_ID(expr) override, only behaving correctly on the
// ON DUPLICATE KEY UPDATE branch. This version doesn't depend on that
// engine-specific behavior at all.
async function generateVoucherNumber(conn, moduleType, occurrenceDateISO) {
  const code = MODULE_CODE[moduleType];
  if (!code) throw new Error(`Unsupported module type for numbering: ${moduleType}`);

  const periodKey = DateTime.fromISO(occurrenceDateISO, { zone: ZONE }).toFormat("yyyyLL");

  const [existing] = await conn.execute(
    "SELECT last_number FROM recurring_number_counters WHERE module_type = ? AND period_key = ? FOR UPDATE",
    [moduleType, periodKey]
  );

  let seq;
  if (existing.length > 0) {
    seq = existing[0].last_number + 1;
    await conn.execute(
      "UPDATE recurring_number_counters SET last_number = ? WHERE module_type = ? AND period_key = ?",
      [seq, moduleType, periodKey]
    );
  } else {
    // The SELECT ... FOR UPDATE above takes a gap lock preventing a
    // concurrent insert for this exact (module_type, period_key) under
    // normal InnoDB isolation, but the UNIQUE constraint is kept as a
    // correctness backstop regardless - if two callers still race here,
    // the loser's INSERT fails with ER_DUP_ENTRY and falls back to the
    // locked read-increment-update path instead of erroring out.
    try {
      await conn.execute(
        "INSERT INTO recurring_number_counters (module_type, period_key, last_number) VALUES (?, ?, 1)",
        [moduleType, periodKey]
      );
      seq = 1;
    } catch (err) {
      if (err.code !== "ER_DUP_ENTRY") throw err;
      const [rows] = await conn.execute(
        "SELECT last_number FROM recurring_number_counters WHERE module_type = ? AND period_key = ? FOR UPDATE",
        [moduleType, periodKey]
      );
      seq = rows[0].last_number + 1;
      await conn.execute(
        "UPDATE recurring_number_counters SET last_number = ? WHERE module_type = ? AND period_key = ?",
        [seq, moduleType, periodKey]
      );
    }
  }

  const paddedSeq = String(seq).padStart(4, "0");
  return `${code}-REC-${periodKey}-${paddedSeq}`;
}

module.exports = { generateVoucherNumber, MODULE_CODE };
