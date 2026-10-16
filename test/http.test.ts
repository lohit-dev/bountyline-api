import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Api } from "../src/http/handlers";
import { runDueJobs, routeWebhook } from "../src/services/jobs";
import { completeFunding, startFunding } from "../src/services/funding";
import { MAINT, MIRA, REPO, INSTALL, addPayoutAccount, commentPayload, makeWorld, prPayload, type World } from "./world";

const SECRET = "whsec";
function setup() {
  const w = makeWorld();
  const oauthCalls: string[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    oauthCalls.push(url);
    if (url.includes("/login/oauth/access_token")) return new Response(JSON.stringify({ access_token: "gho_x" }));
    if (url.endsWith("/user")) return new Response(JSON.stringify({ id: 10, login: "maint" }));
    return new Response("{}", { status: 404 });
  };
  const api = new Api(w.d, { webhookSecret: SECRET, sessionSecret: "sess", githubOAuth: { clientId: "cid", clientSecret: "csec" }, fetch });
  const tokenFor = (u: { id: number; login: string }) => (api as any).sessionToken(u) as string;
  const as = (u: { id: number; login: string }, path: string, init: RequestInit = {}) =>
    new Request(`https://api.test${path}`, { ...init, headers: { authorization: `Bearer ${tokenFor(u)}`, "content-type": "application/json", ...(init.headers as object) } });
  return { w, api, as, oauthCalls };
}
const hook = (w: World, event: string, body: unknown) => routeWebhook(w.d, event, body as any);

async function fundedWorld(amount = 150) {
  const s = setup();
  await hook(s.w, "issue_comment", commentPayload({ body: `/bounty ${amount}`, sender: MAINT }));
  const b = (await s.w.store.findActiveBountyByIssue(1, 5))!;
  await startFunding(s.w.d, b.fundToken, MAINT);
  await completeFunding(s.w.d, b.fundToken, (await s.w.store.getBounty(b.id))!.paypalOrderId!, MAINT);
  return { ...s, id: b.id, token: b.fundToken };
}
async function toWindow(s: Awaited<ReturnType<typeof fundedWorld>>) {
  const { w } = s;
  w.gh.addPull(7, { authorId: MIRA.id, authorLogin: MIRA.login });
  await hook(w, "pull_request", prPayload({ action: "opened", number: 7, author: MIRA, sha: "sha7a" }));
  await runDueJobs(w.d);
  await hook(w, "pull_request", prPayload({ action: "closed", number: 7, merged: true, sha: "sha7a" }));
}

describe("webhook intake", () => {
  const send = (api: Api, body: string, sig: string | null, extra: Record<string, string> = {}) =>
    api.webhook(new Request("https://api.test/webhooks/github", { method: "POST", body, headers: { ...(sig ? { "x-hub-signature-256": sig } : {}), "x-github-event": "issue_comment", "x-github-delivery": "d1", ...extra } }));
  const sign = (body: string) => "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");

  test("rejects bad signatures and does not enqueue", async () => {
    const { api, w } = setup();
    expect((await send(api, "{}", null)).status).toBe(401);
    expect((await send(api, "{}", "sha256=" + "0".repeat(64))).status).toBe(401);
    expect(w.store.jobs.size).toBe(0);
  });
  test("queues a signed delivery once, and the job runs the command", async () => {
    const { api, w } = setup();
    const body = JSON.stringify(commentPayload({ body: "/bounty 40", sender: MAINT }));
    expect((await send(api, body, sign(body))).status).toBe(202);
    expect((await send(api, body, sign(body))).status).toBe(202); // GitHub redelivery
    expect(w.store.jobs.size).toBe(1);
    await runDueJobs(w.d);
    expect((await w.store.findActiveBountyByIssue(1, 5))!.amountCents).toBe(4000);
  });
  test("ping is answered and ignored", async () => {
    const { api, w } = setup();
    const body = "{}";
    expect((await send(api, body, sign(body), { "x-github-event": "ping" })).status).toBe(200);
    expect(w.store.jobs.size).toBe(0);
  });
});

