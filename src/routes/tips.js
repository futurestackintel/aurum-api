import { requireAuth } from "../middleware/auth.js";
import { PaymentService } from "../services/payments.js";

export async function handleTipsRoutes(pathname, request, env) {

  // POST /tips/initialize
  if (pathname === "/tips/initialize" && request.method === "POST") {
    const auth = await requireAuth(request);
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
      const sender = await env.aurum_db
        .prepare(`SELECT id, email FROM users WHERE clerk_id = ?`)
        .bind(auth.user.sub)
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

      const { sender_id, receiver_id, post_id, platform_fee } = transaction.metadata;
      const amount = transaction.amount / 100;
      const now = new Date().toISOString();

      await env.aurum_db
        .prepare(
          `INSERT INTO tips (sender_id, receiver_id, post_id, amount, fee_taken, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(sender_id, receiver_id, post_id, amount, platform_fee, now)
        .run();

      await env.aurum_db
        .prepare(`UPDATE posts SET tips_received = tips_received + ? WHERE id = ?`)
        .bind(amount - platform_fee, post_id)
        .run();

      await env.aurum_db
        .prepare(`UPDATE users SET aurum_score = aurum_score + 2 WHERE id = ?`)
        .bind(sender_id)
        .run();

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