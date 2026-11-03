const { normalizeIdentifier, daysBetween, shiftDate, round2 } = require("./ConfidenceScoringService");

// One-to-many deposit matching (R8.4-B): which combinations of ORs add up
// EXACTLY to one bank deposit. Pure and bounded - it only proposes; the
// confirmation service decides (bankReconMatchService.confirmMatch).
//
// Candidates for a deposit are posted ORs of the session's company + bank
// account that are money IN, not reconciled anywhere (the same pool the
// one-to-one matcher uses, so carried-forward ORs are included), in the
// company's base currency, dated from LOOKBACK before the deposit up to the
// date tolerance after it, and each smaller than the deposit.
//
// Explicit limits - the search never explodes or times out:
//   MAX_POOL          receipts considered (closest to the deposit date first)
//   MAX_SIZE          ORs in one combination
//   MAX_COMBINATIONS  exact-sum combinations collected
//   MAX_STEPS         search steps
//   MAX_CONFIDENT_SIZE largest combination that can ever be high confidence
//   CLOSE_DAYS        a receipt dated further than this (or the session's
//                     date tolerance, if larger) before the deposit is a
//                     weak date
// Hitting any limit is reported (limitReached / poolTruncated) and the
// deposit goes to manual review instead of being guessed.
const LIMITS = Object.freeze({
  MAX_POOL: 25,
  MAX_SIZE: 4,
  MAX_COMBINATIONS: 20,
  MAX_STEPS: 50000,
  LOOKBACK_DAYS: 7,
  MAX_CONFIDENT_SIZE: 3,
  CLOSE_DAYS: 3,
});

const GROUP_LEVEL = { GROUP_REFERENCE: "GROUP_REFERENCE", GROUP_AMOUNT: "GROUP_AMOUNT" };

const cents = (n) => Math.round(Number(n) * 100);

// ORs eligible to be combined for this deposit (before the date window):
// money-in ORs not reconciled anywhere, in the company's base currency.
function depositPool(bookTxns, confirmedKeys) {
  return bookTxns.filter((t) =>
    t.sourceType === "OR"
    && t.direction === "IN"
    && !t.foreignCurrency
    && !confirmedKeys.has(`${t.sourceType}:${t.sourceId}:${t.lineId ?? ""}`));
}

// Statement text the ORs' own numbers are looked for in. Not the check
// column: a check number is never a receipt or document number (R9).
function statementText(line) {
  return [line.description, line.referenceNo, line.bankReference].filter(Boolean).join(" ").toLowerCase();
}

function namesReceipt(text, or) {
  const ids = [or.voucherNo, or.receiptNo, or.referenceNo]
    .map((v) => normalizeIdentifier(v || ""))
    .filter((v) => v.length >= 4);
  return ids.some((id) => text.includes(id) || text.includes(String(id).replace(/^0+/, "")));
}

