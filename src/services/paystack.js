// ============================================================
// AURUM Paystack Provider
// FIX: request() previously called res.json() directly, which
// throws a generic "Unexpected end of JSON input" whenever
// Paystack returns an empty or non-JSON body — giving zero
// diagnostic information about WHY the call failed (bad key,
// wrong mode, malformed request, etc). Now reads the raw text
// first, tries to parse it, and if that fails or the response
// isn't ok, throws an error that includes the real HTTP status
// and the raw response body so wrangler tail actually shows you
// something useful.
// ============================================================

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
    const rawText = await res.text();

    let data;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch (parseErr) {
      // Paystack returned something that isn't valid JSON at all —
      // surface the actual status and raw body instead of a bare
      // "Unexpected end of JSON input".
      throw new Error(
        `Paystack returned a non-JSON response (HTTP ${res.status} ${res.statusText}). ` +
        `Raw body: ${rawText ? rawText.slice(0, 500) : '(empty)'}`
      );
    }

    if (!data) {
      throw new Error(
        `Paystack returned an empty response body (HTTP ${res.status} ${res.statusText}). ` +
        `This usually means an invalid/wrong-mode secret key, or the request was rejected ` +
        `before Paystack processed it. Check that PAYSTACK_SECRET_KEY is a valid live key ` +
        `matching your Paystack dashboard, and that it wasn't swapped with PAYSTACK_PUBLIC_KEY.`
      );
    }

    if (!data.status) {
      throw new Error(
        `Paystack request failed (HTTP ${res.status}): ${data.message || 'Unknown error'}`
      );
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
