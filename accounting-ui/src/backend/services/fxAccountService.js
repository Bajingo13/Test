const pool = require("../db");
const { HttpError } = require("../lib/httpError");
const CurrencyService = require("./currencyService");

// Checkpoint 3FX: company-level configuration of which Chart of Accounts
// entries realized FX gains/losses post to. Mirrors company_rate_policies
// (Phase 2) - one row per company_id, upserted via ON DUPLICATE KEY.
//
// chart_of_accounts has no company_id, no active/status flag, and no
// header/non-postable distinction (confirmed by inspection before writing
// this file) - it's a single global COA. Only existence can actually be
// validated here; the "inactive account" / "account from another company" /
// "non-postable account" checks section 3 describes are not enforceable
// against today's schema and are called out as a known limitation rather
// than invented via an out-of-scope COA redesign.

async function getAccountLabel(accountId) {
  if (!accountId) return null;
  const [rows] = await pool.execute(
    "SELECT id, code, title, account_class AS accountClass FROM chart_of_accounts WHERE id = ?",
    [accountId]
  );
  return rows[0] || null;
}

async function getFxAccounts(user, companyId) {
  const resolvedCompanyId = await CurrencyService.resolveCompanyIdForWrite(user, companyId);
  const [rows] = await pool.execute(
    `SELECT company_id AS companyId,
            realized_fx_gain_account_id AS gainAccountId, realized_fx_loss_account_id AS lossAccountId,
            unrealized_fx_gain_account_id AS unrealizedGainAccountId, unrealized_fx_loss_account_id AS unrealizedLossAccountId,
            updated_at AS updatedAt
     FROM company_fx_accounts WHERE company_id = ?`,
    [resolvedCompanyId]
  );
  const row = rows[0] || { companyId: resolvedCompanyId, gainAccountId: null, lossAccountId: null, unrealizedGainAccountId: null, unrealizedLossAccountId: null, updatedAt: null };
  const [gainAccount, lossAccount, unrealizedGainAccount, unrealizedLossAccount] = await Promise.all([
    getAccountLabel(row.gainAccountId),
    getAccountLabel(row.lossAccountId),
    getAccountLabel(row.unrealizedGainAccountId),
    getAccountLabel(row.unrealizedLossAccountId),
  ]);
  return { ...row, gainAccount, lossAccount, unrealizedGainAccount, unrealizedLossAccount };
}

async function upsertFxAccounts(user, companyId, { gainAccountId, lossAccountId, unrealizedGainAccountId, unrealizedLossAccountId }) {
  const resolvedCompanyId = await CurrencyService.resolveCompanyIdForWrite(user, companyId);

  if (gainAccountId) {
    const account = await getAccountLabel(gainAccountId);
    if (!account) throw new HttpError(400, "Selected Realized FX Gain account does not exist.");
  }
  if (lossAccountId) {
    const account = await getAccountLabel(lossAccountId);
    if (!account) throw new HttpError(400, "Selected Realized FX Loss account does not exist.");
  }
  if (gainAccountId && lossAccountId && Number(gainAccountId) === Number(lossAccountId)) {
    throw new HttpError(400, "Realized FX Gain and Realized FX Loss must be different accounts.");
  }
  if (unrealizedGainAccountId) {
    const account = await getAccountLabel(unrealizedGainAccountId);
    if (!account) throw new HttpError(400, "Selected Unrealized FX Gain account does not exist.");
  }
  if (unrealizedLossAccountId) {
    const account = await getAccountLabel(unrealizedLossAccountId);
    if (!account) throw new HttpError(400, "Selected Unrealized FX Loss account does not exist.");
  }
  if (unrealizedGainAccountId && unrealizedLossAccountId && Number(unrealizedGainAccountId) === Number(unrealizedLossAccountId)) {
    throw new HttpError(400, "Unrealized FX Gain and Unrealized FX Loss must be different accounts.");
  }

  await pool.execute(
    `INSERT INTO company_fx_accounts (company_id, realized_fx_gain_account_id, realized_fx_loss_account_id, unrealized_fx_gain_account_id, unrealized_fx_loss_account_id, updated_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       realized_fx_gain_account_id = VALUES(realized_fx_gain_account_id),
       realized_fx_loss_account_id = VALUES(realized_fx_loss_account_id),
       unrealized_fx_gain_account_id = VALUES(unrealized_fx_gain_account_id),
       unrealized_fx_loss_account_id = VALUES(unrealized_fx_loss_account_id),
       updated_by = VALUES(updated_by)`,
    [resolvedCompanyId, gainAccountId || null, lossAccountId || null, unrealizedGainAccountId || null, unrealizedLossAccountId || null, user.id]
  );

  return getFxAccounts(user, resolvedCompanyId);
}

// Read-only lookup for the posting path (server.js) - throws a clear,
// specific error per direction actually needed (section 3's example),
// rather than a generic "not configured" that doesn't say which one.
// Checkpoint 4 adds UNREALIZED_GAIN/UNREALIZED_LOSS directions, backed by
// their own dedicated columns - never falls back to the realized accounts
// (section 14: no automatic reuse unless explicitly configured that way).
async function requireFxAccount(companyId, direction) {
  const [rows] = await pool.execute(
    `SELECT realized_fx_gain_account_id AS gainAccountId, realized_fx_loss_account_id AS lossAccountId,
            unrealized_fx_gain_account_id AS unrealizedGainAccountId, unrealized_fx_loss_account_id AS unrealizedLossAccountId
     FROM company_fx_accounts WHERE company_id = ?`,
    [companyId]
  );
  const row = rows[0] || { gainAccountId: null, lossAccountId: null, unrealizedGainAccountId: null, unrealizedLossAccountId: null };
  const ACCOUNT_BY_DIRECTION = {
    REALIZED_GAIN: { id: row.gainAccountId, label: "Realized FX Gain" },
    REALIZED_LOSS: { id: row.lossAccountId, label: "Realized FX Loss" },
    UNREALIZED_GAIN: { id: row.unrealizedGainAccountId, label: "Unrealized FX Gain" },
    UNREALIZED_LOSS: { id: row.unrealizedLossAccountId, label: "Unrealized FX Loss" },
  };
  const target = ACCOUNT_BY_DIRECTION[direction];
  if (!target || !target.id) {
    const label = target?.label || direction;
    throw new HttpError(
      422,
      `Cannot post because the ${label} account is not configured. ` +
      "Configure it under File Setup → Currency Setup → FX Accounting before posting."
    );
  }
  const account = await getAccountLabel(target.id);
  return { accountId: target.id, accountCode: account?.code || null, accountTitle: account?.title || null };
}

module.exports = {
  getFxAccounts,
  upsertFxAccounts,
  requireFxAccount,
};
