// ============================================================
// AURUM Tips Routes
// POST /api/tips
// Internal wallet transfer — no Paystack checkout.
// Sender pays full amount. Receiver gets 95%. 5% platform fee.
// ============================================================

import { requireAuth } from "../middleware/auth.js";
import { addScoreEvent } from "../services/aurumScore.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleTipsRoutes(pathname, request, env) {

  // ── POST /api/tips ──────────────────────────────────────────
  if (pathname === "/api/tips" && request.method === "POST") {
    const auth = await requireAuth(request, env);
    if (auth.error) return json({ error: auth.error }, auth.status);

    const body = await request.json();
    const { post_id, receiver_id, amount_usd } = body;

    if (!post_id || !receiver_id || !amount_usd) {
      return json({ error: "post_id, receiver_id, and amount_usd required" }, 400);
    }

    if (amount_usd < 1) {
      return json({ error: "Minimum tip is $1" }, 400);
    }

    try {
      // Get sender by clerk_id
      const sender = await env.DB
        .prepare(`SELECT id, email FROM users WHERE clerk_id = ?`)
        .bind(auth.id)
        .first();

      if (!sender) return json({ error: "Sender not found" }, 404);

      // Cannot tip yourself
      if (sender.id === receiver_id) {
        return json({ error: "You cannot tip your own post" }, 400);
      }

      // Confirm receiver exists
      const receiver = await env.DB
        .prepare(`SELECT id FROM users WHERE id = ?`)
        .bind(receiver_id)
        .first();

      if (!receiver) return json({ error: "Receiver not found" }, 404);

      // Confirm post exists and belongs to receiver
      const post = await env.DB
        .prepare(`SELECT id, user_id FROM posts WHERE id = ? AND deleted_at IS NULL`)
        .bind(post_id)
        .first();

      if (!post) return json({ error: "Post not found" }, 404);

      if (post.user_id !== receiver_id) {
        return json({ error: "Post does not belong to receiver" }, 400);
      }

      // Get sender wallet and check balance
      const senderWallet = await env.DB
        .prepare(`SELECT id, balance_usd FROM wallets WHERE user_id = ?`)
        .bind(sender.id)
        .first();

      if (!senderWallet) {
        return json({ error: "Sender wallet not found. Please deposit funds first." }, 400);
      }

      if (senderWallet.balance_usd < amount_usd) {
        return json({
          error: "Insufficient wallet balance",
          balance_usd: senderWallet.balance_usd,
        }, 400);
      }

      // Get receiver wallet
      const receiverWallet = await env.DB
        .prepare(`SELECT id, balance_usd FROM wallets WHERE user_id = ?`)
        .bind(receiver_id)
        .first();

      if (!receiverWallet) {
        return json({ error: "Receiver wallet not found" }, 400);
      }

      // Calculate fee
      const PLATFORM_FEE = 0.05;
      const feeUsd       = parseFloat((amount_usd * PLATFORM_FEE).toFixed(2));
      const netUsd       = parseFloat((amount_usd - feeUsd).toFixed(2));

      const now = new Date().toISOString();
      const tipId = crypto.randomUUID();

      // Deduct from sender
      const senderNewBalance = parseFloat((senderWallet.balance_usd - amount_usd).toFixed(2));
      await env.DB
        .prepare(`
          UPDATE wallets
          SET balance_usd = ?,
              total_tips_sent_usd = total_tips_sent_usd + ?,
              updated_at = ?
          WHERE user_id = ?
        `)
        .bind(senderNewBalance, amount_usd, now, sender.id)
        .run();

      // Record sender wallet transaction
      await env.DB
        .prepare(`
          INSERT INTO wallet_transactions
            (id, wallet_id, user_id, type, amount_usd,
             balance_after_usd, reference, description, created_at)
          VALUES (?, ?, ?, 'tip_sent', ?, ?, ?, ?, ?)
        `)
        .bind(
          crypto.randomUUID(), senderWallet.id, sender.id,
          amount_usd, senderNewBalance, tipId,
          `Tip sent on post ${post_id}`, now
        )
        .run();

      // Credit receiver (net amount after fee)
      const receiverNewBalance = parseFloat((receiverWallet.balance_usd + netUsd).toFixed(2));
      await env.DB
        .prepare(`
          UPDATE wallets
          SET balance_usd = ?,
              total_tips_received_usd = total_tips_received_usd + ?,
              updated_at = ?
          WHERE user_id = ?
        `)
        .bind(receiverNewBalance, netUsd, now, receiver_id)
        .run();

      // Record receiver wallet transaction
      await env.DB
        .prepare(`
          INSERT INTO wallet_transactions
            (id, wallet_id, user_id, type, amount_usd,
             balance_after_usd, reference, description, created_at)
          VALUES (?, ?, ?, 'tip_received', ?, ?, ?, ?, ?)
        `)
        .bind(
          crypto.randomUUID(), receiverWallet.id, receiver_id,
          netUsd, receiverNewBalance, tipId,
          `Tip received on post ${post_id}`, now
        )
        .run();

      // Insert into tips table
      const amountCents      = Math.round(amount_usd * 100);
      const feeCents         = Math.round(feeUsd * 100);
      const netCents         = Math.round(netUsd * 100);

      await env.DB
        .prepare(`
          INSERT INTO tips
            (id, sender_id, receiver_id, post_id, amount_cents,
             platform_fee_cents, receiver_net_cents,
             is_wallet_tip, status, created_at, completed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'completed', ?, ?)
        `)
        .bind(
          tipId, sender.id, receiver_id, post_id,
          amountCents, feeCents, netCents, now, now
        )
        .run();

      // Update post tips_received_cents
      await env.DB
        .prepare(`
          UPDATE posts
          SET tips_received_cents = tips_received_cents + ?,
              tip_count = tip_count + 1,
              updated_at = ?
          WHERE id = ?
        `)
        .bind(netCents, now, post_id)
        .run();

      // Update users aggregate tip columns
      await env.DB
        .prepare(`
          UPDATE users
          SET total_tips_sent_cents = total_tips_sent_cents + ?,
              updated_at = ?
          WHERE id = ?
        `)
        .bind(amountCents, now, sender.id)
        .run();

      await env.DB
        .prepare(`
          UPDATE users
          SET total_tips_received_cents = total_tips_received_cents + ?,
              updated_at = ?
          WHERE id = ?
        `)
        .bind(netCents, now, receiver_id)
        .run();

      // Score events
      await addScoreEvent(
        sender.id,
        "tip_sent",
        null,
        { tip_id: tipId, post_id },
        env.DB
      );

      await addScoreEvent(
        receiver_id,
        "tip_received_reaction",
        null,
        { tip_id: tipId, post_id },
        env.DB
      );

      return json({
        success: true,
        tip_id: tipId,
        amount_usd,
        fee_usd: feeUsd,
        net_usd: netUsd,
      });

    } catch (err) {
      console.error("Tip error:", err);
      return json({ error: "Unable to send tip. Please try again." }, 500);
    }
  }

  return null;
				}
