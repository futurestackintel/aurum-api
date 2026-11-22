
const MAX_SAFE_MINOR_UNITS = BigInt(Number.MAX_SAFE_INTEGER);

export function validateCurrencyCode(currencyCode) {
  if (
    typeof currencyCode !== 'string' ||
    !/^[A-Z]{3}$/.test(currencyCode)
  ) {
    throw new Error('Invalid currency code');
  }

  return currencyCode;
}

export function validateMinorUnitExponent(exponent) {
  if (
    !Number.isInteger(exponent) ||
    exponent < 0 ||
    exponent > 3
  ) {
    throw new Error('Invalid currency minor-unit exponent');
  }

  return exponent;
}

export function assertSafeMinorUnits(amountMinor) {
  if (
    !Number.isSafeInteger(amountMinor) ||
    amountMinor < 0
  ) {
    throw new Error('Invalid minor-unit amount');
  }

  return amountMinor;
}

/**
 * Convert a decimal amount into integer minor units.
 *
 * Accepts decimal strings only to avoid floating-point precision loss.
 * Rejects excess decimal places instead of silently rounding.
 * Examples:
 * toMinorUnits('125.50', 2) => 12550
 * toMinorUnits('500', 0) => 500
 * toMinorUnits('12.345', 2) => error
 */
export function toMinorUnits(amount, exponent) {
  validateMinorUnitExponent(exponent);

    if (typeof amount !== 'string') {
    throw new Error('Amount must be provided as a decimal string');
  }
  const value = String(amount).trim();

  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(value)) {
    throw new Error('Invalid decimal amount');
  }

  const [whole, fraction = ''] = value.split('.');

  if (fraction.length > exponent) {
    throw new Error(
      'Amount contains more decimal places than the currency supports'
    );
  }

  const paddedFraction = fraction.padEnd(exponent, '0');

  const multiplier = 10n ** BigInt(exponent);

  const minorUnits =
    (BigInt(whole) * multiplier) +
    BigInt(paddedFraction || '0');

  if (minorUnits > MAX_SAFE_MINOR_UNITS) {
    throw new Error('Amount exceeds the supported safe integer range');
  }

  return Number(minorUnits);
}

/**
 * Convert integer minor units into an exact decimal string.
 *
 * Examples:
 * fromMinorUnits(12550, 2) => '125.50'
 * fromMinorUnits(500, 0) => '500'
 */
export function fromMinorUnits(amountMinor, exponent) {
  validateMinorUnitExponent(exponent);
  assertSafeMinorUnits(amountMinor);

  const value = BigInt(amountMinor);
  const divisor = 10n ** BigInt(exponent);

  const whole = value / divisor;

  if (exponent === 0) {
    return whole.toString();
  }

  const fraction = (value % divisor)
    .toString()
    .padStart(exponent, '0');

  return `${whole}.${fraction}`;
}

/**
 * Add minor-unit amounts without allowing unsafe integer overflow.
 */
export function addMinorUnits(...amounts) {
  let total = 0n;

  for (const amount of amounts) {
    assertSafeMinorUnits(amount);
    total += BigInt(amount);
  }

  if (total > MAX_SAFE_MINOR_UNITS) {
    throw new Error('Minor-unit addition exceeds safe integer range');
  }

  return Number(total);
}

/**
 * Subtract minor-unit amounts without allowing negative balances
 * or unsafe integer overflow.
 */
export function subtractMinorUnits(minuend, subtrahend) {
  assertSafeMinorUnits(minuend);
  assertSafeMinorUnits(subtrahend);

  if (subtrahend > minuend) {
    throw new Error('Insufficient minor-unit balance');
  }

  return minuend - subtrahend;
}

/**
 * Calculate a fee in minor units using basis points.
 * Rounds up so fractional minor units are never silently discarded.
 * 500 basis points = 5%.
 */
export function calculateFeeMinor(amountMinor, basisPoints) {
  assertSafeMinorUnits(amountMinor);

  if (
    !Number.isInteger(basisPoints) ||
    basisPoints < 0 ||
    basisPoints > 10000
  ) {
    throw new Error('Invalid fee basis points');
  }

  const fee =
    (BigInt(amountMinor) * BigInt(basisPoints) + 9999n) /
    10000n;

  if (fee > MAX_SAFE_MINOR_UNITS) {
    throw new Error('Calculated fee exceeds safe integer range');
  }

  return Number(fee);
}
