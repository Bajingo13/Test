// TEST-ONLY helper (like testDatabaseGuard.js). Never required by app code.
//
// P1 (server-side party rule, services/transactionPartyService.js): the
// bank-reconciliation / payment-detail suites post ORs, CVs and other
// documents through the real API purely as bank-movement fixtures and never
// sent a party. The server now requires the right General Library party on
// every Invoice / OR / APV / CV / PO / Debit Memo / Credit Memo, so a fixture
// document body that names NO party at all is given its company's fixture
// customer (AR documents) or supplier (AP documents). A body that already
// names a party is passed through untouched, so the rule itself is still
// exercised by every test that deliberately sends a (wrong / missing) party.

const AR_PATH = /^\/api\/(or|invoices)(\/|$)/;
const AP_PATH = /^\/api\/(cv|apv|purchase-orders)(\/|$)/;
const MEMO_PATH = /^\/api\/(debit-memos|credit-memos)(\/|$)/;
const PARTY_KEYS = ["customerId", "supplierId", "payeeId", "partyId"];
const cache = new Map();

async function fixtureParty(pool, companyId, type) {
  const key = `${companyId}:${type}`;
  if (cache.has(key)) return cache.get(key);
  const code = `P1FIX-${type.slice(0, 1)}-${companyId}`;
  const [existing] = await pool.query("SELECT id FROM general_libraries WHERE code = ? AND company_id = ?", [code, companyId]);
  const id = existing.length
    ? existing[0].id
    : (await pool.query(
        "INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, ?, ?, ?, 'ACTIVE')",
        [companyId, code, type, `Fixture ${type === "CUSTOMER" ? "Customer" : "Supplier"} ${companyId}`]
      ))[0].insertId;
  cache.set(key, id);
  return id;
}

async function withFixtureParty(pool, method, url, body) {
  if (!body || typeof body !== "object" || !["post", "put"].includes(String(method).toLowerCase())) return body;
  const path = String(url).split("?")[0];
  const isAr = AR_PATH.test(path), isAp = AP_PATH.test(path), isMemo = MEMO_PATH.test(path);
  if (!isAr && !isAp && !isMemo) return body;
  if (/\/(cancel|void|reverse|email|apply)/.test(path)) return body;
  if (PARTY_KEYS.some((k) => body[k] !== undefined && body[k] !== null && body[k] !== "")) return body;
  const companyId = Number(body.currency?.companyId ?? body.companyId);
  if (!companyId) return body;
  const type = isAr || isMemo ? "CUSTOMER" : "SUPPLIER";
  const id = await fixtureParty(pool, companyId, type);
  return isAr ? { ...body, customerId: id } : isMemo ? { ...body, partyId: id } : { ...body, supplierId: id, payeeId: id };
}

async function cleanupFixtureParties(pool, companyIds) {
  const ids = (companyIds || []).filter(Boolean);
  for (const k of [...cache.keys()]) if (ids.includes(Number(k.split(":")[0]))) cache.delete(k);
  if (!ids.length) return;
  await pool.query("DELETE FROM general_libraries WHERE company_id IN (?) AND code LIKE 'P1FIX-%'", [ids]);
}

module.exports = { fixtureParty, withFixtureParty, cleanupFixtureParties };
