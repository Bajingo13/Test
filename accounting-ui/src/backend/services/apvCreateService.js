// APV creation, shared by POST /api/apv and the RFP -> APV conversion (R5).
//
// Moved verbatim out of the server.js route handler so a caller that owns a
// larger transaction (the RFP conversion locks its RFP first) can create the
// APV on that same connection with exactly the same accounting rules -
// withholding resolution, voucher-number uniqueness, open-period check,
// required lines, currency/balance resolution, tax entries, snapshot and the
// APV CREATE audit. The caller owns beginTransaction / commit / rollback.
const { logAudit } = require("../lib/audit");
const TransactionCurrencyService = require("./transactionCurrencyService");
const AccountingPeriodService = require("./accountingPeriodService");
const TaxEntryService = require("./taxEntryService");
const { computeEwtTaxableBase, computeEwtAmount } = require("./ewtCalculationService");
const { loadVatControlAccountIds } = require("./vatControlAccounts");
const { assertVoucherNoUnique, normalizeVoucherNo } = require("./voucherNumberService");
const { assertRequiredTransactionLines } = require("./transactionLineValidation");
const { assertWriteStatus } = require("./voidCancelService");

// The backend is the final authority on withholding tax figures - it never
// trusts the client-submitted atcCode's rate/type or the client-submitted
// taxWithheldAmount. It looks up the ATC code's authoritative rate/type
// from ewt_library, independently derives the VAT-exclusive taxable base
// from the submitted journal lines (see ewtCalculationService), and only
// keeps the client's amount if it agrees with the backend recalculation
// within a one-centavo rounding tolerance - otherwise it silently corrects
// to the backend-computed value (rather than rejecting the save) and logs
// the discrepancy for follow-up.
//
// vatKeyword follows the same direction used to auto-detect the VAT account
// on the frontend: "output vat" for INV/OR (we're the seller charging VAT),
// "input vat" for APV/CV/PO (we're the buyer paying VAT).
async function resolveTaxWithholding(conn, { moduleLabel, atcCode, lines, totalCredit, clientTaxWithheldAmount, vatKeyword }) {
  if (!atcCode) {
    return { atcCode: null, taxType: null, taxRate: null, taxableBase: null, taxWithheldAmount: null };
  }

  const [ewtRows] = await conn.execute(
    "SELECT atc_code AS atcCode, tax_type AS taxType, rate FROM ewt_library WHERE atc_code = ? LIMIT 1",
    [atcCode]
  );
  if (!ewtRows.length) {
    // Unknown/stale ATC code - don't invent a rate; store no withholding.
    return { atcCode: null, taxType: null, taxRate: null, taxableBase: null, taxWithheldAmount: null };
  }

  const { taxType, rate } = ewtRows[0];
  // Modern APV/Invoice lines carry structured taxEntry metadata -
  // computeEwtTaxableBase uses the VAT-exclusive net directly and never
  // reads this id set. Legacy OR/CV/PO lines don't, so identify their VAT
  // line by validated account identity.
  const vatAccountIds = await loadVatControlAccountIds(conn);
  const taxableBase = computeEwtTaxableBase({ grossAmount: totalCredit, lines, vatAccountIds, vatKeyword });
  const backendAmount = computeEwtAmount({ taxableBase, ewtRate: rate });

  const clientAmount = Number(clientTaxWithheldAmount) || 0;
  const finalAmount =
    Math.abs(clientAmount - backendAmount) <= 0.01 ? clientAmount : backendAmount;

  if (Math.abs(clientAmount - backendAmount) > 0.01) {
    console.warn(
      `${moduleLabel} EWT mismatch for ATC ${atcCode}: client sent ${clientAmount}, backend computed ${backendAmount} ` +
      `(base ${taxableBase} x ${rate}%). Using backend-computed value.`
    );
  }

  return { atcCode, taxType, taxRate: rate, taxableBase, taxWithheldAmount: finalAmount };
}