describe("sign-in", () => {
  test("login redirects to GitHub with a signed state; open redirects are refused", async () => {
    const { api } = setup();
    const r = api.login(new Request("https://api.test/auth/login?next=/fund/abc"));
    const u = new URL(r.headers.get("location")!);
    expect(u.origin + u.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(u.searchParams.get("redirect_uri")).toBe("https://api.test/auth/callback");
    const evil = new URL(api.login(new Request("https://api.test/auth/login?next=//evil.com")).headers.get("location")!);
    // falls back to the dashboard, never to the attacker's URL
    const cb = await api.callback(new Request(`https://api.test/auth/callback?code=c&state=${evil.searchParams.get("state")}`));
    expect(cb.headers.get("location")!.startsWith("https://app.test/#token=")).toBe(true);
  });
  test("callback sets a session cookie and sends the funder back to the funding page", async () => {
    const { api, as } = setup();
    const state = new URL(api.login(new Request("https://api.test/auth/login?next=/fund/abc")).headers.get("location")!).searchParams.get("state");
    const r = await api.callback(new Request(`https://api.test/auth/callback?code=c&state=${state}`));
    expect(r.headers.get("location")).toBe("https://api.test/fund/abc");
    expect(r.headers.get("set-cookie")).toContain("HttpOnly");
    const cookie = r.headers.get("set-cookie")!.split(";")[0]!;
    expect(api.viewer(new Request("https://api.test/api/me", { headers: { cookie } }))).toEqual({ id: 10, login: "maint" });
    expect(as).toBeTruthy();
  });
  test("a forged or missing state is refused", async () => {
    const { api } = setup();
    expect((await api.callback(new Request("https://api.test/auth/callback?code=c&state=forged"))).status).toBe(400);
    expect((await api.callback(new Request("https://api.test/auth/callback"))).status).toBe(400);
  });
  test("API needs a valid session", async () => {
    const { api } = setup();
    expect((await api.me(new Request("https://api.test/api/me"))).status).toBe(401);
    expect((await api.bounties(new Request("https://api.test/api/bounties", { headers: { authorization: "Bearer junk" } }))).status).toBe(401);
  });
});

describe("funding pages", () => {
  test("anonymous visitors are sent to sign in; the wrong account is told so; the funder pays", async () => {
    const s = setup();
    await hook(s.w, "issue_comment", commentPayload({ body: "/bounty 150", sender: MAINT }));
    const b = (await s.w.store.findActiveBountyByIssue(1, 5))!;
    const anon = await s.api.fund(new Request(`https://api.test/fund/${b.fundToken}`), b.fundToken);
    expect(anon.headers.get("location")).toContain(`/auth/login?next=${encodeURIComponent("/fund/" + b.fundToken)}`);

    const wrong = await s.api.fund(s.as(MIRA, `/fund/${b.fundToken}`), b.fundToken);
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain("Only @maint can fund");

    const ok = await s.api.fund(s.as(MAINT, `/fund/${b.fundToken}`), b.fundToken);
    expect(ok.headers.get("location")).toContain("paypal.test/approve");

    const orderId = (await s.w.store.getBounty(b.id))!.paypalOrderId!;
    const back = await s.api.paypalReturn(s.as(MAINT, `/paypal/return?b=${b.fundToken}&token=${orderId}&PayerID=X`));
    expect(back.status).toBe(200);
    expect((await s.w.store.getBounty(b.id))!.status).toBe("funded");
  });
  test("a PayPal return for someone else's order is refused", async () => {
    const s = setup();
    await hook(s.w, "issue_comment", commentPayload({ body: "/bounty 150", sender: MAINT }));
    const b = (await s.w.store.findActiveBountyByIssue(1, 5))!;
    await s.api.fund(s.as(MAINT, `/fund/${b.fundToken}`), b.fundToken);
    const r = await s.api.paypalReturn(s.as(MAINT, `/paypal/return?b=${b.fundToken}&token=SOMEONES-ORDER`));
    expect(r.status).toBe(400);
    expect((await s.w.store.getBounty(b.id))!.status).toBe("created");
  });
  test("error pages escape their content", async () => {
    const s = setup();
    const r = await s.api.fund(s.as(MAINT, "/fund/<script>"), "<script>");
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain("<script>");
  });
});

describe("dashboard API", () => {
  test("funder and contributor see the bounty, strangers do not, and nothing secret is in the response", async () => {
    const s = await fundedWorld();
    await toWindow(s);
    const stranger = { id: 77, login: "rando" };

    for (const who of [MAINT, MIRA]) {
      const list = await (await s.api.bounties(s.as(who, "/api/bounties"))).json() as any;
      expect(list.bounties.length).toBe(1);
      expect(list.bounties[0].status).toBe("window");
      expect(list.bounties[0].review.score).toBeGreaterThan(0);
    }
    expect((await s.api.bounties(s.as(stranger, "/api/bounties")).then((r) => r.json()) as any).bounties).toEqual([]);
    expect((await s.api.bounty(s.as(stranger, `/api/bounties/${s.id}`), s.id)).status).toBe(404);

    const detail = await (await s.api.bounty(s.as(MIRA, `/api/bounties/${s.id}`), s.id)).text();
    expect(detail).not.toContain(s.token);
    expect(detail).not.toMatch(/ORDER\d|CAP-|paypal/i);
    expect(detail).toContain("mira");
  });
  test("only maintainers can veto from the dashboard, and a veto refunds", async () => {
    const s = await fundedWorld();
    await toWindow(s);
    const asMira = await s.api.decision(s.as(MIRA, `/api/bounties/${s.id}/veto`, { method: "POST" }), s.id, "veto");
    expect(asMira.status).toBe(403);
    const stranger = await s.api.decision(s.as({ id: 77, login: "rando" }, "/x", { method: "POST" }), s.id, "veto");
    expect(stranger.status).toBe(404);
    const ok = await s.api.decision(s.as(MAINT, "/x", { method: "POST" }), s.id, "veto");
    expect(ok.status).toBe(200);
    await runDueJobs(s.w.d);
    expect((await s.w.store.getBounty(s.id))!.status).toBe("refunded");
  });
  test("approve from the dashboard pays; after payment both actions are refused", async () => {
    const s = await fundedWorld();
    await toWindow(s);
    await addPayoutAccount(s.w);
    expect((await s.api.decision(s.as(MAINT, "/x", { method: "POST" }), s.id, "approve")).status).toBe(200);
    await runDueJobs(s.w.d);
    expect((await s.w.store.getBounty(s.id))!.status).toBe("paid");
    const veto = await s.api.decision(s.as(MAINT, "/x", { method: "POST" }), s.id, "veto");
    expect(veto.status).toBe(409);
    expect(((await veto.json()) as any).error).toContain("final");
    expect(s.w.pp.refunds.length).toBe(0);
  });
  test("the contributor stores a PayPal email: validated, encrypted, masked, and it unblocks a waiting payout", async () => {
    const s = await fundedWorld();
    await toWindow(s);
    s.w.hours(49);
    await runDueJobs(s.w.d);
    expect((await s.w.store.getBounty(s.id))!.status).toBe("window"); // no address yet

    const bad = await s.api.putPayout(s.as(MIRA, "/api/payout-account", { method: "PUT", body: JSON.stringify({ email: "nope" }) }));
    expect(bad.status).toBe(400);
    const good = await s.api.putPayout(s.as(MIRA, "/api/payout-account", { method: "PUT", body: JSON.stringify({ email: "mira@example.com" }) }));
    expect(((await good.json()) as any).masked).toBe("m***@example.com");
    expect((await s.w.store.getPayoutAccount(MIRA.id))!.paypalEmailEnc).not.toContain("mira");

    await runDueJobs(s.w.d);
    expect((await s.w.store.getBounty(s.id))!.status).toBe("paid");
    expect(s.w.pp.payouts[0]!.email).toBe("mira@example.com");

    const me = (await (await s.api.me(s.as(MIRA, "/api/me"))).json()) as any;
    expect(me.payout).toEqual({ set: true, masked: "m***@example.com" });
  });
});
