ALTER TABLE or_headers ADD COLUMN payment_method VARCHAR(10) NOT NULL DEFAULT 'Cash';
ALTER TABLE or_headers ADD COLUMN bank_account_id INT NULL;
ALTER TABLE or_headers ADD COLUMN check_no VARCHAR(100) NULL;
ALTER TABLE or_headers ADD COLUMN check_date DATE NULL;

ALTER TABLE cv_headers ADD COLUMN payment_method VARCHAR(10) NOT NULL DEFAULT 'Check';
ALTER TABLE cv_headers ADD COLUMN bank_account_id INT NULL;
ALTER TABLE cv_headers ADD COLUMN check_date DATE NULL;
