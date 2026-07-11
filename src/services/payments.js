// ============================================================
// AURUM Payment Service
// Wrapper around PaystackProvider.
// All payment logic goes through here — never call
// PaystackProvider directly from routes.
// ============================================================

import { PaystackProvider } from "./paystack.js";

export class PaymentService {
  constructor(env) {
    this.provider = new PaystackProvider(env.PAYSTACK_SECRET_KEY);
    this.PLATFORM_FEE_PERCENT = 0.05;
    this.currency = env.PAYSTACK_CURRENCY || "NGN";
    this.usdToNgnRate = parseFloat(env.USD_TO_NGN_RATE) || 1600;
  }

  /**
   * Converts a USD amount into whatever currency the Paystack
   * account is currently charging in. When USD becomes enabled
   * on the account, set PAYSTACK_CURRENCY=USD and this becomes
   * a no-op passthrough — no code changes needed anywhere else.
   */
  toChargeAmount(usdAmount) {
    if (this.currency === "USD") return usdAmount;
    return Math.round(usdAmount * this.usdToNgnRate * 100) / 100;
  }

  // ── Customers ───────────────────────────────────────────────

  async createCustomer({ email, firstName, lastName, userId }) {
    return this.provider.createCustomer({
      email,
      first_name: firstName,
      last_name: lastName,
      metadata: { aurum_user_id: userId },
    });
  }

  // ── Verification ────────────────────────────────────────────

  async verifyPayment(reference) {
    return this.provider.verifyTransaction(reference);
  }

  // ── Wallet ──────────────────────────────────────────────────

  async initializeWalletDeposit({ email, amount, userId, callbackUrl }) {
    const reference = `wallet_${userId}_${Date.now()}`;

    const result = await this.provider.initializeTransaction({
      email,
      amount: this.toChargeAmount(amount),
      currency: this.currency,
      callback_url: callbackUrl,
      metadata: {
        type: "wallet_deposit",
        user_id: userId,
        reference,
        usd_amount: amount,
      },
    });

    return {
      authorization_url: result.authorization_url,
      reference: result.reference || reference,
    };
  }

  async createTransferRecipient({ name, account_number, bank_code, currency = "NGN" }) {
    return this.provider.createTransferRecipient({
      name,
      account_number,
      bank_code,
      currency,
    });
  }

  async initiateWithdrawal({ amount, recipientCode, userId }) {
    return this.provider.transfer({
      amount,
      recipient: recipientCode,
      reason: `AURUM wallet withdrawal for user ${userId}`,
    });
  }

  // ── Subscriptions ────────────────────────────────────────────

  async initializeSubscriptionPayment({ email, amount, tier, userId, callbackUrl }) {
    const reference = `sub_${tier}_${userId}_${Date.now()}`;

    const result = await this.provider.initializeTransaction({
      email,
      amount: this.toChargeAmount(amount),
      currency: this.currency,
      callback_url: callbackUrl,
      metadata: {
        type: "subscription",
        tier,
        user_id: userId,
        reference,
        usd_amount: amount,
      },
    });

    return {
      authorization_url: result.authorization_url,
      reference: result.reference || reference,
      tier,
    };
  }

  // ── Challenges ────────────────────────────────────────────
	
	async initializeChallengePayment({ email, amount, challengeId, userId, callbackUrl }) {
    const reference = `challenge_${userId}_${challengeId}_${Date.now()}`;

    const result = await this.provider.initializeTransaction({
      email,
      amount: this.toChargeAmount(amount),
      currency: this.currency,
      callback_url: callbackUrl,
      metadata: {
        type: "challenge_entry",
        challenge_id: challengeId,
        user_id: userId,
        reference,
        usd_amount: amount,
      },
    });

    return {
      authorization_url: result.authorization_url,
      reference: result.reference || reference,
    };
  }

  async payoutWinner({ amount, recipientCode, challengeId }) {
    const fee    = parseFloat((amount * this.PLATFORM_FEE_PERCENT).toFixed(2));
    const payout = amount - fee;

    return this.provider.transfer({
      amount: payout,
      recipient: recipientCode,
      reason: `AURUM Challenge #${challengeId} winnings`,
    });
  }

  // ── Helpers ──────────────────────────────────────────────────

  calculateFee(amount) {
    return parseFloat((amount * this.PLATFORM_FEE_PERCENT).toFixed(2));
  }

  getSubscriptionPlans() {
    return {
      contender: "PLN_pro_contender",
      sovereign:  "PLN_sovereign",
    };
  }
}
