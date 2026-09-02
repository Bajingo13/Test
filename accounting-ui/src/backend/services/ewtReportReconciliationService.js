const pool = require("../db");

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

// Phase 7D.1: closes the confirmed pre-existing APV+CV EWT double-count
// gap in the alphalist/2307 reports. Both reports already deliberately
// UNION apv_headers + cv_headers ("the two modules where a real payment
// happened" - see their own existing comments) but nothing prevented the
// SAME withholding being counted once as the APV's accrual estimate AND
// again as the CV's remittance figure.
//
// AUTHORITY RULE (established from the existing architecture, not
// invented - see the Phase 7D audit report):
//   A CV represents the actual remittance mechanics (Dr AP / Cr Cash
//   net-of-withholding / Cr EWT Payable); an APV's own tax_withheld_amount
//   is only an accrual-time ESTIMATE recorded before any money moved.
//   When a CV that safely, unambiguously belongs to exactly one APV has
//   ALSO independently recorded EWT, that CV supersedes the APV's figure
//   for reporting purposes - the APV is dropped, the CV is kept. An APV
//   with no such CV yet keeps reporting its own accrual figure (the
//   existing union's original behavior, preserved as the fallback).
//
// "Safely, unambiguously belongs to exactly one APV" (spec section 9): a
// single CV can apply to MULTIPLE APVs via transaction_applications. Using
// such a CV's one header-level EWT amount to supersede more than one APV,
// or splitting it across them, would be a FABRICATED allocation - never
// done here. A multi-APV CV's own EWT never supersedes any APV; each of
// those APVs keeps its own accrual figure, and the multi-APV CV ALSO
// reports its own line. This is a deliberate, documented non-de-
// duplication for this one structurally ambiguous case (spec section 9
// explicitly permits leaving this case un-de-duplicated rather than
// guessing an allocation).
//
// Multiple single-APV CVs against ONE APV (spec section 8): if an APV has
// several DIFFERENT CVs that each independently, unambiguously settle
// only that APV and each recorded their own EWT (e.g. two withheld
// installment payments), ALL of them supersede that APV and are summed
// together - a genuine, non-duplicate total (only the APV's own accrual
// figure is dropped, never a second CV's real, distinct withholding).
//
// DATE BASIS (spec section 15 - documented explicitly, not silently
// mixed): supersession is resolved GLOBALLY first, across the company's
// entire EWT history for this tax type, BEFORE any date-range filter is
// applied - a CV can settle an APV from a different reporting period
// entirely. If resolution were done inside an already date-windowed
// query, an out-of-period APV or CV would simply be invisible to the
// exclusion check, and the SAME withholding could appear once in the
// APV's period AND again in the CV's period across two separate report
// runs. Resolving supersession first and filtering the FINAL surviving
// event list by each event's own (already-authoritative) date guarantees
// each withholding event appears in exactly one period, exactly once,
// under whichever date now governs it - the CV's remittance date when a
// CV is authoritative, the APV's accrual date otherwise.
//
// Multi-currency (spec section 13): both apv_headers.tax_withheld_amount
// and cv_headers.tax_withheld_amount are already stored in BASE currency
// (see server.js's own comment: "Stored EWT figures are BASE-currency -
// BIR remittance/Form 2307 reports assume PHP"). This function reads
// those stored values as-is and never re-resolves an exchange rate.
async function resolveReportableEwtEvents({ companyId, taxType }) {
  // Phase 7K: a Cancelled or Void APV/CV is no longer financially
  // recognized (same POSTED-only rule reportRecognitionService applies to
  // every ledger report). Historical structured/header EWT snapshots are
  // left intact - the document simply stops being reportable.
  const [apvRows] = await pool.execute(
    `SELECT id, supplier_id AS partyId, supplier_name AS partyName,
            COALESCE(payee_tin, '') AS tin, atc_code AS atcCode, tax_type AS taxType, tax_rate AS taxRate,
            total_credit AS grossAmount, tax_withheld_amount AS taxWithheld,
            DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transactionDate
     FROM apv_headers
     WHERE company_id = ? AND tax_type = ? AND tax_withheld_amount > 0
       AND UPPER(status) = 'POSTED'`,
    [companyId, taxType]
  );

  const [cvRows] = await pool.execute(
    `SELECT id, payee_id AS partyId, payee_name AS partyName,
            COALESCE(payee_tin, '') AS tin, atc_code AS atcCode, tax_type AS taxType, tax_rate AS taxRate,
            total_credit AS grossAmount, tax_withheld_amount AS taxWithheld,
            DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transactionDate
     FROM cv_headers
     WHERE company_id = ? AND tax_type = ? AND tax_withheld_amount > 0
       AND UPPER(status) = 'POSTED'`,
    [companyId, taxType]
  );

  const events = [];

  if (!apvRows.length && !cvRows.length) return events;

  // Which distinct APV ids does each in-scope CV apply to (via the same
  // transaction_applications linkage the settlement/payment-status flow
  // already uses)? Scoped to CV ids actually in this company/taxType, so
  // this never leaks another company's application rows into the check.
  const cvIds = cvRows.map((c) => c.id);
  const apvIdsByCv = new Map();
  if (cvIds.length) {
    const placeholders = cvIds.map(() => "?").join(",");
    const [appRows] = await pool.execute(
      `SELECT source_id AS apvId, applied_id AS cvId
       FROM transaction_applications
       WHERE source_type = 'APV' AND applied_type = 'CV' AND applied_id IN (${placeholders})`,
      cvIds
    );
    for (const app of appRows) {
      if (!apvIdsByCv.has(app.cvId)) apvIdsByCv.set(app.cvId, new Set());
      apvIdsByCv.get(app.cvId).add(app.apvId);
    }
  }

  const inScopeApvIds = new Set(apvRows.map((a) => a.id));
  const supersededApvIds = new Set();
  for (const cvId of cvIds) {
    const targetApvIds = apvIdsByCv.get(cvId);
    if (targetApvIds && targetApvIds.size === 1) {
      const [onlyApvId] = [...targetApvIds];
      // Only supersede an APV that is itself in this exact company/
      // taxType scope (i.e. it also has its own EWT recorded) - an APV
      // outside that scope has nothing here for the CV to supersede.
      if (inScopeApvIds.has(onlyApvId)) {
        supersededApvIds.add(onlyApvId);
      }
    }
  }

  for (const apv of apvRows) {
    if (supersededApvIds.has(apv.id)) continue;
    events.push({ sourceModule: "APV", sourceId: apv.id, ...apv });
  }
  for (const cv of cvRows) {
    events.push({ sourceModule: "CV", sourceId: cv.id, ...cv });
  }

  return events;
}

function filterEventsByDateRange(events, fromDate, toDate) {
  return events.filter((e) => e.transactionDate >= fromDate && e.transactionDate <= toDate);
}

module.exports = { resolveReportableEwtEvents, filterEventsByDateRange, roundMoney };
