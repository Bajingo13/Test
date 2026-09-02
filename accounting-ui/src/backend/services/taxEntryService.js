const pool = require("../db");
const { HttpError } = require("../lib/httpError");
const {
  computeVatByTreatment,
  normalizeVatTreatment,
  isValidVatTreatment,
  isZeroVatTreatment,
  normalizeVatEntryMode,
  isValidVatEntryMode,
} = require("./vatCalculationService");

// Phase 7C: persistence for the new transaction_tax_entries schedule
// metadata table (see phase7c_tax_schedule_migration.sql for the
// architecture-audit reasoning). One row per tax-generated journal line,
// linked by the LINE'S REAL DATABASE ID (invoice_lines.id/apv_lines.id) -
// never a client-side UUID, which TransactionFormLayout.jsx regenerates
// fresh on every load and is therefore not a stable identity across
// save/reload cycles (see the Phase 7C report's "Tax-line identification
// method" item).
//
// Delete-then-reinsert-all on every save, mirroring the exact convention
// every *_lines table in this codebase already uses (see e.g. the
// invoice_lines DELETE+INSERT-loop in server.js's PUT /api/invoices/:id) -
// this trivially satisfies "atomic save" (same conn/transaction as the
// line writes) and "removing a tax line removes its metadata" (it simply
// isn't re-inserted), with no separate update-in-place path to keep in
// sync.

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

// Independently recomputes/validates each tax entry against the ONE
// centralized helper before it's allowed to reach the database - a
// journal line's amount is part of a balanced double-entry transaction,
// so (unlike EWT's header-only override-on-mismatch precedent) a silent
// server-side correction here could invisibly unbalance lines the user
// already constructed around the client-computed figure. Rejecting with a
// clear error is safer than silently rewriting a monetary line.
function validateVatTaxEntry(taxEntry, lineAmount) {
  const label = taxEntry.entryType === "INPUT_VAT" ? "Input VAT" : "Output VAT";

  // Phase 7J: the VAT entry mode is a remembered-input snapshot only
  // (INCLUSIVE / EXCLUSIVE; null/omitted => INCLUSIVE). It never changes
  // the calculation below - the modal has already converted an EXCLUSIVE
  // base into grossAmount before sending - but an unrecognized value is a
  // client error, rejected here rather than silently coerced or stored.
  if (!isValidVatEntryMode(taxEntry.vatEntryMode)) {
    throw new HttpError(
      400,
      `${label}: unknown VAT entry mode "${taxEntry.vatEntryMode}". Use INCLUSIVE or EXCLUSIVE.`,
      "INVALID_VAT_ENTRY_MODE"
    );
  }

  // Phase 7E: the treatment SNAPSHOT on the entry is authoritative. A
  // missing value (a pre-7E reloaded entry) reads as STANDARD; an
  // unrecognized value is rejected outright.
  if (taxEntry.vatTreatment != null && !isValidVatTreatment(taxEntry.vatTreatment)) {
    throw new HttpError(400, `${label}: unknown VAT treatment "${taxEntry.vatTreatment}".`);
  }
  const treatment = normalizeVatTreatment(taxEntry.vatTreatment);

  // A ZERO_RATED / EXEMPT entry that carries a non-zero rate OR a non-zero
  // VAT amount is a contradiction - reject rather than silently pick one.
  if (isZeroVatTreatment(treatment) && Number(taxEntry.vatRate || 0) !== 0) {
    throw new HttpError(
      400,
      `${label}: a ${treatment} entry cannot have a non-zero VAT rate (got ${taxEntry.vatRate}%).`
    );
  }
  if (isZeroVatTreatment(treatment) && Math.abs(Number(taxEntry.vatAmount || 0)) > 0.01) {
    throw new HttpError(
      400,
      `${label}: a ${treatment} entry must have a VAT amount of 0 (got ${taxEntry.vatAmount}).`
    );
  }

  // STANDARD: amount is the VAT-inclusive gross -> split. ZERO_RATED /
  // EXEMPT: amount IS the base, VAT is 0, base is still recorded.
  const { netAmount, vatAmount } = computeVatByTreatment({
    amount: taxEntry.grossAmount,
    vatRatePercent: taxEntry.vatRate,
    treatment,
  });

  if (Math.abs(vatAmount - Number(lineAmount || 0)) > 0.01) {
    throw new HttpError(
      400,
      isZeroVatTreatment(treatment)
        ? `${label} line amount (${lineAmount}) must be 0 for a ${treatment} entry. Recalculate and try again.`
        : `${label} line amount (${lineAmount}) does not match the centralized VAT calculation ` +
            `(Gross ${taxEntry.grossAmount} at ${taxEntry.vatRate}% = ${vatAmount}). Recalculate and try again.`
    );
  }

  return { netAmount, vatAmount, treatment };
}

