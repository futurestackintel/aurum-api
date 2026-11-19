// ============================================================
// AURUM Webhook Handler
// POST /webhook/paystack
// Handles: wallet_deposit, challenge_entry, subscription,
//          founding_member
// ============================================================
import { DepositService } from '../services/deposits.js';
import { addScoreEvent }  from '../services/aurumScore.js';
import { awardBadge }     from '../services/badge.js';

async function processWalletDepositWebhook({
  event,
  rawBody,
  env,
}) {
  const data = event.data || {};
  const metadata = data.metadata || {};
  const reference = data.reference;

  if (
    metadata.type !== 'wallet_deposit' ||
    !metadata.operation_id ||
    !metadata.user_id ||
    !reference
  ) {
    throw new Error('Invalid wallet deposit webhook metadata');
  }

  const operation = await env.DB
    .prepare(`
      SELECT *
      FROM financial_payment_operations
      WHERE id = ?
        AND user_id = ?
        AND provider = 'paystack'
        AND provider_reference = ?
        AND operation_type = 'deposit'
    `)
    .bind(
      metadata.operation_id,
      metadata.user_id,
      reference
    )
    .first();

  if (!operation) {
    throw new Error('Matching financial deposit operation not found');
  }

  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(rawBody)
  );

  const fingerprint = Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');

  const eventId = crypto.randomUUID();

  const payload = {
    event: event.event,
    data: {
      id: data.id || null,
      reference,
      amount: data.amount,
      currency: data.currency,
      status: data.status || null,
      metadata: {
        type: metadata.type,
        operation_id: metadata.operation_id,
        user_id: metadata.user_id,
      },
    },
  };

  try {
    await env.DB
      .prepare(`
        INSERT INTO financial_provider_events (
          id,
          provider,
          event_type,
          provider_event_id,
          provider_reference,
          event_fingerprint,
          signature_verified,
          processing_status,
          payment_operation_id,
          payload_json
        )
        VALUES (
          ?, 'paystack', ?, ?, ?, ?, 1,
          'received', ?, ?
        )
      `)
      .bind(
        eventId,
        event.event,
        data.id ? String(data.id) : null,
        reference,
        fingerprint,
        operation.id,
        JSON.stringify(payload)
      )
      .run();
  } catch (error) {
    // A duplicate event must never create another wallet credit.
    const existing = await env.DB
      .prepare(`
        SELECT id, processing_status
        FROM financial_provider_events
        WHERE provider = 'paystack'
          AND event_fingerprint = ?
      `)
      .bind(fingerprint)
      .first();

    if (existing) {
      return {
        duplicate: true,
        status: existing.processing_status,
      };
    }

    throw error;
  }

  // Atomically claim this event for processing.
  const claim = await env.DB
    .prepare(`
      UPDATE financial_provider_events
      SET
        processing_status = 'processing',
        attempt_count = attempt_count + 1
      WHERE id = ?
        AND processing_status IN ('received', 'failed')
        AND signature_verified = 1
    `)
    .bind(eventId)
    .run();

  if (claim.meta?.changes !== 1) {
    return { duplicate: true, status: 'processing' };
  }

  try {
    const deposits = new DepositService(env);

    await deposits.confirmDeposit({
      userId: operation.user_id,
      reference,
      requestId: `paystack-webhook:${eventId}`,
    });

    await env.DB
      .prepare(`
        UPDATE financial_provider_events
        SET
          processing_status = 'processed',
          processed_at = ?,
          last_error = NULL
        WHERE id = ?
          AND processing_status = 'processing'
      `)
      .bind(new Date().toISOString(), eventId)
      .run();

    return { processed: true };
  } catch (error) {
    await env.DB
      .prepare(`
        UPDATE financial_provider_events
        SET
          processing_status = 'failed',
          last_error = ?
        WHERE id = ?
          AND processing_status = 'processing'
      `)
      .bind(
        String(error.message || 'Deposit webhook processing failed')
          .slice(0, 500),
        eventId
      )
      .run();

    throw error;
  }
				}

