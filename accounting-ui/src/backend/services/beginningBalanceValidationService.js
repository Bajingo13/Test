const { parseStatementDate, parseStatementAmount } = require("./StatementImportService");

// Pure validation functions - no DB/network calls inside, operate on a
// pre-fetched `context` (accounts/parties looked up once per batch, not
// once per row). Called identically by preview and commit
// (beginningBalanceImportService.js) so there is exactly one place this
// logic lives - commit re-runs these against freshly re-fetched context
// rather than trusting anything the client sent back from preview.

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase();
}

function err(column, value, message) {
  return { column, value: value ?? "", message };
}

// Checkpoint 3D: shared currency validation for GL/AR/AP rows. Pure - takes
// a pre-fetched context.currenciesByCode map (mirrors accountsByCode) plus
// context.baseCurrencyCode, never calls the resolver itself (section 18's
// historical-rate lookup happens in the import service, which already does
// async DB work - this function only validates what's already on the row).
function validateCurrency(row, context) {
  const errors = [];
  const warnings = [];

  const rawCode = row.currencyCode ? String(row.currencyCode).trim().toUpperCase() : "";
  const openingRate = row.openingRate === "" || row.openingRate == null ? null : parseStatementAmount(row.openingRate);
  const baseCode = String(context.baseCurrencyCode || "PHP").toUpperCase();

  if (!rawCode || rawCode === baseCode) {
    if (openingRate != null && Math.abs(openingRate - 1) > 0.000001) {
      errors.push(err("Opening Exchange Rate", row.openingRate, `Opening Exchange Rate must be 1 for the base currency (${baseCode}).`));
    }
    return { errors, warnings, currencyCode: baseCode, currencyId: context.baseCurrencyId || null, openingRate: 1, rateDate: null, isBase: true };
  }

  const currency = context.currenciesByCode.get(rawCode);
  if (!currency) {
    errors.push(err("Currency Code", rawCode, `Currency Code "${rawCode}" does not exist for this company.`));
    return { errors, warnings, currencyCode: rawCode, currencyId: null, openingRate: null, rateDate: null, isBase: false };
  }
  if (!currency.isActive) {
    errors.push(err("Currency Code", rawCode, `Currency "${rawCode}" is not active.`));
  }

  if (openingRate == null) {
    errors.push(
      err(
        "Opening Exchange Rate",
        row.openingRate,
        `Opening Exchange Rate is required for foreign currency "${rawCode}" (no automatic historical lookup is performed during import - provide the opening rate that applied when this balance was brought into the system).`
      )
    );
  } else if (openingRate <= 0) {
    errors.push(err("Opening Exchange Rate", row.openingRate, "Opening Exchange Rate must be greater than zero."));
  }

  return {
    errors,
    warnings,
    currencyCode: currency.currencyCode,
    currencyId: currency.id,
    openingRate: openingRate,
    rateDate: row.rateDate ? parseStatementDate(row.rateDate) : null,
    isBase: false,
  };
}

// ---- GL Beginning Balance ----

function validateGLRow(row, context) {
  const errors = [];
  const warnings = [];

  const accountCode = String(row.accountCode || "").trim();
  const balanceDate = parseStatementDate(row.balanceDate);
  const debit = row.debit === "" || row.debit == null ? null : parseStatementAmount(row.debit);
  const credit = row.credit === "" || row.credit == null ? null : parseStatementAmount(row.credit);

  if (!accountCode) {
    errors.push(err("Account Code", row.accountCode, "Account Code is required."));
  }

  if (!row.balanceDate) {
    errors.push(err("Beginning Balance Date", row.balanceDate, "Beginning Balance Date is required."));
  } else if (!balanceDate) {
    errors.push(err("Beginning Balance Date", row.balanceDate, "Beginning Balance Date is not a valid date."));
  }

  const debitVal = debit || 0;
  const creditVal = credit || 0;

  if (row.debit && row.credit && debitVal > 0 && creditVal > 0) {
    errors.push(
      err("Debit / Credit", `${row.debit} / ${row.credit}`, "Debit and Credit cannot both contain an amount on the same row.")
    );
  } else if (debitVal === 0 && creditVal === 0) {
    errors.push(err("Debit / Credit", "0 / 0", "Debit and Credit cannot both be zero."));
  }

  let account = null;
  if (accountCode) {
    account = context.accountsByCode.get(normalizeCode(accountCode));
    if (!account) {
      errors.push(err("Account Code", accountCode, `Account Code "${accountCode}" does not exist in the Chart of Accounts.`));
    } else if (
      row.accountTitle &&
      String(row.accountTitle).trim().toLowerCase() !== String(account.title).trim().toLowerCase()
    ) {
      warnings.push(
        err(
          "Account Title",
          row.accountTitle,
          `Account Title does not match Account Code ${accountCode} (Chart of Accounts has "${account.title}") - Account Code is what's actually used, title is reference only.`
        )
      );
    }
  }

  const currencyResult = validateCurrency(row, context);
  errors.push(...currencyResult.errors);
  warnings.push(...currencyResult.warnings);

  return {
    errors,
    warnings,
    resolved: {
      accountId: account ? account.id : null,
      accountCode: account ? account.code : accountCode,
      accountTitle: account ? account.title : String(row.accountTitle || "").trim(),
      balanceDate,
      debit: debitVal,
      credit: creditVal,
      referenceNo: row.referenceNo ? String(row.referenceNo).trim() : null,
      description: row.description ? String(row.description).trim() : null,
      department: row.department ? String(row.department).trim() : null,
      project: row.project ? String(row.project).trim() : null,
      remarks: row.remarks ? String(row.remarks).trim() : null,
      currencyId: currencyResult.currencyId,
      currencyCode: currencyResult.currencyCode,
      openingRate: currencyResult.openingRate,
      rateDate: currencyResult.rateDate,
    },
  };
}

