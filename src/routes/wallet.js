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

    const body = await request.json();
    const { amount_usd, callback_url } = body;

    if (!amount_usd || amount_usd < 5) {
      return json({ error: "Minimum deposit is $5" }, 400);
    }

    if (!callback_url) {
      return json({ error: "callback_url required" }, 400);
    }

    try {
      const user = await env.DB
        .prepare(`SELECT id, email FROM users WHERE clerk_id = ?`)
        .bind(auth.id)
        .first();

      if (!user) return json({ error: "User not found" }, 404);

      const payments = new PaymentService(env);
      const result = await payments.initializeWalletDeposit({
        email: user.email,
        amount: amount_usd,
        userId: user.id,
        callbackUrl: callback_url,
      });

      return json({
        authorization_url: result.authorization_url,
        reference: result.reference,
      });
    } catch (err) {
      console.error("Wallet deposit init error:", err);
      return json({ error: "Unable to initialize deposit. Please try again." }, 500);
    }
  }

  // ── POST /api/wallet/deposit/confirm ───────────────────────
  if (pathname === "/api/wallet/deposit/confirm" && request.method === "POST") {
    const auth = await requireAuth(request, env);
    if (auth.error) return json({ error: auth.error }, auth.status);

    const body = await request.json();
    const { reference } = body;

    if (!reference) return json({ error: "reference required" }, 400);

    try {
      const user = await env.DB
        .prepare(`SELECT id, email FROM users WHERE clerk_id = ?`)
        .bind(auth.id)
        .first();

      if (!user) return json({ error: "User not found" }, 404);

      // Idempotency — check if this reference already credited
      const existing = await env.DB
        .prepare(`SELECT id FROM wallet_transactions WHERE reference = ?`)
        .bind(reference)
        .first();

      if (existing) {
        const wallet = await getWallet(user.id, env.DB);
        const display = await buildBalanceDisplay(
          wallet.balance_usd,
          wallet.currency_preference,
          env.DB
        );
        return json({ message: "Already credited", ...display });
      }

      // Verify payment with Paystack
      const payments = new PaymentService(env);
      const transaction = await payments.verifyPayment(reference);

      if (transaction.status !== "success") {
        return json({ error: "Payment not successful" }, 400);
      }

      // Confirm this payment was intended as a wallet deposit
      if (transaction.metadata?.type !== "wallet_deposit") {
        return json({ error: "Invalid payment type for wallet deposit" }, 400);
      }

      // Confirm it belongs to this user
      if (transaction.metadata?.user_id !== user.id) {
        return json({ error: "Payment does not belong to this account" }, 403);
      }

      const amountUsd = transaction.amount / 100;
      const now = new Date().toISOString();
      const wallet = await getWallet(user.id, env.DB);
      const newBalance = wallet.balance_usd + amountUsd;

      await env.DB
        .prepare(`
          UPDATE wallets
          SET balance_usd = ?,
              total_deposited_usd = total_deposited_usd + ?,
              updated_at = ?
          WHERE user_id = ?
        `)
        .bind(newBalance, amountUsd, now, user.id)
        .run();

      await env.DB
        .prepare(`
          INSERT INTO wallet_transactions
            (id, wallet_id, user_id, type, amount_usd,
             balance_after_usd, reference, description, created_at)
          VALUES (?, ?, ?, 'deposit', ?, ?, ?, 'Wallet deposit via Paystack', ?)
        `)
        .bind(
          crypto.randomUUID(), wallet.id, user.id,
          amountUsd, newBalance, reference, now
        )
        .run();

      const display = await buildBalanceDisplay(newBalance, wallet.currency_preference, env.DB);
      return json({ message: "Deposit confirmed", ...display });
    } catch (err) {
      console.error("Wallet deposit confirm error:", err);
      return json({ error: "Unable to confirm deposit. Please try again." }, 500);
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

    const body = await request.json();
    const { amount_usd, account_number, bank_code, account_name } = body;

    if (!amount_usd || amount_usd < 10) {
      return json({ error: "Minimum withdrawal is $10" }, 400);
    }

    if (!account_number || !bank_code || !account_name) {
      return json({ error: "account_number, bank_code, and account_name required" }, 400);
    }

    try {
      const user = await env.DB
        .prepare(`SELECT id FROM users WHERE clerk_id = ?`)
        .bind(auth.id)
        .first();

      if (!user) return json({ error: "User not found" }, 404);

      const wallet = await getWallet(user.id, env.DB);

      if (wallet.balance_usd < amount_usd) {
        return json({
          error: "Insufficient balance",
          balance_usd: wallet.balance_usd,
        }, 400);
      }

      const now = new Date().toISOString();
      const newBalance = wallet.balance_usd - amount_usd;

      // Deduct balance immediately before initiating transfer
      await env.DB
        .prepare(`
          UPDATE wallets
          SET balance_usd = ?,
              total_withdrawn_usd = total_withdrawn_usd + ?,
              updated_at = ?
          WHERE user_id = ?
        `)
        .bind(newBalance, amount_usd, now, user.id)
        .run();

      // Create Paystack transfer recipient then initiate transfer
      const payments = new PaymentService(env);
      const recipient = await payments.createTransferRecipient({
        name: account_name,
        account_number,
        bank_code,
      });

      const transfer = await payments.initiateWithdrawal({
        amount: amount_usd,
        recipientCode: recipient.recipient_code,
        userId: user.id,
      });

      const txReference = transfer.reference ?? `withdrawal_${user.id}_${Date.now()}`;

      await env.DB
        .prepare(`
          INSERT INTO wallet_transactions
            (id, wallet_id, user_id, type, amount_usd,
             balance_after_usd, reference, description, created_at)
          VALUES (?, ?, ?, 'withdrawal', ?, ?, ?, 'Withdrawal to bank account', ?)
        `)
        .bind(
          crypto.randomUUID(), wallet.id, user.id,
          amount_usd, newBalance, txReference, now
        )
        .run();

      const display = await buildBalanceDisplay(newBalance, wallet.currency_preference, env.DB);
      return json({
        success: true,
        reference: txReference,
        ...display,
      });
    } catch (err) {
      console.error("Wallet withdrawal error:", err);
      return json({ error: "Unable to process withdrawal. Please try again." }, 500);
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
