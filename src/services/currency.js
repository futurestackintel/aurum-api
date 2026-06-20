// ============================================================
// AURUM Currency Service
// Converts USD amounts to display currencies.
// USD is always the stored value — display only converts on read.
// Rates are seeded in DB and updated daily by cron.
// ============================================================

const SUPPORTED_CURRENCIES = ['USD', 'NGN', 'GHS', 'KES', 'ZAR'];

const CURRENCY_SYMBOLS = {
  USD: '$',
  NGN: '₦',
  GHS: 'GH₵',
  KES: 'KSh',
  ZAR: 'R',
};

// Fallback rates used if DB lookup fails
const FALLBACK_RATES = {
  USD: 1.0,
  NGN: 0.00065,
  GHS: 0.068,
  KES: 0.0077,
  ZAR: 0.055,
};

/**
 * Get exchange rates from DB.
 * Falls back to hardcoded rates if DB fails.
 */
async function getRates(db) {
  try {
    const { results } = await db
      .prepare(`SELECT currency, rate_to_usd FROM exchange_rates`)
      .all();

    if (!results || results.length === 0) return FALLBACK_RATES;

    const rates = {};
    for (const row of results) {
      rates[row.currency] = row.rate_to_usd;
    }
    return rates;
  } catch {
    return FALLBACK_RATES;
  }
}

/**
 * Convert a USD amount to the target currency.
 * rate_to_usd means: 1 unit of currency = X USD
 * So to go USD -> currency: divide USD by rate_to_usd
 */
export function convertFromUSD(amountUsd, currency, rates) {
  const rate = rates[currency] ?? FALLBACK_RATES[currency] ?? 1;
  if (currency === 'USD') return amountUsd;
  return amountUsd / rate;
}

/**
 * Get the symbol for a currency.
 */
export function getCurrencySymbol(currency) {
  return CURRENCY_SYMBOLS[currency] ?? '$';
}

/**
 * Format a USD amount as a display string in the target currency.
 * Always pass rates from getRates() to avoid redundant DB calls.
 *
 * Example: formatCurrency(10, 'NGN', rates) => '₦15,384.62'
 */
export function formatCurrency(amountUsd, currency, rates) {
  const converted = convertFromUSD(amountUsd, currency, rates);
  const symbol = getCurrencySymbol(currency);

  // Whole number currencies (NGN, KES) — no decimals
  // Decimal currencies (USD, GHS, ZAR) — 2 decimal places
  const noDecimals = ['NGN', 'KES'];
  const formatted = noDecimals.includes(currency)
    ? Math.round(converted).toLocaleString('en-US')
    : converted.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

  return `${symbol}${formatted}`;
}

/**
 * Fetch live rates from exchangerate-api and update the DB.
 * Called by the daily cron in index.js.
 * Uses the free tier — no API key required for base USD rates.
 */
export async function updateExchangeRates(db) {
  try {
    const res = await fetch(
      'https://open.er-api.com/v6/latest/USD'
    );

    if (!res.ok) {
      console.error('Exchange rate fetch failed:', res.status);
      return;
    }

    const data = await res.json();
    if (data.result !== 'success') {
      console.error('Exchange rate API error:', data['error-type']);
      return;
    }

    const now = new Date().toISOString();
    const targets = ['NGN', 'GHS', 'KES', 'ZAR'];

    for (const currency of targets) {
      const rateFromUsd = data.rates[currency];
      if (!rateFromUsd) continue;

      // API gives: 1 USD = X units of currency
      // We store: 1 unit = X USD (inverse)
      const rateToUsd = 1 / rateFromUsd;

      await db
        .prepare(`
          UPDATE exchange_rates
          SET rate_to_usd = ?, updated_at = ?
          WHERE currency = ?
        `)
        .bind(rateToUsd, now, currency)
        .run();
    }

    console.log('Exchange rates updated successfully');
  } catch (err) {
    console.error('Exchange rate update error:', err);
    // Non-fatal — fallback rates remain in DB
  }
}

/**
 * Get rates and format a balance for API responses.
 * Returns both raw USD and display string in user's preferred currency.
 */
export async function buildBalanceDisplay(amountUsd, currencyPreference, db) {
  const rates = await getRates(db);
  return {
    balance_usd: amountUsd,
    balance_display: formatCurrency(amountUsd, currencyPreference, rates),
    currency_preference: currencyPreference,
  };
}

export { SUPPORTED_CURRENCIES, getRates };
