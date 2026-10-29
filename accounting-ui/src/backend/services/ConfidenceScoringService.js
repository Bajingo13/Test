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

// ---- Match evidence levels (R7-4) ----
// EXACT needs deterministic evidence, never amount + date alone:
//   CHECK_NO  - a statement identifier equals the book check number, and
//               the amount is identical;
//   REFERENCE - a statement identifier equals the book document number
//               (OR/CV/JV voucher no., OR receipt no., reference no.), and
//               the amount is identical.
// Everything else is a suggestion: AMOUNT_DATE (identical amount, date
// within tolerance) or FUZZY. Identifiers shorter than
// MIN_IDENTIFIER_LENGTH after normalization ("1", "07") are too weak to be
// evidence. classifyLineCandidates / markCrossLineAmbiguity turn EXACT into
// AMBIGUOUS whenever the evidence does not single out one pairing.
const MATCH_LEVEL = {
  CHECK_NO: "CHECK_NO",
  REFERENCE: "REFERENCE",
  AMOUNT_DATE: "AMOUNT_DATE",
  FUZZY: "FUZZY",
};
const STRICT_EXACT_LEVELS = [MATCH_LEVEL.CHECK_NO, MATCH_LEVEL.REFERENCE];
const MIN_IDENTIFIER_LENGTH = 3;

function strongIdentifiers(values) {
  return values.map(normalizeIdentifier).filter((v) => v.length >= MIN_IDENTIFIER_LENGTH);
}

// Returns null when the candidate falls outside 2x the amount variance or
// 2x the date tolerance (excluded entirely), otherwise a scored candidate.
function scoreCandidate(stmtLine, bookTxn, session) {
  const stmtAmount = Number(stmtLine.debit) > 0 ? Number(stmtLine.debit) : Number(stmtLine.credit);
  const bookAmount = bookTxn.amount;
  const amountDiff = round2(Math.abs(stmtAmount - bookAmount));

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

  // Banks put the check number in either column, so both statement
  // identifiers are compared with both kinds of book identifier.
  const stmtIdentifiers = strongIdentifiers([stmtLine.referenceNo, stmtLine.checkNo]);
  const bookCheckIds = strongIdentifiers([bookTxn.checkNo]);
  const bookDocumentIds = strongIdentifiers([bookTxn.voucherNo, bookTxn.receiptNo, bookTxn.referenceNo]);
  const bookIdentifiers = [...bookCheckIds, ...bookDocumentIds];

  const checkNoExact = stmtIdentifiers.some((s) => bookCheckIds.includes(s));
  const documentExact = stmtIdentifiers.some((s) => bookDocumentIds.includes(s));

  let identifierScore = 0;

  if (stmtIdentifiers.length && bookIdentifiers.length) {
    if (checkNoExact || documentExact) {
      identifierScore = 25;
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

  // EXACT is defined by the evidence itself (identical amount + an exact
  // check / document identifier), not by a score floor - the score only
  // orders suggestions. The date only has to fall inside the candidate
  // window above: a check can clear days after it was issued.
  let matchLevel = MATCH_LEVEL.FUZZY;
  if (amountDiff === 0 && checkNoExact) matchLevel = MATCH_LEVEL.CHECK_NO;
  else if (amountDiff === 0 && documentExact) matchLevel = MATCH_LEVEL.REFERENCE;
  else if (amountDiff === 0 && dateDiffDays <= tolerance) matchLevel = MATCH_LEVEL.AMOUNT_DATE;

  const isExact = STRICT_EXACT_LEVELS.includes(matchLevel);

  return {
    ...bookTxn,
    totalScore: round2(totalScore),
    matchType: isExact ? "EXACT" : "SUGGESTED",
    matchLevel,
    breakdown: {
      amountScore: round2(amountScore),
      dateScore: round2(dateScore),
      identifierScore,
      payeeScore,
      descScore: round2(descScore),
      matchLevel,
    },
  };
}

function bookKey(t) {
  return `${t.sourceType}:${t.sourceId}:${t.lineId ?? ""}`;
}

// Per statement line: best first, at most `limit` kept. More than one
// EXACT candidate means the evidence points at several documents, so none
// of them is EXACT - they become AMBIGUOUS and need a human choice.
function classifyLineCandidates(scored, limit = 3) {
  const ranked = scored.filter(Boolean).sort((a, b) => b.totalScore - a.totalScore);
  const exactCount = ranked.filter((c) => c.matchType === "EXACT").length;
  const classified = exactCount > 1
    ? ranked.map((c) => (c.matchType === "EXACT" ? markAmbiguous(c, "several documents match this statement line") : c))
    : ranked;
  return classified.slice(0, limit);
}

// Across statement lines: one book document EXACT for two lines (e.g. the
// same deposit listed twice) cannot be EXACT for either. Mutates the
// per-line arrays produced by classifyLineCandidates.
function markCrossLineAmbiguity(candidatesByLine) {
  const exactLines = new Map();
  for (const [lineId, cands] of candidatesByLine) {
    for (const c of cands) {
      if (c.matchType !== "EXACT") continue;
      const k = bookKey(c);
      exactLines.set(k, [...(exactLines.get(k) || []), lineId]);
    }
  }
  for (const [lineId, cands] of candidatesByLine) {
    candidatesByLine.set(
      lineId,
      cands.map((c) => (c.matchType === "EXACT" && exactLines.get(bookKey(c)).length > 1
        ? markAmbiguous(c, "this document matches several statement lines")
        : c))
    );
  }
  return candidatesByLine;
}

function markAmbiguous(c, reason) {
  return { ...c, matchType: "AMBIGUOUS", breakdown: { ...c.breakdown, ambiguous: reason } };
}

// Bulk confirmation only trusts a stored EXACT row whose own breakdown
// records strict evidence - rows written before R7 (amount + date EXACT)
// carry no matchLevel and are never bulk-confirmed.
function isStrictExactRow(matchType, scoreBreakdown) {
  if (matchType !== "EXACT") return false;
  let breakdown = scoreBreakdown;
  if (typeof breakdown === "string") {
    try {
      breakdown = JSON.parse(breakdown);
    } catch {
      return false;
    }
  }
  return Boolean(breakdown) && STRICT_EXACT_LEVELS.includes(breakdown.matchLevel) && !breakdown.ambiguous;
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
  MATCH_LEVEL,
  STRICT_EXACT_LEVELS,
  bookKey,
  classifyLineCandidates,
  markCrossLineAmbiguity,
  isStrictExactRow,
  BANK_CHARGE_KEYWORDS,
  INTEREST_INCOME_KEYWORDS,
  classifyAdjustmentSuggestion,
};
