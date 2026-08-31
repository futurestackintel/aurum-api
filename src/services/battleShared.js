// ============================================================
// BATTLE SHARED — pure helper logic shared by duel.js and
// crewBattles.js. Deliberately holds only fee/deadline math, not
// any DB writes — duels and crew battles credit different tables
// (wallets vs crew_wallets, tips vs per-member score events), so
// forcing those into one shared function would hurt readability
// for no real DRY gain.
// ============================================================

export const DISPUTE_WINDOW_HOURS = 4.5;
export const PLATFORM_FEE_RATE = 0.05; // 5%, matches existing duel payouts

export function calcDisputeDeadline() {
  return new Date(Date.now() + DISPUTE_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
}

// Returns { platformFee, netPayout } for a given pot, rounded to cents.
export function calcNetPayout(totalPot, feeRate = PLATFORM_FEE_RATE) {
  const platformFee = Math.round(totalPot * feeRate * 100) / 100;
  const netPayout = totalPot - platformFee;
  return { platformFee, netPayout };
}
