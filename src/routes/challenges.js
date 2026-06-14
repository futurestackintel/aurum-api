import { requireAuth } from "../middleware/auth.js";
import { PaymentService } from "../services/payments.js";
import { TreasuryService } from "../services/treasury.js";

export async function handleChallengePaymentRoutes(pathname, request, env) {
  const fundMatch    = pathname.match(/^\/challenges\/(\d+)\/fund$/);
  const verifyMatch  = pathname.match(/^\/challenges\/(\d+)\/verify$/);
  const payoutMatch  = pathname.match(/^\/challenges\/(\d+)\/payout$/);

  // POST /challenges/:id/fund
  if (fundMatch && request.method === "POST") {
    const challengeId = fundMatch[1];
    const auth = await requireAuth(request);
    if (auth.error) {
      return new Response(JSON.stringify({ error: auth.error }), {
        status: auth.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const challenge = await env.aurum_db
        .prepare(`SELECT id, entry_fee, status FROM challenges WHERE id = ?`)
        .bind(challengeId)
        .first();

      if (!challenge) {
        return new Response(JSON.stringify({ error: "Challenge not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (challenge.status !== "active") {
        return new Response(JSON.stringify({ error: "Challenge is not active" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const user = await env.aurum_db
        .prepare(`SELECT id, email FROM users WHERE clerk_id = ?`)
        .bind(auth.user.sub)
        .first();

      if (!user) {
        return new Response(JSON.stringify({ error: "User not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      const payments = new PaymentService(env);
      const result = await payments.initializeChallengePayment({
        email: user.email,
        amount: challenge.entry_fee,
        challengeId,
        userId: user.id,
        callbackUrl: `https://tryaurum.store/challenge/${challengeId}/callback`,
      });

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("Challenge fund error:", err);
      return new Response(
        JSON.stringify({ error: "Unable to initialize challenge payment. Please try again." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  // POST /challenges/:id/verify
  if (verifyMatch && request.method === "POST") {
    const challengeId = verifyMatch[1];
    const auth = await requireAuth(request);
    if (auth.error) {
      return new Response(JSON.stringify({ error: auth.error }), {
        status: auth.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await request.json();
    const { reference } = body;

    if (!reference) {
      return new Response(JSON.stringify({ error: "reference required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const payments = new PaymentService(env);
      const transaction = await payments.verifyPayment(reference);

      if (transaction.status !== "success") {
        return new Response(JSON.stringify({ error: "Payment not successful" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const amount = transaction.amount / 100;
      const { user_id } = transaction.metadata;
      const now = new Date().toISOString();

      await env.aurum_db
        .prepare(
          `INSERT INTO challenge_entries (challenge_id, user_id, entry_amount, created_at)
           VALUES (?, ?, ?, ?)`
        )
        .bind(challengeId, user_id, amount, now)
        .run();

      const treasury = new TreasuryService(env.aurum_db);
      const balance = await treasury.addFunds(challengeId, amount);

      await env.aurum_db
        .prepare(`UPDATE challenges SET pool_amount = pool_amount + ? WHERE id = ?`)
        .bind(amount, challengeId)
        .run();

      return new Response(
        JSON.stringify({
          message: "Entry verified",
          treasury_balance: balance.total_held,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    } catch (err) {
      console.error("Challenge verify error:", err);
      return new Response(
        JSON.stringify({ error: "Unable to verify challenge payment. Please try again." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  // POST /challenges/:id/payout
  if (payoutMatch && request.method === "POST") {
    const challengeId = payoutMatch[1];
    const auth = await requireAuth(request);
    if (auth.error) {
      return new Response(JSON.stringify({ error: auth.error }), {
        status: auth.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await request.json();
    const { winner_id, recipient_code } = body;

    if (!winner_id || !recipient_code) {
      return new Response(
        JSON.stringify({ error: "winner_id and recipient_code required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    try {
      const treasury = new TreasuryService(env.aurum_db);
      const balance = await treasury.getBalance(challengeId);

      if (!balance || balance.status !== "holding") {
        return new Response(
          JSON.stringify({ error: "Treasury not available for payout" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      await treasury.markReleasing(challengeId);

      const payments = new PaymentService(env);
      await payments.payoutWinner({
        amount: balance.total_held,
        recipientCode: recipient_code,
        challengeId,
      });

      await treasury.markReleased(challengeId);

      await env.aurum_db
        .prepare(`UPDATE challenges SET winner_id = ?, status = 'completed' WHERE id = ?`)
        .bind(winner_id, challengeId)
        .run();

      await env.aurum_db
        .prepare(`UPDATE users SET aurum_score = aurum_score + 50 WHERE id = ?`)
        .bind(winner_id)
        .run();

      return new Response(
        JSON.stringify({
          message: "Payout complete",
          amount_paid: balance.total_held,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    } catch (err) {
      console.error("Challenge payout error:", err);
      return new Response(
        JSON.stringify({ error: "Unable to process payout. Please contact support." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  return null;
}