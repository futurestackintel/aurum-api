/**
 * Legacy Challenge payment routes.
 *
 * Financial operations now use the internal ledger through
 * ChallengeFinancialService. These endpoints are retired to
 * prevent bypassing ledger accounting.
 */

export async function handleChallengePaymentRoutes(
  pathname,
  request,
  env
) {
  const legacyMatch = pathname.match(
    /^\/challenges\/(\d+)\/(fund|verify|payout)$/
  );

  if (!legacyMatch) return null;

  if (!['POST'].includes(request.method)) {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      {
        status: 405,
        headers: {
          'Content-Type': 'application/json',
          'Allow': 'POST',
        },
      }
    );
  }

  return new Response(
    JSON.stringify({
      error: 'This payment endpoint has been retired.',
      code: 'LEGACY_CHALLENGE_PAYMENT_DISABLED',
      message: 'Use the current Challenge entry and settlement system.',
    }),
    {
      status: 410,
      headers: {
        'Content-Type': 'application/json',
      },
    }
  );
}