export async function handleWebhookRoutes(pathname, request, env) {

  if (pathname === '/webhook/paystack' && request.method === 'POST') {

    // ── Signature verification ────────────────────────────
    const signature = request.headers.get('x-paystack-signature');
    if (!signature) {
      return new Response(JSON.stringify({ error: 'No signature' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const rawBody = await request.text();

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(env.PAYSTACK_SECRET_KEY),
      { name: 'HMAC', hash: 'SHA-512' },
      false,
      ['sign'],
    );

    const signatureBytes = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(rawBody),
    );

    const expectedSignature = Array.from(new Uint8Array(signatureBytes))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    if (expectedSignature !== signature) {
      return new Response(JSON.stringify({ error: 'Invalid signature' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Parse event ───────────────────────────────────────
    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Handle charge.success ─────────────────────────────
    if (event.event === 'charge.success') {
      const data        = event.data;
      const reference   = data.reference;
      const metadata    = data.metadata || {};
      const type        = metadata.type;
      const amountCents = data.amount;
      const now         = new Date().toISOString();

      try {

        // ── wallet_deposit ────────────────────────────────
        if (type === 'wallet_deposit') {
  await processWalletDepositWebhook({
    event,
    rawBody,
    env,
  });

          // Idempotency check
          const existing = await env.DB
            .prepare(`SELECT id FROM wallet_transactions WHERE reference = ?`)
            .bind(reference)
            .first();

          if (!existing) {
            const wallet = await env.DB
              .prepare(`SELECT id, balance_usd FROM wallets WHERE user_id = ?`)
              .bind(user_id)
              .first();

            if (wallet) {
              const newBalance = wallet.balance_usd + amountUsd;

              await env.DB
                .prepare(`
                  UPDATE wallets
                  SET balance_usd = ?,
                      total_deposited_usd = total_deposited_usd + ?,
                      updated_at = ?
                  WHERE user_id = ?
                `)
                .bind(newBalance, amountUsd, now, user_id)
                .run();

              await env.DB
                .prepare(`
                  INSERT INTO wallet_transactions
                    (id, wallet_id, user_id, type, amount_usd,
                     balance_after_usd, reference, description, created_at)
                  VALUES (?, ?, ?, 'deposit', ?, ?, ?, 'Wallet deposit via Paystack', ?)
                `)
                .bind(
                  crypto.randomUUID(), wallet.id, user_id,
                  amountUsd, newBalance, reference, now,
                )
                .run();
            }
          }

        // ── challenge_entry ───────────────────────────────
        } else if (type === 'challenge_entry') {
          const { challenge_id, user_id } = metadata;

          // Fix 6 — idempotency now uses paystack_reference
          const existing = await env.DB
            .prepare(`
              SELECT id FROM challenge_entries
              WHERE paystack_reference = ?
            `)
            .bind(reference)
            .first();

          if (!existing) {
            await env.DB
              .prepare(`
                INSERT INTO challenge_entries
                  (id, challenge_id, user_id, entry_fee_paid_cents,
                   paystack_reference, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'entered', ?, ?)
              `)
              .bind(
                crypto.randomUUID(), challenge_id, user_id,
                amountCents, reference, now, now,
              )
              .run();

            await env.DB
              .prepare(`
                UPDATE challenges
                SET pool_total_cents  = pool_total_cents + ?,
                    participant_count = participant_count + 1
                WHERE id = ?
              `)
              .bind(amountCents, challenge_id)
              .run();
          }

        // ── subscription ──────────────────────────────────
        } else if (type === 'subscription') {
          const { user_id, tier } = metadata;

          // Idempotency — only activate once
          const existing = await env.DB
            .prepare(`
              SELECT id FROM subscriptions
              WHERE payment_reference = ? AND status = 'active'
            `)
            .bind(reference)
            .first();

          if (!existing) {
            // Fix 5 — set expires_at to 30 days from activation
            const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

            await env.DB
              .prepare(`UPDATE users SET tier = ?, updated_at = ? WHERE id = ?`)
              .bind(tier, now, user_id)
              .run();

            await env.DB
              .prepare(`
                UPDATE subscriptions
                SET status       = 'active',
                    activated_at = ?,
                    expires_at   = ?,
                    updated_at   = ?
                WHERE payment_reference = ?
              `)
              .bind(now, expiresAt, now, reference)
              .run();
          }

        // ── founding_member ───────────────────────────────
        } else if (type === 'founding_member') {
          const { user_id } = metadata;

          // Idempotency — only process once per reference
          const existing = await env.DB
            .prepare(`SELECT id FROM founding_members WHERE payment_reference = ?`)
            .bind(reference)
            .first();

          if (!existing) {
            // Insert founding member record
            await env.DB
              .prepare(`
                INSERT INTO founding_members
                  (id, user_id, payment_reference, amount_usd, joined_at)
                VALUES (?, ?, ?, 20, ?)
              `)
              .bind(crypto.randomUUID(), user_id, reference, now)
              .run();

            // Award founding_member badge
            await awardBadge(user_id, 'founding_member', env.DB);

            // Award 100 Aurum Score
            await addScoreEvent(
              user_id,
              'founding_member',
              100,
              { note: 'Founding Member — one of the first 100 AURUM members' },
              env.DB,
            );

            // Fire notification (stored in KV for frontend to poll)
            await env.KV.put(
              `notification:${user_id}:founding`,
              JSON.stringify({
                type:       'founding_member',
                message:    '⚡ You are now a Founding Member of AURUM.',
                created_at: now,
              }),
              { expirationTtl: 7 * 24 * 60 * 60 },
            );
          }

        } else {
          // Unknown payment type — log and ignore
          console.warn('Webhook received unknown payment type:', type, reference);
        }

      } catch (err) {
        console.error('Webhook processing error:', err);
        // Always return 200 — prevent Paystack infinite retries
      }
    }

    // ── Always 200 to Paystack ────────────────────────────
    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return null;
}