// Phase 7C.1: closes the gap Phase 7C's own report flagged - "the legacy
// EWT header columns and the new journal line are kept in sync by the
// FRONTEND, not enforced as a DB invariant." This is the backend-
// authoritative reconciliation point for EWT, called once per save
// (POST/PUT /api/invoices and /api/apv) right after `ewt` has already
// been computed by the pre-existing, UNCHANGED resolveTaxWithholding()/
// ewtCalculationService (server.js) - this function never recomputes the
// withholding amount itself, it only checks the submitted journal line
// against that one authoritative result and returns the reconciled
// (backend-sourced, not client-sourced) metadata to persist.
//
// `expectedSide` is "debit" (Invoice/inbound - a Creditable WHT
// Receivable asset increases) or "credit" (APV/outbound - a Withholding
// Tax Payable liability increases) - the exact direction Phase 7C's
// EwtEntryModal/handleEwtEntryConfirm already implements
// (`debit: ewtInbound ? ... : "", credit: ewtOutbound ? ... : ""`); this
// function only verifies that existing behavior, it does not change it.
//
// existingAtcCode is the atc_code already stored on the header BEFORE
// this save (null for a brand-new transaction). The "requires a line"
// rule only fires when the incoming atcCode is non-null AND different
// from what was already stored - i.e. EWT is being newly applied or
// changed THIS save. An unchanged legacy atcCode being silently carried
// through a re-save (the transaction never touched Phase 7C's EWT popup
// at all) is exempt, so pre-existing Drafts keep saving exactly as
// before (spec section 17's backward-compatibility requirement) - the
// Phase 7C frontend has no path left that sets atcCode without also
// creating the matching line, so in real usage this rule only ever
// fires against direct API tampering, never normal UI use.
function reconcileEwtTaxEntry({ ewt, lines, existingAtcCode, expectedSide, moduleLabel }) {
  const ewtLines = (lines || []).filter((l) => l.taxEntry?.entryType === "EWT");

  if (ewtLines.length > 1) {
    throw new HttpError(400, `Only one EWT entry is supported per ${moduleLabel}, but ${ewtLines.length} were submitted.`);
  }
  const ewtLine = ewtLines[0] || null;

  // Orphan line (spec section 9): a line claims to be EWT but no
  // authoritative ATC/withholding was resolved to back it - never
  // persisted, since there is nothing authoritative to reconcile it to.
  if (ewtLine && !ewt.atcCode) {
    throw new HttpError(
      400,
      `An EWT journal line was submitted without a valid ATC code. Select an ATC code or remove the EWT entry.`
    );
  }

  // Missing line (spec section 8): EWT is being newly applied/changed
  // this save, but no matching journal line was submitted.
  const isNewOrChangedEwt = !!ewt.atcCode && ewt.atcCode !== existingAtcCode;
  if (isNewOrChangedEwt && !ewtLine) {
    throw new HttpError(
      400,
      `EWT (ATC ${ewt.atcCode}) was submitted without its corresponding journal line. Add the EWT entry via + Add Entry before saving.`
    );
  }

  if (!ewtLine) return null;

  const debit = Number(ewtLine.foreignDebit || 0);
  const credit = Number(ewtLine.foreignCredit || 0);
  const amount = expectedSide === "debit" ? debit : credit;
  const wrongSideAmount = expectedSide === "debit" ? credit : debit;

  // Direction (spec section 4/5): the amount must be on the side Phase
  // 7C's own popup already implements for this module's EWT direction -
  // never the other side.
  if (wrongSideAmount > 0) {
    throw new HttpError(
      400,
      `EWT journal line is on the wrong side for ${moduleLabel} (expected ${expectedSide}). ` +
        `${moduleLabel === "Invoice" ? "Invoice/inbound withholding increases a receivable (debit)." : "APV/outbound withholding increases a payable (credit)."}`
    );
  }

  if (Math.abs(amount - ewt.taxWithheldAmount) > 0.01) {
    throw new HttpError(
      400,
      `EWT journal line amount (${amount}) does not match the authoritative withholding calculation ` +
        `(ATC ${ewt.atcCode}, base ${ewt.taxableBase}, amount ${ewt.taxWithheldAmount}). Recalculate and try again.`
    );
  }

  return {
    lineRef: ewtLine,
    entry: {
      entryType: "EWT",
      // Content fields (party identity/date) are honest user input, same
      // as the VAT popup's own party fields - not independently
      // computable by any backend service, so they're taken as submitted.
      partyId: ewtLine.taxEntry.partyId || null,
      partyName: ewtLine.taxEntry.partyName || null,
      partyTin: ewtLine.taxEntry.partyTin || null,
      partyAddress: ewtLine.taxEntry.partyAddress || null,
      transactionDate: ewtLine.taxEntry.transactionDate || null,
      // Structural/computed fields (spec section 6 - "must never
      // disagree") are ALWAYS sourced from the same authoritative `ewt`
      // object the header columns are built from, never from the
      // client's copy - this is what makes header <-> structured entry
      // <-> journal line agreement a guarantee by construction, not just
      // a checked invariant.
      atcCode: ewt.atcCode,
      taxType: ewt.taxType,
      taxableBase: ewt.taxableBase,
      withheldAmount: ewt.taxWithheldAmount,
    },
  };
}

