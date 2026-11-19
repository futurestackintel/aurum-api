
import { validateCurrencyCode } from './money.js';

const ACTOR_TYPES = [
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

function validateActor(type, id, label = 'Actor') {
  if (!ACTOR_TYPES.includes(type)) {
    throw new Error(`Invalid ${label.toLowerCase()} type`);
  }

  return {
    type,
    id: requireText(id, `${label} ID`),
  };
}

function validateMetadata(metadata) {
  if (metadata === undefined || metadata === null) {
    return null;
  }

  if (
    typeof metadata !== 'object' ||
    Array.isArray(metadata)
  ) {
    throw new Error('Metadata must be an object');
  }

  try {
    return JSON.stringify(metadata);
  } catch {
    throw new Error('Metadata must be JSON serializable');
  }
}

export class OpeningBalanceService {
  constructor(db) {
    if (!db) {
      throw new Error('A D1 database binding is required');
    }

    this.db = db;
  }

  async getBatch(batchId) {
    batchId = requireText(batchId, 'Batch ID');

    const batch = await this.db.prepare(`
      SELECT *
      FROM financial_opening_balance_batches
      WHERE id = ?
    `).bind(batchId).first();

    if (!batch) {
      return null;
    }

    const items = await this.db.prepare(`
      SELECT *
      FROM financial_opening_balance_items
      WHERE batch_id = ?
      ORDER BY created_at ASC, id ASC
    `).bind(batchId).all();

    return {
      ...batch,
      items: items.results || [],
    };
  }

  async createBatch({
    sourceScope,
    createdByType,
    createdById,
    metadata = null,
  }) {
    sourceScope = requireText(sourceScope, 'Source scope');

    const actor = validateActor(
      createdByType,
      createdById,
      'Creator'
    );

    const metadataJson = validateMetadata(metadata);
    const batchId = crypto.randomUUID();

    await this.db.prepare(`
      INSERT INTO financial_opening_balance_batches (
        id,
        source_scope,
        created_by_type,
        created_by_id,
        metadata_json
      )
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      batchId,
      sourceScope,
      actor.type,
      actor.id,
      metadataJson
    ).run();

    return this.getBatch(batchId);
  }

  async addItem({
    batchId,
    sourceTable,
    sourceRecordId,
    sourceReference = null,
    sourceAmountText,
    sourceCurrencyCode = null,
  }) {
    batchId = requireText(batchId, 'Batch ID');
    sourceTable = requireText(sourceTable, 'Source table');
    sourceRecordId = requireText(
      sourceRecordId,
      'Source record ID'
    );

    sourceAmountText = requireText(
      sourceAmountText,
      'Source amount'
    );

    if (
      sourceCurrencyCode !== null &&
      (
        typeof sourceCurrencyCode !== 'string' ||
        sourceCurrencyCode.trim() === ''
      )
    ) {
      throw new Error('Source currency code must be valid text');
    }

    if (
      sourceReference !== null &&
      typeof sourceReference !== 'string'
    ) {
      throw new Error('Source reference must be text');
    }

    const batch = await this.db.prepare(`
      SELECT status
      FROM financial_opening_balance_batches
      WHERE id = ?
    `).bind(batchId).first();

    if (!batch) {
      throw new Error('Opening-balance batch not found');
    }

    if (batch.status !== 'draft') {
      throw new Error('Opening-balance batch is not editable');
    }

    const itemId = crypto.randomUUID();

    await this.db.prepare(`
      INSERT INTO financial_opening_balance_items (
        id,
        batch_id,
        source_table,
        source_record_id,
        source_reference,
        source_amount_text,
        source_currency_code
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      itemId,
      batchId,
      sourceTable,
      sourceRecordId,
      sourceReference,
      sourceAmountText,
      sourceCurrencyCode === null
        ? null
        : sourceCurrencyCode.trim()
    ).run();

    return this.getBatch(batchId);
  }

  async verifyItem({
    itemId,
    accountId,
    currencyCode,
    openingSide,
    amountMinor,
    verifiedByType,
    verifiedById,
    verificationNote,
  }) {
    itemId = requireText(itemId, 'Item ID');
    accountId = requireText(accountId, 'Account ID');

    currencyCode = validateCurrencyCode(currencyCode);

    if (!['debit', 'credit'].includes(openingSide)) {
      throw new Error('Invalid opening balance side');
    }

    if (
      !Number.isSafeInteger(amountMinor) ||
      amountMinor <= 0
    ) {
      throw new Error('Opening balance must be a positive safe integer');
    }

    const actor = validateActor(
      verifiedByType,
      verifiedById,
      'Verifier'
    );

    if (
      typeof verificationNote !== 'string' ||
      verificationNote.trim() === ''
    ) {
      throw new Error('Verification note is required');
    }

    const item = await this.db.prepare(`
      SELECT
        items.*,
        batches.status AS batch_status
      FROM financial_opening_balance_items AS items
      JOIN financial_opening_balance_batches AS batches
        ON batches.id = items.batch_id
      WHERE items.id = ?
    `).bind(itemId).first();

    if (!item) {
      throw new Error('Opening-balance item not found');
    }

    if (item.batch_status !== 'draft') {
      throw new Error('Opening-balance batch is not editable');
    }

    if (item.item_status !== 'pending') {
      throw new Error('Only pending items can be verified');
    }

    // Do not silently convert or reinterpret currencies.
    if (item.source_currency_code !== currencyCode) {
      throw new Error(
        'Source currency must match the verified ledger currency'
      );
    }

    const account = await this.db.prepare(`
      SELECT
        accounts.id,
        accounts.currency_code,
        accounts.status,
        currencies.is_enabled
      FROM ledger_accounts AS accounts
      JOIN financial_currencies AS currencies
        ON currencies.currency_code = accounts.currency_code
      WHERE accounts.id = ?
    `).bind(accountId).first();

    if (!account) {
      throw new Error('Ledger account does not exist');
    }

    if (account.status !== 'active') {
      throw new Error('Ledger account is not active');
    }

    if (account.is_enabled !== 1) {
      throw new Error('Ledger currency is not enabled');
    }

    if (account.currency_code !== currencyCode) {
      throw new Error('Ledger account currency mismatch');
    }

    const result = await this.db.prepare(`
      UPDATE financial_opening_balance_items
      SET
        account_id = ?,
        currency_code = ?,
        opening_side = ?,
        amount_minor = ?,
        item_status = 'verified',
        verification_note = ?,
        verified_by_type = ?,
        verified_by_id = ?,
        verified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
        AND item_status = 'pending'
    `).bind(
      accountId,
      currencyCode,
      openingSide,
      amountMinor,
      verificationNote.trim(),
      actor.type,
      actor.id,
      itemId
    ).run();

    if (result.meta?.changes !== 1) {
      throw new Error('Opening-balance item verification failed');
    }

    return this.getBatch(item.batch_id);
  }

  async classifyItem({
    itemId,
    itemStatus,
    verificationNote,
  }) {
    itemId = requireText(itemId, 'Item ID');

    if (!['disputed', 'excluded'].includes(itemStatus)) {
      throw new Error('Invalid opening-balance item classification');
    }

    if (
      typeof verificationNote !== 'string' ||
      verificationNote.trim() === ''
    ) {
      throw new Error('A classification note is required');
    }

    const item = await this.db.prepare(`
      SELECT
        items.batch_id,
        items.item_status,
        batches.status AS batch_status
      FROM financial_opening_balance_items AS items
      JOIN financial_opening_balance_batches AS batches
        ON batches.id = items.batch_id
      WHERE items.id = ?
    `).bind(itemId).first();

    if (!item) {
      throw new Error('Opening-balance item not found');
    }

    if (item.batch_status !== 'draft') {
      throw new Error('Opening-balance batch is not editable');
    }

    if (item.item_status !== 'pending') {
      throw new Error('Only pending items can be classified');
    }

    await this.db.prepare(`
      UPDATE financial_opening_balance_items
      SET
        item_status = ?,
        verification_note = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
        AND item_status = 'pending'
    `).bind(
      itemStatus,
      verificationNote.trim(),
      itemId
    ).run();

    return this.getBatch(item.batch_id);
  }

  async reviewBatch({
    batchId,
    reviewedByType,
    reviewedById,
  }) {
    batchId = requireText(batchId, 'Batch ID');

    const reviewer = validateActor(
      reviewedByType,
      reviewedById,
      'Reviewer'
    );

    const batch = await this.db.prepare(`
      SELECT *
      FROM financial_opening_balance_batches
      WHERE id = ?
    `).bind(batchId).first();

    if (!batch) {
      throw new Error('Opening-balance batch not found');
    }

    if (batch.status !== 'draft') {
      throw new Error('Only draft batches can be reviewed');
    }

    if (
      batch.created_by_type === reviewer.type &&
      batch.created_by_id === reviewer.id
    ) {
      throw new Error('Batch creator cannot review their own batch');
    }

    const counts = await this.db.prepare(`
      SELECT
        COUNT(*) AS total_items,
        SUM(CASE WHEN item_status = 'verified' THEN 1 ELSE 0 END)
          AS verified_items,
        SUM(CASE WHEN item_status = 'disputed' THEN 1 ELSE 0 END)
          AS disputed_items,
        SUM(CASE WHEN item_status = 'excluded' THEN 1 ELSE 0 END)
          AS excluded_items
      FROM financial_opening_balance_items
      WHERE batch_id = ?
    `).bind(batchId).first();

    if (!counts || counts.total_items === 0) {
      throw new Error('Cannot review an empty opening-balance batch');
    }

    const classified =
      counts.verified_items +
      counts.disputed_items +
      counts.excluded_items;

    if (classified !== counts.total_items) {
      throw new Error('Every item must be classified before review');
    }

    await this.db.prepare(`
      UPDATE financial_opening_balance_batches
      SET
        status = 'reviewed',
        total_items = ?,
        verified_items = ?,
        disputed_items = ?,
        excluded_items = ?,
        reviewed_by_type = ?,
        reviewed_by_id = ?,
        reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
        AND status = 'draft'
    `).bind(
      counts.total_items,
      counts.verified_items,
      counts.disputed_items,
      counts.excluded_items,
      reviewer.type,
      reviewer.id,
      batchId
    ).run();

    return this.getBatch(batchId);
  }

  async approveBatch({
    batchId,
    approvedByType,
    approvedById,
  }) {
    batchId = requireText(batchId, 'Batch ID');

    const approver = validateActor(
      approvedByType,
      approvedById,
      'Approver'
    );

    const batch = await this.db.prepare(`
      SELECT *
      FROM financial_opening_balance_batches
      WHERE id = ?
    `).bind(batchId).first();

    if (!batch) {
      throw new Error('Opening-balance batch not found');
    }

    if (batch.status !== 'reviewed') {
      throw new Error('Only reviewed batches can be approved');
    }

    if (
      batch.reviewed_by_type === approver.type &&
      batch.reviewed_by_id === approver.id
    ) {
      throw new Error('Reviewer cannot approve their own batch');
    }

    if (batch.verified_items === 0) {
      throw new Error('Batch has no verified opening-balance items');
    }

    await this.db.prepare(`
      UPDATE financial_opening_balance_batches
      SET
        status = 'approved',
        approved_by_type = ?,
        approved_by_id = ?,
        approved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
        AND status = 'reviewed'
    `).bind(
      approver.type,
      approver.id,
      batchId
    ).run();

    return this.getBatch(batchId);
  }
}
