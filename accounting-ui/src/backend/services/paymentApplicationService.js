const TransactionCurrencyService = require("./transactionCurrencyService");
const FxAccountService = require("./fxAccountService");
const { roundMoney } = TransactionCurrencyService;

// Extracted from server.js verbatim (Checkpoint 3B) so this logic is
// directly unit-testable against the real DB, the same way
// transactionCurrencyService.js already is - server.js has no test harness
// of its own. Every call site in server.js still calls these by the same
// bare names via a destructured require, so behavior/call signatures are
// completely unchanged.

// Checkpoint 4: realized FX at settlement must be measured from the
// CURRENT CARRYING basis, not always the document's original historical
// rate - otherwise a gain already recognized by a month-end revaluation
// gets recognized a SECOND time here. Lazily required to avoid a require
// cycle (fxRevaluationService doesn't depend on this file, but keeping
// the require local to the call site matches this file's existing lazy-
// require style for FX-adjacent services). Returns the ORIGINAL snapshot
// rate unchanged when no prior POSTED revaluation exists for this
// document - the historical rate itself is never touched either way.
async function resolveSettlementSourceRate(conn, sourceType, sourceId, originalRate, applicationDate) {
  const FxRevaluationService = require("./fxRevaluationService");
  const carrying = await FxRevaluationService.getCarryingBasis(conn, sourceType, sourceId, applicationDate);
  return carrying ? carrying.rate : originalRate;
}

async function updateInvoicePaymentStatus(conn, invoiceId) {
  const [invoiceRows] = await conn.execute(
    `SELECT
       total_debit AS totalDebit,
       total_credit AS totalCredit
     FROM invoice_headers
     WHERE id = ?`,
    [invoiceId]
  );

  if (invoiceRows.length === 0) return;

  const totalAmount = Math.max(
    Number(invoiceRows[0].totalDebit || 0),
    Number(invoiceRows[0].totalCredit || 0)
  );

  const [paymentRows] = await conn.execute(
    `SELECT COALESCE(SUM(amount), 0) AS paidAmount
     FROM transaction_applications
     WHERE source_type = 'INV'
       AND source_id = ?`,
    [invoiceId]
  );

  const paidAmount = Number(paymentRows[0].paidAmount || 0);
  const balanceAmount = Math.max(totalAmount - paidAmount, 0);

  // Checkpoint 3B (section 25): for a foreign-currency invoice, the
  // FOREIGN balance is the payment-status authority - "never mark Paid
  // based only on rounded base-value coincidence." total_debit/paid_amount
  // (base) keep being tracked exactly as before regardless, for every
  // existing base-currency report that reads them directly.
  const foreignState = await TransactionCurrencyService.getForeignPaymentState(conn, {
    transactionType: "INV",
    transactionId: invoiceId,
  });

  let paymentStatus = "Unpaid";
  if (foreignState.hasForeignCurrency) {
    const { foreignOriginalAmount, foreignPaidAmount } = foreignState;
    if (foreignPaidAmount > 0 && foreignPaidAmount < foreignOriginalAmount) {
      paymentStatus = "Partially Paid";
    } else if (foreignPaidAmount >= foreignOriginalAmount && foreignOriginalAmount > 0) {
      paymentStatus = "Paid";
    }
  } else if (paidAmount > 0 && paidAmount < totalAmount) {
    paymentStatus = "Partially Paid";
  } else if (paidAmount >= totalAmount && totalAmount > 0) {
    paymentStatus = "Paid";
  }

  await conn.execute(
    `UPDATE invoice_headers
     SET paid_amount = ?,
         balance_amount = ?,
         payment_status = ?,
         foreign_paid_amount = ?,
         foreign_balance_amount = ?
     WHERE id = ?`,
    [
      paidAmount,
      balanceAmount,
      paymentStatus,
      foreignState.hasForeignCurrency ? foreignState.foreignPaidAmount : null,
      foreignState.hasForeignCurrency ? foreignState.foreignBalanceAmount : null,
      invoiceId,
    ]
  );
}

