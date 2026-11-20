// Branch-assignment rules shared by user access (PATCH /api/users/:id) and
// invitations (POST /api/invitations). Server-side - the pickers only reflect them.
//
//   1. An assigner's BRANCH scope is every branch of the companies they belong to
//      (company-based, like Branch Management) - not only the branches they are
//      personally assigned to. SUPER_ADMIN has no scope limit.
//   2. A branch may be assigned to a user only if it belongs to one of THAT user's
//      companies - a branch assignment never crosses a company boundary. This is
//      a data-integrity rule and applies to every assigner, Super Admin included.
const pool = require("../db");

// company_id of each existing branch id (unknown ids are simply absent).
async function branchCompanies(branchIds) {
  if (!branchIds || !branchIds.length) return new Map();
  const [rows] = await pool.query("SELECT id, company_id FROM branches WHERE id IN (?)", [branchIds]);
  return new Map(rows.map((r) => [Number(r.id), Number(r.company_id)]));
}

// Every branch id of the given companies (the assigner's branch scope).
async function branchIdsOfCompanies(companyIds) {
  const ids = [...(companyIds || [])].map(Number).filter(Boolean);
  if (!ids.length) return [];
  const [rows] = await pool.query("SELECT id FROM branches WHERE company_id IN (?)", [ids]);
  return rows.map((r) => Number(r.id));
}

// Rule 2. Returns null when fine, otherwise the first offending branch id.
async function branchOutsideCompanies(branchIds, companyIds) {
  if (!branchIds || !branchIds.length) return null;
  const owners = await branchCompanies(branchIds);
  const allowed = new Set([...(companyIds || [])].map(Number));
  return branchIds.find((id) => !allowed.has(owners.get(Number(id)))) ?? null;
}

const BRANCH_COMPANY_MISMATCH = "A branch can only be assigned to a user who belongs to that branch's company.";

module.exports = { branchCompanies, branchIdsOfCompanies, branchOutsideCompanies, BRANCH_COMPANY_MISMATCH };
