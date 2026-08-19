// ============================================================
// AURUM Auth Routes
// POST /auth/register
// GET  /auth/me
// FIX: GET /api/auth/me was missing profile_visibility,
// hide_aurum_score, and hide_league in its SELECT — settings.html
// reads these to set toggle states on page load, so without them
// the Public Profile / Hide Aurum Score / Hide League toggles could
// never reflect what was actually saved, regardless of what the
// save side does. Added below.
// ============================================================

import { requireAuth } from "../middleware/auth.js";
import { PaymentService } from "../services/payments.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const REFERRAL_SIGNUP_POINTS = 50;

async function generateReferralCode(env) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  for (let attempt = 0; attempt < 5; attempt++) {
    let code = "";
    for (let i = 0; i < 7; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    const existing = await env.DB
      .prepare(`SELECT id FROM users WHERE referral_code = ?`)
      .bind(code)
      .first();
    if (!existing) return code;
  }
  throw new Error("Could not generate unique referral code");
}

export async function handleAuthRoutes(pathname, request, env) {

  // ── POST /auth/register ─────────────────────────────────────
  if (pathname === "/api/auth/register" && request.method === "POST") {
    const auth = await requireAuth(request, env);
    if (auth.error) return json({ error: auth.error }, auth.status);

        const clerkUserId = auth.id;
    const body = await request.json();
    const { email, username, display_name, ref_code } = body;

    if (!email || !username) {
      return json({ error: "email and username are required" }, 400);
    }

    try {
      // Idempotency — return early if already registered
      const existing = await env.DB
        .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
        .bind(clerkUserId)
        .first();

      if (existing) {
        return json({ message: "User already registered", user_id: existing.id });
      }

            const now    = new Date().toISOString();
      const userId = crypto.randomUUID();
      const newReferralCode = await generateReferralCode(env);

      // Resolve referrer (if a valid ref_code was passed) BEFORE insert,
      // so a bad/unknown code never blocks registration
            let referrerId = null;
      if (ref_code) {
        const referrer = await env.DB
          .prepare(`SELECT id FROM users WHERE referral_code = ? AND deleted_at IS NULL`)
          .bind(ref_code)
          .first();
        // Guard: a referrer can never be the same account as the new signup
        if (referrer && referrer.id !== userId) referrerId = referrer.id;
      }

      // Insert user ΓÇö only columns that exist in the schema
      await env.DB
        .prepare(`
          INSERT INTO users
            (id, clerk_id, email, username, display_name,
             tier, league, aurum_score, referral_code, referred_by,
             created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'explorer', 'bronze', 0, ?, ?, ?, ?)
        `)
        .bind(
          userId, clerkUserId, email, username,
          display_name || username,
          newReferralCode, referrerId,
          now, now
        )
        .run();

      // Log referral + award points to referrer (non-blocking, failure is safe)
      if (referrerId) {
        try {
          await env.DB
            .prepare(`
              INSERT INTO referrals (id, referrer_id, referred_id, points_awarded, created_at)
              VALUES (?, ?, ?, ?, ?)
            `)
            .bind(crypto.randomUUID(), referrerId, userId, REFERRAL_SIGNUP_POINTS, now)
            .run();

          await env.DB
            .prepare(`UPDATE users SET aurum_score = aurum_score + ? WHERE id = ?`)
            .bind(REFERRAL_SIGNUP_POINTS, referrerId)
            .run();
        } catch (err) {
          console.error("Referral logging failed (non-fatal):", err.message);
        }
      }
      // Auto-create wallet for new user
      const walletId = crypto.randomUUID();
      await env.DB
        .prepare(`
          INSERT INTO wallets
            (id, user_id, balance_usd, total_deposited_usd,
             total_withdrawn_usd, total_tips_sent_usd,
             total_tips_received_usd, currency_preference,
             created_at, updated_at)
          VALUES (?, ?, 0, 0, 0, 0, 0, 'USD', ?, ?)
        `)
        .bind(walletId, userId, now, now)
        .run();

      // Create Paystack customer — non-blocking, failure is safe
      try {
        const payments = new PaymentService(env);
        await payments.createCustomer({
          email,
          firstName: display_name || username,
          lastName:  "",
          userId,
        });
      } catch (err) {
        console.error("Paystack customer creation failed (non-fatal):", err.message);
      }

      return json(
        { message: "User registered successfully", user_id: userId },
        201
      );
    } catch (err) {
      console.error("Register error:", err);

      // Surface duplicate username/email constraint errors clearly
      if (err.message?.includes("UNIQUE constraint failed")) {
        if (err.message.includes("username")) {
          return json({ error: "Username already taken" }, 409);
        }
        if (err.message.includes("email")) {
          return json({ error: "Email already registered" }, 409);
        }
      }

      return json({ error: "Registration failed. Please try again." }, 500);
    }
  }

  // ── GET /auth/me ────────────────────────────────────────────
  if (pathname === "/api/auth/me" && request.method === "GET") {
    const auth = await requireAuth(request, env);
    if (auth.error) return json({ error: auth.error }, auth.status);

    try {
      const user = await env.DB
        .prepare(`
                    SELECT
            id, username, display_name, email, avatar_url, bio,
            tier, league, aurum_score,
            streak_current, streak_longest,
            total_tips_sent_cents, total_tips_received_cents,
            total_challenges_won, stealth_mode,
            is_verified, is_founding_member,
            kyc_status, created_at,
            profile_visibility, hide_aurum_score, hide_league,
            referral_code
          FROM users
          WHERE clerk_id = ? AND deleted_at IS NULL
        `)
        .bind(auth.id)
        .first();

            if (!user) return json({ error: "User not found" }, 404);

      // Lazy-backfill: users created before the referral system shipped
      // won't have a referral_code yet. Generate one on first load.
      if (!user.referral_code) {
        try {
          const code = await generateReferralCode(env);
          await env.DB
            .prepare(`UPDATE users SET referral_code = ? WHERE id = ?`)
            .bind(code, user.id)
            .run();
          user.referral_code = code;
        } catch (err) {
          console.error("Referral code backfill failed (non-fatal):", err.message);
        }
      }

      return json({ user });
    } catch (err) {
      console.error("Auth me error:", err);
      return json({ error: "Unable to load profile. Please try again." }, 500);
    }
  }

  return null;
}
