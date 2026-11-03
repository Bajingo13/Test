-- R11 bank account ownership and payment data audit - READ ONLY (SELECT
-- statements only; changes nothing). Not a migration: it is not listed in
-- migrationOrder.js and never runs at startup. Run r9PaymentFieldAudit.sql as
-- well - this file only adds what that one does not cover.
--
-- An empty result means nothing to review. Every result is for an accountant
-- to check by hand; nothing here can tell what the user originally meant.
--
-- Which parts can run depends on the migrations the database has:
--   R11-00 and Part 1  the schema on origin/main (the last pushed code)
--   Part 2             + bank_recon_company_scope_migration.sql
--   Part 3             + r9_payment_details_migration.sql
--   Part 4             + r10_deposit_slips_migration.sql
-- R11-00 reports which of these exist. A query from a part whose migration is
-- missing fails with "Unknown column" / "doesn't exist" and changes nothing;
-- --force below carries on with the next query, and such a part has nothing
-- to review because that feature was never deployed there.
--
-- The first column of every result names the query, e.g. R11-03.
--
-- Running it: use a read-only database login, off-peak, with the transaction
-- also forced read-only. Keep the credentials out of the command line and
-- shell history, and keep the output outside the repository: it lists document
-- and check numbers, so treat it as confidential accounting data.
--   mysql --defaults-extra-file=<file with host/user/password> <database> \
--     --init-command="SET SESSION TRANSACTION READ ONLY" --table --verbose --force \
--     < r11BankPaymentAudit.sql > r11-results.txt 2>&1
--
-- Questions this answers (R9 = r9PaymentFieldAudit.sql):
--   Which parts apply to this database ............ R11-00
--   Bank accounts used by each company ............ R11-14, R11-22, R11-34, R11-01
--   Used by more than one company ................. R11-02
--   OR / CV documents on each bank account ........ R11-15
--   Inactive but still referenced ................. R11-04
--   Header bank vs GL line mismatch ............... R11-06, R11-07
--   Cash amounts by bank / GL situation ........... R11-16, R11-33
--   Cash-on-hand documents with a bank selected ... R11-17 (R9 Q7)
--   ... already in Bank Reconciliation ............ R11-18 (R9 Q8)
--   ... already on Deposit Slips .................. R11-32, R11-33
--   Reconciled, but not on the bank's GL .......... R11-19
--   Possibly wrong payment fields ................. R11-08 to R11-11, R11-20,
--                                                   R11-21 (R9 Q2 to Q6)

