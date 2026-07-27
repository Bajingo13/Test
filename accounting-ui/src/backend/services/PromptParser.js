// Small deterministic helpers the agent's tool handlers use to validate and
// normalize the parameters Claude extracts from a prompt. Claude does the
// actual natural-language work (which bank account, which month) by
// reasoning over tool-provided data and the current date in the system
// prompt - these helpers exist so a malformed or ambiguous date never
// reaches SQL, and so "July 2026" -> a correct period-end (leap years,
// 30 vs 31 day months) doesn't have to be reasoned about token-by-token.

function isValidIsoDate(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !isNaN(new Date(`${value}T00:00:00Z`))
  );
}

function lastDayOfMonth(year, month) {
  // Day 0 of the next month is the last day of this month (UTC-anchored).
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Accepts either explicit periodStart/periodEnd (YYYY-MM-DD) or a
// month+year shorthand and returns a validated { periodStart, periodEnd }.
function resolveDateRange({ periodStart, periodEnd, month, year }) {
  if (periodStart || periodEnd) {
    if (!isValidIsoDate(periodStart) || !isValidIsoDate(periodEnd)) {
      throw new Error("periodStart and periodEnd must both be YYYY-MM-DD dates");
    }
    if (periodEnd < periodStart) {
      throw new Error("periodEnd cannot be before periodStart");
    }
    return { periodStart, periodEnd };
  }

  if (month && year) {
    const m = Number(month);
    const y = Number(year);

    if (!Number.isInteger(m) || m < 1 || m > 12) {
      throw new Error("month must be an integer between 1 and 12");
    }
    if (!Number.isInteger(y) || y < 2000 || y > 2100) {
      throw new Error("year must be a plausible 4-digit year");
    }

    const mm = String(m).padStart(2, "0");
    const lastDay = lastDayOfMonth(y, m);

    return {
      periodStart: `${y}-${mm}-01`,
      periodEnd: `${y}-${mm}-${String(lastDay).padStart(2, "0")}`,
    };
  }

  throw new Error("Provide either periodStart+periodEnd or month+year");
}

function todayIso() {
  return new Date().toISOString().split("T")[0];
}

// ---- Deterministic NLU for AI_PROVIDER=mock/local (no LLM involved) ----
// Regex/keyword extraction only. This is deliberately not full natural-
// language understanding - it covers the prompt shapes the module was
// asked to support, and returns UNKNOWN with a helpful menu rather than
// guessing when a prompt doesn't match anything recognized.

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenSet(value) {
  return new Set(normalizeText(value).split(" ").filter(Boolean));
}

// Fuzzy-matches free text like "BDO Account 001" or "BPI Payroll Account"
// against the bank_codes list. Exact code/account-number containment scores
// highest, then full-name containment, then token overlap.
function findBankAccount(bankAccounts, query) {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return null;

  const queryTokens = tokenSet(query);
  let best = null;
  let bestScore = 0;

  for (const acct of bankAccounts) {
    const codeNormalized = normalizeText(acct.bankCode);
    const acctNoNormalized = normalizeText(acct.accountNo);
    const nameNormalized = normalizeText(acct.bankName);
    const nameTokens = tokenSet(acct.bankName);

    let score = 0;

    if (codeNormalized && normalizedQuery.includes(codeNormalized)) score += 50;
    if (acctNoNormalized && normalizedQuery.includes(acctNoNormalized)) score += 50;
    if (
      nameNormalized &&
      (normalizedQuery.includes(nameNormalized) || nameNormalized.includes(normalizedQuery))
    ) {
      score += 40;
    }

    let overlap = 0;
    for (const t of queryTokens) {
      if (t.length > 1 && nameTokens.has(t)) overlap++;
    }
    score += overlap * 10;

    if (score > bestScore) {
      bestScore = score;
      best = acct;
    }
  }

  return bestScore >= 10 ? { account: best, score: bestScore } : null;
}

function extractMonthYear(text) {
  const monthPattern = MONTH_NAMES.join("|");
  const asOfMatch = text.match(
    new RegExp(`as of (${monthPattern})\\s+(\\d{1,2}),?\\s+(\\d{4})`, "i")
  );
  if (asOfMatch) {
    const month = MONTH_NAMES.indexOf(asOfMatch[1].toLowerCase()) + 1;
    const day = Number(asOfMatch[2]);
    const year = Number(asOfMatch[3]);
    const mm = String(month).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    return { periodEnd: `${year}-${mm}-${dd}`, month, year, isAsOf: true };
  }

  const monthYearMatch = text.match(new RegExp(`(${monthPattern})\\s+(\\d{4})`, "i"));
  if (monthYearMatch) {
    const month = MONTH_NAMES.indexOf(monthYearMatch[1].toLowerCase()) + 1;
    const year = Number(monthYearMatch[2]);
    return { month, year, isAsOf: false };
  }

  return null;
}

function extractToleranceDays(text) {
  const m = text.match(/(\d+)\s*[- ]?\s*day(?:s)?\s*(?:tolerance|window)?/i) ||
    text.match(/within\s+(\d+)\s*days?/i);
  return m ? Number(m[1]) : null;
}

function extractAmountVariance(text) {
  // Handles both orderings: "allow/variance ... ₱1.00" (variance word first)
  // and "₱1.00 variance" (amount stated first, e.g. "...tolerance and
  // ₱1.00 variance.").
  const m =
    text.match(/(?:variance|allow(?:ance)?)[^\d]{0,15}(?:₱|php|\$)?\s*([\d,]+(?:\.\d+)?)/i) ||
    text.match(/(?:₱|php|\$)\s*([\d,]+(?:\.\d+)?)[^\d]{0,15}variance/i);
  if (!m) return null;
  const value = Number(m[1].replace(/,/g, ""));
  const type = /%|percent/i.test(text) ? "PERCENT" : "FIXED";
  return { amountVarianceValue: value, amountVarianceType: type };
}

function extractConfidenceThreshold(text) {
  const m = text.match(/(?:below|under|less than)\s+(\d{1,3})\s*%/i);
  return m ? Number(m[1]) : null;
}

function extractAmountThreshold(text) {
  const m = text.match(/below\s+(?:₱|php|\$)\s*([\d,]+(?:\.\d+)?)/i);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

const INTENTS = {
  GENERATE: "GENERATE",
  OUTSTANDING_CHECKS: "OUTSTANDING_CHECKS",
  DEPOSITS_IN_TRANSIT: "DEPOSITS_IN_TRANSIT",
  LOW_CONFIDENCE: "LOW_CONFIDENCE",
  ADJUSTING_ENTRIES: "ADJUSTING_ENTRIES",
  EXPLAIN_UNBALANCED: "EXPLAIN_UNBALANCED",
  RERUN_TOLERANCE: "RERUN_TOLERANCE",
  CONFIRM_ALL_EXACT: "CONFIRM_ALL_EXACT",
  UNKNOWN: "UNKNOWN",
};

// context: { bankAccounts: [...], sessionId: number|null }
function parsePrompt(text, context = {}) {
  const raw = String(text || "");
  const bankMatch = context.bankAccounts
    ? findBankAccount(context.bankAccounts, raw)
    : null;
  const monthYear = extractMonthYear(raw);
  const toleranceDays = extractToleranceDays(raw);
  const variance = extractAmountVariance(raw);
  const confidenceThreshold = extractConfidenceThreshold(raw);
  const amountThreshold = extractAmountThreshold(raw);

  const params = {
    bankAccountId: bankMatch ? bankMatch.account.id : null,
    bankAccountLabel: bankMatch
      ? `${bankMatch.account.bankCode} - ${bankMatch.account.bankName}`
      : null,
    month: monthYear ? monthYear.month : null,
    year: monthYear ? monthYear.year : null,
    periodEnd: monthYear && monthYear.isAsOf ? monthYear.periodEnd : null,
    dateToleranceDays: toleranceDays,
    amountVarianceType: variance ? variance.amountVarianceType : null,
    amountVarianceValue: variance ? variance.amountVarianceValue : null,
    confidenceThreshold,
    amountThreshold,
    sessionId: context.sessionId || null,
  };

  let intent = INTENTS.UNKNOWN;

  if (/confirm\s+all\s+exact/i.test(raw)) {
    intent = INTENTS.CONFIRM_ALL_EXACT;
  } else if (/outstanding\s+check|unmatched\s+check/i.test(raw)) {
    intent = INTENTS.OUTSTANDING_CHECKS;
  } else if (/deposit(s)?\s+in\s+transit/i.test(raw)) {
    intent = INTENTS.DEPOSITS_IN_TRANSIT;
  } else if (confidenceThreshold !== null || /confidence/i.test(raw)) {
    intent = INTENTS.LOW_CONFIDENCE;
  } else if (/adjust(ing)?\s*(journal)?\s*entr|journal\s+entr|suggest.*entr|ignore\s+bank\s+charges/i.test(raw)) {
    intent = INTENTS.ADJUSTING_ENTRIES;
  } else if (/why.*(not\s+balanced|unbalanced|difference)|explain/i.test(raw)) {
    intent = INTENTS.EXPLAIN_UNBALANCED;
  } else if (
    bankMatch ||
    /generat|reconcil|show.*reconciliation|summary|balanced/i.test(raw)
  ) {
    // A bank-account match or an explicit "generate/reconcile" imperative
    // wins over bare tolerance/variance wording, so "Reconcile X using a
    // 3-day tolerance..." starts a new session instead of being treated as
    // a RERUN_TOLERANCE follow-up on an already-open one.
    intent = INTENTS.GENERATE;
  } else if (
    (toleranceDays !== null || variance !== null) &&
    /match|tolerance|variance|re-?run/i.test(raw)
  ) {
    intent = INTENTS.RERUN_TOLERANCE;
  }

  return { intent, params };
}

module.exports = {
  isValidIsoDate,
  resolveDateRange,
  todayIso,
  findBankAccount,
  parsePrompt,
  INTENTS,
};
