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
    },
  };
}

// Batch-level: total debit must equal total credit across every VALID row
// in the file before commit is even offered as an option.
function validateGLBatchBalance(resolvedRows) {
  const totalDebit = resolvedRows.reduce((sum, r) => sum + (r.debit || 0), 0);
  const totalCredit = resolvedRows.reduce((sum, r) => sum + (r.credit || 0), 0);
  const difference = Math.round((totalDebit - totalCredit) * 100) / 100;

  return { totalDebit, totalCredit, difference, balanced: Math.abs(difference) < 0.01 };
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
  validateGLRow,
  validateGLBatchBalance,
  findInFileDuplicates,
};