async function resolveApvTaxWithholding(conn, { atcCode, lines, totalCredit, clientTaxWithheldAmount }) {
  return resolveTaxWithholding(conn, {
    moduleLabel: "APV",
    atcCode,
    lines,
    totalCredit,
    clientTaxWithheldAmount,
    vatKeyword: "input vat",
  });
}

// Creates one APV (header, lines, tax entries, currency snapshot, CREATE
// audit) on `conn`, inside the caller's transaction. `resolveCompanyId` is
// called at the same point the route always resolved the company, so the
// route keeps its exact validation order; the RFP conversion passes the
// RFP's stored company instead.
async function createApvRecord(conn, { user, body, resolveCompanyId }) {
  const {
    voucherNo,
    supplierId,
    supplierName,
    transactionDate,
    dueDate,
    referenceNo,
    description,
    remarks,
    totalDebit,
    totalCredit,
    status,
    lines,
    sourcePoId,
    atcCode,
    taxWithheldAmount,
    payeeTin,
    currency,
  } = body;

  const finalStatus = status || "DRAFT";
  assertWriteStatus(finalStatus); // Phase 7K: Cancelled/Void only via the dedicated endpoints
  const foreignGross = Number(totalCredit || 0);

  const ewt = await resolveApvTaxWithholding(conn, {
    atcCode,
    lines,
    totalCredit: foreignGross,
    clientTaxWithheldAmount: taxWithheldAmount,
  });

  const companyId = await resolveCompanyId();
  await assertVoucherNoUnique(conn, { module: "APV", companyId, voucherNo });
  await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate, operation: "CREATE", user }, conn);
  assertRequiredTransactionLines(lines);
  const currencyResult = await TransactionCurrencyService.resolveTransactionCurrency({
    user, companyId, transactionType: "APV", transactionId: null, currencyPayload: currency,
    lines, grossAmount: foreignGross, vatKeyword: "input vat", taxWithheldAmount: ewt.taxWithheldAmount,
    isPosting: String(finalStatus).toUpperCase() === "POSTED",
  });

  // Phase 7C.1: see the identical comment in server.js POST /api/invoices -
  // APV is "outbound" (credit side; a Withholding Tax Payable liability).
  const reconciledEwt = TaxEntryService.reconcileEwtTaxEntry({
    ewt, lines: currencyResult.lines, existingAtcCode: null, expectedSide: "credit", moduleLabel: "APV",
  });

  const [result] = await conn.execute(
    `INSERT INTO apv_headers (
      company_id,
      voucher_no,
      supplier_id,
      supplier_name,
      transaction_date,
      due_date,
      reference_no,
      description,
      remarks,
      total_debit,
      total_credit,
      paid_amount,
      balance_amount,
      payment_status,
      status,
      source_po_id,
      atc_code,
      tax_type,
      tax_rate,
      tax_withheld_amount,
      taxable_base,
      payee_tin,
      currency_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      companyId,
      normalizeVoucherNo(voucherNo),
      supplierId || null,
      supplierName || "",
      transactionDate || null,
      dueDate || null,
      referenceNo || "",
      description || "",
      remarks || "",
      currencyResult.baseTotalDebit,
      currencyResult.baseTotalCredit,
      0,
      currencyResult.baseTotalCredit,
      "Unpaid",
      finalStatus,
      sourcePoId || null,
      ewt.atcCode,
      ewt.taxType,
      ewt.taxRate,
      ewt.atcCode ? currencyResult.baseTotals.baseEwt : null,
      ewt.atcCode ? currencyResult.baseTotals.baseSubtotal : null,
      payeeTin || null,
      currencyResult.currencyId,
    ]
  );

  const apvId = result.insertId;

  if (sourcePoId) {
    await conn.execute(
      "UPDATE purchase_order_headers SET status = 'Converted' WHERE id = ?",
      [sourcePoId]
    );
  }

  const taxEntriesToSave = [];

  for (const line of currencyResult.lines) {
    if (line.taxEntry && line.taxEntry.entryType === "INPUT_VAT") {
      TaxEntryService.validateVatTaxEntry(line.taxEntry, line.foreignDebit || line.foreignCredit);
    }

    const [lineResult] = await conn.execute(
      `INSERT INTO apv_lines (
        apv_id,
        account_id,
        account_code,
        account_title,
        particulars,
        debit,
        credit,
        gen_ref,
        gen_name,
        foreign_debit,
        foreign_credit
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        apvId,
        line.accountId || null,
        line.accountCode || "",
        line.accountTitle || "",
        line.particulars || "",
        line.baseDebit,
        line.baseCredit,
        line.genRef || "",
        line.genName || "",
        line.foreignDebit,
        line.foreignCredit,
      ]
    );

    if (reconciledEwt && line === reconciledEwt.lineRef) {
      // Phase 7C.1: the EWT line's saved metadata comes from the
      // RECONCILED (backend-authoritative) entry, never the client's raw
      // taxEntry - see reconcileEwtTaxEntry()'s own comment for why this
      // is what guarantees header/structured-entry/journal-line
      // agreement by construction.
      taxEntriesToSave.push({
        ...reconciledEwt.entry,
        lineId: lineResult.insertId,
        accountId: line.accountId || null,
      });
    } else if (line.taxEntry) {
      // Phase 7C bug fix (caught via Playwright, see the completion
      // report's "bugs discovered/fixed" item): a RELOADED taxEntry
      // already carries its OWN lineId/accountId fields (from
      // loadTaxEntries()'s own SELECT aliases) - spreading it AFTER
      // these two let that stale, previous-save lineId silently
      // clobber the line that was just actually inserted THIS save.
      // The structural fields (lineId/accountId) must always win over
      // whatever the client echoed back; only the content fields
      // (party/amounts/etc.) come from the client's taxEntry.
      taxEntriesToSave.push({
        ...line.taxEntry,
        lineId: lineResult.insertId,
        accountId: line.accountId || null,
      });
    }
  }

  await TaxEntryService.saveTaxEntries(conn, {
    companyId, transactionType: "APV", transactionId: apvId,
    entries: taxEntriesToSave, userId: user.id,
  });

  await TransactionCurrencyService.saveSnapshot(conn, {
    companyId, transactionType: "APV", transactionId: apvId,
    currencyId: currencyResult.currencyId, currencyCode: currencyResult.currencyCode,
    baseCurrencyId: currencyResult.baseCurrencyId, baseCurrencyCode: currencyResult.baseCurrencyCode,
    rateInfo: currencyResult.rateInfo, foreignTotals: currencyResult.foreignTotals, baseTotals: currencyResult.baseTotals,
    userId: user.id, lockNow: String(finalStatus).toUpperCase() === "POSTED",
  });

  // module/entityType: "TRANSACTIONS"/"APV" - matches APV's own existing
  // Cancel/Void/Reverse/Delete audit events (see server.js) rather than a
  // short "APV" module code, so APV's whole audit trail stays under one
  // consistent module value.
  await logAudit(conn, {
    module: "TRANSACTIONS",
    entityType: "APV",
    entityId: apvId,
    companyId,
    action: "CREATE",
    description: `APV ${voucherNo} created (${finalStatus})`,
    afterData: {
      voucherNo, supplierName, transactionDate, status: finalStatus,
      totalDebit: currencyResult.baseTotalDebit, totalCredit: currencyResult.baseTotalCredit,
      currencyCode: currencyResult.currencyCode,
    },
    user,
  });

  return {
    id: apvId,
    companyId,
    voucherNo: normalizeVoucherNo(voucherNo),
    status: finalStatus,
    totalDebit: currencyResult.baseTotalDebit,
    totalCredit: currencyResult.baseTotalCredit,
    currencyCode: currencyResult.currencyCode,
  };
}

module.exports = { resolveTaxWithholding, resolveApvTaxWithholding, createApvRecord };
