-- ============================================================
-- 0040: FINANCIAL PAYMENT OPERATIONS AND PROVIDER EVENT INBOX
-- ============================================================
-- Establishes durable records for deposits, withdrawals and
-- verified provider events.
--
-- Does NOT:
--   - initiate provider payments
--   - credit or debit user wallets
--   - reserve or release funds
--   - post ledger transactions
-- ============================================================


-- ============================================================
-- 1. PAYMENT OPERATIONS
-- ============================================================

CREATE TABLE financial_payment_operations (
  id TEXT PRIMARY KEY,

  user_id TEXT NOT NULL
    REFERENCES users(id)
    ON DELETE RESTRICT,

  operation_type TEXT NOT NULL
    CHECK (
      operation_type IN (
        'deposit',
        'withdrawal'
      )
    ),

  status TEXT NOT NULL
    CHECK (
      status IN (
        'pending',
        'reserved',
        'processing',
        'succeeded',
        'failed',
        'reconciliation_required',
        'cancelled'
      )
    ),

  amount_minor INTEGER NOT NULL
    CHECK (amount_minor > 0),

  currency_code TEXT NOT NULL
    REFERENCES financial_currencies(currency_code)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,

  provider TEXT NOT NULL,

  provider_currency_code TEXT
    REFERENCES financial_currencies(currency_code)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,

  provider_amount_minor INTEGER
    CHECK (
      provider_amount_minor IS NULL
      OR provider_amount_minor > 0
    ),

  provider_reference TEXT,

  provider_transfer_code TEXT,

  idempotency_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,

  request_fingerprint TEXT NOT NULL
    CHECK (length(request_fingerprint) = 64),

  reserve_ledger_transaction_id TEXT
    REFERENCES ledger_transactions(id)
    ON DELETE RESTRICT,

  settlement_ledger_transaction_id TEXT
    REFERENCES ledger_transactions(id)
    ON DELETE RESTRICT,

  failure_code TEXT,
  failure_message TEXT,

  metadata_json TEXT
    CHECK (
      metadata_json IS NULL
      OR json_valid(metadata_json)
    ),

  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  updated_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  completed_at TEXT,

  UNIQUE(idempotency_scope, idempotency_key)
);


CREATE UNIQUE INDEX idx_financial_payment_provider_reference
ON financial_payment_operations(provider, provider_reference)
WHERE provider_reference IS NOT NULL;


CREATE UNIQUE INDEX idx_financial_payment_transfer_code
ON financial_payment_operations(provider, provider_transfer_code)
WHERE provider_transfer_code IS NOT NULL;


CREATE INDEX idx_financial_payment_user_history
ON financial_payment_operations(user_id, created_at);


CREATE INDEX idx_financial_payment_status
ON financial_payment_operations(status, created_at);


CREATE INDEX idx_financial_payment_provider_status
ON financial_payment_operations(provider, status, created_at);


-- ============================================================
-- 2. PAYMENT OPERATION IDENTITY IMMUTABILITY
-- ============================================================

CREATE TRIGGER prevent_financial_payment_identity_update
BEFORE UPDATE ON financial_payment_operations
WHEN
  NEW.id != OLD.id
  OR NEW.user_id != OLD.user_id
  OR NEW.operation_type != OLD.operation_type
  OR NEW.amount_minor != OLD.amount_minor
  OR NEW.currency_code != OLD.currency_code
  OR NEW.provider != OLD.provider
  OR NEW.idempotency_scope != OLD.idempotency_scope
  OR NEW.idempotency_key != OLD.idempotency_key
  OR NEW.request_fingerprint != OLD.request_fingerprint
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(
    ABORT,
    'Financial payment operation identity is immutable'
  );
END;


-- ============================================================
-- 3. PAYMENT OPERATION STATUS TRANSITIONS
-- ============================================================

