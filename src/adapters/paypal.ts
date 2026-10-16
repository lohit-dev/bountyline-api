/**
 * PayPal REST client using plain fetch.
 * VERIFY in the PayPal sandbox: written from the docs, not run against PayPal.
 * Things most likely to need adjusting: the payer-action link, ORDER_ALREADY_CAPTURED
 * handling, and what a duplicate payout batch returns.
 */
import { centsToDecimal, decimalToCents } from "../core/rules";
import type { PayPalPort } from "../ports";

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export class PayPalError extends Error {
  constructor(public status: number, public name_: string, message: string) {
    super(message);
  }
}

export class PayPalClient implements PayPalPort {
  private token: { value: string; expires: number } | null = null;
  private fetchFn: FetchFn;
  constructor(private opts: { clientId: string; secret: string; env: "sandbox" | "live"; fetch?: FetchFn; now?: () => number }) {
    this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
  }
  private get base() {
    return this.opts.env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  }
  private now() {
    return (this.opts.now ?? Date.now)();
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires - 60_000 > this.now()) return this.token.value;
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.secret}`).toString("base64");
    const res = await this.fetchFn(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new PayPalError(res.status, "AUTH", `PayPal auth failed: ${res.status}`);
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: data.access_token, expires: this.now() + data.expires_in * 1000 };
    return data.access_token;
  }

  private async call(method: string, path: string, body?: unknown, requestId?: string): Promise<{ status: number; ok: boolean; json: any }> {
    const token = await this.accessToken();
    const res = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(requestId ? { "paypal-request-id": requestId } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, json };
  }

  private fail(r: { status: number; json: any }, what: string): never {
    const name = r.json?.name ?? "UNKNOWN";
    const detail = r.json?.details?.[0]?.issue ?? r.json?.message ?? "";
    throw new PayPalError(r.status, name, `PayPal ${what} failed: ${r.status} ${name} ${detail}`.trim());
  }

  async createOrder(i: { amountCents: number; referenceId: string; requestId: string; returnUrl: string; cancelUrl: string }) {
    const r = await this.call(
      "POST",
      "/v2/checkout/orders",
      {
        intent: "CAPTURE",
        purchase_units: [{ reference_id: i.referenceId, amount: { currency_code: "USD", value: centsToDecimal(i.amountCents) } }],
        payment_source: {
          paypal: {
            experience_context: { return_url: i.returnUrl, cancel_url: i.cancelUrl, user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING", brand_name: "Bountyline" },
          },
        },
      },
      i.requestId,
    );
    if (!r.ok) this.fail(r, "create order");
    const links: { rel: string; href: string }[] = r.json.links ?? [];
    const approve = links.find((l) => l.rel === "payer-action") ?? links.find((l) => l.rel === "approve");
    if (!approve) throw new PayPalError(502, "NO_APPROVE_LINK", "PayPal did not return an approval link");
    return { orderId: r.json.id as string, approveUrl: approve.href };
  }

  private readCapture(order: any) {
    const cap = order?.purchase_units?.[0]?.payments?.captures?.[0];
    if (!cap) throw new PayPalError(502, "NO_CAPTURE", "PayPal order has no capture");
    return { captureId: cap.id as string, completed: cap.status === "COMPLETED", amountCents: decimalToCents(cap.amount?.value ?? "0") };
  }

  async captureOrder(orderId: string, requestId: string) {
    const r = await this.call("POST", `/v2/checkout/orders/${orderId}/capture`, undefined, requestId);
    if (r.ok) return this.readCapture(r.json);
    const issue = r.json?.details?.[0]?.issue;
    if (r.status === 422 && issue === "ORDER_ALREADY_CAPTURED") {
      const again = await this.call("GET", `/v2/checkout/orders/${orderId}`);
      if (again.ok) return this.readCapture(again.json);
    }
    this.fail(r, "capture");
  }

  async refundCapture(captureId: string, requestId: string) {
    const r = await this.call("POST", `/v2/payments/captures/${captureId}/refund`, {}, requestId);
    if (r.ok) return { refundId: r.json.id as string };
    // Already fully refunded: treat as success so retries finish.
    if (r.status === 422 && r.json?.details?.[0]?.issue === "CAPTURE_FULLY_REFUNDED") return { refundId: "already-refunded" };
    this.fail(r, "refund");
  }

  async sendPayout(i: { senderBatchId: string; itemId: string; email: string; amountCents: number; note: string; requestId: string }) {
    const r = await this.call(
      "POST",
      "/v1/payments/payouts",
      {
        sender_batch_header: { sender_batch_id: i.senderBatchId, email_subject: "You earned a Bountyline bounty", email_message: i.note },
        items: [{ recipient_type: "EMAIL", receiver: i.email, amount: { value: centsToDecimal(i.amountCents), currency: "USD" }, note: i.note, sender_item_id: i.itemId }],
      },
      i.requestId,
    );
    if (!r.ok) this.fail(r, "payout");
    return { batchId: r.json.batch_header.payout_batch_id as string };
  }

  async getPayoutBatch(batchId: string): Promise<{ status: "pending" | "success" | "failed"; detail?: string }> {
    const r = await this.call("GET", `/v1/payments/payouts/${batchId}`);
    if (!r.ok) this.fail(r, "payout status");
    const batch = r.json.batch_header?.batch_status as string | undefined;
    const item = r.json.items?.[0]?.transaction_status as string | undefined;
    if (item && ["FAILED", "BLOCKED", "RETURNED", "REFUNDED", "REVERSED", "UNCLAIMED"].includes(item)) return { status: "failed", detail: item };
    if (batch === "DENIED" || batch === "CANCELED") return { status: "failed", detail: batch };
    if (batch === "SUCCESS" && (!item || item === "SUCCESS")) return { status: "success" };
    return { status: "pending" };
  }
}
