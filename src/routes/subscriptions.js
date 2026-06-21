import { requireAuth } from "../middleware/auth.js";
import { PaymentService } from "../services/payments.js";

export async function handleSubscriptionRoutes(pathname, request, env) {

  // POST /subscriptions/upgrade
  if (pathname === "/subscriptions/upgrade" && request.method === "POST") {
    const auth = await requireAuth(request, env);
    if (auth.error) {
      return new Response(JSON.stringify({ error: auth.error }), {
        status: auth.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await request.json();
    const { tier } = body;

    if (!["contender", "sovereign"].includes(tier)) {
      return new Response(
        JSON.stringify({ error: "tier must be 'contender' or 'sovereign'" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    try {
      const user = await env.DB
        .prepare(`SELECT id, email FROM users WHERE clerk_id = ?`)
        .bind(auth.id)
        .first();

      if (!user) {
        return new Response(JSON.stringify({ error: "User not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      const amount = tier === "contender" ? 29 : 99;
      const payments = new PaymentService(env);

      // Uses dedicated subscription method — sets type: "subscription" in metadata
      const result = await payments.initializeSubscriptionPayment({
        email: user.email,
        amount,
        userId: user.id,
        tier,
        callbackUrl: `https://tryaurum.store/subscription/callback?tier=${tier}`,
      });

      const now = new Date().toISOString();

      // Store tier in subscription record at initialization
      await env.DB
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
    const auth = await requireAuth(request, env);
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

      const user = await env.DB
        .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
        .bind(auth.id)
        .first();

      if (!user) {
        return new Response(JSON.stringify({ error: "User not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Retrieve tier from subscription record — never guess from reference string
      const subscription = await env.DB
        .prepare(`SELECT tier, status FROM subscriptions WHERE payment_reference = ?`)
        .bind(reference)
        .first();

      if (!subscription) {
        return new Response(
          JSON.stringify({ error: "Subscription record not found for this reference" }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
      }

      // Idempotency — if already active, return success without re-processing
      if (subscription.status === "active") {
        return new Response(
          JSON.stringify({ message: `Already upgraded to ${subscription.tier}`, tier: subscription.tier }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      const tier = subscription.tier;
      const now  = new Date().toISOString();

      // Fix 5 — set expires_at to 30 days from activation
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

      await env.DB
        .prepare(`UPDATE users SET tier = ? WHERE id = ?`)
        .bind(tier, user.id)
        .run();

      await env.DB
        .prepare(`
          UPDATE subscriptions
          SET status       = 'active',
              activated_at = ?,
              expires_at   = ?
          WHERE payment_reference = ?
        `)
        .bind(now, expiresAt, reference)
        .run();

      return new Response(
        JSON.stringify({ message: `Upgraded to ${tier}`, tier, expires_at: expiresAt }),
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
