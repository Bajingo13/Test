// General Libraries - branch-aware party code identity (one rule, used by the
// import preview, the import confirm, manual create / edit and the backend).
//
// Identity of a party = (company, code, owner) where owner is SHARED or ONE
// branch. Codes compare trimmed and case-insensitively (the column collation
// is case-insensitive). Within one company:
//
//   same code + same owner (shared/shared or branch X/branch X) -> duplicate
//   same code + different branches                              -> allowed,
//        when both records have the same party type, so a code still means
//        one kind of party wherever it is consolidated
//   shared code <-> branch-only code                            -> refused,
//        both ways: a branch record would shadow the shared one (and a new
//        shared record would make existing branch records ambiguous), so a
//        shared code always means exactly ONE record
//   another company                                             -> never a
//        conflict (companies are isolated; uq_genlib_company_code_branch)
//
// The database enforces (company_id, code, branch_scope) - branch_scope =
// IFNULL(branch_id, 0) - (genlib_branch_code_scope_migration.sql); the shared
// <-> branch and party-type rules are enforced here, like the Chart of
// Accounts (coaLookupService.assertCoaCodeAllowed).
//
// Transaction lines keep referencing a party by code (gen_ref); a code is
// resolved for the line's OWN branch (resolvePartyForBranch): that branch's
// record, else the shared one - never another branch's record.
const { HttpError } = require("../lib/httpError");

const codeKey = (code) => String(code ?? "").trim().toLowerCase();
const ownerKey = (branchId) => (branchId === null || branchId === undefined ? 0 : Number(branchId));

// Pure. `taken` = records already holding this code in the company (database
// rows and / or rows accepted earlier in the same file):
//   [{ branchId, partyType, inFile, row }]
// Returns null when (code, branchId, partyType) may be created, otherwise
// { code, reason } (reason is user-facing; it never names another branch).
function genlibCodeRefusal(code, branchId, partyType, taken = []) {
  const shared = taken.filter((t) => ownerKey(t.branchId) === 0);
  const fileNote = (t) => (t && t.inFile ? ` (row ${t.row} of this file)` : "");
  // Same owner: the long-standing wordings (unchanged for shared records).
  const duplicate = (t, where) => (t.inFile
    ? { code: "GENLIB_CODE_EXISTS", reason: `Code "${code}" is repeated in this file (first used on row ${t.row})` }
    : { code: "GENLIB_CODE_EXISTS", reason: `Code "${code}" already exists${where}` });
  if (ownerKey(branchId) === 0) {
    if (shared.length) return duplicate(shared[0], "");
    if (taken.length) {
      return { code: "GENLIB_CODE_USED_BY_BRANCH", reason: `Code "${code}" is already used by a branch-only record${fileNote(taken[0])}; a shared record cannot reuse it` };
    }
    return null;
  }
  if (shared.length) {
    return { code: "GENLIB_CODE_SHARED_CONFLICT", reason: `Code "${code}" is a shared record${fileNote(shared[0])}; a branch-only record cannot reuse it` };
  }
  const same = taken.filter((t) => ownerKey(t.branchId) === ownerKey(branchId));
  if (same.length) return duplicate(same[0], " in this branch");
  const type = String(partyType || "").toUpperCase();
  const otherType = taken.find((t) => String(t.partyType || "").toUpperCase() !== type);
  if (otherType) {
    return {
      code: "GENLIB_CODE_TYPE_CONFLICT",
      reason: `Code "${code}" is used by another branch as a ${String(otherType.partyType || "").toUpperCase()}${fileNote(otherType)}; branches sharing a code must use the same type`,
    };
  }
  return null; // same code, another branch, same type - allowed
}

