// Branch-aware File Setup imports - "Owning Branch" column (COA, General
// Libraries). Classifies a setup record exactly like the manual forms do
// (branchOwnership.mjs / BranchResolution):
//   blank or "SHARED"  -> shared record (branch_id NULL) - the existing default;
//                         a company with zero branches imports this way, and
//                         nothing is ever placed in a fabricated branch
//   a Branch Code      -> branch-only record of that branch
// Master data stays SHARED when the cell is blank even in a one-branch
// company: blank never silently becomes a branch assignment (shared is a valid
// and the historical state of every imported record).
//
// Resolution is always on the server, against branches the request may use:
//   companyId given    -> branches of that company (General Libraries)
//   companyId null     -> branches of every company the user belongs to
//                         (the system-wide Chart of Accounts)
// Refused, with a row-level reason: unknown or another company's branch (one
// wording - existence elsewhere is never disclosed), INACTIVE branch, a branch
// the user is not authorized for, and an ambiguous value (a code that exists
// in two of the user's companies, or one branch's code = another's name).
const pool = require("../db");
const BranchResolution = require("../lib/branchResolution");

const OWNING_BRANCH_ALIASES = ["owning branch", "owningbranch", "branch owner", "assigned branch"];
const SHARED_KEYWORD = "SHARED";

const collapse = (v) => String(v ?? "").trim().replace(/\s+/g, " ");

async function candidateBranches(user, companyId) {
  const cols = "b.id, b.code, b.name, b.status, b.company_id AS companyId, c.name AS companyName";
  let rows;
  if (companyId) {
    [rows] = await pool.execute(`SELECT ${cols} FROM branches b JOIN companies c ON c.id = b.company_id WHERE b.company_id = ? ORDER BY b.code`, [companyId]);
  } else if (user.roleCode === "SUPER_ADMIN") {
    [rows] = await pool.execute(`SELECT ${cols} FROM branches b JOIN companies c ON c.id = b.company_id ORDER BY c.name, b.code`);
  } else {
    [rows] = await pool.execute(
      `SELECT ${cols} FROM branches b JOIN companies c ON c.id = b.company_id
         JOIN user_companies uc ON uc.company_id = b.company_id AND uc.user_id = ?
       ORDER BY c.name, b.code`,
      [user.id]
    );
  }
  const authorized = new Set(
    companyId ? await BranchResolution.authorizedBranchIds(user, companyId) : await BranchResolution.authorizedBranchIdsAnyCompany(user)
  );
  return rows.map((r) => ({ ...r, id: Number(r.id), authorized: authorized.has(Number(r.id)) }));
}

function makeResolver(candidates, { scopeLabel }) {
  return function resolve(raw) {
    const typed = collapse(raw);
    if (!typed || typed.toUpperCase() === SHARED_KEYWORD) return { ok: true, branchId: null, label: "Shared" };
    const key = typed.toLowerCase();
    const matches = candidates.filter((b) => String(b.code).toLowerCase() === key || collapse(b.name).toLowerCase() === key);
    if (!matches.length) {
      return { ok: false, reason: `Owning Branch "${typed}" is not a branch of ${scopeLabel}. Use a Branch Code from the Branches sheet, or leave it blank (or ${SHARED_KEYWORD}) for a shared record.` };
    }
    if (matches.length > 1) {
      const list = matches.map((b) => `${b.code} (${b.companyName})`).join(", ");
      return { ok: false, reason: `Owning Branch "${typed}" is ambiguous - it matches ${list}. It was not assigned; assign this record in the form instead.` };
    }
    const b = matches[0];
    if (String(b.status || "").toUpperCase() !== "ACTIVE") {
      return { ok: false, reason: `Owning Branch "${b.code}" is ${String(b.status || "not active").toUpperCase()}; records cannot be assigned to it.` };
    }
    if (!b.authorized) {
      return { ok: false, reason: `You are not authorized to assign records to branch "${b.code}".` };
    }
    return { ok: true, branchId: b.id, label: b.code };
  };
}

// Builds the resolver for one import request. `companyId` null = system-wide
// (Chart of Accounts).
async function buildOwningBranchResolver(user, { companyId = null } = {}) {
  const candidates = await candidateBranches(user, companyId);
  return {
    candidates,
    resolve: makeResolver(candidates, { scopeLabel: companyId ? "the selected company" : "your companies" }),
  };
}

// Reference rows for the template's "Branches" sheet: the ACTIVE branches the
// user may assign (inactive / unauthorized ones are refused on import anyway).
async function templateBranchRows(user, { companyId = null } = {}) {
  const candidates = await candidateBranches(user, companyId);
  return candidates
    .filter((b) => b.authorized && String(b.status || "").toUpperCase() === "ACTIVE")
    .map((b) => ({ code: b.code, name: b.name, company: b.companyName }));
}

// Preview summary: how many ready rows go to each owner.
function ownershipSummary(readyRows) {
  const counts = new Map();
  for (const r of readyRows) counts.set(r.owningBranchLabel, (counts.get(r.owningBranchLabel) || 0) + 1);
  return [...counts.entries()].map(([owner, count]) => ({ owner, count }));
}

module.exports = {
  OWNING_BRANCH_ALIASES,
  SHARED_KEYWORD,
  buildOwningBranchResolver,
  templateBranchRows,
  ownershipSummary,
  makeResolver,
};
