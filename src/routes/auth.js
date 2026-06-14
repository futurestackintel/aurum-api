import { requireAuth } from "../middleware/auth.js";
import { PaymentService } from "../services/payments.js";

export async function handleAuthRoutes(pathname, request, env) {

  // POST /auth/register
  if (pathname === "/auth/register" && request.method === "POST") {
    const auth = await requireAuth(request);
    if (auth.error) {
      return new Response(JSON.stringify({ error: auth.error }), {
        status: auth.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    const clerkUserId = auth.user.sub;
    const body = await request.json();
    const { email, username, firstName, lastName } = body;

    if (!email || !username) {
      return new Response(JSON.stringify({ error: "email and username are required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const existing = await env.aurum_db
        .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
        .bind(clerkUserId)
        .first();

      if (existing) {
        return new Response(
          JSON.stringify({ message: "User already registered", user_id: existing.id }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // Create Paystack customer — non-blocking, failure is safe
      let paystackCustomerCode = null;
      try {
        const payments = new PaymentService(env);
        const customer = await payments.createCustomer({
          email,
          firstName,
          lastName,
          userId: clerkUserId,
        });
        paystackCustomerCode = customer.customer_code;
      } catch (err) {
        console.error("Paystack customer creation failed:", err.message);
      }

      const now = new Date().toISOString();
      const result = await env.aurum_db
        .prepare(
          `INSERT INTO users (clerk_id, email, username, first_name, last_name, tier, league, aurum_score, paystack_customer_code, created_at)
           VALUES (?, ?, ?, ?, ?, 'free', 'bronze', 0, ?, ?)`
        )
        .bind(clerkUserId, email, username, firstName, lastName, paystackCustomerCode, now)
        .run();

      return new Response(
        JSON.stringify({
          message: "User registered successfully",
          user_id: result.meta.last_row_id,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } }
      );
    } catch (err) {
      console.error("Register error:", err);
      return new Response(
        JSON.stringify({ error: "Registration failed. Please try again." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  // GET /auth/me
  if (pathname === "/auth/me" && request.method === "GET") {
    const auth = await requireAuth(request);
    if (auth.error) {
      return new Response(JSON.stringify({ error: auth.error }), {
        status: auth.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const user = await env.aurum_db
        .prepare(
          `SELECT id, username, email, tier, league, aurum_score, verified_badges, streak, created_at
           FROM users WHERE clerk_id = ?`
        )
        .bind(auth.user.sub)
        .first();

      if (!user) {
        return new Response(JSON.stringify({ error: "User not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ user }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("Auth me error:", err);
      return new Response(
        JSON.stringify({ error: "Unable to load profile. Please try again." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  return null;
}