// Transactional check for one manual create / edit. Locks the code's rows in
// the company (FOR UPDATE) so two concurrent writers cannot both pass.
async function assertGenLibCodeAllowed(conn, { companyId, code, branchId, partyType, excludeId = null }) {
  // Serialize every writer of this company + code on its registry row FIRST -
  // the same row lock the triggers take (genlib_code_registry_migration.sql),
  // so concurrent writers queue instead of deadlocking on index gap locks. A
  // new code gets a zero-count row; the INSERT's trigger counts it, and a
  // refused / rolled-back write removes it with the transaction.
  await conn.execute(
    "INSERT INTO general_library_code_registry (company_id, code, shared_count, branch_count) VALUES (?, ?, 0, 0) ON DUPLICATE KEY UPDATE company_id = company_id",
    [companyId, String(code ?? "").trim()]
  );
  const [rows] = await conn.execute(
    "SELECT id, branch_id, party_type FROM general_libraries WHERE company_id = ? AND code = ? FOR UPDATE",
    [companyId, String(code ?? "").trim()]
  );
  const taken = rows
    .filter((r) => excludeId === null || Number(r.id) !== Number(excludeId))
    .map((r) => ({ branchId: r.branch_id === null ? null : Number(r.branch_id), partyType: r.party_type }));
  const refusal = genlibCodeRefusal(String(code ?? "").trim(), branchId, partyType, taken);
  if (!refusal) return;
  // 400 like the existing create / edit contract; a plain duplicate keeps its
  // long-standing message, the branch-identity conflicts explain themselves.
  if (refusal.code === "GENLIB_CODE_EXISTS") throw new HttpError(400, "Code already exists", refusal.code);
  throw new HttpError(400, `${refusal.reason}.`, refusal.code);
}

// Picks the record a code means for a document of `branchId` from `rows`
// (all records of that code in the company):
//   1. the document branch's own record;
//   2. otherwise the shared record (a shared code is never reused by a branch);
//   3. otherwise NOTHING (null = unresolved).
// A document without a branch can only mean a shared record. Another branch's
// record is never returned - not even when it is the only record with that
// code: it may be an unrelated party created later under a freed code, or a
// party moved between branches, and a code alone cannot tell which. Callers
// show the line's own stored name and leave master-data fields blank.
function resolvePartyForBranch(rows, branchId) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return null;
  const want = ownerKey(branchId);
  const own = want ? list.find((r) => ownerKey(r.branch_id ?? r.branchId) === want) : null;
  if (own) return own;
  return list.find((r) => ownerKey(r.branch_id ?? r.branchId) === 0) || null;
}

// The database's own enforcement (genlib_code_registry_migration.sql): its
// triggers SIGNAL (errno 1644) when a concurrent writer slipped past the check
// above; two writers of one code can also deadlock on the registry row (1213).
const DB_REFUSALS = {
  GENLIB_CODE_SHARED_BRANCH_CONFLICT: "This code is already used by another record of a different owner (a code is either one shared record or branch-only records). Nothing was saved.",
  GENLIB_CODE_TYPE_CONFLICT: "This code is used by another branch with a different type; branches sharing a code must use the same type. Nothing was saved.",
};
function fromDatabaseError(err) {
  if (!err) return null;
  if (err.errno === 1644) {
    const key = Object.keys(DB_REFUSALS).find((k) => String(err.sqlMessage || err.message || "").includes(k));
    if (key) return new HttpError(400, DB_REFUSALS[key], key);
  }
  if (err.errno === 1213 || err.code === "ER_LOCK_DEADLOCK") {
    return new HttpError(409, "Another user changed this code at the same time. Nothing was saved; please try again.", "GENLIB_CODE_CONCURRENT_CHANGE");
  }
  return null;
}
// True when another writer created / changed one of the codes meanwhile: the
// unique key (ER_DUP_ENTRY) or the code-registry triggers (errno 1644). A
// deadlock stays a generic "rolled back, try again" failure for imports.
const isConcurrentCodeConflict = (err) => !!err && (err.code === "ER_DUP_ENTRY" || err.errno === 1644);

module.exports = { codeKey, ownerKey, genlibCodeRefusal, assertGenLibCodeAllowed, resolvePartyForBranch, fromDatabaseError, isConcurrentCodeConflict };