async function updateApvPaymentStatus(conn, apvId) {
  const [apvRows] = await conn.execute(
    `SELECT
       total_debit AS totalDebit,
       total_credit AS totalCredit
     FROM apv_headers
     WHERE id = ?`,
    [apvId]
  );

  if (apvRows.length === 0) return;

  const totalAmount = Math.max(
    Number(apvRows[0].totalDebit || 0),
    Number(apvRows[0].totalCredit || 0)
  );

  const [paymentRows] = await conn.execute(
    `SELECT COALESCE(SUM(amount), 0) AS paidAmount
     FROM transaction_applications
     WHERE source_type = 'APV'
       AND source_id = ?`,
    [apvId]
  );

  const paidAmount = Number(paymentRows[0].paidAmount || 0);
  const balanceAmount = Math.max(totalAmount - paidAmount, 0);

  // See updateInvoicePaymentStatus above for why a foreign-currency APV
  // uses its FOREIGN balance as the payment-status authority instead.
  const foreignState = await TransactionCurrencyService.getForeignPaymentState(conn, {
    transactionType: "APV",
    transactionId: apvId,
  });

  let paymentStatus = "Unpaid";
  if (foreignState.hasForeignCurrency) {
    const { foreignOriginalAmount, foreignPaidAmount } = foreignState;
    if (foreignPaidAmount > 0 && foreignPaidAmount < foreignOriginalAmount) {
      paymentStatus = "Partially Paid";
    } else if (foreignPaidAmount >= foreignOriginalAmount && foreignOriginalAmount > 0) {
      paymentStatus = "Paid";
    }
  } else if (paidAmount > 0 && paidAmount < totalAmount) {
    paymentStatus = "Partially Paid";
  } else if (paidAmount >= totalAmount && totalAmount > 0) {
    paymentStatus = "Paid";
  }

  await conn.execute(
    `UPDATE apv_headers
     SET paid_amount = ?,
         balance_amount = ?,
         payment_status = ?,
         foreign_paid_amount = ?,
         foreign_balance_amount = ?
     WHERE id = ?`,
    [
      paidAmount,
      balanceAmount,
      paymentStatus,
      foreignState.hasForeignCurrency ? foreignState.foreignPaidAmount : null,
      foreignState.hasForeignCurrency ? foreignState.foreignBalanceAmount : null,
      apvId,
    ]
  );
}

