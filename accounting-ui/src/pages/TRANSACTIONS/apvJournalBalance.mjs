// Phase 7L Part E: limited, deterministic journal-balancing assistance for
// modern APV VAT/EWT entry.
//
// When a VAT or EWT line is added / edited / removed through the APV tax
// modals, the counterparty (Accounts Payable / control) CREDIT is
// recalculated so total debit === total credit WITHOUT touching the
// substantive expense/asset base lines - but ONLY when that counterparty
// line can be identified UNAMBIGUOUSLY. If it cannot, nothing is mutated
// and the caller surfaces a validation message telling the user to adjust
// the payable themselves (never a silent change to an arbitrary line).
//
// jest runs testEnvironment: "node" with no jsdom, so this logic lives
// here as pure functions the component wires up - unit-tested directly,
// the same pattern as voucherToolbarRules.mjs / accountSearch.mjs.

export const AP_AMBIGUITY_MESSAGE =
  "VAT was added, but the payable line could not be identified automatically. " +
  "Adjust the Accounts Payable credit so the journal balances.";

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// A line is a counterparty-CREDIT candidate when ALL hold:
//   - it is NOT a tax-generated line (no `taxEntry` metadata), and
//   - its account is an AP/AR control account (caller's isAPorARAccount,
//     which already checks COA validations + title), and
//   - it is not currently a DEBIT line (debit is empty / zero) - i.e. it
//     is the credit side, whether it already carries a credit figure or is
//     still blank and waiting to receive the balancing amount.
export function counterpartyCreditCandidates(lines, isAPorARAccount) {
  return (Array.isArray(lines) ? lines : []).filter((line) => {
    if (!line || line.taxEntry) return false;
    if (typeof isAPorARAccount === "function" && !isAPorARAccount(line.accountId)) return false;
    return !(num(line.debit) > 0);
  });
}

// Exactly one candidate -> its id. Zero or many -> null (ambiguous).
export function identifyCounterpartyCreditLineId(lines, isAPorARAccount) {
  const candidates = counterpartyCreditCandidates(lines, isAPorARAccount);
  return candidates.length === 1 ? candidates[0].id : null;
}

// The credit the counterparty line must carry for the whole journal to
// balance: (sum of every debit) - (sum of every OTHER credit). Never reads
// or changes any expense/asset/tax line.
export function requiredCounterpartyCredit(lines, counterpartyLineId) {
  let sumDebits = 0;
  let sumOtherCredits = 0;
  for (const line of lines || []) {
    sumDebits += num(line.debit);
    if (line.id !== counterpartyLineId) sumOtherCredits += num(line.credit);
  }
  return roundMoney(sumDebits - sumOtherCredits);
}

// Returns:
//   { status: "BALANCED", lines, counterpartyLineId, requiredCredit }
//     - a copy of `lines` with only the counterparty credit rewritten.
//   { status: "AMBIGUOUS", lines, message }
//     - `lines` returned UNCHANGED; caller shows `message`.
//
// `enabled` lets the caller scope this to APV only (code === "APV").
export function applyApvTaxBalancing(lines, { isAPorARAccount, enabled = true } = {}) {
  if (!enabled) return { status: "DISABLED", lines, message: "" };

  const id = identifyCounterpartyCreditLineId(lines, isAPorARAccount);
  if (id == null) {
    return { status: "AMBIGUOUS", lines, message: AP_AMBIGUITY_MESSAGE };
  }

  const required = requiredCounterpartyCredit(lines, id);
  if (required < 0) {
    // Balancing by lifting the payable alone is impossible (the non-payable
    // credits already exceed the debits) - do NOT guess another line.
    return { status: "AMBIGUOUS", lines, message: AP_AMBIGUITY_MESSAGE };
  }

  const next = lines.map((line) =>
    line.id === id ? { ...line, debit: "", credit: String(required) } : line
  );
  return { status: "BALANCED", lines: next, counterpartyLineId: id, requiredCredit: required };
}
