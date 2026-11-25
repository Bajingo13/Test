// File Setup deletion - ONE set of rules for the single-record DELETE routes
// and the bulk "Delete Selected" routes (Chart of Accounts, General Libraries,
// Group Codes, Report Sections). Nothing here cascades: a record that is still
// referenced is BLOCKED (never deleted, never detached), so no transaction,
// beginning balance or setup link is ever orphaned, and Maker-Checker / posted
// records are untouched (only master records are deleted, and only unused).
//
// Every outcome is one of:
//   deleted  - the record was removed (audited; no secrets, before-image only)
//   blocked  - in use / protected; `code` + `reason` + `references` say why
//   skipped  - not found, or not visible to this user (never disclosed which)
//
// Bulk deletion = the same deleteOne() per id, independently: one blocked or
// failing record never stops or undoes the others, and the response reports
// every id. Authorization (permission) is the route's; branch / company scope
// is re-checked here for every record.
const pool = require("../db");
const { logAudit } = require("../lib/audit");
const BranchResolution = require("../lib/branchResolution");

const MAX_BULK_IDS = 500;

// ---- Chart of Accounts --------------------------------------------------
// TC-FS-001: an account that is still referenced must not be deleted (same
// rule as the Group Code delete guard). Transaction / beginning-balance lines
// reference accounts by account_id and/or account_code WITHOUT a foreign key,
// so a delete used to orphan them silently; the few real FKs (bank-recon
// adjustments, FX account settings) made it fail with a raw 500.
// (Moved unchanged from server.js.)
const COA_REFERENCE_SOURCES = [
  ["apv_lines", "account_id", "account_code"], ["cv_lines", "account_id", "account_code"],
  ["invoice_lines", "account_id", "account_code"], ["or_lines", "account_id", "account_code"],
  ["jv_lines", "account_id", "account_code"], ["memo_lines", "account_id", "account_code"],
  ["petty_cash_lines", "account_id", "account_code"], ["purchase_order_lines", "account_id", "account_code"],
  ["quotation_lines", "account_id", "account_code"], ["recurring_transaction_template_lines", "account_id", "account_code"],
  ["arap_beginning_balance_lines", "account_id", "account_code"], ["gl_beginning_balance_lines", "account_id", "account_code"],
  ["rfp_lines", "account_id", null], ["transaction_tax_entries", "account_id", null],
  ["bank_codes", "coa_account_id", null], ["bank_recon_adjustments", "suggested_account_id", null],
  ["prepaid_accounts", null, "account_code"], ["prepaid_accounts", null, "expense_account_code"],
];
async function countCoaReferences(account) {
  const references = {};
  for (const [table, idCol, codeCol] of COA_REFERENCE_SOURCES) {
    const where = [idCol ? `${idCol} = ?` : null, codeCol ? `${codeCol} = ?` : null].filter(Boolean).join(" OR ");
    const params = [idCol ? account.id : null, codeCol ? account.code : null].filter((v) => v !== null);
    const [[row]] = await pool.execute(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, params);
    const n = Number(row.n) || 0;
    if (n) references[codeCol && !idCol ? `${table}.${codeCol}` : table] = n;
  }
  const [[fx]] = await pool.execute(
    `SELECT COUNT(*) AS n FROM company_fx_accounts WHERE ? IN (realized_fx_gain_account_id, realized_fx_loss_account_id, unrealized_fx_gain_account_id, unrealized_fx_loss_account_id)`,
    [account.id]
  );
  if (Number(fx.n)) references.company_fx_accounts = Number(fx.n);
  return references;
}

