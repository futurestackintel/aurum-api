
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { ReconciliationService } from '../src/services/reconciliation.js';

const service = new ReconciliationService(env.DB);

async function seedCurrencies() {
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO financial_currencies (
        currency_code,
        minor_unit_exponent,
        is_enabled
      )
      VALUES ('NGN', 2, 1)
      ON CONFLICT(currency_code)
      DO UPDATE SET is_enabled = 1
    `),
    env.DB.prepare(`
      INSERT INTO financial_currencies (
        currency_code,
        minor_unit_exponent,
        is_enabled
      )
      VALUES ('USD', 2, 1)
      ON CONFLICT(currency_code)
      DO UPDATE SET is_enabled = 1
    `),
  ]);
}

beforeEach(async () => {
  await seedCurrencies();
});

describe('ReconciliationService validation', () => {
  it('rejects an invalid actor type', async () => {
    await expect(
      service.runLedgerIntegrity({
        startedByType: 'unauthorized',
      })
    ).rejects.toThrow('Invalid reconciliation actor type');

    const count = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM financial_reconciliation_runs
    `).first();

    expect(count.total).toBe(0);
  });

  it('rejects a blank actor ID', async () => {
    await expect(
      service.runLedgerIntegrity({
        startedByType: 'platform_admin',
        startedById: '   ',
      })
    ).rejects.toThrow('Reconciliation actor ID is required');
  });

  it('rejects a missing database binding', () => {
    expect(() => new ReconciliationService(null))
      .toThrow('A D1 database binding is required');
  });
});

describe('Ledger integrity reconciliation', () => {
  it('completes a reconciliation run and persists its summary', async () => {
    const result = await service.runLedgerIntegrity();

    expect(result.runId).toBeTruthy();
    expect(result.status).toBe('completed');
    expect(result.counts).toEqual({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    });

    const run = await env.DB.prepare(`
      SELECT *
      FROM financial_reconciliation_runs
      WHERE id = ?
    `).bind(result.runId).first();

    expect(run).toMatchObject({
      id: result.runId,
      reconciliation_type: 'ledger_integrity',
      status: 'completed',
      started_by_type: 'system',
      total_findings: 0,
      critical_count: 0,
      high_count: 0,
      medium_count: 0,
      low_count: 0,
      info_count: 0,
    });

    expect(run.finished_at).toBeTruthy();
  });

  it('detects a persisted draft transaction', async () => {
    const transactionId = crypto.randomUUID();

    await env.DB.prepare(`
      INSERT INTO ledger_transactions (
        id,
        idempotency_scope,
        idempotency_key,
        source_module,
        transaction_type,
        status,
        actor_type
      )
      VALUES (?, ?, ?, ?, ?, 'draft', 'system')
    `).bind(
      transactionId,
      'reconciliation-test',
      crypto.randomUUID(),
      'test',
      'unfinished_test'
    ).run();

    const result = await service.runLedgerIntegrity();

    const finding = result.findings.find(item =>
      item.checkCode === 'PERSISTED_DRAFT_TRANSACTION' &&
      item.sourceRecordId === transactionId
    );

    expect(finding).toBeTruthy();
    expect(finding.severity).toBe('high');
    expect(finding.details).toMatchObject({
      source_module: 'test',
      transaction_type: 'unfinished_test',
    });

    expect(result.counts.high).toBeGreaterThanOrEqual(1);
  });

  it('detects an account with an invalid natural balance', async () => {
    const accountId = crypto.randomUUID();

    await env.DB.prepare(`
      INSERT INTO ledger_accounts (
        id,
        account_code,
        account_name,
        account_class,
        normal_balance,
        owner_type,
        owner_id,
        currency_code
      )
      VALUES (?, ?, ?, 'asset', 'credit', 'platform', NULL, 'NGN')
    `).bind(
      accountId,
      `RECON-INVALID-${accountId}`,
      'Invalid natural balance test account'
    ).run();

    const result = await service.runLedgerIntegrity();

    const finding = result.findings.find(item =>
      item.checkCode === 'ACCOUNT_NATURAL_BALANCE_MISMATCH' &&
      item.sourceRecordId === accountId
    );

    expect(finding).toBeTruthy();
    expect(finding.severity).toBe('high');
    expect(finding.details).toMatchObject({
      account_class: 'asset',
      normal_balance: 'credit',
    });
  });

  it('persists findings and their evidence against the reconciliation run', async () => {
    const transactionId = crypto.randomUUID();

    await env.DB.prepare(`
      INSERT INTO ledger_transactions (
        id,
        idempotency_scope,
        idempotency_key,
        source_module,
        transaction_type,
        status,
        actor_type
      )
      VALUES (?, ?, ?, ?, ?, 'draft', 'system')
    `).bind(
      transactionId,
      'reconciliation-persistence-test',
      crypto.randomUUID(),
      'test',
      'unfinished_test'
    ).run();

    const result = await service.runLedgerIntegrity({
      startedByType: 'platform_admin',
      startedById: 'admin-test-001',
    });

    const finding = await env.DB.prepare(`
      SELECT *
      FROM financial_reconciliation_findings
      WHERE run_id = ?
        AND check_code = 'PERSISTED_DRAFT_TRANSACTION'
        AND source_record_id = ?
    `).bind(result.runId, transactionId).first();

    expect(finding).toBeTruthy();
    expect(finding).toMatchObject({
      run_id: result.runId,
      check_code: 'PERSISTED_DRAFT_TRANSACTION',
      severity: 'high',
      finding_status: 'open',
      source_table: 'ledger_transactions',
      source_record_id: transactionId,
    });

    expect(JSON.parse(finding.details_json)).toMatchObject({
      source_module: 'test',
      transaction_type: 'unfinished_test',
    });

    const run = await env.DB.prepare(`
      SELECT *
      FROM financial_reconciliation_runs
      WHERE id = ?
    `).bind(result.runId).first();

    expect(run.started_by_type).toBe('platform_admin');
    expect(run.started_by_id).toBe('admin-test-001');
    expect(run.high_count).toBeGreaterThanOrEqual(1);
  });
});