// ===================== CHECKPOINT 3B/3D: PAYMENT APPLICATIONS =====================
// Shared by OR (Invoice/AR_BEGINNING) and CV (APV/AP_BEGINNING) POST/PUT
// handlers - one code path for locking, currency/FX validation,
// overpayment protection, and the transaction_applications insert, instead
// of four near-duplicate copies.
//
// Checkpoint 3D: AR_BEGINNING/AP_BEGINNING now go through the SAME
// buildApplication/FX-account machinery as INV/APV - each beginning
// balance LINE is its own "source document" with its own
// transaction_currency_snapshots row (transaction_type='AR_BEGINNING'/
// 'AP_BEGINNING', transaction_id=line.id, see
// beginningBalanceCurrencyService.js). No second FX engine was built; this
// is the exact same buildApplication() call INV/APV already use, just fed
// the beginning-balance line's own snapshot instead of an invoice/APV
// header's.
//
// `paymentCurrencyCode`/`paymentExchangeRate`/`baseCurrencyCode` describe
// the OR/CV's OWN resolved currency (from its own resolveTransactionCurrency
// call) - never re-derived here.
async function applyInvoicePayment(conn, {
  appItem,
  appliedType, // "OR"
  appliedId,
  paymentCurrencyCode,
  paymentExchangeRate,
  baseCurrencyCode,
  fallbackDate,
  isPosting,
  companyId,
}) {
  const sourceId = appItem.sourceId ?? appItem.invoiceId ?? null;
  const requestedAmount = Number(appItem.amount || 0);
  if (!sourceId || requestedAmount <= 0) return null;

  const applicationDate = appItem.applicationDate || fallbackDate || new Date().toISOString().slice(0, 10);
  const sourceType = appItem.sourceType === "AR_BEGINNING" ? "AR_BEGINNING" : "INV";

  if (sourceType === "AR_BEGINNING") {
    const [rows] = await conn.execute(
      `SELECT COALESCE(l.balance_amount, l.debit, 0) AS balanceAmount, h.company_id AS companyId
       FROM arap_beginning_balance_lines l
       JOIN arap_beginning_balance_headers h ON h.id = l.header_id
       WHERE l.id = ? FOR UPDATE`,
      [sourceId]
    );
    if (!rows.length) throw new Error(`AR beginning balance ${sourceId} was not found.`);
    if (companyId && rows[0].companyId !== companyId) {
      throw new Error(`AR beginning balance ${sourceId} does not belong to this company - cross-company payment application is not allowed.`);
    }

    const sourceSnapshot = await TransactionCurrencyService.getSnapshot("AR_BEGINNING", sourceId);
    const isForeign = !!sourceSnapshot && sourceSnapshot.currencyId !== sourceSnapshot.baseCurrencyId;

    let currentBalance;
    if (isForeign) {
      const foreignState = await TransactionCurrencyService.getForeignPaymentState(conn, { transactionType: "AR_BEGINNING", transactionId: sourceId });
      currentBalance = foreignState.foreignBalanceAmount;
    } else {
      currentBalance = Number(rows[0].balanceAmount || 0);
    }

    const application = TransactionCurrencyService.buildApplication({
      sourceCurrencyCode: isForeign ? sourceSnapshot.currencyCode : baseCurrencyCode,
      sourceExchangeRate: isForeign ? await resolveSettlementSourceRate(conn, "AR_BEGINNING", sourceId, sourceSnapshot.exchangeRate, applicationDate) : 1,
      paymentCurrencyCode,
      paymentExchangeRate,
      foreignAmountApplied: requestedAmount,
      perspective: "RECEIVABLE",
      isPosting,
    });

    if (application.foreignAmountApplied - currentBalance > 0.01) {
      throw new Error(`Payment amount cannot exceed AR beginning balance of ${currentBalance.toFixed(2)}.`);
    }

    let fxAccount = null;
    if (application.fxDifference !== 0 && isPosting) {
      fxAccount = await FxAccountService.requireFxAccount(companyId, application.fxDirection);
    }

    const [insertResult] = await conn.execute(
      `INSERT INTO transaction_applications (
         source_type, source_id, applied_type, applied_id, amount, application_date,
         source_currency_code, payment_currency_code, foreign_amount_applied,
         source_exchange_rate, payment_exchange_rate, source_base_amount, payment_base_amount,
         fx_difference, fx_direction, fx_account_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "AR_BEGINNING", sourceId, appliedType, appliedId, application.baseAmount, applicationDate,
        application.sourceCurrencyCode, application.paymentCurrencyCode, application.foreignAmountApplied,
        application.sourceExchangeRate, application.paymentExchangeRate, application.sourceBaseAmount, application.paymentBaseAmount,
        application.fxDifference, application.fxDirection, fxAccount?.accountId || null,
      ]
    );

    // Base paid/balance always advance by application.baseAmount (===
    // sourceBaseAmount, valued at the beginning balance's own historical
    // opening rate - see buildApplication's comment on why baseAmount must
    // be sourceBaseAmount, not paymentBaseAmount).
    await conn.execute(
      `UPDATE arap_beginning_balance_lines
       SET paid_amount = COALESCE(paid_amount, 0) + ?,
           balance_amount = GREATEST(COALESCE(balance_amount, debit, 0) - ?, 0),
           status = CASE WHEN GREATEST(COALESCE(balance_amount, debit, 0) - ?, 0) <= 0 THEN 'Paid' ELSE 'Partially Paid' END
       WHERE id = ?`,
      [application.baseAmount, application.baseAmount, application.baseAmount, sourceId]
    );

    if (isForeign) {
      const foreignState = await TransactionCurrencyService.getForeignPaymentState(conn, { transactionType: "AR_BEGINNING", transactionId: sourceId });
      await conn.execute(
        `UPDATE arap_beginning_balance_lines SET foreign_paid_amount = ?, foreign_balance_amount = ? WHERE id = ?`,
        [foreignState.foreignPaidAmount, foreignState.foreignBalanceAmount, sourceId]
      );
    }

    return { ...application, applicationId: insertResult.insertId, fxAccount };
  }

  // Row-lock the invoice first (section 33) - serializes two concurrent
  // applications against the same invoice so the balance check below can't
  // race.
  const [invRows] = await conn.execute(
    "SELECT COALESCE(balance_amount, total_debit, 0) AS balanceAmount, company_id AS companyId FROM invoice_headers WHERE id = ? FOR UPDATE",
    [sourceId]
  );
  if (!invRows.length) throw new Error(`Invoice ${sourceId} was not found.`);
  if (companyId && invRows[0].companyId !== companyId) {
    throw new Error(`Invoice ${sourceId} does not belong to this company - cross-company payment application is not allowed.`);
  }

  const sourceSnapshot = await TransactionCurrencyService.getSnapshot("INV", sourceId);
  const isForeign = !!sourceSnapshot && sourceSnapshot.currencyId !== sourceSnapshot.baseCurrencyId;

  let currentBalance;
  if (isForeign) {
    const foreignState = await TransactionCurrencyService.getForeignPaymentState(conn, { transactionType: "INV", transactionId: sourceId });
    currentBalance = foreignState.foreignBalanceAmount;
  } else {
    currentBalance = Number(invRows[0].balanceAmount || 0);
  }

  const application = TransactionCurrencyService.buildApplication({
    sourceCurrencyCode: isForeign ? sourceSnapshot.currencyCode : baseCurrencyCode,
    sourceExchangeRate: isForeign ? await resolveSettlementSourceRate(conn, "INV", sourceId, sourceSnapshot.exchangeRate, applicationDate) : 1,
    paymentCurrencyCode,
    paymentExchangeRate,
    foreignAmountApplied: requestedAmount,
    perspective: "RECEIVABLE",
    isPosting,
  });

  if (application.foreignAmountApplied - currentBalance > 0.01) {
    throw new Error(`Payment amount cannot exceed invoice balance of ${currentBalance.toFixed(2)}.`);
  }

  // Checkpoint 3FX: resolve the configured FX account for THIS
  // application's own direction as soon as we know we need one - throws a
  // clear, specific error (which account is missing) and rolls back the
  // whole atomic transaction, rather than discovering the gap only after
  // journal lines were already partially built. Only required when
  // actually POSTING (section 13: "Do not post FX entries while Draft") -
  // a Draft application may carry a nonzero fxDifference (the estimate)
  // without any FX account configured yet; applyForeignSettlementToLines
  // is never invoked for a Draft save in the first place (server.js only
  // calls it from the Post flow), so there is nothing to post here either.
  let fxAccount = null;
  if (application.fxDifference !== 0 && isPosting) {
    fxAccount = await FxAccountService.requireFxAccount(companyId, application.fxDirection);
  }

  const [insertResult] = await conn.execute(
    `INSERT INTO transaction_applications (
       source_type, source_id, applied_type, applied_id, amount, application_date,
       source_currency_code, payment_currency_code, foreign_amount_applied,
       source_exchange_rate, payment_exchange_rate, source_base_amount, payment_base_amount,
       fx_difference, fx_direction, fx_account_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sourceType, sourceId, appliedType, appliedId, application.baseAmount, applicationDate,
      application.sourceCurrencyCode, application.paymentCurrencyCode, application.foreignAmountApplied,
      application.sourceExchangeRate, application.paymentExchangeRate, application.sourceBaseAmount, application.paymentBaseAmount,
      application.fxDifference, application.fxDirection, fxAccount?.accountId || null,
    ]
  );

  await updateInvoicePaymentStatus(conn, sourceId);
  return { ...application, applicationId: insertResult.insertId, fxAccount };
}

async function applyApvPayment(conn, {
  appItem,
  appliedType, // "CV"
  appliedId,
  paymentCurrencyCode,
  paymentExchangeRate,
  baseCurrencyCode,
  fallbackDate,
  isPosting,
  companyId,
}) {
  const sourceId = appItem.sourceId ?? appItem.apvId ?? null;
  const requestedAmount = Number(appItem.amount || 0);
  if (!sourceId || requestedAmount <= 0) return null;

  const applicationDate = appItem.applicationDate || fallbackDate || new Date().toISOString().slice(0, 10);
  const sourceType = appItem.sourceType === "AP_BEGINNING" ? "AP_BEGINNING" : "APV";

  if (sourceType === "AP_BEGINNING") {
    const [rows] = await conn.execute(
      `SELECT COALESCE(l.balance_amount, l.credit, 0) AS balanceAmount, h.company_id AS companyId
       FROM arap_beginning_balance_lines l
       JOIN arap_beginning_balance_headers h ON h.id = l.header_id
       WHERE l.id = ? FOR UPDATE`,
      [sourceId]
    );
    if (!rows.length) throw new Error(`AP beginning balance ${sourceId} was not found.`);
    if (companyId && rows[0].companyId !== companyId) {
      throw new Error(`AP beginning balance ${sourceId} does not belong to this company - cross-company payment application is not allowed.`);
    }

    const sourceSnapshot = await TransactionCurrencyService.getSnapshot("AP_BEGINNING", sourceId);
    const isForeign = !!sourceSnapshot && sourceSnapshot.currencyId !== sourceSnapshot.baseCurrencyId;

    let currentBalance;
    if (isForeign) {
      const foreignState = await TransactionCurrencyService.getForeignPaymentState(conn, { transactionType: "AP_BEGINNING", transactionId: sourceId });
      currentBalance = foreignState.foreignBalanceAmount;
    } else {
      currentBalance = Number(rows[0].balanceAmount || 0);
    }

    const application = TransactionCurrencyService.buildApplication({
      sourceCurrencyCode: isForeign ? sourceSnapshot.currencyCode : baseCurrencyCode,
      sourceExchangeRate: isForeign ? await resolveSettlementSourceRate(conn, "AP_BEGINNING", sourceId, sourceSnapshot.exchangeRate, applicationDate) : 1,
      paymentCurrencyCode,
      paymentExchangeRate,
      foreignAmountApplied: requestedAmount,
      perspective: "PAYABLE",
      isPosting,
    });

    if (application.foreignAmountApplied - currentBalance > 0.01) {
      throw new Error(`Payment amount cannot exceed AP beginning balance of ${currentBalance.toFixed(2)}.`);
    }

    let fxAccount = null;
    if (application.fxDifference !== 0 && isPosting) {
      fxAccount = await FxAccountService.requireFxAccount(companyId, application.fxDirection);
    }

    const [insertResult] = await conn.execute(
      `INSERT INTO transaction_applications (
         source_type, source_id, applied_type, applied_id, amount, application_date,
         source_currency_code, payment_currency_code, foreign_amount_applied,
         source_exchange_rate, payment_exchange_rate, source_base_amount, payment_base_amount,
         fx_difference, fx_direction, fx_account_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "AP_BEGINNING", sourceId, appliedType, appliedId, application.baseAmount, applicationDate,
        application.sourceCurrencyCode, application.paymentCurrencyCode, application.foreignAmountApplied,
        application.sourceExchangeRate, application.paymentExchangeRate, application.sourceBaseAmount, application.paymentBaseAmount,
        application.fxDifference, application.fxDirection, fxAccount?.accountId || null,
      ]
    );

    await conn.execute(
      `UPDATE arap_beginning_balance_lines
       SET paid_amount = COALESCE(paid_amount, 0) + ?,
           balance_amount = GREATEST(COALESCE(balance_amount, credit, 0) - ?, 0),
           status = CASE WHEN GREATEST(COALESCE(balance_amount, credit, 0) - ?, 0) <= 0 THEN 'Paid' ELSE 'Partially Paid' END
       WHERE id = ?`,
      [application.baseAmount, application.baseAmount, application.baseAmount, sourceId]
    );

    if (isForeign) {
      const foreignState = await TransactionCurrencyService.getForeignPaymentState(conn, { transactionType: "AP_BEGINNING", transactionId: sourceId });
      await conn.execute(
        `UPDATE arap_beginning_balance_lines SET foreign_paid_amount = ?, foreign_balance_amount = ? WHERE id = ?`,
        [foreignState.foreignPaidAmount, foreignState.foreignBalanceAmount, sourceId]
      );
    }

    return { ...application, applicationId: insertResult.insertId, fxAccount };
  }

  const [apvRows] = await conn.execute(
    "SELECT COALESCE(balance_amount, total_credit, 0) AS balanceAmount, company_id AS companyId FROM apv_headers WHERE id = ? FOR UPDATE",
    [sourceId]
  );
  if (!apvRows.length) throw new Error(`APV ${sourceId} was not found.`);
  if (companyId && apvRows[0].companyId !== companyId) {
    throw new Error(`APV ${sourceId} does not belong to this company - cross-company payment application is not allowed.`);
  }

  const sourceSnapshot = await TransactionCurrencyService.getSnapshot("APV", sourceId);
  const isForeign = !!sourceSnapshot && sourceSnapshot.currencyId !== sourceSnapshot.baseCurrencyId;

  let currentBalance;
  if (isForeign) {
    const foreignState = await TransactionCurrencyService.getForeignPaymentState(conn, { transactionType: "APV", transactionId: sourceId });
    currentBalance = foreignState.foreignBalanceAmount;
  } else {
    currentBalance = Number(apvRows[0].balanceAmount || 0);
  }

  const application = TransactionCurrencyService.buildApplication({
    sourceCurrencyCode: isForeign ? sourceSnapshot.currencyCode : baseCurrencyCode,
    sourceExchangeRate: isForeign ? await resolveSettlementSourceRate(conn, "APV", sourceId, sourceSnapshot.exchangeRate, applicationDate) : 1,
    paymentCurrencyCode,
    paymentExchangeRate,
    foreignAmountApplied: requestedAmount,
    perspective: "PAYABLE",
    isPosting,
  });

  if (application.foreignAmountApplied - currentBalance > 0.01) {
    throw new Error(`Payment amount cannot exceed APV balance of ${currentBalance.toFixed(2)}.`);
  }

  // See applyInvoicePayment above - only required when actually posting.
  let fxAccount = null;
  if (application.fxDifference !== 0 && isPosting) {
    fxAccount = await FxAccountService.requireFxAccount(companyId, application.fxDirection);
  }

  const [insertResult] = await conn.execute(
    `INSERT INTO transaction_applications (
       source_type, source_id, applied_type, applied_id, amount, application_date,
       source_currency_code, payment_currency_code, foreign_amount_applied,
       source_exchange_rate, payment_exchange_rate, source_base_amount, payment_base_amount,
       fx_difference, fx_direction, fx_account_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sourceType, sourceId, appliedType, appliedId, application.baseAmount, applicationDate,
      application.sourceCurrencyCode, application.paymentCurrencyCode, application.foreignAmountApplied,
      application.sourceExchangeRate, application.paymentExchangeRate, application.sourceBaseAmount, application.paymentBaseAmount,
      application.fxDifference, application.fxDirection, fxAccount?.accountId || null,
    ]
  );

  await updateApvPaymentStatus(conn, sourceId);
  return { ...application, applicationId: insertResult.insertId, fxAccount };
}

// ===================== CHECKPOINT 3FX: REALIZED FX SETTLEMENT LINES =====================
//
// Runs once per OR/CV, AFTER all of its applyInvoicePayment/applyApvPayment
// calls (one per selected source document) have completed and their
// journal lines (Cash + the auto-filled AR/AP line) are already inserted
// into or_lines/cv_lines at the OR/CV's own uniform rate. That uniform
// conversion is exactly right for every line EXCEPT the AR/AP settlement
// line, which today's rate does not touch - the historical basis it's
// settling belongs to the SOURCE document's own (unchanged) rate. This
// function corrects exactly that one line and adds the FX line(s) needed
// to keep the voucher balanced. If every application settled at its
// source's own rate (the only case Checkpoint 3B allowed), fxDifference is
// 0 for all of them and this is a complete no-op - same-rate behavior is
// untouched.
//
// Math (verified against both worked examples in the 3FX spec before
// writing this code): let aggregateSourceBase = SUM(sourceBaseAmount) and
// aggregatePaymentBase = SUM(paymentBaseAmount) across all applications.
// The Cash/Bank line was already converted at aggregatePaymentBase (the
// OR/CV's own uniform rate applied to the SAME foreign total the AR/AP
// line carries). Overriding the AR/AP line to aggregateSourceBase and
// adding a Gain CREDIT / Loss DEBIT line for
// SUM(fxDifference where >0) / SUM(-fxDifference where <0) respectively
// balances exactly for ANY mix of gains and losses, because
// aggregatePaymentBase - aggregateSourceBase == SUM(fxDifference) by
// construction (fxDifference := paymentBaseAmount - sourceBaseAmount per
// application) == totalGain - totalLoss. Section 17: gain and loss are
// kept as two SEPARATE lines (never netted into one), so every
// application's own contribution stays traceable via its stored
// fx_account_id/fx_difference/fx_direction row.
async function applyForeignSettlementToLines(conn, {
  headerTable, // "or_headers" | "cv_headers"
  lineTable, // "or_lines" | "cv_lines"
  lineIdCol, // "or_id" | "cv_id"
  transactionId,
  applications, // the array of (non-null) results from applyInvoicePayment/applyApvPayment
  perspective, // "RECEIVABLE" | "PAYABLE"
}) {
  const withFx = applications.filter(Boolean);
  if (!withFx.length) return { totalGainAmount: 0, totalLossAmount: 0 };

  const aggregateSourceBase = roundMoney(withFx.reduce((s, a) => s + a.sourceBaseAmount, 0));
  // Must classify by each application's own fxDirection (already
  // perspective-aware, computed by buildApplication), NOT by the raw sign
  // of fxDifference - for PAYABLE that sign is inverted relative to
  // RECEIVABLE (a positive fxDifference is a GAIN for a receivable but a
  // LOSS for a payable). Using the raw sign here would silently swap
  // gain/loss for every APV->CV settlement.
  const totalGainAmount = roundMoney(withFx.reduce((s, a) => s + (a.fxDirection === "REALIZED_GAIN" ? Math.abs(a.fxDifference) : 0), 0));
  const totalLossAmount = roundMoney(withFx.reduce((s, a) => s + (a.fxDirection === "REALIZED_LOSS" ? Math.abs(a.fxDifference) : 0), 0));

  if (totalGainAmount === 0 && totalLossAmount === 0) return { totalGainAmount, totalLossAmount };

  // Locate the settlement line the same way the frontend does (title
  // contains "receivable"/"payable") - the only account-classification
  // signal this system has (chart_of_accounts has no dedicated AR/AP
  // flag). Every application in `withFx` came from a modal that only ever
  // shows once an AR/AP line exists on this exact voucher (section 28 of
  // the 3B spec), so failing to find one here indicates real data
  // corruption, not a normal path - fail loudly rather than silently
  // skip the correction and post a wrong historical basis.
  const titleFilter = perspective === "PAYABLE" ? "payable" : "receivable";
  const [lineRows] = await conn.execute(
    `SELECT t.id, t.debit, t.credit
     FROM ${lineTable} t
     JOIN chart_of_accounts coa ON coa.id = t.account_id
     WHERE t.${lineIdCol} = ? AND LOWER(coa.title) LIKE ?`,
    [transactionId, `%${titleFilter}%`]
  );
  if (!lineRows.length) {
    throw new Error(
      `Could not locate the ${perspective === "PAYABLE" ? "Accounts Payable" : "Accounts Receivable"} line to apply the realized FX adjustment to.`
    );
  }
  const settlementLine = lineRows[0];
  const settlementColumn = perspective === "PAYABLE" ? "debit" : "credit";

  await conn.execute(
    `UPDATE ${lineTable} SET ${settlementColumn} = ? WHERE id = ?`,
    [aggregateSourceBase, settlementLine.id]
  );

  if (totalGainAmount > 0) {
    const gainAccount = withFx.find((a) => a.fxDirection === "REALIZED_GAIN")?.fxAccount;
    await conn.execute(
      `INSERT INTO ${lineTable} (${lineIdCol}, account_id, account_code, account_title, particulars, debit, credit)
       VALUES (?, ?, ?, ?, 'Realized Foreign Exchange Gain', 0, ?)`,
      [transactionId, gainAccount.accountId, gainAccount.accountCode, gainAccount.accountTitle, totalGainAmount]
    );
  }
  if (totalLossAmount > 0) {
    const lossAccount = withFx.find((a) => a.fxDirection === "REALIZED_LOSS")?.fxAccount;
    await conn.execute(
      `INSERT INTO ${lineTable} (${lineIdCol}, account_id, account_code, account_title, particulars, debit, credit)
       VALUES (?, ?, ?, ?, 'Realized Foreign Exchange Loss', ?, 0)`,
      [transactionId, lossAccount.accountId, lossAccount.accountCode, lossAccount.accountTitle, totalLossAmount]
    );
  }

  // Section 18: assert exact balance before letting the caller commit -
  // this is provably guaranteed by the math above, but a real assertion
  // (not just a comment) is what section 18 explicitly asks for. Any
  // failure rolls back the entire atomic transaction (the caller's
  // conn.rollback() in its catch block), never a partially-applied state.
  const [balanceRows] = await conn.execute(
    `SELECT COALESCE(SUM(debit), 0) AS totalDebit, COALESCE(SUM(credit), 0) AS totalCredit FROM ${lineTable} WHERE ${lineIdCol} = ?`,
    [transactionId]
  );
  const { totalDebit, totalCredit } = balanceRows[0];
  if (Math.abs(Number(totalDebit) - Number(totalCredit)) > 0.01) {
    throw new Error(
      `Realized FX settlement produced an unbalanced voucher (debit ${totalDebit} vs credit ${totalCredit}) - posting has been cancelled.`
    );
  }

  await conn.execute(`UPDATE ${headerTable} SET total_debit = ?, total_credit = ? WHERE id = ?`, [
    totalDebit, totalCredit, transactionId,
  ]);

  return { totalGainAmount, totalLossAmount };
}

module.exports = {
  updateInvoicePaymentStatus,
  updateApvPaymentStatus,
  applyInvoicePayment,
  applyApvPayment,
  applyForeignSettlementToLines,
};