function findDepositCombinations(line, pool, session, limits = LIMITS) {
  const target = cents(line.credit);
  const tolerance = Number(session.dateToleranceDays) || 0;
  const lookback = Math.max(limits.LOOKBACK_DAYS, tolerance * 2);
  const from = shiftDate(line.txnDate, -lookback);
  const to = shiftDate(line.txnDate, tolerance);

  const inWindow = pool
    .filter((t) => t.date >= from && t.date <= to && cents(t.amount) > 0 && cents(t.amount) < target)
    .sort((a, b) => daysBetween(a.date, line.txnDate) - daysBetween(b.date, line.txnDate) || a.sourceId - b.sourceId);
  const poolTruncated = inWindow.length > limits.MAX_POOL;
  const items = inWindow.slice(0, limits.MAX_POOL).sort((a, b) => cents(b.amount) - cents(a.amount) || a.sourceId - b.sourceId);
  const amounts = items.map((t) => cents(t.amount));

  const found = [];
  let steps = 0;
  let limitReached = false;
  const chosen = [];
  (function search(start, sum) {
    if (limitReached) return;
    steps += 1;
    if (steps > limits.MAX_STEPS) {
      limitReached = true;
      return;
    }
    if (sum === target && chosen.length >= 2) {
      found.push(chosen.map((i) => items[i]));
      if (found.length >= limits.MAX_COMBINATIONS) limitReached = true;
      return;
    }
    if (chosen.length === limits.MAX_SIZE) return;
    const slots = limits.MAX_SIZE - chosen.length;
    for (let i = start; i < items.length && !limitReached; i++) {
      const a = amounts[i];
      if (sum + a > target) continue;
      // sorted largest first: if even `slots` copies of this amount cannot
      // reach the target, no later (smaller) item can either.
      if (sum + a * slots < target) break;
      chosen.push(i);
      search(i + 1, sum + a);
      chosen.pop();
    }
  })(0, 0);

  const text = statementText(line);
  const closeDays = Math.max(limits.CLOSE_DAYS, tolerance);
  const namedInWindow = inWindow.filter((t) => namesReceipt(text, t));
  const combos = found.map((members) => {
    const named = members.filter((m) => namesReceipt(text, m)).length;
    const memberKeys = new Set(members.map((m) => m.sourceId));
    const avgDays = members.reduce((s, m) => s + daysBetween(m.date, line.txnDate), 0) / members.length;
    const dateScore = round2(20 * Math.max(0, 1 - avgDays / lookback));
    const referenceScore = round2(25 * (named / members.length));
    const sizePenalty = 5 * (members.length - 2);
    return {
      members: [...members].sort((a, b) => a.date.localeCompare(b.date) || a.sourceId - b.sourceId),
      totalCents: target,
      level: named === members.length ? GROUP_LEVEL.GROUP_REFERENCE : GROUP_LEVEL.GROUP_AMOUNT,
      namedCount: named,
      // the statement names a receipt that is NOT in this combination
      inconsistentReference: namedInWindow.some((t) => !memberKeys.has(t.sourceId)),
      weakDates: members.some((m) => daysBetween(m.date, line.txnDate) > closeDays),
      score: round2(Math.min(100, 50 + dateScore + referenceScore - sizePenalty)),
      breakdown: { amountScore: 50, dateScore, referenceScore, sizePenalty },
    };
  }).sort((a, b) => b.score - a.score || a.members.length - b.members.length);

  return { combos, limitReached, poolTruncated, considered: items.length, steps };
}

// A combination is strong (EXACT, high confidence) only when the statement
// names every receipt in it and no other, the receipts are dated close to
// the deposit and it is not unusually large. An exact sum alone is never
// strong.
function isStrong(c, limits = LIMITS) {
  return c.level === GROUP_LEVEL.GROUP_REFERENCE
    && !c.inconsistentReference
    && !c.weakDates
    && c.members.length <= limits.MAX_CONFIDENT_SIZE;
}

// EXACT only for the single strong combination the statement itself names;
// several plausible combinations are AMBIGUOUS (the accountant chooses);
// anything weaker is a suggestion to review. At most `keep` alternatives
// are proposed.
function classifyCombinations(result, keep = 3) {
  const { combos, limitReached, poolTruncated } = result;
  if (!combos.length) return [];
  const named = combos.filter((c) => c.level === GROUP_LEVEL.GROUP_REFERENCE);
  if (!limitReached && named.length === 1) return [{ ...named[0], matchType: isStrong(named[0]) ? "EXACT" : "SUGGESTED" }];
  if (combos.length === 1 && !limitReached && !poolTruncated) {
    return [{ ...combos[0], matchType: isStrong(combos[0]) ? "EXACT" : "SUGGESTED" }];
  }
  const reason = limitReached || poolTruncated
    ? "the search limit was reached - more combinations may exist"
    : "multiple possible combinations found";
  return combos.slice(0, keep).map((c) => ({ ...c, matchType: "AMBIGUOUS", ambiguous: reason }));
}

module.exports = { LIMITS, GROUP_LEVEL, depositPool, findDepositCombinations, classifyCombinations, namesReceipt, statementText };