-- R11-00 Run first: what this database has. 0 = that part's queries cannot run.
SELECT 'R11-00' AS audit, DATABASE() AS database_name, VERSION() AS mysql_version,
       (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bank_recon_sessions' AND COLUMN_NAME = 'company_id') AS part2_session_company,
       (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'or_headers' AND COLUMN_NAME = 'payment_reference') AS part3_r9_columns,
       (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deposit_slips') AS part4_deposit_slips,
       (SELECT COUNT(*) FROM companies) AS companies,
       (SELECT COUNT(*) FROM bank_codes) AS bank_accounts,
       (SELECT COUNT(*) FROM or_headers) AS or_documents,
       (SELECT COUNT(*) FROM cv_headers) AS cv_documents,
       (SELECT COUNT(*) FROM bank_recon_sessions) AS recon_sessions;

-- ============================================================
-- PART 1: bank account ownership and document consistency
-- ============================================================

-- R11-01 Every bank account, its GL link and which companies use it. There is
-- no company column on bank_codes, so document use is the only evidence of
-- ownership (BANK-OWNERSHIP-01). Use this to assign an owner in a later phase.
-- no_account_number = 1 on a bank code can mean a cash-on-hand GL: "Sync from
-- COA" creates a code for every BANK / CASH account. Only a person can tell.
SELECT 'R11-01' AS audit, bc.id AS bank_account_id, bc.bank_code, bc.bank_name, bc.status, bc.coa_account_id,
       coa.code AS gl_code, coa.title AS gl_title, (bc.account_no IS NULL OR bc.account_no = '') AS no_account_number,
       (SELECT COUNT(DISTINCT u.company_id) FROM (
          SELECT company_id, bank_account_id FROM or_headers UNION ALL
          SELECT company_id, bank_account_id FROM cv_headers) u
        WHERE u.bank_account_id = bc.id) AS companies_using,
       (SELECT COUNT(*) FROM or_headers h WHERE h.bank_account_id = bc.id) AS or_documents,
       (SELECT COUNT(*) FROM cv_headers h WHERE h.bank_account_id = bc.id) AS cv_documents,
       (SELECT COUNT(*) FROM bank_recon_sessions s WHERE s.bank_account_id = bc.id) AS recon_sessions
FROM bank_codes bc
LEFT JOIN chart_of_accounts coa ON coa.id = bc.coa_account_id
ORDER BY bc.bank_code, bc.id;

-- R11-02 REVIEW: bank accounts used by more than one company. Either a real
-- shared account or a wrong selection - a physical account has one owner.
SELECT 'R11-02' AS audit, u.bank_account_id, u.company_id, COUNT(*) AS records
FROM (
  SELECT company_id, bank_account_id FROM or_headers WHERE bank_account_id IS NOT NULL UNION ALL
  SELECT company_id, bank_account_id FROM cv_headers WHERE bank_account_id IS NOT NULL
) u
WHERE u.bank_account_id IN (
  SELECT x.bank_account_id FROM (
    SELECT company_id, bank_account_id FROM or_headers WHERE bank_account_id IS NOT NULL UNION ALL
    SELECT company_id, bank_account_id FROM cv_headers WHERE bank_account_id IS NOT NULL
  ) x GROUP BY x.bank_account_id HAVING COUNT(DISTINCT x.company_id) > 1
)
GROUP BY u.bank_account_id, u.company_id
ORDER BY u.bank_account_id, u.company_id;

-- R11-03 REVIEW: documents pointing at a bank account that no longer exists
-- (or_headers / cv_headers have no foreign key to bank_codes). Bank
-- Reconciliation can never select these documents.
SELECT 'R11-03' AS audit, 'OR' AS doc, h.id, h.company_id, h.voucher_no, h.status, h.payment_method, h.bank_account_id
FROM or_headers h LEFT JOIN bank_codes bc ON bc.id = h.bank_account_id
WHERE h.bank_account_id IS NOT NULL AND bc.id IS NULL
UNION ALL
SELECT 'R11-03', 'CV', h.id, h.company_id, h.voucher_no, h.status, h.payment_method, h.bank_account_id
FROM cv_headers h LEFT JOIN bank_codes bc ON bc.id = h.bank_account_id
WHERE h.bank_account_id IS NOT NULL AND bc.id IS NULL;

-- R11-04 Documents on a bank account that is now inactive. Posted ones stay
-- usable in Bank Reconciliation; drafts cannot be posted until the account is
-- active again or changed. Listed so a deactivated account can be reviewed.
SELECT 'R11-04' AS audit, 'OR' AS doc, h.company_id, h.bank_account_id, bc.bank_code, bc.status AS bank_status,
       COUNT(*) AS documents, SUM(UPPER(h.status) = 'POSTED') AS posted_documents
FROM or_headers h JOIN bank_codes bc ON bc.id = h.bank_account_id
WHERE UPPER(COALESCE(bc.status, '')) <> 'ACTIVE'
GROUP BY h.company_id, h.bank_account_id, bc.bank_code, bc.status
UNION ALL
SELECT 'R11-04', 'CV', h.company_id, h.bank_account_id, bc.bank_code, bc.status, COUNT(*), SUM(UPPER(h.status) = 'POSTED')
FROM cv_headers h JOIN bank_codes bc ON bc.id = h.bank_account_id
WHERE UPPER(COALESCE(bc.status, '')) <> 'ACTIVE'
GROUP BY h.company_id, h.bank_account_id, bc.bank_code, bc.status;

-- R11-05 REVIEW: posted documents on a bank account with no GL link. Their
-- bank movement can only come from the gross-less-withholding fallback.
SELECT 'R11-05' AS audit, 'OR' AS doc, h.company_id, h.bank_account_id, bc.bank_code, COUNT(*) AS posted_documents
FROM or_headers h JOIN bank_codes bc ON bc.id = h.bank_account_id AND bc.coa_account_id IS NULL
WHERE UPPER(h.status) = 'POSTED'
GROUP BY h.company_id, h.bank_account_id, bc.bank_code
UNION ALL
SELECT 'R11-05', 'CV', h.company_id, h.bank_account_id, bc.bank_code, COUNT(*)
FROM cv_headers h JOIN bank_codes bc ON bc.id = h.bank_account_id AND bc.coa_account_id IS NULL
WHERE UPPER(h.status) = 'POSTED'
GROUP BY h.company_id, h.bank_account_id, bc.bank_code;

-- R11-06 REVIEW: documents of any method and status whose header names a bank
-- account with a GL link, but whose journal has no line on that GL. Once
-- posted, Bank Reconciliation counts them through the fallback, so the
-- reconciliation and the GL disagree. Filter on status for the posted ones.
SELECT 'R11-06' AS audit, 'OR' AS doc, h.id, h.company_id, h.voucher_no, h.status, h.payment_method,
       h.bank_account_id AS header_bank_account_id, bc.bank_code AS header_bank_code, bc.coa_account_id AS header_bank_gl, h.total_debit
FROM or_headers h JOIN bank_codes bc ON bc.id = h.bank_account_id AND bc.coa_account_id IS NOT NULL
WHERE NOT EXISTS (SELECT 1 FROM or_lines l WHERE l.or_id = h.id AND l.account_id = bc.coa_account_id)
UNION ALL
SELECT 'R11-06', 'CV', h.id, h.company_id, h.voucher_no, h.status, h.payment_method,
       h.bank_account_id, bc.bank_code, bc.coa_account_id, h.total_debit
FROM cv_headers h JOIN bank_codes bc ON bc.id = h.bank_account_id AND bc.coa_account_id IS NOT NULL
WHERE NOT EXISTS (SELECT 1 FROM cv_lines l WHERE l.cv_id = h.id AND l.account_id = bc.coa_account_id);

-- R11-07 REVIEW: documents of any method and status with a journal line on a
-- bank account's GL while the header names no bank account or a different one.
-- Once posted, the GL has moved but that bank account's reconciliation will
-- never list the document. A document moving money between two banks is
-- legitimate here: read it with its other bank line.
SELECT 'R11-07' AS audit, 'OR' AS doc, h.id, h.company_id, h.voucher_no, h.status, h.payment_method,
       h.bank_account_id AS header_bank_account_id, hb.bank_code AS header_bank_code,
       bc.id AS gl_bank_account_id, bc.bank_code AS gl_bank_code, SUM(l.debit - l.credit) AS gl_net
FROM or_headers h JOIN or_lines l ON l.or_id = h.id JOIN bank_codes bc ON bc.coa_account_id = l.account_id
LEFT JOIN bank_codes hb ON hb.id = h.bank_account_id
WHERE h.bank_account_id IS NULL OR h.bank_account_id <> bc.id
GROUP BY h.id, h.company_id, h.voucher_no, h.status, h.payment_method, h.bank_account_id, hb.bank_code, bc.id, bc.bank_code
UNION ALL
SELECT 'R11-07', 'CV', h.id, h.company_id, h.voucher_no, h.status, h.payment_method,
       h.bank_account_id, hb.bank_code, bc.id, bc.bank_code, SUM(l.credit - l.debit)
FROM cv_headers h JOIN cv_lines l ON l.cv_id = h.id JOIN bank_codes bc ON bc.coa_account_id = l.account_id
LEFT JOIN bank_codes hb ON hb.id = h.bank_account_id
WHERE h.bank_account_id IS NULL OR h.bank_account_id <> bc.id
GROUP BY h.id, h.company_id, h.voucher_no, h.status, h.payment_method, h.bank_account_id, hb.bank_code, bc.id, bc.bank_code;

-- R11-08 REVIEW: Cash ORs with a digits-only receipt number. Before R9 the
-- receipt field was labelled "Check No." and the method defaulted to Cash, so
-- these may be checks recorded as Cash. (Check ORs: r9PaymentFieldAudit.sql
-- query 3.)
SELECT 'R11-08' AS audit, h.id, h.company_id, h.voucher_no, DATE_FORMAT(h.transaction_date, '%Y-%m-%d') AS transaction_date, h.status, h.receipt_no, h.bank_account_id
FROM or_headers h
WHERE h.payment_method = 'Cash' AND h.receipt_no REGEXP '^[0-9]{4,}$'
ORDER BY h.company_id, h.transaction_date, h.id;

-- R11-09 REVIEW: an OR whose receipt number equals its check number (typed
-- twice, or the wrong field was used).
SELECT 'R11-09' AS audit, h.id, h.company_id, h.voucher_no, h.status, h.payment_method, h.receipt_no, h.check_no
FROM or_headers h
WHERE h.check_no IS NOT NULL AND h.check_no <> '' AND TRIM(h.receipt_no) = TRIM(h.check_no);

-- R11-10 REVIEW: check numbers that were damaged or carry stray spaces (a
-- spreadsheet turning 000123 into 123.0 or 1.2E+5). Leading zeros cannot be
-- recovered from the data itself.
SELECT 'R11-10' AS audit, 'OR' AS doc, h.id, h.company_id, h.voucher_no, h.status, h.check_no
FROM or_headers h WHERE h.check_no REGEXP '^[[:space:]]|[[:space:]]$|[.]0+$|^[0-9.]+[eE][+][0-9]+$'
UNION ALL
SELECT 'R11-10', 'CV', h.id, h.company_id, h.voucher_no, h.status, h.check_no
FROM cv_headers h WHERE h.check_no REGEXP '^[[:space:]]|[[:space:]]$|[.]0+$|^[0-9.]+[eE][+][0-9]+$';

-- R11-11 REVIEW: the same check number on several posted documents of one
-- company and bank account (compared as matching does: leading zeros ignored).
-- Matching treats these as AMBIGUOUS; a real duplicate needs correcting.
SELECT 'R11-11' AS audit, d.company_id, d.bank_account_id, d.normalized_check_no, COUNT(*) AS documents,
       GROUP_CONCAT(CONCAT(d.doc, ' ', d.voucher_no) ORDER BY d.doc, d.voucher_no SEPARATOR ', ') AS document_numbers
FROM (
  SELECT 'OR' AS doc, company_id, bank_account_id, voucher_no, TRIM(LEADING '0' FROM LOWER(TRIM(check_no))) AS normalized_check_no
  FROM or_headers WHERE UPPER(status) = 'POSTED' AND check_no IS NOT NULL AND check_no <> ''
  UNION ALL
  SELECT 'CV', company_id, bank_account_id, voucher_no, TRIM(LEADING '0' FROM LOWER(TRIM(check_no)))
  FROM cv_headers WHERE UPPER(status) = 'POSTED' AND check_no IS NOT NULL AND check_no <> ''
) d
GROUP BY d.company_id, d.bank_account_id, d.normalized_check_no
HAVING COUNT(*) > 1;

-- R11-13 REVIEW: confirmed matches whose document changed afterwards: no
-- longer posted, or now on another bank account than the session. (Another
-- company than the session: R11-23.)
SELECT 'R11-13' AS audit, 'OR' AS doc, m.id AS match_id, m.session_id, h.id, h.company_id, h.voucher_no, h.status, h.bank_account_id AS document_bank, s.bank_account_id AS session_bank
FROM bank_recon_matches m JOIN bank_recon_sessions s ON s.id = m.session_id JOIN or_headers h ON m.book_source_type = 'OR' AND h.id = m.book_source_id
WHERE m.status = 'CONFIRMED' AND (UPPER(h.status) <> 'POSTED' OR NOT (h.bank_account_id <=> s.bank_account_id))
UNION ALL
SELECT 'R11-13', 'CV', m.id, m.session_id, h.id, h.company_id, h.voucher_no, h.status, h.bank_account_id, s.bank_account_id
FROM bank_recon_matches m JOIN bank_recon_sessions s ON s.id = m.session_id JOIN cv_headers h ON m.book_source_type = 'CV' AND h.id = m.book_source_id
WHERE m.status = 'CONFIRMED' AND (UPPER(h.status) <> 'POSTED' OR NOT (h.bank_account_id <=> s.bank_account_id));

-- R11-14 Each company's documents on each bank account. A row with no
-- bank_code is an account that no longer exists (see R11-03). Sessions: R11-22.
-- Slips: R11-34.
SELECT 'R11-14' AS audit, u.company_id, c.name AS company_name, u.bank_account_id, bc.bank_code, bc.bank_name, bc.status AS bank_status,
       SUM(u.src = 'OR') AS or_documents, SUM(u.src = 'OR' AND u.posted = 1) AS posted_or,
       SUM(u.src = 'CV') AS cv_documents, SUM(u.src = 'CV' AND u.posted = 1) AS posted_cv
FROM (
  SELECT 'OR' AS src, company_id, bank_account_id, UPPER(status) = 'POSTED' AS posted FROM or_headers WHERE bank_account_id IS NOT NULL
  UNION ALL
  SELECT 'CV', company_id, bank_account_id, UPPER(status) = 'POSTED' FROM cv_headers WHERE bank_account_id IS NOT NULL
) u
LEFT JOIN companies c ON c.id = u.company_id
LEFT JOIN bank_codes bc ON bc.id = u.bank_account_id
GROUP BY u.company_id, c.name, u.bank_account_id, bc.bank_code, bc.bank_name, bc.status
ORDER BY u.company_id, bc.bank_code;

-- R11-15 Every OR / CV document on a bank account. Can be a long list.
SELECT 'R11-15' AS audit, h.bank_account_id, 'OR' AS doc, h.id, h.company_id, h.voucher_no,
       DATE_FORMAT(h.transaction_date, '%Y-%m-%d') AS transaction_date, h.status, h.payment_method, h.total_debit
FROM or_headers h WHERE h.bank_account_id IS NOT NULL
UNION ALL
SELECT 'R11-15', h.bank_account_id, 'CV', h.id, h.company_id, h.voucher_no,
       DATE_FORMAT(h.transaction_date, '%Y-%m-%d'), h.status, h.payment_method, h.total_debit
FROM cv_headers h WHERE h.bank_account_id IS NOT NULL
ORDER BY bank_account_id, company_id, doc, transaction_date, id;

-- R11-16 Cash documents in numbers, per company, type and status. Read the
-- Posted rows first. no_line_on_bank_gl is the cash-on-hand situation: a bank
-- account is selected, but the journal never touched that bank's GL.
SELECT 'R11-16' AS audit, d.company_id, d.doc, d.status, COUNT(*) AS cash_documents,
       SUM(d.bank_account_id IS NULL) AS no_bank_account,
       SUM(d.bank_account_id IS NOT NULL) AS with_bank_account,
       SUM(d.coa_account_id IS NOT NULL) AS bank_linked_to_gl,
       SUM(d.bank_account_id IS NOT NULL AND d.coa_account_id IS NULL) AS bank_not_linked_to_gl,
       SUM(d.coa_account_id IS NOT NULL AND d.bank_lines > 0) AS line_on_bank_gl,
       SUM(d.coa_account_id IS NOT NULL AND d.bank_lines = 0) AS no_line_on_bank_gl,
       SUM(CASE WHEN d.coa_account_id IS NOT NULL AND d.bank_lines = 0 THEN d.net_amount ELSE 0 END) AS no_line_amount,
       SUM(d.recon_matches > 0) AS in_bank_recon,
       SUM(d.confirmed_matches > 0) AS confirmed_in_bank_recon
FROM (
  SELECT 'OR' AS doc, h.company_id, h.status, h.bank_account_id, bc.coa_account_id, h.total_debit - COALESCE(h.tax_withheld_amount, 0) AS net_amount,
         (SELECT COUNT(*) FROM or_lines l WHERE l.or_id = h.id AND l.account_id = bc.coa_account_id) AS bank_lines,
         (SELECT COUNT(*) FROM bank_recon_matches m WHERE m.book_source_type = 'OR' AND m.book_source_id = h.id) AS recon_matches,
         (SELECT COUNT(*) FROM bank_recon_matches m WHERE m.book_source_type = 'OR' AND m.book_source_id = h.id AND m.status = 'CONFIRMED') AS confirmed_matches
  FROM or_headers h LEFT JOIN bank_codes bc ON bc.id = h.bank_account_id
  WHERE h.payment_method = 'Cash'
  UNION ALL
  SELECT 'CV', h.company_id, h.status, h.bank_account_id, bc.coa_account_id, h.total_debit - COALESCE(h.tax_withheld_amount, 0),
         (SELECT COUNT(*) FROM cv_lines l WHERE l.cv_id = h.id AND l.account_id = bc.coa_account_id),
         (SELECT COUNT(*) FROM bank_recon_matches m WHERE m.book_source_type = 'CV' AND m.book_source_id = h.id),
         (SELECT COUNT(*) FROM bank_recon_matches m WHERE m.book_source_type = 'CV' AND m.book_source_id = h.id AND m.status = 'CONFIRMED')
  FROM cv_headers h LEFT JOIN bank_codes bc ON bc.id = h.bank_account_id
  WHERE h.payment_method = 'Cash'
) d
GROUP BY d.company_id, d.doc, d.status
ORDER BY d.company_id, d.doc, d.status;

-- R11-17 REVIEW: Cash documents with a bank account selected that may really
-- be cash on hand. situation: NO_LINE_ON_BANK_GL (the journal never touched
-- the bank's GL), BANK_HAS_NO_GL_LINK (cannot be told from the GL), or
-- BANK_CODE_WITHOUT_ACCOUNT_NO (the line exists, but the "bank" may itself be a
-- cash-on-hand GL - see R11-01). bank_cash_gl lists the BANK / CASH accounts the
-- journal actually used.
SELECT 'R11-17' AS audit, 'OR' AS doc, h.id, h.company_id, h.voucher_no, DATE_FORMAT(h.transaction_date, '%Y-%m-%d') AS transaction_date, h.status,
       h.bank_account_id, bc.bank_code, bc.coa_account_id AS bank_gl,
       CASE WHEN bc.coa_account_id IS NULL THEN 'BANK_HAS_NO_GL_LINK'
            WHEN NOT EXISTS (SELECT 1 FROM or_lines l WHERE l.or_id = h.id AND l.account_id = bc.coa_account_id) THEN 'NO_LINE_ON_BANK_GL'
            ELSE 'BANK_CODE_WITHOUT_ACCOUNT_NO' END AS situation,
       (SELECT GROUP_CONCAT(DISTINCT coa.code ORDER BY coa.code SEPARATOR ', ') FROM or_lines l
        JOIN coa_validations v ON v.coa_id = l.account_id AND v.validation_name = 'BANK / CASH'
        JOIN chart_of_accounts coa ON coa.id = l.account_id WHERE l.or_id = h.id) AS bank_cash_gl,
       h.total_debit - COALESCE(h.tax_withheld_amount, 0) AS net_amount
FROM or_headers h JOIN bank_codes bc ON bc.id = h.bank_account_id
WHERE h.payment_method = 'Cash'
  AND (bc.coa_account_id IS NULL OR bc.account_no IS NULL OR bc.account_no = ''
       OR NOT EXISTS (SELECT 1 FROM or_lines l WHERE l.or_id = h.id AND l.account_id = bc.coa_account_id))
UNION ALL
SELECT 'R11-17', 'CV', h.id, h.company_id, h.voucher_no, DATE_FORMAT(h.transaction_date, '%Y-%m-%d'), h.status,
       h.bank_account_id, bc.bank_code, bc.coa_account_id,
       CASE WHEN bc.coa_account_id IS NULL THEN 'BANK_HAS_NO_GL_LINK'
            WHEN NOT EXISTS (SELECT 1 FROM cv_lines l WHERE l.cv_id = h.id AND l.account_id = bc.coa_account_id) THEN 'NO_LINE_ON_BANK_GL'
            ELSE 'BANK_CODE_WITHOUT_ACCOUNT_NO' END,
       (SELECT GROUP_CONCAT(DISTINCT coa.code ORDER BY coa.code SEPARATOR ', ') FROM cv_lines l
        JOIN coa_validations v ON v.coa_id = l.account_id AND v.validation_name = 'BANK / CASH'
        JOIN chart_of_accounts coa ON coa.id = l.account_id WHERE l.cv_id = h.id),
       h.total_debit - COALESCE(h.tax_withheld_amount, 0)
FROM cv_headers h JOIN bank_codes bc ON bc.id = h.bank_account_id
WHERE h.payment_method = 'Cash'
  AND (bc.coa_account_id IS NULL OR bc.account_no IS NULL OR bc.account_no = ''
       OR NOT EXISTS (SELECT 1 FROM cv_lines l WHERE l.cv_id = h.id AND l.account_id = bc.coa_account_id));

-- R11-18 REVIEW: Cash documents with no line on their bank's GL that are
-- already in Bank Reconciliation, pending or confirmed.
SELECT 'R11-18' AS audit, m.book_source_type AS doc, m.book_source_id AS id, h.company_id, h.voucher_no, h.status,
       m.id AS match_id, m.status AS match_status, m.session_id, s.status AS session_status,
       DATE_FORMAT(sl.txn_date, '%Y-%m-%d') AS statement_date, m.amount
FROM bank_recon_matches m
JOIN or_headers h ON m.book_source_type = 'OR' AND h.id = m.book_source_id
JOIN bank_codes bc ON bc.id = h.bank_account_id AND bc.coa_account_id IS NOT NULL
JOIN bank_recon_sessions s ON s.id = m.session_id
JOIN bank_recon_statement_lines sl ON sl.id = m.statement_line_id
WHERE h.payment_method = 'Cash' AND NOT EXISTS (SELECT 1 FROM or_lines l WHERE l.or_id = h.id AND l.account_id = bc.coa_account_id)
UNION ALL
SELECT 'R11-18', m.book_source_type, m.book_source_id, h.company_id, h.voucher_no, h.status,
       m.id, m.status, m.session_id, s.status, DATE_FORMAT(sl.txn_date, '%Y-%m-%d'), m.amount
FROM bank_recon_matches m
JOIN cv_headers h ON m.book_source_type = 'CV' AND h.id = m.book_source_id
JOIN bank_codes bc ON bc.id = h.bank_account_id AND bc.coa_account_id IS NOT NULL
JOIN bank_recon_sessions s ON s.id = m.session_id
JOIN bank_recon_statement_lines sl ON sl.id = m.statement_line_id
WHERE h.payment_method = 'Cash' AND NOT EXISTS (SELECT 1 FROM cv_lines l WHERE l.cv_id = h.id AND l.account_id = bc.coa_account_id);

-- R11-19 REVIEW: the size of the accounting risk. Posted documents CONFIRMED in
-- a reconciliation with no journal line on that bank's GL: the reconciliation
-- shows the money as cleared through the bank, while the GL carries it on some
-- other account. Each company and bank account's total is the amount by which
-- the bank's GL can differ from what its reconciliations show, per method.
SELECT 'R11-19' AS audit, c.company_id, c.bank_account_id, c.bank_code, c.doc, c.payment_method,
       COUNT(DISTINCT c.id) AS documents, SUM(c.amount) AS reconciled_amount,
       COUNT(DISTINCT CASE WHEN c.session_status = 'FINALIZED' THEN c.id END) AS in_finalized_sessions
FROM (
  SELECT h.company_id, h.bank_account_id, bc.bank_code, 'OR' AS doc, h.payment_method, h.id, m.amount, s.status AS session_status
  FROM bank_recon_matches m
  JOIN or_headers h ON m.book_source_type = 'OR' AND h.id = m.book_source_id
  JOIN bank_recon_sessions s ON s.id = m.session_id
  JOIN bank_codes bc ON bc.id = s.bank_account_id AND bc.coa_account_id IS NOT NULL
  WHERE m.status = 'CONFIRMED' AND UPPER(h.status) = 'POSTED'
    AND NOT EXISTS (SELECT 1 FROM or_lines l WHERE l.or_id = h.id AND l.account_id = bc.coa_account_id)
  UNION ALL
  SELECT h.company_id, h.bank_account_id, bc.bank_code, 'CV', h.payment_method, h.id, m.amount, s.status
  FROM bank_recon_matches m
  JOIN cv_headers h ON m.book_source_type = 'CV' AND h.id = m.book_source_id
  JOIN bank_recon_sessions s ON s.id = m.session_id
  JOIN bank_codes bc ON bc.id = s.bank_account_id AND bc.coa_account_id IS NOT NULL
  WHERE m.status = 'CONFIRMED' AND UPPER(h.status) = 'POSTED'
    AND NOT EXISTS (SELECT 1 FROM cv_lines l WHERE l.cv_id = h.id AND l.account_id = bc.coa_account_id)
) c
GROUP BY c.company_id, c.bank_account_id, c.bank_code, c.doc, c.payment_method
ORDER BY c.company_id, c.bank_account_id, c.doc, c.payment_method;

-- ============================================================
-- PART 2: needs bank_recon_company_scope_migration.sql
-- ============================================================

-- R11-12 REVIEW: reconciliation sessions with no company (Super Admin only,
-- and their book queries are not limited to one company).
SELECT 'R11-12' AS audit, s.id, s.bank_account_id, DATE_FORMAT(s.period_start, '%Y-%m-%d') AS period_start, DATE_FORMAT(s.period_end, '%Y-%m-%d') AS period_end, s.status
FROM bank_recon_sessions s WHERE s.company_id IS NULL;

-- R11-22 Each company's reconciliation sessions on each bank account.
SELECT 'R11-22' AS audit, s.company_id, s.bank_account_id, bc.bank_code, COUNT(*) AS recon_sessions,
       SUM(s.status = 'FINALIZED') AS finalized_sessions
FROM bank_recon_sessions s LEFT JOIN bank_codes bc ON bc.id = s.bank_account_id
GROUP BY s.company_id, s.bank_account_id, bc.bank_code
ORDER BY s.company_id, s.bank_account_id;

-- R11-23 REVIEW: confirmed matches whose document belongs to another company
-- than its session.
SELECT 'R11-23' AS audit, 'OR' AS doc, m.id AS match_id, m.session_id, h.id, h.voucher_no, h.company_id AS document_company, s.company_id AS session_company
FROM bank_recon_matches m JOIN bank_recon_sessions s ON s.id = m.session_id JOIN or_headers h ON m.book_source_type = 'OR' AND h.id = m.book_source_id
WHERE m.status = 'CONFIRMED' AND s.company_id IS NOT NULL AND NOT (h.company_id <=> s.company_id)
UNION ALL
SELECT 'R11-23', 'CV', m.id, m.session_id, h.id, h.voucher_no, h.company_id, s.company_id
FROM bank_recon_matches m JOIN bank_recon_sessions s ON s.id = m.session_id JOIN cv_headers h ON m.book_source_type = 'CV' AND h.id = m.book_source_id
WHERE m.status = 'CONFIRMED' AND s.company_id IS NOT NULL AND NOT (h.company_id <=> s.company_id);

-- ============================================================
-- PART 3: needs r9_payment_details_migration.sql
-- ============================================================

-- R11-20 REVIEW: posted Bank Transfers missing their bank account, reference
-- or date.
SELECT 'R11-20' AS audit, 'OR' AS doc, h.id, h.company_id, h.voucher_no, h.bank_account_id, h.payment_reference, h.payment_date
FROM or_headers h
WHERE UPPER(h.status) = 'POSTED' AND h.payment_method = 'Bank Transfer'
  AND (h.bank_account_id IS NULL OR h.payment_reference IS NULL OR h.payment_reference = '' OR h.payment_date IS NULL)
UNION ALL
SELECT 'R11-20', 'CV', h.id, h.company_id, h.voucher_no, h.bank_account_id, h.payment_reference, h.payment_date
FROM cv_headers h
WHERE UPPER(h.status) = 'POSTED' AND h.payment_method = 'Bank Transfer'
  AND (h.bank_account_id IS NULL OR h.payment_reference IS NULL OR h.payment_reference = '' OR h.payment_date IS NULL);

-- R11-21 REVIEW: payment fields that do not belong to the document's method.
-- A stale check number still counts as check evidence in matching. (Cash CVs
-- with a check number: r9PaymentFieldAudit.sql query 5.)
SELECT 'R11-21' AS audit, 'OR' AS doc, h.id, h.company_id, h.voucher_no, h.status, h.payment_method, h.check_no, h.check_date, h.payment_reference, h.payment_date
FROM or_headers h
WHERE (h.payment_method <> 'Check' AND ((h.check_no IS NOT NULL AND h.check_no <> '') OR h.check_date IS NOT NULL))
   OR (h.payment_method <> 'Bank Transfer' AND ((h.payment_reference IS NOT NULL AND h.payment_reference <> '') OR h.payment_date IS NOT NULL))
UNION ALL
SELECT 'R11-21', 'CV', h.id, h.company_id, h.voucher_no, h.status, h.payment_method, h.check_no, h.check_date, h.payment_reference, h.payment_date
FROM cv_headers h
WHERE (h.payment_method NOT IN ('Check', 'Cash') AND ((h.check_no IS NOT NULL AND h.check_no <> '') OR h.check_date IS NOT NULL))
   OR (h.payment_method = 'Cash' AND h.check_date IS NOT NULL)
   OR (h.payment_method <> 'Bank Transfer' AND ((h.payment_reference IS NOT NULL AND h.payment_reference <> '') OR h.payment_date IS NOT NULL));

-- ============================================================
-- PART 4: needs r10_deposit_slips_migration.sql
-- ============================================================

-- R11-30 REVIEW: active deposit slip lines whose document no longer fits the
-- slip: other company, other bank account, not posted, or not Cash / Check.
SELECT 'R11-30' AS audit, s.id AS slip_id, s.deposit_no, s.status AS slip_status, l.source_type,
       COALESCE(l.or_id, l.cv_id) AS document_id, COALESCE(o.voucher_no, c.voucher_no) AS voucher_no,
       COALESCE(o.status, c.status) AS document_status, COALESCE(o.payment_method, c.payment_method) AS payment_method,
       COALESCE(o.bank_account_id, c.bank_account_id) AS document_bank, s.bank_account_id AS slip_bank,
       COALESCE(o.company_id, c.company_id) AS document_company, s.company_id AS slip_company
FROM deposit_slip_lines l
JOIN deposit_slips s ON s.id = l.deposit_slip_id
LEFT JOIN or_headers o ON o.id = l.or_id
LEFT JOIN cv_headers c ON c.id = l.cv_id
WHERE l.released_at IS NULL AND s.status <> 'CANCELLED'
  AND (UPPER(COALESCE(o.status, c.status)) <> 'POSTED'
       OR COALESCE(o.payment_method, c.payment_method) NOT IN ('Cash', 'Check')
       OR NOT (COALESCE(o.bank_account_id, c.bank_account_id) <=> s.bank_account_id)
       OR NOT (COALESCE(o.company_id, c.company_id) <=> s.company_id));

-- R11-31 REVIEW: deposit slips whose total differs from their active lines.
SELECT 'R11-31' AS audit, s.id AS slip_id, s.deposit_no, s.status, s.total_amount, COALESCE(SUM(l.amount), 0) AS lines_total
FROM deposit_slips s
LEFT JOIN deposit_slip_lines l ON l.deposit_slip_id = s.id AND l.released_at IS NULL
WHERE s.status <> 'CANCELLED'
GROUP BY s.id, s.deposit_no, s.status, s.total_amount
HAVING ROUND(s.total_amount, 2) <> ROUND(COALESCE(SUM(l.amount), 0), 2);

-- R11-32 REVIEW: documents on an active slip with no journal line on the
-- slip bank's GL - typically cash booked to cash on hand with a bank account
-- selected. A slip posts no journal, so the bank reconciliation can clear
-- these while the GL still shows the money in cash on hand.
SELECT 'R11-32' AS audit, s.company_id, s.id AS slip_id, s.deposit_no, s.status AS slip_status, l.source_type,
       COALESCE(l.or_id, l.cv_id) AS document_id, COALESCE(o.voucher_no, c.voucher_no) AS voucher_no,
       COALESCE(o.status, c.status) AS document_status, l.payment_method, l.amount, s.bank_account_id, bc.coa_account_id AS bank_gl
FROM deposit_slip_lines l
JOIN deposit_slips s ON s.id = l.deposit_slip_id
JOIN bank_codes bc ON bc.id = s.bank_account_id
LEFT JOIN or_headers o ON o.id = l.or_id
LEFT JOIN cv_headers c ON c.id = l.cv_id
WHERE l.released_at IS NULL AND s.status <> 'CANCELLED'
  AND NOT (
    (l.or_id IS NOT NULL AND EXISTS (SELECT 1 FROM or_lines ol WHERE ol.or_id = l.or_id AND ol.account_id = bc.coa_account_id))
    OR (l.cv_id IS NOT NULL AND EXISTS (SELECT 1 FROM cv_lines cl WHERE cl.cv_id = l.cv_id AND cl.account_id = bc.coa_account_id))
  );

-- R11-33 Cash documents on active deposit slips, in numbers, per company and
-- slip status. no_line_on_bank_gl is the same situation as R11-32.
SELECT 'R11-33' AS audit, s.company_id, s.status AS slip_status, COUNT(*) AS cash_documents, SUM(l.amount) AS amount,
       SUM(NOT (
         (l.or_id IS NOT NULL AND EXISTS (SELECT 1 FROM or_lines ol WHERE ol.or_id = l.or_id AND ol.account_id = bc.coa_account_id))
         OR (l.cv_id IS NOT NULL AND EXISTS (SELECT 1 FROM cv_lines cl WHERE cl.cv_id = l.cv_id AND cl.account_id = bc.coa_account_id))
       )) AS no_line_on_bank_gl
FROM deposit_slip_lines l
JOIN deposit_slips s ON s.id = l.deposit_slip_id
JOIN bank_codes bc ON bc.id = s.bank_account_id
WHERE l.released_at IS NULL AND s.status <> 'CANCELLED' AND l.payment_method = 'Cash'
GROUP BY s.company_id, s.status
ORDER BY s.company_id, s.status;

-- R11-34 Each company's deposit slips on each bank account (completes R11-14).
SELECT 'R11-34' AS audit, s.company_id, s.bank_account_id, bc.bank_code, s.status AS slip_status, COUNT(*) AS slips, SUM(s.total_amount) AS total_amount
FROM deposit_slips s JOIN bank_codes bc ON bc.id = s.bank_account_id
GROUP BY s.company_id, s.bank_account_id, bc.bank_code, s.status
ORDER BY s.company_id, s.bank_account_id, s.status;
