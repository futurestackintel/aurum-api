// ============================================================
// AURUM Wallet Routes
// POST /api/wallet/deposit
// POST /api/wallet/deposit/confirm
// GET  /api/wallet/balance
// POST /api/wallet/withdraw
// POST /api/wallet/currency
// GET  /api/wallet/transactions
// POST /api/wallet/bank-details   ← NEW (Fix 2)
// GET  /api/wallet/bank-details   ← NEW (Fix 2)
// POST /api/admin/wallet/migrate
// ============================================================

import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { PaymentService } from "../services/payments.js";
import { DepositService } from "../services/deposits.js";
import { WithdrawalService } from "../services/withdrawals.js";
import { buildBalanceDisplay, SUPPORTED_CURRENCIES } from "../services/currency.js";
// ── Helpers ──────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Get or create a wallet for a user.
 * Registration auto-creates wallets for new users.
 * This is a safety net for any user who slipped through.
 */
async function getWallet(userId, db) {
  const wallet = await db
    .prepare(`SELECT * FROM wallets WHERE user_id = ?`)
    .bind(userId)
    .first();

  if (wallet) return wallet;

  // Auto-create if missing
  const now = new Date().toISOString();
  const walletId = crypto.randomUUID();
  await db
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

  return await db
    .prepare(`SELECT * FROM wallets WHERE user_id = ?`)
    .bind(userId)
    .first();
}

// ── Route Handler ─────────────────────────────────────────────

