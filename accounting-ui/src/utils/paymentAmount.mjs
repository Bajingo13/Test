// Payment Details amount (CV "Check / Transfer / Cash Amount", OR receipt
// amount) - the voucher's bank movement, computed with the SAME rule bank
// reconciliation uses (backend/services/BankMatchingService.js
// bankMovement): the net of the voucher's own lines on the selected bank
// account's GL account (bank_codes.coa_account_id) -
//   CV: SUM(credit - debit)  (money out)
//   OR: SUM(debit - credit)  (money in)
// and only when no line touches that GL account (no bank selected, a bank
// code without a GL link, or a voucher booked to another cash account) the
// fallback gross (total debit) - tax withheld. Display only: nothing here is
// stored; the amount always follows the journal lines.

export const AMOUNT_SOURCE = { BANK_LINE: "BANK_LINE", GROSS_LESS_WITHHOLDING: "GROSS_LESS_WITHHOLDING" };

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export function paymentAmount({ code, lines = [], bankAccount = null, taxWithheld = 0 }) {
  const coa = bankAccount?.coaAccountId != null && bankAccount.coaAccountId !== "" ? String(bankAccount.coaAccountId) : null;
  const onBank = coa ? lines.filter((l) => l && l.accountId !== undefined && l.accountId !== null && String(l.accountId) === coa) : [];
  if (onBank.length) {
    const net = onBank.reduce(
      (sum, l) => sum + (code === "OR" ? Number(l.debit || 0) - Number(l.credit || 0) : Number(l.credit || 0) - Number(l.debit || 0)),
      0
    );
    return { amount: round2(net), source: AMOUNT_SOURCE.BANK_LINE };
  }
  const gross = lines.reduce((sum, l) => sum + Number(l?.debit || 0), 0);
  return { amount: round2(gross - Number(taxWithheld || 0)), source: AMOUNT_SOURCE.GROSS_LESS_WITHHOLDING };
}
