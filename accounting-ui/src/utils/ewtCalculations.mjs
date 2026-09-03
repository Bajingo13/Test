// EWT (Expanded Withholding Tax) base/amount preview - mirrors the
// authoritative formula in accounting-ui/src/backend/services/
// ewtCalculationService.js. This copy exists only to drive the live
// "suggested amount" the user sees while filling in the form; it is
// NOT trusted on save - the backend independently recomputes and, on
// mismatch, overrides with its own value. A parity test
// (utils/__tests__/ewtCalculationsParity.test.js) asserts this file and
// the backend service return identical results for the same inputs.
//
// Phase 7L - two paths, one contract (see the backend header for the full
// reasoning):
//   1. MODERN / STRUCTURED: each Input/Output VAT line carries a validated
//      `taxEntry.netAmount`; the EWT base is the sum of those net amounts,
//      INDEPENDENT of whether the draft journal currently balances.
//   2. LEGACY / FALLBACK: base = gross total minus the VAT line, where the
//      VAT line is identified by VALIDATED ACCOUNT IDENTITY (account id in
//      the INPUT VAT / OUTPUT VAT validated set), not by matching the
//      account title text. The title keyword is a last resort only.

export function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

const STRUCTURED_VAT_ENTRY_TYPES = ["INPUT_VAT", "OUTPUT_VAT"];

export function toIdSet(vatAccountIds, vatAccountId) {
  const set = new Set();
  const add = (v) => {
    if (v == null || v === "") return;
    set.add(String(v));
  };
  if (vatAccountIds instanceof Set) vatAccountIds.forEach(add);
  else if (Array.isArray(vatAccountIds)) vatAccountIds.forEach(add);
  else add(vatAccountIds);
  add(vatAccountId);
  return set;
}

function structuredVatNet(line) {
  const te = line && line.taxEntry;
  if (!te || !STRUCTURED_VAT_ENTRY_TYPES.includes(te.entryType)) return null;
  if (te.netAmount == null) return null;
  const n = Number(te.netAmount);
  return Number.isFinite(n) ? n : null;
}

export function hasStructuredVat(lines) {
  return (lines || []).some((l) => structuredVatNet(l) != null);
}

export function sumStructuredVatExclusiveBase(lines) {
  return roundMoney(
    (lines || []).reduce((sum, line) => {
      const n = structuredVatNet(line);
      return n == null ? sum : sum + n;
    }, 0)
  );
}

function isLegacyVatLine(line, { idSet, vatKeyword }) {
  const te = line && line.taxEntry;
  if (te && STRUCTURED_VAT_ENTRY_TYPES.includes(te.entryType)) return true;
  if (idSet && idSet.size > 0 && idSet.has(String(line.accountId))) return true;
  if ((!idSet || idSet.size === 0) && vatKeyword) {
    return String(line.accountTitle || "").toLowerCase().includes(String(vatKeyword).toLowerCase());
  }
  return false;
}

export function sumVatLines(lines, vatKeywordOrOpts) {
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

export function computeEwtTaxableBase({ grossAmount, lines, vatAccountIds, vatAccountId, vatKeyword }) {
  if (hasStructuredVat(lines)) {
    return sumStructuredVatExclusiveBase(lines);
  }
  const gross = Number(grossAmount) || 0;
  const idSet = toIdSet(vatAccountIds, vatAccountId);
  const vatLineTotal = sumVatLines(lines, { vatAccountIds: idSet, vatKeyword });
  return roundMoney(gross - vatLineTotal);
}

export function computeEwtAmount({ taxableBase, ewtRate }) {
  const base = Number(taxableBase) || 0;
  const rate = Number(ewtRate) || 0;
  return roundMoney((base * rate) / 100);
}
