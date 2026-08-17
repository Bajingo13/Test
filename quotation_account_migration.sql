ALTER TABLE quotation_lines ADD COLUMN account_id INT NULL;
ALTER TABLE quotation_lines ADD COLUMN account_code VARCHAR(50) NULL;
ALTER TABLE quotation_lines ADD COLUMN account_title VARCHAR(255) NULL;
