-- Stage 2: Encrypt saved wallet bank account numbers.
-- Legacy plaintext values remain temporarily for re-entry.
-- New writes must use encrypted storage.

ALTER TABLE user_bank_details
ADD COLUMN account_number_ciphertext TEXT;

ALTER TABLE user_bank_details
ADD COLUMN account_number_iv TEXT;

ALTER TABLE user_bank_details
ADD COLUMN account_number_last4 TEXT;
