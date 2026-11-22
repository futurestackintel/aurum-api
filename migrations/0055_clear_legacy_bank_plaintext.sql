-- Stage 2: Remove legacy plaintext bank account numbers.
-- Users with legacy records must re-save their bank details.
-- Preserve the last four digits for masked display.

UPDATE user_bank_details
SET
  account_number_last4 = CASE
    WHEN account_number_last4 IS NULL
      AND account_number IS NOT NULL
      AND LENGTH(account_number) >= 4
    THEN SUBSTR(account_number, -4)
    ELSE account_number_last4
  END,
  account_number = ''
WHERE account_number IS NOT NULL
  AND account_number <> '';
