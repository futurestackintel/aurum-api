export class PaystackProvider {
  constructor(secretKey) {
    this.secretKey = secretKey;
    this.baseUrl = "https://api.paystack.co";
  }

  async request(method, path, body = null) {
    const options = {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/json",
      },
    };
    if (body) options.body = JSON.stringify(body);

    const res = await fetch(`${this.baseUrl}${path}`, options);
    const data = await res.json();

    if (!data.status) {
      throw new Error(data.message || "Paystack request failed");
    }
    return data.data;
  }

  async createCustomer({ email, first_name, last_name, metadata }) {
    return this.request("POST", "/customer", {
      email,
      first_name,
      last_name,
      metadata,
    });
  }

  async initializeTransaction({ email, amount, metadata, callback_url }) {
    return this.request("POST", "/transaction/initialize", {
      email,
      amount: Math.round(amount * 100),
      metadata,
      callback_url,
    });
  }

  async verifyTransaction(reference) {
    return this.request("GET", `/transaction/verify/${reference}`);
  }

  async createPlan({ name, amount, interval }) {
    return this.request("POST", "/plan", {
      name,
      amount: Math.round(amount * 100),
      interval,
    });
  }

  async createSubscription({ customer, plan, authorization }) {
    return this.request("POST", "/subscription", {
      customer,
      plan,
      authorization,
    });
  }

  async cancelSubscription({ code, token }) {
    return this.request("POST", "/subscription/disable", {
      code,
      token,
    });
  }

  async transfer({ amount, recipient, reason }) {
    return this.request("POST", "/transfer", {
      source: "balance",
      amount: Math.round(amount * 100),
      recipient,
      reason,
    });
  }

  async createTransferRecipient({ name, account_number, bank_code, currency = "NGN" }) {
    return this.request("POST", "/transferrecipient", {
      type: "nuban",
      name,
      account_number,
      bank_code,
      currency,
    });
  }
}