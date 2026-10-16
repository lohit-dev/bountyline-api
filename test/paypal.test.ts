import { describe, expect, test } from "bun:test";
import { PayPalClient } from "../src/adapters/paypal";

type Call = { method: string; url: string; body: any; headers: Record<string, string> };
function client(handler: (c: Call) => { status?: number; json?: unknown }) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    const c: Call = { method: init.method ?? "GET", url: url.replace("https://api-m.sandbox.paypal.com", ""), body: init.body && typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : init.body, headers: init.headers as any };
    calls.push(c);
    if (c.url === "/v1/oauth2/token") return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
    const r = handler(c);
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  };
  return { pp: new PayPalClient({ clientId: "id", secret: "sec", env: "sandbox", fetch }), calls };
}

describe("PayPalClient", () => {
  test("creates an order with decimal amount, request id and the payer-action link", async () => {
    const { pp, calls } = client(() => ({ status: 200, json: { id: "O1", links: [{ rel: "self", href: "x" }, { rel: "payer-action", href: "https://paypal.test/pay" }] } }));
    const r = await pp.createOrder({ amountCents: 15050, referenceId: "b1", requestId: "order-b1", returnUrl: "https://r", cancelUrl: "https://c" });
    expect(r).toEqual({ orderId: "O1", approveUrl: "https://paypal.test/pay" });
    const c = calls.find((x) => x.url === "/v2/checkout/orders")!;
    expect(c.body.purchase_units[0].amount).toEqual({ currency_code: "USD", value: "150.50" });
    expect(c.headers["paypal-request-id"]).toBe("order-b1");
    expect(c.headers.authorization).toBe("Bearer tok");
  });
  test("the access token is reused", async () => {
    const { pp, calls } = client(() => ({ json: { id: "R1" } }));
    await pp.refundCapture("C1", "refund-1");
    await pp.refundCapture("C1", "refund-1");
    expect(calls.filter((c) => c.url === "/v1/oauth2/token").length).toBe(1);
  });
  test("capture reads the capture id and amount", async () => {
    const { pp } = client(() => ({ json: { purchase_units: [{ payments: { captures: [{ id: "CAP1", status: "COMPLETED", amount: { value: "150.00" } }] } }] } }));
    expect(await pp.captureOrder("O1", "capture-O1")).toEqual({ captureId: "CAP1", completed: true, amountCents: 15000 });
  });
  test("an already captured order is read back instead of failing", async () => {
    const order = { purchase_units: [{ payments: { captures: [{ id: "CAP1", status: "COMPLETED", amount: { value: "50.00" } }] } }] };
    const { pp } = client((c) => (c.method === "POST" ? { status: 422, json: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] } } : { json: order }));
    expect((await pp.captureOrder("O1", "r")).captureId).toBe("CAP1");
  });
  test("other capture errors throw", async () => {
    const { pp } = client(() => ({ status: 422, json: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }] } }));
    await expect(pp.captureOrder("O1", "r")).rejects.toThrow("INSTRUMENT_DECLINED");
  });
  test("refund of an already refunded capture counts as done", async () => {
    const { pp } = client(() => ({ status: 422, json: { details: [{ issue: "CAPTURE_FULLY_REFUNDED" }] } }));
    expect((await pp.refundCapture("C1", "r")).refundId).toBe("already-refunded");
  });
  test("payout sends one email item with the idempotent batch id", async () => {
    const { pp, calls } = client(() => ({ status: 201, json: { batch_header: { payout_batch_id: "B1" } } }));
    const r = await pp.sendPayout({ senderBatchId: "payout-b1", itemId: "p1", email: "mira@example.com", amountCents: 15000, note: "n", requestId: "payout-b1" });
    expect(r.batchId).toBe("B1");
    const c = calls.find((x) => x.url === "/v1/payments/payouts")!;
    expect(c.body.sender_batch_header.sender_batch_id).toBe("payout-b1");
    expect(c.body.items[0]).toMatchObject({ receiver: "mira@example.com", amount: { value: "150.00", currency: "USD" } });
    expect(c.headers["paypal-request-id"]).toBe("payout-b1");
  });
  test("batch status mapping", async () => {
    const status = async (batch: string, item?: string) =>
      (await client(() => ({ json: { batch_header: { batch_status: batch }, items: item ? [{ transaction_status: item }] : [] } })).pp.getPayoutBatch("B1")).status;
    expect(await status("PROCESSING")).toBe("pending");
    expect(await status("SUCCESS", "SUCCESS")).toBe("success");
    expect(await status("SUCCESS", "UNCLAIMED")).toBe("failed");
    expect(await status("DENIED")).toBe("failed");
  });
});
