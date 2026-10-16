/** Hono router. All behaviour lives in handlers.ts; this only maps URLs to it. */
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Api } from "./handlers";

export function createApp(api: Api, dashboardUrl: string) {
  const app = new Hono();

  app.use("/api/*", cors({ origin: dashboardUrl, allowHeaders: ["authorization", "content-type"], allowMethods: ["GET", "POST", "PUT", "OPTIONS"] }));

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.post("/webhooks/github", (c) => api.webhook(c.req.raw));

  app.get("/auth/login", (c) => api.login(c.req.raw));
  app.get("/auth/callback", (c) => api.callback(c.req.raw));
  app.post("/auth/logout", () => api.logout());

  app.get("/fund/:token", (c) => api.fund(c.req.raw, c.req.param("token")));
  app.get("/paypal/return", (c) => api.paypalReturn(c.req.raw));

  app.get("/api/me", (c) => api.me(c.req.raw));
  app.get("/api/bounties", (c) => api.bounties(c.req.raw));
  app.get("/api/activity", (c) => api.activity(c.req.raw));
  app.get("/api/bounties/:id", (c) => api.bounty(c.req.raw, c.req.param("id")));
  app.post("/api/bounties/:id/approve", (c) => api.decision(c.req.raw, c.req.param("id"), "approve"));
  app.post("/api/bounties/:id/veto", (c) => api.decision(c.req.raw, c.req.param("id"), "veto"));
  app.put("/api/payout-account", (c) => api.putPayout(c.req.raw));

  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    console.error("unhandled error", err);
    return c.json({ error: "internal error" }, 500);
  });
  return app;
}
