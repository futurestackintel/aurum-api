// ============================================================
// FOUNDING MEMBER ROUTES
// POST /api/founding/join — initialize $20 Paystack payment
// Limited to first 100 members only.
// ============================================================

import { requireAuth } from '../middleware/auth.js';

export async function handleFoundingRoutes(pathname, request, env) {

  // ── POST /api/founding/join ───────────────────────────────
  if (pathname === '/api/founding/join' && request.method === 'POST') {
    const user = await requireAuth(request, env);
    if (user.error) return jsonResponse({ error: user.error }, 401);

    const db  = env.DB;
    const now = new Date().toISOString();

    try {
      // Check if user is already a founding member
      const alreadyMember = await db
        .prepare(`SELECT id FROM founding_members WHERE user_id = ?`)
        .bind(user.id)
        .first();

      if (alreadyMember) {
        return jsonResponse({ error: 'You are already a Founding Member.' }, 400);
      }

      // Check founding member cap — max 100
      const { results } = await db
        .prepare(`SELECT COUNT(*) as count FROM founding_members`)
        .all();

      const count = results[0]?.count ?? 0;

      if (count >= 100) {
        return jsonResponse(
          { error: 'Founding Member spots are full. All 100 have been claimed.' },
          410, // 410 Gone — as specified in brief
        );
      }

      // Fetch user email for Paystack
      const userRow = await db
        .prepare(`SELECT email, username FROM users WHERE id = ?`)
        .bind(user.id)
        .first();

      if (!userRow) {
        return jsonResponse({ error: 'User not found.' }, 404);
      }

      // Initialize $20 Paystack payment
      // Paystack amount is in kobo (NGN) or cents (USD) depending on currency.
      // We use USD — amount in cents: $20 = 2000
      const reference = `founding_${user.id}_${Date.now()}`;

      const paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: {
          Authorization:  `Bearer ${env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email:     userRow.email,
          amount:    2000, // $20.00 in cents
          currency:  'USD',
          reference,
          metadata: {
            type:     'founding_member',
            user_id:  user.id,
            username: userRow.username,
          },
        }),
      });

      const paystackData = await paystackRes.json();

      if (!paystackData.status) {
        console.error('Paystack init error:', paystackData);
        return jsonResponse(
          { error: 'Payment initialization failed. Please try again.' },
          502,
        );
      }

      return jsonResponse({
        authorization_url: paystackData.data.authorization_url,
        reference:         paystackData.data.reference,
        spots_remaining:   100 - count,
      });

    } catch (err) {
      console.error('Founding join error:', err);
      return jsonResponse({ error: 'Unable to process request. Please try again.' }, 500);
    }
  }

  return null;
}

// ── Helper ────────────────────────────────────────────────────
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
                           }