export async function handleWalletRoutes(pathname, request, env) {

    // ── POST /api/wallet/deposit ────────────────────────────────
  if (pathname === "/api/wallet/deposit" && request.method === "POST") {
    const auth = await requireAuth(request, env);
    if (auth.error) return json({ error: auth.error }, auth.status);

    try {
      const body = await request.json();

      const user = await env.DB
        .prepare(`SELECT id, email FROM users WHERE clerk_id = ?`)
        .bind(auth.id)
        .first();

      if (!user) return json({ error: "User not found" }, 404);

      const idempotencyKey = request.headers.get("Idempotency-Key");

      if (!idempotencyKey) {
        return json({ error: "Idempotency-Key header required" }, 400);
      }

      const deposits = new DepositService(env);

      const result = await deposits.initializeDeposit({
        userId: user.id,
        email: user.email,
        amountMinor: body.amount_minor,
        currencyCode: body.currency_code,
        idempotencyKey,
        callbackUrl: env.WALLET_DEPOSIT_CALLBACK_URL,
        requestId: request.headers.get("cf-ray"),
      });

      return json({
        operation_id: result.operationId,
        authorization_url: result.authorizationUrl,
        reference: result.reference,
        status: result.status,
      });
    } catch (err) {
      console.error("Wallet deposit initialization error:", err);

      return json({
        error: "Unable to initialize deposit.",
      }, 400);
    }
	}

  // ── POST /api/wallet/deposit/confirm ───────────────────────
  // ── POST /api/wallet/deposit/confirm ───────────────────────
  if (pathname === "/api/wallet/deposit/confirm" && request.method === "POST") {
    const auth = await requireAuth(request, env);
    if (auth.error) return json({ error: auth.error }, auth.status);

    try {
      const body = await request.json();

      if (!body.reference) {
        return json({ error: "reference required" }, 400);
      }

      const user = await env.DB
        .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
        .bind(auth.id)
        .first();

      if (!user) return json({ error: "User not found" }, 404);

      const deposits = new DepositService(env);

      const result = await deposits.confirmDeposit({
        userId: user.id,
        reference: body.reference,
        requestId: request.headers.get("cf-ray"),
      });

      return json(result);
    } catch (err) {
      console.error("Wallet deposit confirmation error:", err);

      return json({
        error: "Unable to confirm deposit. Please try again.",
      }, 400);
    }
  }

  // ── GET /api/wallet/balance ─────────────────────────────────
  if (pathname === "/api/wallet/balance" && request.method === "GET") {
    const auth = await requireAuth(request, env);
    if (auth.error) return json({ error: auth.error }, auth.status);

    try {
      const user = await env.DB
        .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
        .bind(auth.id)
        .first();

      if (!user) return json({ error: "User not found" }, 404);

      const wallet = await getWallet(user.id, env.DB);
      const display = await buildBalanceDisplay(
        wallet.balance_usd,
        wallet.currency_preference,
        env.DB
      );

      return json({
        ...display,
        total_deposited_usd: wallet.total_deposited_usd,
        total_tips_sent_usd: wallet.total_tips_sent_usd,
        total_tips_received_usd: wallet.total_tips_received_usd,
      });
    } catch (err) {
      console.error("Wallet balance error:", err);
      return json({ error: "Unable to fetch balance. Please try again." }, 500);
    }
  }

    // ── POST /api/wallet/withdraw ───────────────────────────────
  if (pathname === "/api/wallet/withdraw" && request.method === "POST") {
    const auth = await requireAuth(request, env);
    if (auth.error) return json({ error: auth.error }, auth.status);

    try {
      const body = await request.json();

      const idempotencyKey = request.headers.get("Idempotency-Key");

      if (!idempotencyKey) {
        return json({
          error: "Idempotency-Key header required",
        }, 400);
      }

      const user = await env.DB
        .prepare(`
          SELECT id
          FROM users
          WHERE clerk_id = ?
        `)
        .bind(auth.id)
        .first();

      if (!user) {
        return json({ error: "User not found" }, 404);
      }

      // Withdrawals must use previously saved bank details.
      // Never accept payout account details directly from this request.
      const bankDetails = await env.DB
        .prepare(`
          SELECT
            bank_name,
            account_number,
            account_name,
            bank_code
          FROM user_bank_details
          WHERE user_id = ?
        `)
        .bind(user.id)
        .first();

      if (
        !bankDetails ||
        !bankDetails.account_number ||
        !bankDetails.account_name ||
        !bankDetails.bank_code
      ) {
        return json({
          error: "Please save complete bank details before withdrawing.",
        }, 400);
      }

      const withdrawals = new WithdrawalService(env);

      const result = await withdrawals.initiateWithdrawal({
        userId: user.id,
        amountMinor: body.amount_minor,
        currencyCode: body.currency_code,
        idempotencyKey,
        bankDetails,
        requestId: request.headers.get("cf-ray"),
      });

      const response = {
        operation_id: result.operationId,
        reference: result.reference,
        status: result.status,
        already_created: result.alreadyCreated || false,
      };

      if (result.status === "reconciliation_required") {
        return json(response, 202);
      }

      return json(response);
    } catch (err) {
      console.error("Wallet withdrawal error:", err);

      // Preserve visibility of uncertain provider outcomes.
      const idempotencyKey = request.headers.get("Idempotency-Key");

      if (idempotencyKey) {
        try {
          const user = await env.DB
            .prepare(`
              SELECT id
              FROM users
              WHERE clerk_id = ?
            `)
            .bind(auth.id)
            .first();

          if (user) {
            const operation = await env.DB
              .prepare(`
                SELECT id, provider_reference, status
                FROM financial_payment_operations
                WHERE user_id = ?
                  AND idempotency_scope = 'wallet-withdrawal'
                  AND idempotency_key = ?
                LIMIT 1
              `)
              .bind(user.id, idempotencyKey)
              .first();

            if (operation?.status === "reconciliation_required") {
              return json({
                operation_id: operation.id,
                reference: operation.provider_reference,
                status: operation.status,
                message: "Withdrawal requires reconciliation. Funds remain reserved.",
              }, 202);
            }
          }
        } catch (lookupError) {
          console.error(
            "Withdrawal reconciliation lookup error:",
            lookupError
          );
        }
      }

      return json({
        error: "Unable to process withdrawal. Please try again.",
      }, 500);
    }
  }
  // ── POST /api/wallet/currency ───────────────────────────────
  if (pathname === "/api/wallet/currency" && request.method === "POST") {
    const auth = await requireAuth(request, env);
    if (auth.error) return json({ error: auth.error }, auth.status);

    const body = await request.json();
    const { currency } = body;

    if (!currency || !SUPPORTED_CURRENCIES.includes(currency)) {
      return json({
        error: `currency must be one of: ${SUPPORTED_CURRENCIES.join(", ")}`,
      }, 400);
    }

    try {
      const user = await env.DB
        .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
        .bind(auth.id)
        .first();

      if (!user) return json({ error: "User not found" }, 404);

      const now = new Date().toISOString();
      await env.DB
        .prepare(`
          UPDATE wallets
          SET currency_preference = ?, updated_at = ?
          WHERE user_id = ?
        `)
        .bind(currency, now, user.id)
        .run();

      return json({ currency_preference: currency });
    } catch (err) {
      console.error("Wallet currency error:", err);
      return json({ error: "Unable to update currency. Please try again." }, 500);
    }
  }

  // ── GET /api/wallet/transactions ────────────────────────────
  if (pathname === "/api/wallet/transactions" && request.method === "GET") {
    const auth = await requireAuth(request, env);
    if (auth.error) return json({ error: auth.error }, auth.status);

    const url = new URL(request.url);
    const limit  = Math.min(parseInt(url.searchParams.get("limit")  ?? "20"), 50);
    const offset = parseInt(url.searchParams.get("offset") ?? "0");

    try {
      const user = await env.DB
        .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
        .bind(auth.id)
        .first();

      if (!user) return json({ error: "User not found" }, 404);

      const { results } = await env.DB
        .prepare(`
          SELECT id, type, amount_usd, balance_after_usd,
                 reference, description, created_at
          FROM wallet_transactions
          WHERE user_id = ?
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?
        `)
        .bind(user.id, limit, offset)
        .all();

      return json({ transactions: results, limit, offset });
    } catch (err) {
      console.error("Wallet transactions error:", err);
      return json({ error: "Unable to fetch transactions. Please try again." }, 500);
    }
  }

  // ── POST /api/wallet/bank-details ───────────────────────────
  // Fix 2: save withdrawal bank details for a user.
  // Resolves internal DB user id from Clerk id before any write.
  if (pathname === "/api/wallet/bank-details" && request.method === "POST") {
    const auth = await requireAuth(request, env);
    if (auth.error) return json({ error: auth.error }, auth.status);

    const body = await request.json();
    const { bank_name, account_number, account_name, bank_code } = body;

    if (!bank_name || !account_number || !account_name) {
      return json({ error: "bank_name, account_number, and account_name are required" }, 400);
    }

    try {
      const user = await env.DB
        .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
        .bind(auth.id)
        .first();

      if (!user) return json({ error: "User not found" }, 404);

      const now = new Date().toISOString();

      const existing = await env.DB
        .prepare(`SELECT id FROM user_bank_details WHERE user_id = ?`)
        .bind(user.id)
        .first();

      if (existing) {
        await env.DB
          .prepare(`
            UPDATE user_bank_details
            SET bank_name = ?, account_number = ?, account_name = ?,
                bank_code = ?, updated_at = ?
            WHERE user_id = ?
          `)
          .bind(bank_name, account_number, account_name, bank_code ?? null, now, user.id)
          .run();
      } else {
        await env.DB
          .prepare(`
            INSERT INTO user_bank_details
              (id, user_id, bank_name, account_number, account_name,
               bank_code, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .bind(
            crypto.randomUUID(), user.id, bank_name, account_number,
            account_name, bank_code ?? null, now, now
          )
          .run();
      }

      return json({ saved: true });
    } catch (err) {
      console.error("Save bank details error:", err);
      return json({ error: "Unable to save bank details. Please try again." }, 500);
    }
  }

  // ── GET /api/wallet/bank-details ────────────────────────────
  // Fix 2: return saved withdrawal bank details for the user.
  if (pathname === "/api/wallet/bank-details" && request.method === "GET") {
    const auth = await requireAuth(request, env);
    if (auth.error) return json({ error: auth.error }, auth.status);

    try {
      const user = await env.DB
        .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
        .bind(auth.id)
        .first();

      if (!user) return json({ error: "User not found" }, 404);

      const details = await env.DB
        .prepare(`
          SELECT bank_name, account_number, account_name, bank_code, updated_at
          FROM user_bank_details
          WHERE user_id = ?
        `)
        .bind(user.id)
        .first();

      return json({ bank_details: details ?? null });
    } catch (err) {
      console.error("Get bank details error:", err);
      return json({ error: "Unable to fetch bank details. Please try again." }, 500);
    }
  }

  // ── POST /api/admin/wallet/migrate ──────────────────────────
  // One-time: creates wallets for all existing users who don't have one
  if (pathname === "/api/admin/wallet/migrate" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth.error) return json({ error: auth.error }, auth.status);

    try {
      const { results: users } = await env.DB
        .prepare(`
          SELECT u.id FROM users u
          LEFT JOIN wallets w ON w.user_id = u.id
          WHERE w.id IS NULL AND u.deleted_at IS NULL
        `)
        .all();

      const now = new Date().toISOString();
      let created = 0;

      for (const user of users) {
        await env.DB
          .prepare(`
            INSERT OR IGNORE INTO wallets
              (id, user_id, balance_usd, total_deposited_usd,
               total_withdrawn_usd, total_tips_sent_usd,
               total_tips_received_usd, currency_preference,
               created_at, updated_at)
            VALUES (?, ?, 0, 0, 0, 0, 0, 'USD', ?, ?)
          `)
          .bind(crypto.randomUUID(), user.id, now, now)
          .run();
        created++;
      }

      return json({ created, skipped: 0 });
    } catch (err) {
      console.error("Wallet migration error:", err);
      return json({ error: "Migration failed. Please try again." }, 500);
    }
  }

  return null;
}
