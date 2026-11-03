const { normalizeIdentifier, shiftDate, daysBetween, bookKey } = require("./ConfidenceScoringService");

// R10: deposit slip proposals for the matching engine (pure except the one
// loading query). Priority order for a statement deposit:
//   1. a DEPOSITED slip of this company + bank account the statement names
//      (deposit number in the description / reference / bank reference) with
//      the exact total                                        -> EXACT
//   2. the only DEPOSITED slip with the exact total, deposited within the
//      date window, when the statement names no other slip     -> EXACT
//      several such slips                                      -> AMBIGUOUS
//   3. otherwise the existing one-to-one / R8.4-B combination matching.
// A slip is only proposed while all its documents are still unreconciled
// bank items of this bank account with their recorded amounts.

const DEPOSIT_SLIP_LEVEL = "DEPOSIT_SLIP";
const cents = (n) => Math.round(Number(n) * 100);

// Deposited slips of the session's company + bank account. slips: those whose
// documents are still unreconciled book items with unchanged amounts.
// memberKeys: the documents of every deposited slip, usable or not - they are
// matched through their slip only, so they are never proposed on their own.
async function loadDepositedSlips(conn, session, bookTxns, confirmedKeys) {
  if (!session.companyId) return { slips: [], memberKeys: new Set() };
  const [rows] = await conn.execute(
    `SELECT s.id, s.deposit_no AS depositNo, DATE_FORMAT(s.deposit_date, '%Y-%m-%d') AS depositDate, s.total_amount AS total,
            l.source_type AS sourceType, COALESCE(l.or_id, l.cv_id) AS sourceId, l.amount
     FROM deposit_slips s JOIN deposit_slip_lines l ON l.deposit_slip_id = s.id AND l.released_at IS NULL
     WHERE s.company_id = ? AND s.bank_account_id = ? AND s.status = 'DEPOSITED'
     ORDER BY s.id, l.id`,
    [session.companyId, session.bankAccountId]
  );
  const byKey = new Map(bookTxns.map((t) => [bookKey(t), t]));
  const slips = new Map();
  for (const r of rows) {
    if (!slips.has(r.id)) slips.set(r.id, { id: r.id, depositNo: r.depositNo, depositDate: r.depositDate, totalCents: cents(r.total), lines: [] });
    slips.get(r.id).lines.push(r);
  }
  const out = [];
  for (const s of slips.values()) {
    const members = s.lines.map((l) => byKey.get(`${l.sourceType}:${l.sourceId}:`));
    const usable = members.every((m, i) => m && !confirmedKeys.has(bookKey(m)) && m.direction === "IN" && cents(m.amount) === cents(s.lines[i].amount))
      && members.reduce((sum, m) => sum + cents(m.amount), 0) === s.totalCents;
    if (usable) out.push({ ...s, members });
  }
  return { slips: out, memberKeys: new Set(rows.map((r) => `${r.sourceType}:${r.sourceId}:`)) };
}

// The statement's check column holds check numbers, so it never names a slip.
const statementIds = (line) => [line.description, line.referenceNo, line.bankReference]
  .filter(Boolean).map((v) => String(v).toLowerCase());

// "DS-00125" named on the statement: the whole number (as typed, or as DS125
// / DS 00125) anywhere in the text, or 00125 / 125 as a reference column's
// whole value - never digits that happen to follow "ds" inside another word
// ("FUNDS 125") or a longer number ("DS1250").
function namesSlip(line, depositNo) {
  const digits = depositNo.toLowerCase().replace(/^ds-?/, "");
  const stripped = digits.replace(/^0+/, "");
  const whole = new RegExp(`(^|[^a-z0-9])ds[\\s-]*0*${stripped}(?![a-z0-9])`);
  if (statementIds(line).some((t) => whole.test(t))) return true;
  const refs = [line.referenceNo, line.bankReference].filter(Boolean).map((v) => normalizeIdentifier(String(v)));
  return stripped.length >= 3 && refs.some((r) => r === stripped || r === digits);
}

function proposeSlipMatches(stmtLines, slips, session) {
  const tolerance = Number(session.dateToleranceDays) || 0;
  const after = Math.max(7, tolerance * 2); // a bank may credit a deposit a few days later
  const proposals = new Map();
  for (const line of stmtLines) {
    if (!(Number(line.credit) > 0) || !slips.length) continue;
    const target = cents(line.credit);
    const named = slips.filter((s) => namesSlip(line, s.depositNo));
    let chosen = [];
    let evidence;
    const sameAmount = (s) => s.totalCents === target;
    if (named.length) {
      chosen = named.filter(sameAmount);
      evidence = "DEPOSIT_REFERENCE";
    } else {
      chosen = slips.filter((s) => sameAmount(s)
        && line.txnDate >= shiftDate(s.depositDate, -tolerance) && line.txnDate <= shiftDate(s.depositDate, after));
      evidence = "AMOUNT_DATE";
    }
    if (!chosen.length) continue;
    proposals.set(line.id, chosen.map((s, i) => ({
      members: s.members,
      level: DEPOSIT_SLIP_LEVEL,
      totalCents: s.totalCents,
      namedCount: 0,
      matchType: chosen.length === 1 ? "EXACT" : "AMBIGUOUS",
      ...(chosen.length > 1 ? { ambiguous: "more than one deposit slip fits" } : {}),
      score: evidence === "DEPOSIT_REFERENCE" ? 100 : Math.max(60, 95 - 5 * daysBetween(s.depositDate, line.txnDate)),
      breakdown: { depositSlipId: s.id, depositNo: s.depositNo, depositDate: s.depositDate, evidence, option: i + 1 },
    })));
  }
  // One slip proposed for two statement lines is ambiguous for both.
  const linesBySlip = new Map();
  for (const [lineId, groups] of proposals) {
    for (const g of groups) linesBySlip.set(g.breakdown.depositSlipId, [...(linesBySlip.get(g.breakdown.depositSlipId) || []), lineId]);
  }
  for (const [lineId, groups] of proposals) {
    proposals.set(lineId, groups.map((g) => (g.matchType === "EXACT" && linesBySlip.get(g.breakdown.depositSlipId).length > 1
      ? { ...g, matchType: "AMBIGUOUS", ambiguous: "this deposit slip fits more than one statement deposit" }
      : g)));
  }
  return proposals;
}

module.exports = { DEPOSIT_SLIP_LEVEL, loadDepositedSlips, proposeSlipMatches, namesSlip };
