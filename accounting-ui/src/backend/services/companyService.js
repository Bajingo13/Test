// Company Management - the controlled way to create a NEW company (the migration
// seed only ever creates the first one). Super Admin only by default
// (FILESETUP.COMPANIES / CREATE, granted to no role - company_management_migration.sql).
//
// Creates ONLY what a company needs to be usable, in one database transaction:
//   - the `companies` row (fields and conventions of Company Profile);
//   - its PHP base currency - every company must have one (the exchange-rate
//     resolver refuses a company without it), and this is exactly the row
//     currencies_migration.sql seeds for every company that lacks one;
//   - a COMPANY / CREATE audit entry.
// It copies NOTHING from another company: no customers/suppliers, transactions,
// beginning balances, periods, audit history or EIS/BIR records. No branch is
// created (no business rule requires one - the company's Admin adds MAIN and the
// other branches through Branch Management). Users are assigned afterwards
// through the existing user-access workflow.
const pool = require("../db");
const audit = require("../lib/audit");
const { HttpError } = require("../lib/httpError");

const LIMITS = { name: 255, tin: 20, address: 255, zip: 20, telephone: 50, email: 255, branchCode: 20 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TIN_RE = /^[0-9][0-9\s-]*$/;
const LOCK = "astrea_company_create";

const text = (v) => (v === undefined || v === null ? "" : String(v).trim());
const optional = (v) => (text(v) === "" ? null : text(v));
const digits = (v) => text(v).replace(/\D/g, "");
const bad = (message, code) => new HttpError(400, message, code);

function validate(body) {
  const out = {
    name: text(body?.name),
    tin: text(body?.tin),
    address: optional(body?.address),
    zip: optional(body?.zip),
    telephone: optional(body?.telephone),
    email: optional(body?.email),
    branchCode: optional(body?.branchCode),
    vatRegistered: body?.vatRegistered === undefined || body?.vatRegistered === null ? true : Boolean(body.vatRegistered),
  };
  if (!out.name) throw bad("Company Name is required.", "COMPANY_NAME_REQUIRED");
  if (!out.tin) throw bad("TIN is required.", "COMPANY_TIN_REQUIRED");
  if (!TIN_RE.test(out.tin) || digits(out.tin).length < 9) throw bad("TIN must contain at least 9 digits (digits, spaces and hyphens only).", "COMPANY_TIN_INVALID");
  if (out.branchCode && !/^[0-9]+$/.test(out.branchCode)) throw bad("BIR Branch Code must contain digits only (e.g. 000).", "COMPANY_BRANCH_CODE_INVALID");
  for (const [f, label] of [["name", "Company Name"], ["tin", "TIN"], ["address", "Address"], ["zip", "ZIP"], ["telephone", "Telephone"], ["email", "Email"], ["branchCode", "BIR Branch Code"]]) {
    if (out[f] && out[f].length > LIMITS[f]) throw bad(`${label} must be at most ${LIMITS[f]} characters.`, `COMPANY_${f.replace(/[A-Z]/g, (m) => `_${m}`).toUpperCase()}_TOO_LONG`);
  }
  if (out.email && !EMAIL_RE.test(out.email)) throw bad("Email is not a valid email address.", "COMPANY_EMAIL_INVALID");
  return out;
}

const SUMMARY_SQL = `
  SELECT c.id, c.name, c.tin, c.branch_code AS branchCode, UPPER(c.status) AS status, c.created_at AS createdAt,
         (SELECT COUNT(*) FROM branches b WHERE b.company_id = c.id) AS branchCount,
         (SELECT COUNT(*) FROM user_companies uc WHERE uc.company_id = c.id) AS userCount,
         (SELECT cu.currency_code FROM currencies cu WHERE cu.company_id = c.id AND cu.is_base_currency = 1 LIMIT 1) AS baseCurrency
  FROM companies c`;

async function listCompanies() {
  const [rows] = await pool.execute(`${SUMMARY_SQL} ORDER BY c.name, c.id`);
  return rows.map((r) => ({ ...r, branchCount: Number(r.branchCount), userCount: Number(r.userCount) }));
}

async function createCompany(user, body) {
  const f = validate(body);
  const conn = await pool.getConnection();
  let locked = false;
  try {
    // Two concurrent creates of the same company cannot both pass the duplicate check.
    const [[lock]] = await conn.query("SELECT GET_LOCK(?, 10) AS ok", [LOCK]);
    if (Number(lock.ok) !== 1) throw new HttpError(503, "Another company is being created - please try again.", "COMPANY_CREATE_BUSY");
    locked = true;
    await conn.beginTransaction();

    // There is no unique constraint on companies; the identifiers are checked here:
    // the name (case- and space-insensitive) and the TIN + BIR branch code pair.
    const [sameName] = await conn.execute("SELECT id FROM companies WHERE LOWER(TRIM(name)) = LOWER(?) LIMIT 1", [f.name]);
    if (sameName.length) throw new HttpError(409, "A company with this name already exists.", "COMPANY_NAME_DUPLICATE");
    const [tins] = await conn.execute("SELECT id, tin, branch_code FROM companies WHERE tin IS NOT NULL AND tin <> ''");
    if (tins.some((r) => digits(r.tin) === digits(f.tin) && digits(r.branch_code) === digits(f.branchCode))) {
      throw new HttpError(409, "A company with this TIN and BIR branch code already exists.", "COMPANY_TIN_DUPLICATE");
    }

    const [r] = await conn.execute(
      `INSERT INTO companies (name, tin, address, zip, telephone, email, vat_registered, branch_code, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
      [f.name, f.tin, f.address, f.zip, f.telephone, f.email, f.vatRegistered ? 1 : 0, f.branchCode]
    );
    const companyId = r.insertId;
    // The base currency every company must have - the same row currencies_migration.sql seeds.
    await conn.execute(
      `INSERT INTO currencies (
         company_id, currency_code, currency_name, currency_symbol, iso_numeric_code,
         symbol_position, space_after_symbol, decimal_places, decimal_separator, thousand_separator,
         default_rate_mode, is_base_currency, is_active, current_rate, notes)
       VALUES (?, 'PHP', 'Philippine Peso', '₱', '608', 'BEFORE', 0, 2, '.', ',', 'BASE', 1, 1, 1.0000000000,
               'Base currency created with the company (Company Management).')`,
      [companyId]
    );
    const [[created]] = await conn.execute(`${SUMMARY_SQL} WHERE c.id = ?`, [companyId]);
    await audit.logAudit(conn, {
      module: "COMPANY",
      entityType: "COMPANY",
      entityId: companyId,
      action: "CREATE",
      description: `Company ${f.name} created`,
      afterData: { id: companyId, name: f.name, tin: f.tin, branchCode: f.branchCode, vatRegistered: f.vatRegistered, status: "ACTIVE", baseCurrency: "PHP" },
      user,
      companyId,
    });
    await conn.commit();
    return {
      id: companyId, name: created.name, tin: created.tin, branchCode: created.branchCode,
      address: f.address, zip: f.zip, telephone: f.telephone, email: f.email, vatRegistered: f.vatRegistered,
      status: created.status, baseCurrency: created.baseCurrency, branchCount: 0, userCount: 0, createdAt: created.createdAt,
    };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    if (locked) await conn.query("SELECT RELEASE_LOCK(?)", [LOCK]).catch(() => {});
    conn.release();
  }
}

module.exports = { listCompanies, createCompany, validate, LIMITS };
