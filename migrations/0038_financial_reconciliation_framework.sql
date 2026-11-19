-- ============================================================
-- 0038: FINANCIAL RECONCILIATION FRAMEWORK
-- ============================================================
-- Stores reconciliation runs and their findings.
-- This migration does not alter wallets or move money.
-- ============================================================

CREATE TABLE financial_reconciliation_runs (
  id TEXT PRIMARY KEY,

  reconciliation_type TEXT NOT NULL
    CHECK (
      reconciliation_type IN (
        'ledger_integrity',
        'legacy_wallet',
        'payment_provider',
        'duel_escrow',
        'challenge_escrow',
        'crew_escrow',
        'full'
      )
    ),

  status TEXT NOT NULL DEFAULT 'running'
    CHECK (
      status IN (
        'running',
        'completed',
        'failed'
      )
    ),

  started_by_type TEXT NOT NULL DEFAULT 'system'
    CHECK (
      started_by_type IN (
        'member',
        'platform_admin',
        'system'
      )
    ),

  started_by_id TEXT,

  total_findings INTEGER NOT NULL DEFAULT 0
    CHECK (total_findings >= 0),

  critical_count INTEGER NOT NULL DEFAULT 0
    CHECK (critical_count >= 0),

  high_count INTEGER NOT NULL DEFAULT 0
    CHECK (high_count >= 0),

  medium_count INTEGER NOT NULL DEFAULT 0
    CHECK (medium_count >= 0),

  low_count INTEGER NOT NULL DEFAULT 0
    CHECK (low_count >= 0),

  info_count INTEGER NOT NULL DEFAULT 0
    CHECK (info_count >= 0),

  error_message TEXT,

  metadata_json TEXT
    CHECK (
      metadata_json IS NULL
      OR json_valid(metadata_json)
    ),

  started_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  finished_at TEXT
);


CREATE INDEX idx_financial_reconciliation_runs_type
ON financial_reconciliation_runs(
  reconciliation_type,
  started_at
);


CREATE INDEX idx_financial_reconciliation_runs_status
ON financial_reconciliation_runs(status, started_at);


CREATE TABLE financial_reconciliation_findings (
  id TEXT PRIMARY KEY,

  run_id TEXT NOT NULL
    REFERENCES financial_reconciliation_runs(id)
    ON DELETE RESTRICT,

  check_code TEXT NOT NULL,

  severity TEXT NOT NULL
    CHECK (
      severity IN (
        'critical',
        'high',
        'medium',
        'low',
        'info'
      )
    ),

  finding_status TEXT NOT NULL DEFAULT 'open'
    CHECK (
      finding_status IN (
        'open',
        'resolved',
        'waived'
      )
    ),

  source_table TEXT,
  source_record_id TEXT,

  related_reference TEXT,

  currency_code TEXT
    REFERENCES financial_currencies(currency_code)
    ON DELETE RESTRICT,

  expected_minor INTEGER,
  observed_minor INTEGER,
  difference_minor INTEGER,

  details_json TEXT
    CHECK (
      details_json IS NULL
      OR json_valid(details_json)
    ),

  resolution_note TEXT,
  resolved_by_type TEXT,
  resolved_by_id TEXT,
  resolved_at TEXT,

  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);


CREATE INDEX idx_financial_reconciliation_findings_run
ON financial_reconciliation_findings(run_id, severity);


CREATE INDEX idx_financial_reconciliation_findings_status
ON financial_reconciliation_findings(finding_status, severity);


CREATE INDEX idx_financial_reconciliation_findings_source
ON financial_reconciliation_findings(
  source_table,
  source_record_id
);


-- A finding's original evidence must remain immutable.
CREATE TRIGGER prevent_reconciliation_finding_evidence_update
BEFORE UPDATE OF
  run_id,
  check_code,
  severity,
  source_table,
  source_record_id,
  related_reference,
  currency_code,
  expected_minor,
  observed_minor,
  difference_minor,
  details_json
ON financial_reconciliation_findings
BEGIN
  SELECT RAISE(
    ABORT,
    'Reconciliation finding evidence is immutable'
  );
END;


-- Findings cannot be deleted.
CREATE TRIGGER prevent_reconciliation_finding_delete
BEFORE DELETE ON financial_reconciliation_findings
BEGIN
  SELECT RAISE(
    ABORT,
    'Reconciliation findings cannot be deleted'
  );
END;


-- Completed reconciliation runs cannot be modified.
CREATE TRIGGER prevent_completed_reconciliation_run_update
BEFORE UPDATE ON financial_reconciliation_runs
WHEN OLD.status IN ('completed', 'failed')
BEGIN
  SELECT RAISE(
    ABORT,
    'Finished reconciliation runs are immutable'
  );
END;


-- Reconciliation runs cannot be deleted.
CREATE TRIGGER prevent_reconciliation_run_delete
BEFORE DELETE ON financial_reconciliation_runs
BEGIN
  SELECT RAISE(
    ABORT,
    'Reconciliation runs cannot be deleted'
  );
END;


-- ============================================================
-- END MIGRATION 0038
-- ============================================================