CREATE TRIGGER validate_financial_payment_status_transition
BEFORE UPDATE OF status ON financial_payment_operations
WHEN OLD.status != NEW.status
BEGIN

  SELECT CASE
    WHEN NOT (
      (
        OLD.operation_type = 'deposit'
        AND OLD.status = 'pending'
        AND NEW.status IN (
          'succeeded',
          'failed',
          'reconciliation_required',
          'cancelled'
        )
      )
      OR
      (
        OLD.operation_type = 'withdrawal'
        AND OLD.status = 'reserved'
        AND NEW.status IN (
          'processing',
          'succeeded',
          'failed',
          'reconciliation_required'
        )
      )
      OR
      (
        OLD.operation_type = 'withdrawal'
        AND OLD.status = 'processing'
        AND NEW.status IN (
          'succeeded',
          'failed',
          'reconciliation_required'
        )
      )
      OR
      (
        OLD.status = 'reconciliation_required'
        AND NEW.status IN (
          'succeeded',
          'failed'
        )
      )
    )
    THEN RAISE(
      ABORT,
      'Invalid financial payment status transition'
    )
  END;

END;


-- ============================================================
-- 4. PROVIDER EVENT INBOX
-- ============================================================

CREATE TABLE financial_provider_events (
  id TEXT PRIMARY KEY,

  provider TEXT NOT NULL,

  event_type TEXT NOT NULL,

  provider_event_id TEXT,

  provider_reference TEXT,

  event_fingerprint TEXT NOT NULL
    CHECK (length(event_fingerprint) = 64),

  signature_verified INTEGER NOT NULL
    CHECK (signature_verified IN (0, 1)),

  processing_status TEXT NOT NULL DEFAULT 'received'
    CHECK (
      processing_status IN (
        'received',
        'processing',
        'processed',
        'failed',
        'ignored'
      )
    ),

  payment_operation_id TEXT
    REFERENCES financial_payment_operations(id)
    ON DELETE RESTRICT,

  payload_json TEXT NOT NULL
    CHECK (json_valid(payload_json)),

  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0),

  last_error TEXT,

  received_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  processed_at TEXT
);


CREATE UNIQUE INDEX idx_financial_provider_event_fingerprint
ON financial_provider_events(provider, event_fingerprint);


CREATE UNIQUE INDEX idx_financial_provider_event_external_id
ON financial_provider_events(provider, provider_event_id)
WHERE provider_event_id IS NOT NULL;


CREATE INDEX idx_financial_provider_event_status
ON financial_provider_events(processing_status, received_at);


CREATE INDEX idx_financial_provider_event_reference
ON financial_provider_events(provider, provider_reference);


CREATE INDEX idx_financial_provider_event_operation
ON financial_provider_events(payment_operation_id);


-- ============================================================
-- 5. PROVIDER EVENT PROCESSING PROTECTIONS
-- ============================================================

CREATE TRIGGER prevent_financial_provider_event_delete
BEFORE DELETE ON financial_provider_events
BEGIN
  SELECT RAISE(
    ABORT,
    'Financial provider event evidence cannot be deleted'
  );
END;


CREATE TRIGGER prevent_financial_provider_event_identity_update
BEFORE UPDATE ON financial_provider_events
WHEN
  NEW.id != OLD.id
  OR NEW.provider != OLD.provider
  OR NEW.event_type != OLD.event_type
  OR NEW.provider_event_id IS NOT OLD.provider_event_id
  OR NEW.provider_reference IS NOT OLD.provider_reference
  OR NEW.event_fingerprint != OLD.event_fingerprint
  OR NEW.signature_verified != OLD.signature_verified
  OR NEW.payload_json != OLD.payload_json
  OR NEW.received_at != OLD.received_at
BEGIN
  SELECT RAISE(
    ABORT,
    'Financial provider event evidence is immutable'
  );
END;


CREATE TRIGGER validate_financial_provider_event_status_transition
BEFORE UPDATE OF processing_status ON financial_provider_events
WHEN OLD.processing_status != NEW.processing_status
BEGIN

  SELECT CASE
    WHEN NOT (
      (
        OLD.processing_status = 'received'
        AND NEW.processing_status IN (
          'processing',
          'ignored'
        )
      )
      OR
      (
        OLD.processing_status = 'processing'
        AND NEW.processing_status IN (
          'processed',
          'failed'
        )
      )
      OR
      (
        OLD.processing_status = 'failed'
        AND NEW.processing_status = 'processing'
      )
    )
    THEN RAISE(
      ABORT,
      'Invalid provider event processing transition'
    )
  END;

END;


-- ============================================================
-- END MIGRATION 0040
-- ============================================================
