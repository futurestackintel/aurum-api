const CHECKS = [
  {
    code: 'LEDGER_UNBALANCED_TRANSACTION',
    severity: 'critical',
    sql: `
      SELECT
        entries.transaction_id,
        entries.currency_code,
        SUM(
          CASE WHEN entries.entry_side = 'debit'
          THEN entries.amount_minor ELSE 0 END
        ) AS debit_minor,
        SUM(
          CASE WHEN entries.entry_side = 'credit'
          THEN entries.amount_minor ELSE 0 END
        ) AS credit_minor
      FROM ledger_entries AS entries
      JOIN ledger_transactions AS transactions
        ON transactions.id = entries.transaction_id
      WHERE transactions.status = 'posted'
      GROUP BY entries.transaction_id, entries.currency_code
      HAVING debit_minor != credit_minor
    `,
    map: row => ({
      sourceTable: 'ledger_transactions',
      sourceRecordId: row.transaction_id,
      currencyCode: row.currency_code,
      expectedMinor: row.debit_minor,
      observedMinor: row.credit_minor,
      differenceMinor: row.debit_minor - row.credit_minor,
      details: {
        debit_minor: row.debit_minor,
        credit_minor: row.credit_minor,
      },
    }),
  },
  {
    code: 'POSTED_TRANSACTION_INVALID_STRUCTURE',
    severity: 'critical',
    sql: `
      SELECT
        transactions.id,
        transactions.posted_at,
        COUNT(entries.id) AS entry_count
      FROM ledger_transactions AS transactions
      LEFT JOIN ledger_entries AS entries
        ON entries.transaction_id = transactions.id
      WHERE transactions.status = 'posted'
      GROUP BY transactions.id
      HAVING
        COUNT(entries.id) < 2
        OR transactions.posted_at IS NULL
    `,
    map: row => ({
      sourceTable: 'ledger_transactions',
      sourceRecordId: row.id,
      details: {
        posted_at: row.posted_at,
        entry_count: row.entry_count,
      },
    }),
  },
  {
    code: 'PERSISTED_DRAFT_TRANSACTION',
    severity: 'high',
    sql: `
      SELECT
        id,
        source_module,
        transaction_type,
        created_at
      FROM ledger_transactions
      WHERE status = 'draft'
    `,
    map: row => ({
      sourceTable: 'ledger_transactions',
      sourceRecordId: row.id,
      details: {
        source_module: row.source_module,
        transaction_type: row.transaction_type,
        created_at: row.created_at,
      },
    }),
  },
  {
    code: 'ACCOUNT_NATURAL_BALANCE_MISMATCH',
    severity: 'high',
    sql: `
      SELECT
        id,
        account_code,
        account_class,
        normal_balance
      FROM ledger_accounts
      WHERE
        (account_class IN ('asset', 'expense')
          AND normal_balance != 'debit')
        OR
        (account_class IN ('liability', 'equity', 'revenue')
          AND normal_balance != 'credit')
    `,
    map: row => ({
      sourceTable: 'ledger_accounts',
      sourceRecordId: row.id,
      details: {
        account_code: row.account_code,
        account_class: row.account_class,
        normal_balance: row.normal_balance,
      },
    }),
  },
  {
    code: 'ENTRY_ACCOUNT_CURRENCY_MISMATCH',
    severity: 'critical',
    sql: `
      SELECT
        entries.id,
        entries.transaction_id,
        entries.account_id,
        entries.currency_code AS entry_currency,
        accounts.currency_code AS account_currency
      FROM ledger_entries AS entries
      JOIN ledger_accounts AS accounts
        ON accounts.id = entries.account_id
      WHERE entries.currency_code != accounts.currency_code
    `,
    map: row => ({
      sourceTable: 'ledger_entries',
      sourceRecordId: row.id,
      relatedReference: row.transaction_id,
      currencyCode: row.entry_currency,
      details: {
        account_id: row.account_id,
        entry_currency: row.entry_currency,
        account_currency: row.account_currency,
      },
    }),
  },
];

const VALID_ACTOR_TYPES = [
  'member',
  'platform_admin',
  'system',
];

function requireText(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} is required`);
  }

  return value.trim();
}

function validateActorType(value) {
  if (!VALID_ACTOR_TYPES.includes(value)) {
    throw new Error('Invalid reconciliation actor type');
  }

  return value;
}

function countSeverities(findings) {
  const counts = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };

  for (const finding of findings) {
    counts[finding.severity] += 1;
  }

  return counts;
}

export class ReconciliationService {
  constructor(db) {
    if (!db) {
      throw new Error('A D1 database binding is required');
    }

    this.db = db;
  }

  async runLedgerIntegrity({
    startedByType = 'system',
    startedById = null,
  } = {}) {
    startedByType = validateActorType(startedByType);

    if (startedById !== null) {
      startedById = requireText(
        startedById,
        'Reconciliation actor ID'
      );
    }

    const runId = crypto.randomUUID();

    await this.db.prepare(`
      INSERT INTO financial_reconciliation_runs (
        id,
        reconciliation_type,
        status,
        started_by_type,
        started_by_id
      )
      VALUES (?, 'ledger_integrity', 'running', ?, ?)
    `).bind(
      runId,
      startedByType,
      startedById
    ).run();

    try {
      const results = await Promise.all(
        CHECKS.map(async check => {
          const result = await this.db
            .prepare(check.sql)
            .all();

          return (result.results || []).map(row => ({
            checkCode: check.code,
            severity: check.severity,
            ...check.map(row),
          }));
        })
      );

      const findings = results.flat();
      const counts = countSeverities(findings);

      const statements = findings.map(finding =>
        this.db.prepare(`
          INSERT INTO financial_reconciliation_findings (
            id,
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
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          crypto.randomUUID(),
          runId,
          finding.checkCode,
          finding.severity,
          finding.sourceTable ?? null,
          finding.sourceRecordId ?? null,
          finding.relatedReference ?? null,
          finding.currencyCode ?? null,
          finding.expectedMinor ?? null,
          finding.observedMinor ?? null,
          finding.differenceMinor ?? null,
          JSON.stringify(finding.details ?? {})
        )
      );

      statements.push(
        this.db.prepare(`
          UPDATE financial_reconciliation_runs
          SET
            status = 'completed',
            total_findings = ?,
            critical_count = ?,
            high_count = ?,
            medium_count = ?,
            low_count = ?,
            info_count = ?,
            finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?
            AND status = 'running'
        `).bind(
          findings.length,
          counts.critical,
          counts.high,
          counts.medium,
          counts.low,
          counts.info,
          runId
        )
      );

      await this.db.batch(statements);

      return {
        runId,
        status: 'completed',
        totalFindings: findings.length,
        counts,
        findings,
      };
    } catch (error) {
      await this.db.prepare(`
        UPDATE financial_reconciliation_runs
        SET
          status = 'failed',
          error_message = ?,
          finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
          AND status = 'running'
      `).bind(
        String(error?.message || error).slice(0, 2000),
        runId
      ).run();

      throw error;
    }
  }
}
