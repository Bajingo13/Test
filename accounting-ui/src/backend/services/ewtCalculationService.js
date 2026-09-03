// EWT (Expanded Withholding Tax) base/amount calculation - single source of
// truth for the backend, which is the final authority on stored tax values
// (see utils/ewtCalculations.mjs for the frontend's non-authoritative
// preview mirror of this same formula - the two are kept byte-for-byte
// equivalent and a parity test asserts it).
//
// Core rule: EWT is computed on the VAT-EXCLUSIVE amount, never on the VAT
// itself.
//
// Phase 7L - two paths, one contract:
//
//   1. MODERN / STRUCTURED (APV & Invoice "+ Add Entry" tax modals):
//      each Input/Output VAT line carries a validated `taxEntry` with a
//      `netAmount` (the VAT-exclusive base the centralized VAT helper
//      computed from the gross, INCLUSIVE or EXCLUSIVE mode). The EWT base
//      is simply the sum of those structured net amounts. This is
//      INDEPENDENT of whether the draft journal currently balances - it
//      never reads totalCredit or a counterparty line.
//
//   2. LEGACY / FALLBACK (OR/CV/PO plain VAT lines, and any historical
//      row with no structured metadata): base = gross total minus whatever
//      was posted to the VAT control account. The VAT line is identified
//      by VALIDATED ACCOUNT IDENTITY (a COA account tagged INPUT VAT /
//      OUTPUT VAT), NOT by matching the account title text - so a control
//      account titled "Taxes Recoverable" but validation-tagged INPUT VAT
//      behaves exactly like one literally titled "Input VAT". The old
//      title keyword is retained only as a last resort when no validated
//      id set is available at the call site.

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

const STRUCTURED_VAT_ENTRY_TYPES = ["INPUT_VAT", "OUTPUT_VAT"];

// Normalize a caller-supplied id collection (Set | array | single value |
// null) into a Set<string> for O(1) membership tests.
function toIdSet(vatAccountIds, vatAccountId) {
  const set = new Set();
  const add = (v) => {
    if (v == null || v === "") return;
    set.add(String(v));
  };
  if (vatAccountIds instanceof Set) vatAccountIds.forEach(add);
  else if (Array.isArray(vatAccountIds)) vatAccountIds.forEach(add);
  else add(vatAccountIds);
  add(vatAccountId); // legacy singular param still honored
  return set;
}

// Is this line a structured Input/Output VAT line with a usable net?
function structuredVatNet(line) {
  const te = line && line.taxEntry;
  if (!te || !STRUCTURED_VAT_ENTRY_TYPES.includes(te.entryType)) return null;
  if (te.netAmount == null) return null;
  const n = Number(te.netAmount);
  return Number.isFinite(n) ? n : null;
}

function hasStructuredVat(lines) {
  return (lines || []).some((l) => structuredVatNet(l) != null);
}

// Sum of the structured VAT-exclusive net amounts (modern path).
function sumStructuredVatExclusiveBase(lines) {
  return roundMoney(
    (lines || []).reduce((sum, line) => {
      const n = structuredVatNet(line);
      return n == null ? sum : sum + n;
    }, 0)
  );
}

// Identify a VAT line for the LEGACY fallback:
//   a) a structured Input/Output VAT taxEntry (defensive - the modern
//      path above already handled these), OR
//   b) the line's account id is in the validated INPUT VAT / OUTPUT VAT
//      id set, OR
//   c) (last resort, only when no id set was provided) the account title
//      contains the direction keyword - the pre-7L behavior.
function isLegacyVatLine(line, { idSet, vatKeyword }) {
  const te = line && line.taxEntry;
  if (te && STRUCTURED_VAT_ENTRY_TYPES.includes(te.entryType)) return true;
  if (idSet && idSet.size > 0 && idSet.has(String(line.accountId))) return true;
  if ((!idSet || idSet.size === 0) && vatKeyword) {
    return String(line.accountTitle || "").toLowerCase().includes(String(vatKeyword).toLowerCase());
  }
  return false;
}

// Back-compat export: sum whichever side (debit or credit) is populated on
// the VAT line(s), now keyed on validated identity first, title last.
function sumVatLines(lines, vatKeywordOrOpts) {
  const opts =
    typeof vatKeywordOrOpts === "string"
      ? { vatKeyword: vatKeywordOrOpts }
      : vatKeywordOrOpts || {};
  const idSet = toIdSet(opts.vatAccountIds, opts.vatAccountId);
  const vatKeyword = opts.vatKeyword || "vat";
  return (lines || [])
    .filter((line) => isLegacyVatLine(line, { idSet, vatKeyword }))
    .reduce((sum, line) => sum + (Number(line.debit) || 0) + (Number(line.credit) || 0), 0);
}

// grossAmount: the transaction's balanced total (used by the LEGACY path
// only). lines: the submitted journal lines. vatAccountIds / vatAccountId:
// validated INPUT/OUTPUT VAT control account id(s). vatKeyword: legacy
// direction keyword, retained as the final fallback.
function computeEwtTaxableBase({ grossAmount, lines, vatAccountIds, vatAccountId, vatKeyword }) {
  // MODERN: structured metadata is present -> base is the sum of the
  // VAT-exclusive net amounts, regardless of draft balance state.
  if (hasStructuredVat(lines)) {
    return sumStructuredVatExclusiveBase(lines);
  }

  // LEGACY: gross minus the VAT line, identified by validated account id
  // (preferred) or the direction keyword (last resort).
  const gross = Number(grossAmount) || 0;
  const idSet = toIdSet(vatAccountIds, vatAccountId);
  const vatLineTotal = sumVatLines(lines, { vatAccountIds: idSet, vatKeyword });
  return roundMoney(gross - vatLineTotal);
}

function computeEwtAmount({ taxableBase, ewtRate }) {
  const base = Number(taxableBase) || 0;
  const rate = Number(ewtRate) || 0;
  return roundMoney((base * rate) / 100);
}

module.exports = {
  roundMoney,
  sumVatLines,
  sumStructuredVatExclusiveBase,
  hasStructuredVat,
  computeEwtTaxableBase,
  computeEwtAmount,
  toIdSet,
};
