
import { requireAuth } from "../middleware/auth.js";
import { FinancialService } from "../services/financialService.js";
import { addScoreEvent } from "../services/aurumScore.js";
import { notificationEnabled } from "../services/notifications.js";
import { fromMinorUnits } from "../services/money.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function fingerprint(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

function validText(value) {
  return typeof value === "string" && value.trim().length > 0;
}
async function applyTipEffects(operation, db, requestId = null) {
  const eventId = `tip:${operation.id}`;
  const now = new Date().toISOString();

  await db
    .prepare(`
      INSERT OR IGNORE INTO domain_events (
        event_id,
        event_type,
        schema_version,
        occurred_at,
        actor_type,
        actor_id,
        resource_type,
        resource_id,
        request_id,
        payload_json
      )
      VALUES (?, 'tip.completed', 1, ?, 'member', ?, 'tip', ?, ?, ?)
    `)
    .bind(
      eventId,
      now,
      operation.sender_id,
      operation.id,
      requestId,
      JSON.stringify({
        tip_id: operation.id,
        sender_id: operation.sender_id,
        receiver_id: operation.receiver_id,
        post_id: operation.post_id,
        currency_code: operation.currency_code,
        amount_minor: operation.amount_minor,
      })
    )
    .run();

  await addScoreEvent(
    operation.sender_id,
    "tip_sent",
    null,
    {
      event_id: `tip-sent:${operation.id}`,
      tip_id: operation.id,
      post_id: operation.post_id,
      note: "Sent a wallet tip",
    },
    db
  );

  await addScoreEvent(
    operation.receiver_id,
    "tip_received_reaction",
    null,
    {
      event_id: `tip-received:${operation.id}`,
      tip_id: operation.id,
      post_id: operation.post_id,
      note: "Received a wallet tip",
    },
    db
  );

  const notificationsAllowed = await notificationEnabled(
    operation.receiver_id,
    "tips_received",
    db
  );

  if (!notificationsAllowed) return;

  const currency = await db
    .prepare(`
      SELECT minor_unit_exponent
      FROM financial_currencies
      WHERE currency_code = ?
        AND is_enabled = 1
    `)
    .bind(operation.currency_code)
    .first();

  if (!currency) {
    throw new Error("Tip currency configuration could not be loaded");
  }

  const amount = fromMinorUnits(
    operation.amount_minor,
    currency.minor_unit_exponent
  );

  await db
    .prepare(`
      INSERT OR IGNORE INTO notifications (
        id,
        user_id,
        type,
        title,
        body,
        action_url,
        metadata,
        source_event_id,
        created_at
      )
      VALUES (?, ?, 'tip_received', ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      crypto.randomUUID(),
      operation.receiver_id,
      "You received a tip",
      `${amount} ${operation.currency_code} was sent to your post.`,
      `/ledger`,
      JSON.stringify({
        tip_id: operation.id,
        post_id: operation.post_id,
        sender_id: operation.sender_id,
        currency_code: operation.currency_code,
        amount_minor: operation.amount_minor,
      }),
      eventId,
      now
    )
    .run();
}

export async function handleTipsRoutes(pathname, request, env) {
  if (pathname !== "/api/tips" || request.method !== "POST") {
    return null;
  }

  const auth = await requireAuth(request, env);

  if (auth.error) {
    return json({ error: auth.error }, auth.status || 401);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON request body" }, 400);
  }

  const {
    post_id,
    receiver_id,
    currency_code,
    amount_minor,
  } = body ?? {};

  if (
    !validText(post_id) ||
    !validText(receiver_id) ||
    !validText(currency_code) ||
    !Number.isSafeInteger(amount_minor) ||
    amount_minor <= 0
  ) {
    return json({
      error: "post_id, receiver_id, currency_code, and a positive integer amount_minor are required",
    }, 400);
  }

  const idempotencyKey = request.headers.get("Idempotency-Key");

  if (
    !validText(idempotencyKey) ||
    idempotencyKey.length > 128
  ) {
    return json({
      error: "A valid Idempotency-Key header is required",
    }, 400);
  }

  const normalizedCurrency = currency_code.trim().toUpperCase();

  if (!/^[A-Z]{3}$/.test(normalizedCurrency)) {
    return json({ error: "Invalid currency code" }, 400);
  }

  try {
    const sender = await env.DB
      .prepare(`
        SELECT id
        FROM users
        WHERE clerk_id = ?
      `)
      .bind(auth.id)
      .first();

    if (!sender) {
      return json({ error: "Sender not found" }, 404);
    }

    if (sender.id === receiver_id) {
      return json({
        error: "You cannot tip your own post",
      }, 400);
    }

    const receiver = await env.DB
      .prepare(`
        SELECT id
        FROM users
        WHERE id = ?
      `)
      .bind(receiver_id)
      .first();

    if (!receiver) {
      return json({ error: "Receiver not found" }, 404);
    }

    const post = await env.DB
      .prepare(`
        SELECT id, user_id
        FROM posts
        WHERE id = ?
          AND deleted_at IS NULL
      `)
      .bind(post_id)
      .first();

    if (!post) {
      return json({ error: "Post not found" }, 404);
    }

    if (post.user_id !== receiver_id) {
      return json({
        error: "Post does not belong to receiver",
      }, 400);
    }

    const requestFingerprint = await fingerprint({
      sender_id: sender.id,
      receiver_id,
      post_id,
      currency_code: normalizedCurrency,
      amount_minor,
    });

    let operation = await env.DB
      .prepare(`
        SELECT *
        FROM financial_tip_operations
        WHERE sender_id = ?
          AND idempotency_key = ?
      `)
      .bind(sender.id, idempotencyKey)
      .first();

    if (operation) {
      if (operation.request_fingerprint !== requestFingerprint) {
        return json({
          error: "Idempotency key was already used for a different tip request",
        }, 409);
      }

      if (operation.status === "completed") {
				await applyTipEffects(operation, env.DB, request.headers.get("cf-ray"));
        return json({
          success: true,
          tip_id: operation.id,
          ledger_transaction_id: operation.ledger_transaction_id,
          status: operation.status,
          already_completed: true,
          currency_code: operation.currency_code,
          amount_minor: operation.amount_minor,
        });
      }
    } else {
      const tipId = crypto.randomUUID();

      try {
        await env.DB
          .prepare(`
            INSERT INTO financial_tip_operations (
              id,
              sender_id,
              receiver_id,
              post_id,
              currency_code,
              amount_minor,
              idempotency_key,
              request_fingerprint,
              status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
          `)
          .bind(
            tipId,
            sender.id,
            receiver_id,
            post_id,
            normalizedCurrency,
            amount_minor,
            idempotencyKey,
            requestFingerprint
          )
          .run();
      } catch (insertError) {
        // A concurrent retry may have inserted this operation first.
        operation = await env.DB
          .prepare(`
            SELECT *
            FROM financial_tip_operations
            WHERE sender_id = ?
              AND idempotency_key = ?
          `)
          .bind(sender.id, idempotencyKey)
          .first();

        if (!operation) {
          throw insertError;
        }

        if (operation.request_fingerprint !== requestFingerprint) {
          return json({
            error: "Idempotency key was already used for a different tip request",
          }, 409);
        }

                if (operation.status === "completed") {
          await applyTipEffects(
            operation,
            env.DB,
            request.headers.get("cf-ray")
          );

          return json({
            success: true,
            tip_id: operation.id,
            ledger_transaction_id: operation.ledger_transaction_id,
            status: operation.status,
            already_completed: true,
            currency_code: operation.currency_code,
            amount_minor: operation.amount_minor,
          });
        }


      }

      if (!operation) {
        operation = await env.DB
          .prepare(`
            SELECT *
            FROM financial_tip_operations
            WHERE id = ?
          `)
          .bind(tipId)
          .first();
      }
    }
      
    
    if (!operation) {
      throw new Error("Tip operation could not be loaded");
    }

    const financial = new FinancialService(env.DB);

    const transfer = await financial.transferBetweenUsers({
      senderUserId: sender.id,
      recipientUserId: receiver_id,
      actorUserId: sender.id,
      currencyCode: normalizedCurrency,
      amountMinor: amount_minor,
      idempotencyKey: `tip:${sender.id}:${idempotencyKey}`,
      requestId: request.headers.get("cf-ray"),
      description: "AURUM post tip",
      reference: operation.id,
      metadata: {
        tip_id: operation.id,
        post_id,
        receiver_id,
      },
    });

    if (
      !transfer.transaction ||
      transfer.transaction.status !== "posted"
    ) {
      throw new Error("Tip ledger transaction was not posted");
    }

    const completedAt = new Date().toISOString();

    await env.DB
      .prepare(`
        UPDATE financial_tip_operations
        SET
          ledger_transaction_id = ?,
          status = 'completed',
          completed_at = ?
        WHERE id = ?
          AND status = 'pending'
      `)
      .bind(
        transfer.transaction.id,
        completedAt,
        operation.id
      )
      .run();

    const completedOperation = await env.DB
      .prepare(`
        SELECT *
        FROM financial_tip_operations
        WHERE id = ?
      `)
      .bind(operation.id)
      .first();

    if (!completedOperation || completedOperation.status !== "completed") {
      throw new Error("Tip completion could not be confirmed");
    }

		  await applyTipEffects(
      completedOperation,
      env.DB,
      request.headers.get("cf-ray")
    );

    return json({
      success: true,
      tip_id: completedOperation.id,
      ledger_transaction_id: completedOperation.ledger_transaction_id,
      status: completedOperation.status,
      already_completed: !transfer.created,
      currency_code: completedOperation.currency_code,
      amount_minor: completedOperation.amount_minor,
    });
  } catch (error) {
    console.error("Financial tip error:", error);

    return json({
      error: "Unable to complete tip. Retry using the same Idempotency-Key.",
    }, 500);
  }
}