// Batch-level: total debit must equal total credit, in BASE currency,
// across every VALID row in the file before commit is even offered as an
// option (section 4 - never require different-currency rows to balance
// against each other in their own foreign amounts). Rows carry their own
// openingRate (1 for base-currency rows), so this single reduction is
// correct whether the batch is all-PHP or a mix of USD/EUR/PHP.
function baseAmount(row, field) {
  const rate = Number(row.openingRate) || 1;
  return Math.round((Number(row[field]) || 0) * rate * 100) / 100;
}

function validateGLBatchBalance(resolvedRows) {
  const totalDebit = resolvedRows.reduce((sum, r) => sum + baseAmount(r, "debit"), 0);
  const totalCredit = resolvedRows.reduce((sum, r) => sum + baseAmount(r, "credit"), 0);
  const difference = Math.round((totalDebit - totalCredit) * 100) / 100;

  return { totalDebit, totalCredit, difference, balanced: Math.abs(difference) < 0.01 };
}

// Foreign totals grouped BY CURRENCY (section 17) - never summed across
// different currencies into one meaningless number. `fields` names which
// resolved-row properties to sum (GL: debit/credit; AR/AP: originalAmount).
function summarizeForeignTotalsByCurrency(resolvedRows, fields) {
  const byCurrency = new Map();
  for (const row of resolvedRows) {
    if (!row.currencyCode || row.currencyId == null) continue; // base-currency rows aren't "foreign"
    const key = row.currencyCode;
    if (!byCurrency.has(key)) {
      byCurrency.set(key, { currencyCode: key, ...Object.fromEntries(fields.map((f) => [f, 0])) });
    }
    const entry = byCurrency.get(key);
    for (const f of fields) {
      entry[f] = Math.round((entry[f] + (Number(row[f]) || 0)) * 100) / 100;
    }
  }
  return Array.from(byCurrency.values());
}

// ---- AR / AP Beginning Balance (shared - AR and AP differ only in which
// party type / COA validation flag a row must resolve against, and label
// text, so this is one function parameterized rather than two near-copies) ----