// ---- General Libraries ---------------------------------------------------
// Post-File-Setup fix: parties had NO delete guard and no database foreign key
// protects them, so deleting a supplier / customer that transactions use left
// those documents pointing at a party that no longer exists. References by id
// (authoritative) and by code on the company's own transaction lines (gen_ref
// carries the party code).
const PARTY_ID_SOURCES = [
  ["apv_headers", "supplier_id"], ["cv_headers", "payee_id"], ["invoice_headers", "customer_id"],
  ["or_headers", "customer_id"], ["memo_headers", "party_id"], ["petty_cash_headers", "payee_id"],
  ["purchase_order_headers", "supplier_id"], ["quotation_headers", "customer_id"], ["rfp_headers", "supplier_id"],
  ["recurring_transaction_templates", "party_id"], ["transaction_tax_entries", "party_id"],
  ["arap_beginning_balance_lines", "party_id"],
];
const PARTY_CODE_LINE_SOURCES = [
  ["apv_lines", "apv_id", "apv_headers"], ["cv_lines", "cv_id", "cv_headers"],
  ["invoice_lines", "invoice_id", "invoice_headers"], ["or_lines", "or_id", "or_headers"],
  ["jv_lines", "jv_id", "jv_headers"], ["memo_lines", "memo_id", "memo_headers"],
  ["petty_cash_lines", "petty_cash_id", "petty_cash_headers"], ["purchase_order_lines", "po_id", "purchase_order_headers"],
  ["recurring_transaction_template_lines", "template_id", "recurring_transaction_templates"],
];
async function countPartyReferences(party) {
  const references = {};
  for (const [table, col] of PARTY_ID_SOURCES) {
    const [[row]] = await pool.execute(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`, [party.id]);
    if (Number(row.n)) references[table] = Number(row.n);
  }
  for (const [lines, fk, headers] of PARTY_CODE_LINE_SOURCES) {
    const [[row]] = await pool.execute(
      `SELECT COUNT(*) AS n FROM ${lines} l JOIN ${headers} h ON h.id = l.${fk} WHERE h.company_id = ? AND l.gen_ref = ?`,
      [party.company_id, party.code]
    );
    if (Number(row.n)) references[`${lines}.gen_ref`] = Number(row.n);
  }
  return references;
}

const result = (id, status, extra = {}) => ({ id: Number(id), status, ...extra });
const SKIPPED = (id) => result(id, "skipped", { reason: "Not found (already deleted, or not available to you)." });

async function audit(user, meta, { entityType, entityId, label, before, companyId = null, bulk }) {
  await logAudit(pool, {
    module: "FILESETUP",
    entityType,
    entityId,
    action: "DELETED",
    description: `${user?.username || "user"} deleted ${entityType.toLowerCase().replace(/_/g, " ")} ${label}${bulk ? " (bulk delete)" : ""}`,
    beforeData: before,
    user,
    companyId,
    ...meta,
  });
}

async function deleteCoa(user, id, { meta = {}, bulk = false } = {}) {
  const [[row]] = await pool.execute("SELECT id, code, title, account_class, branch_id FROM chart_of_accounts WHERE id = ?", [id]);
  if (!row) return SKIPPED(id);
  try {
    await BranchResolution.assertSetupRecordVisible(user, row.branch_id);
  } catch (err) {
    if (err.statusCode === 404) return SKIPPED(id);
    throw err;
  }
  const references = await countCoaReferences(row);
  if (Object.keys(references).length) {
    return result(id, "blocked", {
      label: row.code,
      code: "COA_IN_USE",
      reason: "This account cannot be deleted because it is used by transactions, beginning balances or other setup records.",
      references,
    });
  }
  await pool.execute("DELETE FROM chart_of_accounts WHERE id = ?", [id]);
  await audit(user, meta, { entityType: "COA", entityId: row.id, label: `${row.code} ${row.title}`, before: { code: row.code, title: row.title, accountClass: row.account_class, branchId: row.branch_id }, bulk });
  return result(id, "deleted", { label: row.code });
}

async function deleteGenLib(user, id, companyId, { meta = {}, bulk = false } = {}) {
  const [[row]] = await pool.execute("SELECT id, code, name, party_type, company_id, branch_id FROM general_libraries WHERE id = ?", [id]);
  if (!row || Number(row.company_id) !== Number(companyId)) return SKIPPED(id);
  try {
    await BranchResolution.assertSetupRecordVisible(user, row.branch_id);
  } catch (err) {
    if (err.statusCode === 404) return SKIPPED(id);
    throw err;
  }
  const references = await countPartyReferences(row);
  if (Object.keys(references).length) {
    return result(id, "blocked", {
      label: row.code,
      code: "GENLIB_IN_USE",
      reason: "This record cannot be deleted because transactions, beginning balances or templates use it. Set it INACTIVE instead.",
      references,
    });
  }
  await pool.execute("DELETE FROM general_libraries WHERE id = ? AND company_id = ?", [id, companyId]);
  await audit(user, meta, { entityType: "GENERAL_LIBRARY", entityId: row.id, label: `${row.code} ${row.name}`, before: { code: row.code, name: row.name, type: row.party_type, branchId: row.branch_id }, companyId: row.company_id, bulk });
  return result(id, "deleted", { label: row.code });
}

async function deleteGroupCode(user, id, { meta = {}, bulk = false } = {}) {
  const [[row]] = await pool.execute("SELECT id, group_code, group_description, account_class FROM account_group_codes WHERE id = ?", [id]);
  if (!row) return SKIPPED(id);
  const [[usage]] = await pool.execute("SELECT COUNT(*) AS refCount FROM coa_groups WHERE group_code = ?", [row.group_code]);
  const refCount = Number(usage.refCount) || 0;
  if (refCount > 0) {
    return result(id, "blocked", {
      label: row.group_code,
      code: "GROUP_CODE_IN_USE",
      reason: "This Group Code cannot be deleted because it is assigned to one or more Chart of Accounts records.",
      references: { coaGroups: refCount },
    });
  }
  await pool.execute("DELETE FROM account_group_codes WHERE id = ?", [id]);
  await audit(user, meta, { entityType: "GROUP_CODE", entityId: row.id, label: row.group_code, before: { groupCode: row.group_code, description: row.group_description, accountClass: row.account_class }, bulk });
  return result(id, "deleted", { label: row.group_code });
}

async function deleteReportSection(user, id, { meta = {}, bulk = false } = {}) {
  const ReportSectionService = require("./reportSectionService");
  const [[row]] = await pool.execute("SELECT id, code, name, account_class FROM report_sections WHERE id = ?", [id]);
  if (!row) return SKIPPED(id);
  try {
    await ReportSectionService.deleteReportSection(id);
  } catch (err) {
    if (err.statusCode === 409) {
      return result(id, "blocked", { label: row.code, code: err.code, reason: err.message, references: err.references });
    }
    throw err;
  }
  await audit(user, meta, { entityType: "REPORT_SECTION", entityId: row.id, label: `${row.code} ${row.name}`, before: { code: row.code, name: row.name, accountClass: row.account_class }, bulk });
  return result(id, "deleted", { label: row.code });
}

// ids: the request body's list. 400 for anything that is not 1..MAX unique
// positive integers.
function parseIds(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "Select at least one record to delete." };
  const ids = [...new Set(raw.map(Number))];
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) return { error: "The selection contains an invalid record id." };
  if (ids.length > MAX_BULK_IDS) return { error: `At most ${MAX_BULK_IDS} records can be deleted at once.` };
  return { ids };
}

// Runs deleteOne for every id, sequentially and independently.
async function bulk(ids, deleteOne) {
  const results = [];
  for (const id of ids) {
    try {
      results.push(await deleteOne(id));
    } catch (err) {
      console.error("FILE SETUP BULK DELETE - RECORD FAILED:", id, err.code || err.message);
      results.push(result(id, "failed", { reason: "This record could not be deleted. Nothing was changed for it." }));
    }
  }
  const count = (s) => results.filter((r) => r.status === s).length;
  return {
    success: true,
    summary: { requested: ids.length, deleted: count("deleted"), blocked: count("blocked"), skipped: count("skipped"), failed: count("failed") },
    results,
  };
}

module.exports = {
  MAX_BULK_IDS,
  countCoaReferences,
  countPartyReferences,
  deleteCoa,
  deleteGenLib,
  deleteGroupCode,
  deleteReportSection,
  parseIds,
  bulk,
};
