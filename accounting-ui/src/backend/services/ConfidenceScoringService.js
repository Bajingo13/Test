// ---- Matching engine (Phase 5, compute-only) ----
// Deterministic weighted-rule scoring. Only CV, OR, and JV touch a bank
// account directly (invoice_headers/apv_headers have no bank_account_id -
// they're AR/AP documents; a paid invoice shows up here as the OR that
// applied against it, per the existing transaction_applications design).

function normalizeIdentifier(value) {
  if (!value) return "";
  return String(value).trim().toLowerCase().replace(/^0+(?=\d)/, "");
}

function tokenize(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2)
  );
}

function jaccardSimilarity(a, b) {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Both sides of every date diff here are plain 'YYYY-MM-DD' strings pulled
// via SQL DATE_FORMAT (see loadBookTransactions/statement-lines queries),
// so anchoring to UTC midnight here is safe and never drifts a day.
function daysBetween(dateStrA, dateStrB) {
  const a = new Date(`${dateStrA}T00:00:00Z`);
  const b = new Date(`${dateStrB}T00:00:00Z`);
  return Math.round(Math.abs(a - b) / 86400000);
}

function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().split("T")[0];
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Returns null when the candidate falls outside 2x the amount variance or
// 2x the date tolerance (excluded entirely), otherwise a scored candidate.
function scoreCandidate(stmtLine, bookTxn, session) {
  const stmtAmount = Number(stmtLine.debit) > 0 ? Number(stmtLine.debit) : Number(stmtLine.credit);
  const bookAmount = bookTxn.amount;
  const amountDiff = Math.abs(stmtAmount - bookAmount);

  const varianceEdge =
    session.amountVarianceType === "PERCENT"
      ? stmtAmount * (Number(session.amountVarianceValue) / 100)
      : Number(session.amountVarianceValue);

  let amountScore = 0;
  if (amountDiff === 0) {
    amountScore = 40;
  } else if (varianceEdge > 0 && amountDiff <= varianceEdge) {
    amountScore = 40 * (1 - amountDiff / varianceEdge);
  } else if (varianceEdge > 0 && amountDiff <= varianceEdge * 2) {
    amountScore = 0;
  } else {
    return null;
  }

  const tolerance = Number(session.dateToleranceDays) || 0;
  const dateDiffDays = daysBetween(stmtLine.txnDate, bookTxn.date);

  let dateScore = 0;
  if (dateDiffDays === 0) {
    dateScore = 20;
  } else if (tolerance > 0 && dateDiffDays <= tolerance) {
    dateScore = 20 * (1 - dateDiffDays / tolerance);
  } else if (tolerance > 0 && dateDiffDays <= tolerance * 2) {
    dateScore = 0;
  } else {
    return null;
  }

  const stmtIdentifiers = [stmtLine.referenceNo, stmtLine.checkNo]
    .map(normalizeIdentifier)
    .filter(Boolean);
  const bookIdentifiers = [bookTxn.referenceNo, bookTxn.checkNo, bookTxn.receiptNo]
    .map(normalizeIdentifier)
    .filter(Boolean);

  let identifierScore = 0;
  let identifierExact = false;

  if (stmtIdentifiers.length && bookIdentifiers.length) {
    if (stmtIdentifiers.some((s) => bookIdentifiers.includes(s))) {
      identifierScore = 25;
      identifierExact = true;
    } else if (
      stmtIdentifiers.some((s) =>
        bookIdentifiers.some(
          (b) => s.length >= 3 && b.length >= 3 && (s.includes(b) || b.includes(s))
        )
      )
    ) {
      identifierScore = 10;
    }
  }

  const stmtDescNormalized = normalizeIdentifier(stmtLine.description);
  const bookNameNormalized = normalizeIdentifier(bookTxn.payeeOrCustomer);

  let payeeScore = 0;
  if (bookNameNormalized) {
    if (stmtDescNormalized === bookNameNormalized) {
      payeeScore = 10;
    } else if (bookNameNormalized.length >= 3 && stmtDescNormalized.includes(bookNameNormalized)) {
      payeeScore = 5;
    }
  }

  const descScore = jaccardSimilarity(stmtLine.description, bookTxn.description) * 5;

  const totalScore = Math.min(
    100,
    amountScore + dateScore + identifierScore + payeeScore + descScore
  );

  // Amount(40) + date(20) + identifier(25) only sum to 85 of the 100
  // possible points, so requiring totalScore >= 95 on top of these three
  // being individually perfect would demand bonus payee/description
  // similarity too - something free-text bank statement wording routinely
  // lacks even on a genuinely exact match. EXACT is defined by the three
  // conditions themselves, not an unreachable extra score floor.
  const hasStmtIdentifier = stmtIdentifiers.length > 0;
  const isExact =
    amountDiff === 0 && dateDiffDays === 0 && (identifierExact || !hasStmtIdentifier);

  return {
    ...bookTxn,
    totalScore: round2(totalScore),
    matchType: isExact ? "EXACT" : "SUGGESTED",
    breakdown: {
      amountScore: round2(amountScore),
      dateScore: round2(dateScore),
      identifierScore,
      payeeScore,
      descScore: round2(descScore),
    },
  };
}

// ---- Outstanding items + adjustment suggestions (Phase 7) ----

const BANK_CHARGE_KEYWORDS = [
  "service charge",
  "bank charge",
  "maintaining balance",
  "debit memo",
  "atm fee",
];
const INTEREST_INCOME_KEYWORDS = ["interest", "int income", "credit memo interest"];

// Every statement line the matching engine can't explain becomes something
// the user must explicitly decide on - a guessed BANK_CHARGE/INTEREST_INCOME
// via keyword match, or OTHER when no keyword hits. Never auto-approved.
function classifyAdjustmentSuggestion(line) {
  const desc = String(line.description || "").toLowerCase();
  const isDebit = Number(line.debit) > 0;
  const isCredit = Number(line.credit) > 0;

  if (isDebit && BANK_CHARGE_KEYWORDS.some((kw) => desc.includes(kw))) {
    return { adjustmentType: "BANK_CHARGE", amount: Number(line.debit) };
  }
  if (isCredit && INTEREST_INCOME_KEYWORDS.some((kw) => desc.includes(kw))) {
    return { adjustmentType: "INTEREST_INCOME", amount: Number(line.credit) };
  }

  return { adjustmentType: "OTHER", amount: isDebit ? Number(line.debit) : Number(line.credit) };
}

module.exports = {
  normalizeIdentifier,
  tokenize,
  jaccardSimilarity,
  daysBetween,
  shiftDate,
  round2,
  scoreCandidate,
  BANK_CHARGE_KEYWORDS,
  INTEREST_INCOME_KEYWORDS,
  classifyAdjustmentSuggestion,
};