// entries: [{ lineId, accountId, entryType, partyId, partyName, partyTin,
//   partyAddress, transactionDate, grossAmount, netAmount, vatRate,
//   vatAmount, purchaseClassification, atcCode, taxType, taxableBase,
//   withheldAmount }]
async function saveTaxEntries(conn, { companyId, transactionType, transactionId, entries, userId }) {
  await conn.execute(
    "DELETE FROM transaction_tax_entries WHERE transaction_type = ? AND transaction_id = ?",
    [transactionType, transactionId]
  );

  for (const entry of entries || []) {
    // Phase 7E: persist the VAT code + treatment as a transaction-time
    // snapshot for VAT entries. A later edit to the VAT Rate Library must
    // never reclassify this row. EWT entries carry neither (left NULL).
    const isVatEntry = entry.entryType === "INPUT_VAT" || entry.entryType === "OUTPUT_VAT";
    const vatCodeSnapshot = isVatEntry ? entry.vatCode || null : null;
    const vatTreatmentSnapshot = isVatEntry
      ? normalizeVatTreatment(entry.vatTreatment)
      : null;
    // Phase 7J: persist the entry-mode snapshot for VAT rows only. A row
    // whose client payload carried no mode at all (a pre-7J entry echoed
    // back unchanged on an unrelated edit) is stored as NULL - history is
    // never rewritten. EWT rows carry no mode.
    const vatEntryModeSnapshot = isVatEntry
      ? (entry.vatEntryMode ? normalizeVatEntryMode(entry.vatEntryMode) : null)
      : null;

    await conn.execute(
      `INSERT INTO transaction_tax_entries (
        company_id, transaction_type, transaction_id, line_id, entry_type,
        party_id, party_name_snapshot, party_tin_snapshot, party_address_snapshot,
        transaction_date, gross_amount, net_amount, vat_rate, vat_amount, purchase_classification,
        vat_code, vat_treatment, vat_entry_mode,
        atc_code, tax_type, taxable_base, withheld_amount, account_id, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        companyId, transactionType, transactionId, entry.lineId, entry.entryType,
        entry.partyId || null, entry.partyName || null, entry.partyTin || null, entry.partyAddress || null,
        entry.transactionDate || null,
        entry.grossAmount ?? null, entry.netAmount ?? null, entry.vatRate ?? null, entry.vatAmount ?? null,
        entry.purchaseClassification || null,
        vatCodeSnapshot, vatTreatmentSnapshot, vatEntryModeSnapshot,
        entry.atcCode || null, entry.taxType || null, entry.taxableBase ?? null, entry.withheldAmount ?? null,
        entry.accountId || null, userId || null,
      ]
    );
  }
}

async function loadTaxEntries(transactionType, transactionId) {
  const [rows] = await pool.execute(
    `SELECT
      id, line_id AS lineId, entry_type AS entryType,
      party_id AS partyId, party_name_snapshot AS partyName, party_tin_snapshot AS partyTin,
      party_address_snapshot AS partyAddress,
      DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transactionDate,
      gross_amount AS grossAmount, net_amount AS netAmount, vat_rate AS vatRate, vat_amount AS vatAmount,
      purchase_classification AS purchaseClassification,
      vat_code AS vatCode, vat_treatment AS vatTreatment, vat_entry_mode AS vatEntryMode,
      atc_code AS atcCode, tax_type AS taxType, taxable_base AS taxableBase, withheld_amount AS withheldAmount,
      account_id AS accountId
    FROM transaction_tax_entries
    WHERE transaction_type = ? AND transaction_id = ?
    ORDER BY id ASC`,
    [transactionType, transactionId]
  );
  return rows.map((row) => ({
    ...row,
    grossAmount: row.grossAmount == null ? null : Number(row.grossAmount),
    netAmount: row.netAmount == null ? null : Number(row.netAmount),
    vatRate: row.vatRate == null ? null : Number(row.vatRate),
    vatAmount: row.vatAmount == null ? null : Number(row.vatAmount),
    taxableBase: row.taxableBase == null ? null : Number(row.taxableBase),
    withheldAmount: row.withheldAmount == null ? null : Number(row.withheldAmount),
  }));
}

module.exports = { roundMoney, validateVatTaxEntry, reconcileEwtTaxEntry, saveTaxEntries, loadTaxEntries };
