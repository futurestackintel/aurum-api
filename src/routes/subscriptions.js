import { requireAuth } from "../middleware/auth.js";
import { PaymentService } from "../services/payments.js";

export async function handleSubscriptionRoutes(pathname, request, env) {

  // POST /subscriptions/upgrade
  if (pathname === "/subscriptions/upgrade" && request.method === "POST") {
    const auth = await requireAuth(request);
    if (auth.error) {
      return new Response(JSON.stringify({ error: auth.error }), {
        status: auth.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await request.json();
    const { tier } = body;

    if (!["pro", "sovereign"].includes(tier)) {
      return new Response(
        JSON.stringify({ error: "tier must be 'pro' or 'sovereign'" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    try {
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

      const amount = tier === "pro" ? 29 : 99;
      const payments = new PaymentService(env);

      const result = await payments.initializeChallengePayment({
        email: user.email,
        amount,
        challengeId: `sub_${tier}`,
        userId: user.id,
        callbackUrl: `https://tryaurum.store/subscription/callback?tier=${tier}`,
      });

      const now = new Date().toISOString();
      await env.aurum_db
        .prepare(
          `INSERT OR REPLACE INTO subscriptions (user_id, tier, status, payment_reference, created_at)
           VALUES (?, ?, 'pending', ?, ?)`
        )
        .bind(user.id, tier, result.reference, now)
        .run();

      return new Response(
        JSON.stringify({
          authorization_url: result.authorization_url,
          reference: result.reference,
          tier,
          amount,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    } catch (err) {
      console.error("Subscription upgrade error:", err);
      return new Response(
        JSON.stringify({ error: "Unable to initialize subscription. Please try again." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  // POST /subscriptions/verify
  if (pathname === "/subscriptions/verify" && request.method === "POST") {
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

      const user = await env.aurum_db
        .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
        .bind(auth.user.sub)
        .first();

      if (!user) {
        return new Response(JSON.stringify({ error: "User not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      const tier = reference.includes("sovereign") ? "sovereign" : "pro";
      const now = new Date().toISOString();

      await env.aurum_db
        .prepare(`UPDATE users SET tier = ? WHERE id = ?`)
        .bind(tier, user.id)
        .run();

      await env.aurum_db
        .prepare(
          `UPDATE subscriptions SET status = 'active', activated_at = ? WHERE payment_reference = ?`
        )
        .bind(now, reference)
        .run();

      return new Response(
        JSON.stringify({ message: `Upgraded to ${tier}`, tier }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    } catch (err) {
      console.error("Subscription verify error:", err);
      return new Response(
        JSON.stringify({ error: "Unable to verify subscription. Please try again." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  return null;
}