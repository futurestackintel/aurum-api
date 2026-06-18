import { requireAuth } from "../middleware/auth.js";
import { PaymentService } from "../services/payments.js";
import { addScoreEvent } from "../services/aurumScore.js";

export async function handleTipsRoutes(pathname, request, env) {

  // POST /tips/initialize
  if (pathname === "/tips/initialize" && request.method === "POST") {
    const auth = await requireAuth(request, env);
    if (auth.error) {
      return new Response(JSON.stringify({ error: auth.error }), {
        status: auth.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await request.json();
    const { post_id, receiver_id, amount } = body;

    if (!post_id || !receiver_id || !amount || amount < 1) {
      return new Response(
        JSON.stringify({ error: "post_id, receiver_id, and amount (min $1) required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    try {
      const sender = await env.DB
        .prepare(`SELECT id, email FROM users WHERE clerk_id = ?`)
        .bind(auth.id)
        .first();

      if (!sender) {
        return new Response(JSON.stringify({ error: "Sender not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      const payments = new PaymentService(env);
      const result = await payments.initializeTip({
        senderEmail: sender.email,
        amount,
        postId: post_id,
        senderId: sender.id,
        receiverId: receiver_id,
        callbackUrl: "https://tryaurum.store/tip/callback",
      });

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("Tips initialize error:", err);
      return new Response(
        JSON.stringify({ error: "Unable to initialize tip. Please try again." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  // POST /tips/verify
  if (pathname === "/tips/verify" && request.method === "POST") {
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

      // Idempotency check — prevent duplicate tip recording
      const existingTip = await env.DB
        .prepare(`SELECT id FROM tips WHERE paystack_reference = ?`)
        .bind(reference)
        .first();

      if (existingTip) {
        return new Response(
          JSON.stringify({ message: "Tip already recorded", tip_id: existingTip.id }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      const { sender_id, receiver_id, post_id, platform_fee } = transaction.metadata;
      const amount = transaction.amount / 100;
      const now = new Date().toISOString();

      const tipResult = await env.DB
        .prepare(
          `INSERT INTO tips (sender_id, receiver_id, post_id, amount, fee_taken, paystack_reference, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(sender_id, receiver_id, post_id, amount, platform_fee, reference, now)
        .run();

      await env.DB
        .prepare(`UPDATE posts SET tips_received = tips_received + ? WHERE id = ?`)
        .bind(amount - platform_fee, post_id)
        .run();

      // Score event — replaces raw SQL score update
      await addScoreEvent(
        sender_id,
        "tip_sent",
        null,
        { tip_id: tipResult.meta.last_row_id },
        env.DB
      );

      return new Response(
        JSON.stringify({ message: "Tip verified and recorded", amount, fee: platform_fee }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    } catch (err) {
      console.error("Tips verify error:", err);
      return new Response(
        JSON.stringify({ error: "Unable to verify tip. Please try again." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  return null;
}