function validatePartyRow(row, context, { partyTypeLabel }) {
  const errors = [];
  const warnings = [];

  const partyCode = String(row.partyCode || "").trim();
  const accountCode = String(row.accountCode || "").trim();
  const balanceDate = row.balanceDate ? parseStatementDate(row.balanceDate) : null;
  const documentDate = row.documentDate ? parseStatementDate(row.documentDate) : null;
  const dueDate = row.dueDate ? parseStatementDate(row.dueDate) : null;
  const originalAmount =
    row.originalAmount === "" || row.originalAmount == null ? null : parseStatementAmount(row.originalAmount);
  const paidAmountRaw =
    row.paidAmount === "" || row.paidAmount == null ? 0 : parseStatementAmount(row.paidAmount);
  const paidAmount = paidAmountRaw || 0;
  const balanceAmount =
    row.balanceAmount === "" || row.balanceAmount == null ? null : parseStatementAmount(row.balanceAmount);

  if (!partyCode) {
    errors.push(err(`${partyTypeLabel} Code`, row.partyCode, `${partyTypeLabel} Code is required.`));
  }

  let party = null;
  if (partyCode) {
    party = context.partiesByCode.get(normalizeCode(partyCode));
    if (!party) {
      errors.push(
        err(`${partyTypeLabel} Code`, partyCode, `${partyTypeLabel} Code "${partyCode}" does not exist in General Libraries.`)
      );
    } else if (
      row.partyName &&
      String(row.partyName).trim().toLowerCase() !== String(party.name).trim().toLowerCase()
    ) {
      warnings.push(
        err(
          `${partyTypeLabel} Name`,
          row.partyName,
          `${partyTypeLabel} Name does not match ${partyTypeLabel} Code ${partyCode} (General Libraries has "${party.name}") - ${partyTypeLabel} Code is what's actually used, name is reference only.`
        )
      );
    }
  }

  let account = null;
  if (!accountCode) {
    errors.push(err("Account Code", row.accountCode, "Account Code is required."));
  } else {
    account = context.accountsByCode.get(normalizeCode(accountCode));
    if (!account) {
      errors.push(
        err(
          "Account Code",
          accountCode,
          `Account Code "${accountCode}" does not exist, or is not flagged as a valid ${partyTypeLabel === "Customer" ? "Accounts Receivable (AR CODE)" : "Accounts Payable (AP CODE)"} account in the Chart of Accounts.`
        )
      );
    }
  }

  if (!row.balanceDate) {
    errors.push(err("Beginning Balance Date", row.balanceDate, "Beginning Balance Date is required."));
  } else if (!balanceDate) {
    errors.push(err("Beginning Balance Date", row.balanceDate, "Beginning Balance Date is not a valid date."));
  }

  if (row.documentDate && !documentDate) {
    errors.push(err("Document Date", row.documentDate, "Document Date is not a valid date."));
  }

  if (!row.dueDate) {
    errors.push(err("Due Date", row.dueDate, "Due Date is required."));
  } else if (!dueDate) {
    errors.push(err("Due Date", row.dueDate, "Due Date is not a valid date."));
  } else if (documentDate && dueDate < documentDate) {
    errors.push(err("Due Date", row.dueDate, "Due Date cannot be earlier than Document Date."));
  }

  if (originalAmount === null) {
    errors.push(err("Original Amount", row.originalAmount, "Original Amount is required."));
  } else if (originalAmount < 0) {
    errors.push(err("Original Amount", row.originalAmount, "Original Amount cannot be negative."));
  }

  if (paidAmountRaw !== null && paidAmountRaw < 0) {
    errors.push(err("Paid Amount", row.paidAmount, "Paid Amount cannot be negative."));
  } else if (originalAmount !== null && paidAmount > originalAmount) {
    errors.push(err("Paid Amount", row.paidAmount, "Paid Amount cannot exceed Original Amount."));
  }

  if (originalAmount !== null && balanceAmount !== null) {
    const expectedBalance = Math.round((originalAmount - paidAmount) * 100) / 100;
    if (Math.abs(expectedBalance - balanceAmount) > 0.01) {
      errors.push(
        err(
          "Balance Amount",
          row.balanceAmount,
          `Balance Amount must equal Original Amount minus Paid Amount (expected ${expectedBalance.toFixed(2)}).`
        )
      );
    }
  }

  const resolvedBalance =
    balanceAmount !== null
      ? balanceAmount
      : originalAmount !== null
      ? Math.round((originalAmount - paidAmount) * 100) / 100
      : 0;

  const currencyResult = validateCurrency(row, context);
  errors.push(...currencyResult.errors);
  warnings.push(...currencyResult.warnings);

  return {
    errors,
    warnings,
    resolved: {
      partyId: party ? party.id : null,
      partyCode: party ? party.code : partyCode,
      partyName: party ? party.name : String(row.partyName || "").trim(),
      accountId: account ? account.id : null,
      accountCode: account ? account.code : accountCode,
      accountTitle: account ? account.title : "",
      documentNumber: row.documentNumber ? String(row.documentNumber).trim() : null,
      balanceDate,
      documentDate,
      dueDate,
      referenceNo: row.referenceNo ? String(row.referenceNo).trim() : null,
      originalAmount: originalAmount || 0,
      paidAmount,
      balanceAmount: resolvedBalance,
      currencyId: currencyResult.currencyId,
      currencyCode: currencyResult.currencyCode,
      openingRate: currencyResult.openingRate,
      rateDate: currencyResult.rateDate,
    },
  };
}

function validateARRow(row, context) {
  return validatePartyRow(row, context, { partyTypeLabel: "Customer" });
}

function validateAPRow(row, context) {
  return validatePartyRow(row, context, { partyTypeLabel: "Supplier" });
}

// ---- Shared, module-agnostic checks ----

// In-file duplicate detection - flags rows that are identical on the given
// key fields to an earlier row in the same file (not the database).
function findInFileDuplicates(rows, keyFn) {
  const seen = new Map();
  const duplicateRowNumbers = new Set();

  rows.forEach((row, idx) => {
    const key = keyFn(row);
    if (!key) return;
    if (seen.has(key)) {
      duplicateRowNumbers.add(idx);
      duplicateRowNumbers.add(seen.get(key));
    } else {
      seen.set(key, idx);
    }
  });

  return duplicateRowNumbers;
}

module.exports = {
  normalizeCode,
  validateCurrency,
  validateGLRow,
  validateGLBatchBalance,
  summarizeForeignTotalsByCurrency,
  validateARRow,
  validateAPRow,
  findInFileDuplicates,
};
