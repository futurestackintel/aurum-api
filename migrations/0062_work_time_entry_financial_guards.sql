-- ============================================================
-- AURUM STAGE 4: HOURLY TIME ENTRY FINANCIAL GUARDS
-- Prevent concurrent approvals from exceeding the agreed cap.
-- Approved time entries become immutable financial records.
-- ============================================================

-- Enforce the spending cap when an entry is approved.
CREATE TRIGGER prevent_work_time_entry_approval_over_cap
BEFORE UPDATE OF status ON work_time_entries
WHEN NEW.status = 'approved'
  AND OLD.status <> 'approved'
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM work_engagements e
      WHERE e.id = NEW.engagement_id
        AND e.pricing_model = 'hourly'
        AND (
          COALESCE((
            SELECT SUM(t.duration_minutes)
            FROM work_time_entries t
            WHERE t.engagement_id = NEW.engagement_id
              AND t.status = 'approved'
              AND t.id <> NEW.id
          ), 0) + NEW.duration_minutes
        ) <= CAST(
          (e.agreed_spending_limit_minor * 60)
          / e.agreed_hourly_rate_minor
          AS INTEGER
        )
    )
    THEN RAISE(
      ABORT,
      'Approving this time entry would exceed the agreed spending limit'
    )
  END;
END;

-- Also protect against inserting an already-approved entry.
CREATE TRIGGER prevent_inserted_work_time_entry_over_cap
BEFORE INSERT ON work_time_entries
WHEN NEW.status = 'approved'
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM work_engagements e
      WHERE e.id = NEW.engagement_id
        AND e.pricing_model = 'hourly'
        AND (
          COALESCE((
            SELECT SUM(t.duration_minutes)
            FROM work_time_entries t
            WHERE t.engagement_id = NEW.engagement_id
              AND t.status = 'approved'
          ), 0) + NEW.duration_minutes
        ) <= CAST(
          (e.agreed_spending_limit_minor * 60)
          / e.agreed_hourly_rate_minor
          AS INTEGER
        )
    )
    THEN RAISE(
      ABORT,
      'This time entry would exceed the agreed spending limit'
    )
  END;
END;

-- Once approved, a time entry cannot be altered.
CREATE TRIGGER prevent_approved_work_time_entry_update
BEFORE UPDATE ON work_time_entries
WHEN OLD.status = 'approved'
BEGIN
  SELECT RAISE(
    ABORT,
    'Approved Work time entries are immutable'
  );
END;

CREATE TRIGGER prevent_approved_work_time_entry_delete
BEFORE DELETE ON work_time_entries
WHEN OLD.status = 'approved'
BEGIN
  SELECT RAISE(
    ABORT,
    'Approved Work time entries cannot be deleted'
  );
END;
