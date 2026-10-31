-- R9 payment-field audit - READ ONLY (SELECT statements only; changes nothing).
-- Run against a database to see how existing OR / CV rows use the payment
-- fields before / after the R9 code is deployed. Not a migration: it is not
-- listed in migrationOrder.js and never runs at startup.
--
-- Known limitation BANK-OWNERSHIP-01: bank_codes has no company column, so a
-- bank account cannot be checked against the document company yet.
--
-- Nothing here is "fixed" automatically: an existing row whose fields
-- disagree cannot be corrected without knowing what the user meant, so the
-- review lists are for an accountant to check by hand.

-- 1. How each method is used, per company.
SELECT 'OR' AS doc, company_id, payment_method, COUNT(*) AS documents,
       SUM(check_no IS NOT NULL AND check_no <> '') AS with_check_no,
       SUM(check_date IS NOT NULL) AS with_check_date,
       SUM(receipt_no IS NOT NULL AND receipt_no <> '') AS with_receipt_no,
       SUM(bank_account_id IS NOT NULL) AS with_bank_account
FROM or_headers GROUP BY company_id, payment_method
UNION ALL
SELECT 'CV', company_id, payment_method, COUNT(*),
       SUM(check_no IS NOT NULL AND check_no <> ''), SUM(check_date IS NOT NULL), NULL, SUM(bank_account_id IS NOT NULL)
FROM cv_headers GROUP BY company_id, payment_method
ORDER BY doc, company_id, payment_method;

-- 2. Unexpected stored method values (anything other than the three labels).
SELECT 'OR' AS doc, payment_method, COUNT(*) AS documents FROM or_headers
WHERE payment_method NOT IN ('Cash', 'Check', 'Bank Transfer') GROUP BY payment_method
UNION ALL
SELECT 'CV', payment_method, COUNT(*) FROM cv_headers
WHERE payment_method NOT IN ('Cash', 'Check', 'Bank Transfer') GROUP BY payment_method;

-- 3. REVIEW: Check ORs with no check number but a receipt number - the
--    receipt-number field was labelled "Check No." before R9, so the check
--    number may have been typed there. Bank Reconciliation will NOT use it as
--    a check number.
SELECT id, company_id, voucher_no, DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transaction_date, status,
       receipt_no, check_no, bank_account_id
FROM or_headers
WHERE payment_method = 'Check' AND (check_no IS NULL OR check_no = '') AND receipt_no IS NOT NULL AND receipt_no <> ''
ORDER BY company_id, transaction_date, id;

-- 4. REVIEW: ORs of any method with a receipt number that looks like a check
--    number (digits only) - informational; may simply be receipt numbers.
SELECT company_id, payment_method, COUNT(*) AS documents
FROM or_headers WHERE receipt_no REGEXP '^[0-9]{4,}$'
GROUP BY company_id, payment_method;

-- 5. REVIEW: Cash CVs that carry a check number (before R9 the CV API stored
--    check_no for any method). Either the method or the number is wrong.
SELECT id, company_id, voucher_no, DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transaction_date, status, check_no, bank_account_id
FROM cv_headers
WHERE payment_method = 'Cash' AND check_no IS NOT NULL AND check_no <> ''
ORDER BY company_id, transaction_date, id;

-- 6. REVIEW: posted Checks missing the check number / date / bank account
--    (R9 requires them when posting; existing posted rows are untouched).
SELECT 'OR' AS doc, id, company_id, voucher_no, check_no, check_date, bank_account_id FROM or_headers
WHERE UPPER(status) = 'POSTED' AND payment_method = 'Check'
  AND ((check_no IS NULL OR check_no = '') OR check_date IS NULL OR bank_account_id IS NULL)
UNION ALL
SELECT 'CV', id, company_id, voucher_no, check_no, check_date, bank_account_id FROM cv_headers
WHERE UPPER(status) = 'POSTED' AND payment_method = 'Check'
  AND ((check_no IS NULL OR check_no = '') OR check_date IS NULL OR bank_account_id IS NULL)
ORDER BY doc, company_id, id;

-- 7. REVIEW (future phase): posted Cash vouchers on a bank account with a
--    GL link but no line on that GL account (booked to cash on hand). Bank
--    Reconciliation counts them as bank movement through the gross-minus-
--    withholding fallback. R9 does NOT change that; these are the vouchers a
--    later, controlled phase must review before their treatment changes.
SELECT 'OR' AS doc, h.company_id, h.bank_account_id, COUNT(*) AS documents
FROM or_headers h JOIN bank_codes bc ON bc.id = h.bank_account_id AND bc.coa_account_id IS NOT NULL
WHERE UPPER(h.status) = 'POSTED' AND h.payment_method = 'Cash'
  AND NOT EXISTS (SELECT 1 FROM or_lines l WHERE l.or_id = h.id AND l.account_id = bc.coa_account_id)
GROUP BY h.company_id, h.bank_account_id
UNION ALL
SELECT 'CV', h.company_id, h.bank_account_id, COUNT(*)
FROM cv_headers h JOIN bank_codes bc ON bc.id = h.bank_account_id AND bc.coa_account_id IS NOT NULL
WHERE UPPER(h.status) = 'POSTED' AND h.payment_method = 'Cash'
  AND NOT EXISTS (SELECT 1 FROM cv_lines l WHERE l.cv_id = h.id AND l.account_id = bc.coa_account_id)
GROUP BY h.company_id, h.bank_account_id;

-- 8. Of those, the ones already CONFIRMED in a bank reconciliation (listed
--    for the same future review; nothing is changed).
SELECT m.book_source_type, m.book_source_id, m.session_id, m.statement_line_id, m.amount
FROM bank_recon_matches m
JOIN or_headers h ON m.book_source_type = 'OR' AND h.id = m.book_source_id
JOIN bank_codes bc ON bc.id = h.bank_account_id AND bc.coa_account_id IS NOT NULL
WHERE m.status = 'CONFIRMED' AND h.payment_method = 'Cash'
  AND NOT EXISTS (SELECT 1 FROM or_lines l WHERE l.or_id = h.id AND l.account_id = bc.coa_account_id)
UNION ALL
SELECT m.book_source_type, m.book_source_id, m.session_id, m.statement_line_id, m.amount
FROM bank_recon_matches m
JOIN cv_headers h ON m.book_source_type = 'CV' AND h.id = m.book_source_id
JOIN bank_codes bc ON bc.id = h.bank_account_id AND bc.coa_account_id IS NOT NULL
WHERE m.status = 'CONFIRMED' AND h.payment_method = 'Cash'
  AND NOT EXISTS (SELECT 1 FROM cv_lines l WHERE l.cv_id = h.id AND l.account_id = bc.coa_account_id);
