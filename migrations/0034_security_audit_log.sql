-- AURUM Security & Audit Logging
-- Creates an append-only record of security-sensitive platform events.
-- Existing crew governance history remains separate and is preserved.

CREATE TABLE IF NOT EXISTS security_audit_log (
id INTEGER PRIMARY KEY AUTOINCREMENT,

actor_id TEXT,
actor_type TEXT NOT NULL
CHECK (actor_type IN ('member', 'platform_admin', 'system', 'anonymous')),

action TEXT NOT NULL,
resource_type TEXT,
resource_id TEXT,

outcome TEXT NOT NULL
CHECK (outcome IN ('success', 'denied', 'failed')),

request_id TEXT,

-- Only sanitized, non-sensitive event metadata may be stored here.
-- Never store credentials, tokens, private evidence or unnecessary personal data.
metadata_json TEXT
CHECK (metadata_json IS NULL OR json_valid(metadata_json)),

created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_security_audit_created_at
ON security_audit_log(created_at);

CREATE INDEX IF NOT EXISTS idx_security_audit_actor
ON security_audit_log(actor_id, created_at);

CREATE INDEX IF NOT EXISTS idx_security_audit_action
ON security_audit_log(action, created_at);

CREATE INDEX IF NOT EXISTS idx_security_audit_resource
ON security_audit_log(resource_type, resource_id, created_at);

CREATE INDEX IF NOT EXISTS idx_security_audit_request
ON security_audit_log(request_id);

-- Enforce append-only behavior at database level.
CREATE TRIGGER IF NOT EXISTS prevent_security_audit_update
BEFORE UPDATE ON security_audit_log
BEGIN
SELECT RAISE(ABORT, 'Security audit records are immutable');
END;

CREATE TRIGGER IF NOT EXISTS prevent_security_audit_delete
BEFORE DELETE ON security_audit_log
BEGIN
SELECT RAISE(ABORT, 'Security audit records cannot be deleted');
END;
