// ============================================================
// PAYSTACK WEBHOOK
// POST /webhook/paystack
// ============================================================

import { addScoreEvent } from "../services/aurumScore.js";

export async function handleWebhookRoutes(pathname, request, env) {

  if (pathname === "/webhook/paystack" && request.method === "POST") {

    // Verify signature
    const signature = request.headers.get("x-paystack-signature");
    if (!signature) {
      return new Response(JSON.stringify({ error: "No signature" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const rawBody = await request.text();

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(env.PAYSTACK_SECRET_KEY),
      { name: "HMAC", hash: "SHA-512" },
      false,
      ["sign"]
    );

    const signatureBytes = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(rawBody)
    );

    const expectedSignature = Array.from(new Uint8Array(signatureBytes))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");

    if (expectedSignature !== signature) {
      return new Response(JSON.stringify({ error: "Invalid signature" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Parse event
    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Handle charge.success
    if (event.event === "charge.success") {
      const data        = event.data;
      const reference   = data.reference;
      const metadata    = data.metadata || {};
      const type        = metadata.type;
      const amountCents = data.amount;
      const now         = new Date().toISOString();

      try {
        if (type === "tip") {
          const { sender_id, receiver_id, post_id, platform_fee } = metadata;
          const platformFeeCents  = Math.round(platform_fee * 100);
          const receiverNetCents  = amountCents - platformFeeCents;

          // Avoid duplicate processing
          const existing = await env.DB
            .prepare(`SELECT id FROM tips WHERE paystack_reference = ?`)
            .bind(reference)
            .first();

          if (!existing) {
            const tipResult = await env.DB
              .prepare(
                `INSERT INTO tips
                  (sender_id, receiver_id, post_id, amount_cents, platform_fee_cents,
                   receiver_net_cents, stripe_payment_intent_id, status, paystack_reference, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?)`
              )
              .bind(
                sender_id, receiver_id, post_id,
                amountCents, platformFeeCents, receiverNetCents,
                reference, reference, now
              )
              .run();

            await env.DB
              .prepare(`UPDATE posts SET tips_received = tips_received + ? WHERE id = ?`)
              .bind(receiverNetCents, post_id)
              .run();

            // Score event — replaces raw SQL score update
            await addScoreEvent(
              sender_id,
              "tip_sent",
              null,
              { tip_id: tipResult.meta.last_row_id },
              env.DB
            );
          }

        } else if (type === "challenge_entry") {
          const { challenge_id, user_id } = metadata;

          const existing = await env.DB
            .prepare(`SELECT id FROM challenge_entries WHERE paystack_reference = ?`)
            .bind(reference)
            .first();

          if (!existing) {
            await env.DB
              .prepare(
                `INSERT INTO challenge_entries
                  (challenge_id, user_id, entry_fee_paid_cents, stripe_payment_intent,
                   status, paystack_reference, created_at, updated_at)
                 VALUES (?, ?, ?, ?, 'entered', ?, ?, ?)`
              )
              .bind(challenge_id, user_id, amountCents, reference, reference, now, now)
              .run();

            await env.DB
              .prepare(`UPDATE challenges SET pool_amount = pool_amount + ? WHERE id = ?`)
              .bind(amountCents, challenge_id)
              .run();
          }

        } else if (type === "subscription") {
          const { user_id, tier } = metadata;

          await env.DB
            .prepare(`UPDATE users SET tier = ? WHERE id = ?`)
            .bind(tier, user_id)
            .run();

          await env.DB
            .prepare(
              `UPDATE subscriptions SET status = 'active', activated_at = ?
               WHERE payment_reference = ?`
            )
            .bind(now, reference)
            .run();
        }

      } catch (err) {
        console.error("Webhook processing error:", err);
        // Return 200 anyway — prevent Paystack infinite retries
      }
    }

    // Always 200 to Paystack
    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  return null;
}
