/**
 * HTTP handlers as plain Request -> Response functions (testable without a server).
 * src/http/app.ts mounts them on Hono.
 */
import { signToken, verifyToken } from "../core/crypto";
import { verifyWebhookSignature } from "../adapters/github";
import type { Deps } from "../services/context";
import { decide, getBountyDetail, listActivity, getPayoutAddress, listBounties, setPayoutAddress, type Viewer } from "../services/dashboard";
import { completeFunding, FundingError, startFunding } from "../services/funding";

export type HttpConfig = {
  webhookSecret: string;
  sessionSecret: string;
  githubOAuth: { clientId: string; clientSecret: string };
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
};

const COOKIE = "bl_session";
const SESSION_SECONDS = 7 * 24 * 3600;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const redirect = (url: string, headers: Record<string, string> = {}) => new Response(null, { status: 302, headers: { location: url, ...headers } });

function page(title: string, bodyHtml: string, status = 200) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1b1f23}h1{font-size:1.4rem}a{color:#0b6e4f}</style></head>
<body><h1>${esc(title)}</h1>${bodyHtml}</body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

/** Only same-site relative paths are allowed as a post-login destination. */
const safeNext = (n: string | null) => (n && n.startsWith("/") && !n.startsWith("//") && !n.includes("\\") ? n : null);

export class Api {
  constructor(private d: Deps, private cfg: HttpConfig) {}

  private get secure() {
    return this.d.config.apiUrl.startsWith("https://");
  }
  private f(url: string, init?: RequestInit) {
    return (this.cfg.fetch ?? ((u, i) => fetch(u, i)))(url, init);
  }

  /* ------------------------------ session ------------------------------ */

  viewer(req: Request): Viewer | null {
    const auth = req.headers.get("authorization");
    let token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) {
      const cookie = req.headers.get("cookie") ?? "";
      token = cookie.split(/;\s*/).map((c) => c.split("=")).find(([k]) => k === COOKIE)?.[1] ?? null;
    }
    const data = verifyToken<{ k: string; uid: number; login: string }>(this.cfg.sessionSecret, token, this.d.clock.now());
    return data && data.k === "session" ? { id: data.uid, login: data.login } : null;
  }

  private sessionToken(v: Viewer) {
    return signToken(this.cfg.sessionSecret, { k: "session", uid: v.id, login: v.login }, SESSION_SECONDS, this.d.clock.now());
  }
  private cookie(token: string, maxAge = SESSION_SECONDS) {
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.secure ? "; Secure" : ""}`;
  }

  /* ------------------------------- OAuth ------------------------------- */

  login(req: Request): Response {
    const q = new URL(req.url).searchParams;
    const to = q.get("to") === "dashboard" ? "dashboard" : (safeNext(q.get("next")) ?? "dashboard");
    const state = signToken(this.cfg.sessionSecret, { k: "oauth", next: to }, 600, this.d.clock.now());
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", this.cfg.githubOAuth.clientId);
    url.searchParams.set("redirect_uri", `${this.d.config.apiUrl}/auth/callback`);
    url.searchParams.set("state", state);
    return redirect(url.toString());
  }

  async callback(req: Request): Promise<Response> {
    const q = new URL(req.url).searchParams;
    const state = verifyToken<{ k: string; next: string }>(this.cfg.sessionSecret, q.get("state"), this.d.clock.now());
    const code = q.get("code");
    if (!state || state.k !== "oauth" || !code) return page("Sign-in failed", "<p>The sign-in link expired. Please try again.</p>", 400);

    const tokenRes = await this.f("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: this.cfg.githubOAuth.clientId, client_secret: this.cfg.githubOAuth.clientSecret, code, redirect_uri: `${this.d.config.apiUrl}/auth/callback` }),
    });
    const tokenData = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
    if (!tokenRes.ok || !tokenData.access_token) return page("Sign-in failed", "<p>GitHub did not accept the sign-in. Please try again.</p>", 400);

    const userRes = await this.f("https://api.github.com/user", { headers: { authorization: `Bearer ${tokenData.access_token}`, accept: "application/vnd.github+json", "user-agent": "bountyline" } });
    const user = (await userRes.json().catch(() => ({}))) as { id?: number; login?: string };
    if (!userRes.ok || !user.id || !user.login) return page("Sign-in failed", "<p>Could not read your GitHub profile.</p>", 400);

    // The GitHub token is not kept: we only need to know who you are.
    const token = this.sessionToken({ id: user.id, login: user.login });
    if (state.next === "dashboard") return redirect(`${this.d.config.dashboardUrl}/#token=${token}`, { "set-cookie": this.cookie(token) });
    return redirect(`${this.d.config.apiUrl}${safeNext(state.next) ?? "/"}`, { "set-cookie": this.cookie(token) });
  }

  logout(): Response {
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "set-cookie": this.cookie("", 0) } });
  }

  /* ------------------------------ webhooks ------------------------------ */

  async webhook(req: Request): Promise<Response> {
    const raw = await req.text();
    if (!verifyWebhookSignature(this.cfg.webhookSecret, raw, req.headers.get("x-hub-signature-256"))) return json({ error: "bad signature" }, 401);
    const event = req.headers.get("x-github-event") ?? "";
    const delivery = req.headers.get("x-github-delivery") ?? "";
    if (event === "ping") return json({ ok: true });
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: "bad json" }, 400);
    }
    // Work happens in the job queue: GitHub gets a fast answer, and failures are retried.
    const key = delivery ? `webhook:${delivery}` : `webhook:${event}:${this.d.newId()}`;
    await this.d.store.enqueue({ kind: "webhook", key, payload: { event, body }, runAt: this.d.clock.now() });
    return json({ queued: true }, 202);
  }

  /* ------------------------------ funding ------------------------------ */

  private needLogin(req: Request): Response {
    const u = new URL(req.url);
    return redirect(`${this.d.config.apiUrl}/auth/login?next=${encodeURIComponent(u.pathname + u.search)}`);
  }

  private fundingError(err: unknown, token: string): Response {
    if (err instanceof FundingError) {
      const extra = err.code === "forbidden" ? `<p><a href="${esc(this.d.config.apiUrl)}/auth/login?next=${encodeURIComponent(`/fund/${token}`)}">Sign in with a different account</a></p>` : "";
      return page("Funding", `<p>${esc(err.message)}</p>${extra}`, err.code === "not_found" ? 404 : 400);
    }
    this.d.log("funding failed", err);
    return page("Funding", "<p>Something went wrong. Nothing was charged twice. Please try again in a minute.</p>", 500);
  }

  async fund(req: Request, token: string): Promise<Response> {
    const v = this.viewer(req);
    if (!v) return this.needLogin(req);
    try {
      const { approveUrl } = await startFunding(this.d, token, v);
      return redirect(approveUrl);
    } catch (err) {
      return this.fundingError(err, token);
    }
  }

  async paypalReturn(req: Request): Promise<Response> {
    const v = this.viewer(req);
    if (!v) return this.needLogin(req);
    const q = new URL(req.url).searchParams;
    const bountyToken = q.get("b") ?? "";
    const orderId = q.get("token") ?? ""; // PayPal puts the order id in `token`
    try {
      const b = await completeFunding(this.d, bountyToken, orderId, v);
      const repo = await this.d.store.getRepo(b.repoId);
      const issue = repo ? `https://github.com/${repo.owner}/${repo.name}/issues/${b.issueNumber}` : "#";
      return page("Bounty funded", `<p>Thank you. The bounty is live on the issue.</p><p><a href="${esc(issue)}">Back to the issue</a> · <a href="${esc(this.d.config.dashboardUrl)}">Dashboard</a></p>`);
    } catch (err) {
      return this.fundingError(err, bountyToken);
    }
  }

  /* ------------------------------ JSON API ------------------------------ */

  private auth(req: Request): Viewer | Response {
    return this.viewer(req) ?? json({ error: "not signed in" }, 401);
  }

  async me(req: Request): Promise<Response> {
    const v = this.auth(req);
    if (v instanceof Response) return v;
    return json({ id: v.id, login: v.login, payout: await getPayoutAddress(this.d, v) });
  }
  async bounties(req: Request): Promise<Response> {
    const v = this.auth(req);
    if (v instanceof Response) return v;
    return json({ bounties: await listBounties(this.d, v) });
  }
  async activity(req: Request): Promise<Response> {
    const v = this.auth(req);
    if (v instanceof Response) return v;
    const limit = Number(new URL(req.url).searchParams.get("limit") ?? 20);
    return json({ activity: await listActivity(this.d, v, Number.isFinite(limit) ? limit : 20) });
  }
  async bounty(req: Request, id: string): Promise<Response> {
    const v = this.auth(req);
    if (v instanceof Response) return v;
    const detail = await getBountyDetail(this.d, v, id);
    return detail ? json(detail) : json({ error: "not found" }, 404);
  }
  async decision(req: Request, id: string, action: "approve" | "veto"): Promise<Response> {
    const v = this.auth(req);
    if (v instanceof Response) return v;
    const r = await decide(this.d, v, id, action);
    return r.ok ? json({ ok: true }) : json({ error: r.error }, r.status);
  }
  async putPayout(req: Request): Promise<Response> {
    const v = this.auth(req);
    if (v instanceof Response) return v;
    const body = (await req.json().catch(() => ({}))) as { email?: unknown };
    const r = await setPayoutAddress(this.d, v, body.email);
    return r.ok ? json({ ok: true, masked: r.masked }) : json({ error: r.error }, 400);
  }
}
