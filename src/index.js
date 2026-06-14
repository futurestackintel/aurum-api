import { handleWebhookRoutes } from "./routes/webhook.js";
import { handleAuthRoutes }             from "./routes/auth.js";
import { handleTipsRoutes }             from "./routes/tips.js";
import { handleSubscriptionRoutes }     from "./routes/subscriptions.js";
import { handleChallengePaymentRoutes } from "./routes/challenges.js";
import { handleLeagueRoutes }           from "./routes/league.js";
import { handleBadgeRoutes }            from "./routes/badge.js";
import { handlePostRoutes }             from "./routes/posts.js";
import { handleChallengeRoutes }        from "./routes/dropCircle.js";
import { handleDuelRoutes }             from "./routes/duel.js";
import { handleAdminRoutes }            from "./routes/admin.js";
import { runLeaderboardSnapshot }       from "./services/leaderboardCron.js";

const ALLOWED_ORIGINS = [
  "https://tryaurum.store",
  "https://www.tryaurum.store",
  "https://aurum-frontend.pages.dev",  // keep during transition
];

function getCorsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = ALLOWED_ORIGINS.includes(origin)
    ? origin
    : ALLOWED_ORIGINS[0];

  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: getCorsHeaders(request) });
    }

    const url      = new URL(request.url);
    const pathname = url.pathname;

    try {
      let response =
        (await handleWebhookRoutes(pathname, request, env))                    ||
        (await handleAuthRoutes(pathname, request, env))                       ||
        (await handleTipsRoutes(pathname, request, env))                       ||
        (await handleSubscriptionRoutes(pathname, request, env))               ||
        (await handleChallengePaymentRoutes(pathname, request, env))           ||
        (await handleLeagueRoutes(pathname, request.method, request, env))     ||
        (await handleBadgeRoutes(pathname, request.method, request, env))      ||
        (await handlePostRoutes(pathname, request.method, request, env))       ||
        (await handleChallengeRoutes(pathname, request.method, request, env))  ||
        (await handleDuelRoutes(pathname, request.method, request, env))       ||
        (await handleAdminRoutes(pathname, request.method, request, env));

      if (!response) {
        response = new Response(
          JSON.stringify({ error: "Route not found" }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
      }

      const newHeaders = new Headers(response.headers);
Object.entries(getCorsHeaders(request)).forEach(([k, v]) => newHeaders.set(k, v));

return new Response(response.body, {
  status:  response.status,
  headers: newHeaders,
});
    } catch (err) {
      console.error("Worker error:", err);
      return new Response(
        JSON.stringify({ error: "Internal server error" }),
        {
          status:  500,
          headers: { ...getCorsHeaders(request), "Content-Type": "application/json" },
        }
      );
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runLeaderboardSnapshot(env));
  },
};