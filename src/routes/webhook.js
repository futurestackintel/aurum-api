// ============================================================
// AURUM Webhook Handler
// POST /webhook/paystack
// Handles: wallet_deposit, challenge_entry, subscription,
//          founding_member
// ============================================================

import { addScoreEvent }  from '../services/aurumScore.js';
import { awardBadge }     from '../services/badge.js';

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
          const { user_id } = metadata;
          const amountUsd   = amountCents / 100;

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
