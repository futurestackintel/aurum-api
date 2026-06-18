import { PaystackProvider } from "./paystack.js";

export class PaymentService {
  constructor(env) {
    this.provider = new PaystackProvider(env.PAYSTACK_SECRET_KEY);
    this.PLATFORM_FEE_PERCENT = 0.05;
  }

  async createCustomer({ email, firstName, lastName, userId }) {
    return this.provider.createCustomer({
      email,
      first_name: firstName,
      last_name: lastName,
      metadata: { aurum_user_id: userId },
    });
  }

  async initializeTip({ senderEmail, amount, postId, senderId, receiverId, callbackUrl }) {
    const fee = parseFloat((amount * this.PLATFORM_FEE_PERCENT).toFixed(2));
    const reference = `tip_${senderId}_${postId}_${Date.now()}`;

    const result = await this.provider.initializeTransaction({
      email: senderEmail,
      amount,
      callback_url: callbackUrl,
      metadata: {
        type: "tip",
        post_id: postId,
        sender_id: senderId,
        receiver_id: receiverId,
        platform_fee: fee,
        reference,
      },
    });

    return {
      authorization_url: result.authorization_url,
      reference: result.reference || reference,
      fee,
      net_amount: amount - fee,
    };
  }

  async verifyPayment(reference) {
    return this.provider.verifyTransaction(reference);
  }

  async initializeChallengePayment({ email, amount, challengeId, userId, callbackUrl }) {
    const reference = `challenge_${userId}_${challengeId}_${Date.now()}`;

    const result = await this.provider.initializeTransaction({
      email,
      amount,
      callback_url: callbackUrl,
      metadata: {
        type: "challenge_entry",
        challenge_id: challengeId,
        user_id: userId,
        reference,
      },
    });

    return {
      authorization_url: result.authorization_url,
      reference: result.reference || reference,
    };
  }

  async initializeSubscriptionPayment({ email, amount, tier, userId, callbackUrl }) {
    const reference = `sub_${tier}_${userId}_${Date.now()}`;

    const result = await this.provider.initializeTransaction({
      email,
      amount,
      callback_url: callbackUrl,
      metadata: {
        type: "subscription",
        tier,
        user_id: userId,
        reference,
      },
    });

    return {
      authorization_url: result.authorization_url,
      reference: result.reference || reference,
      tier,
    };
  }

  async payoutWinner({ amount, recipientCode, challengeId }) {
    const fee = parseFloat((amount * this.PLATFORM_FEE_PERCENT).toFixed(2));
    const payout = amount - fee;

    return this.provider.transfer({
      amount: payout,
      recipient: recipientCode,
      reason: `AURUM Challenge #${challengeId} winnings`,
    });
  }

  getSubscriptionPlans() {
    return {
      contender: "PLN_pro_contender",
      sovereign: "PLN_sovereign",
    };
  }
}
