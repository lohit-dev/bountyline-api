import { describe, expect, test } from "bun:test";
import { createHmac, createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { GitHubClient, createAppJwt, verifyWebhookSignature } from "../src/adapters/github";
import { isManagedLabel } from "../src/core/messages";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const repo = { id: 1, owner: "acme", name: "widgets", installationId: 99 };

type Call = { method: string; url: string; body: any; auth: string | null };
function client(handler: (c: Call) => { status?: number; json?: unknown }) {
  const calls: Call[] = [];
  let now = Date.parse("2026-10-20T10:00:00Z");
  const fetch = async (url: string, init: RequestInit = {}) => {
    const c: Call = { method: init.method ?? "GET", url: url.replace("https://api.github.com", ""), body: init.body ? JSON.parse(init.body as string) : undefined, auth: (init.headers as any)?.authorization ?? null };
    calls.push(c);
    if (c.url.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "inst-token", expires_at: new Date(now + 3_600_000).toISOString() }), { status: 201 });
    const r = handler(c);
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), { status: r.status ?? 200 });
  };
  const gh = new GitHubClient({ appId: "123", privateKey, fetch, now: () => now });
  return { gh, calls, tick: (ms: number) => (now += ms) };
}

describe("webhook signature", () => {
  const body = '{"a":1}';
  const sig = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
  test("accepts the right signature and rejects everything else", () => {
    expect(verifyWebhookSignature("s3cret", body, sig)).toBe(true);
    expect(verifyWebhookSignature("other", body, sig)).toBe(false);
    expect(verifyWebhookSignature("s3cret", body + " ", sig)).toBe(false);
    expect(verifyWebhookSignature("s3cret", body, null)).toBe(false);
    expect(verifyWebhookSignature("s3cret", body, "sha256=zz")).toBe(false);
    expect(verifyWebhookSignature("s3cret", body, "sha256=" + "00".repeat(32))).toBe(false);
  });
});

describe("app JWT", () => {
  test("is a valid RS256 token for the app id", () => {
    const jwt = createAppJwt("123", privateKey, 1_000_000);
    const [h, p, s] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(payload.iss).toBe("123");
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
    expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(createPublicKey(publicKey), Buffer.from(s, "base64url"))).toBe(true);
  });
});

describe("GitHubClient", () => {
  test("installation tokens are cached and refreshed before expiry", async () => {
    const { gh, calls, tick } = client(() => ({ json: { permission: "write" } }));
    await gh.getPermission(repo, "a");
    await gh.getPermission(repo, "b");
    expect(calls.filter((c) => c.url.endsWith("/access_tokens")).length).toBe(1);
    expect(calls.find((c) => c.url.includes("/collaborators/"))!.auth).toBe("Bearer inst-token");
    tick(3_600_000);
    await gh.getPermission(repo, "c");
    expect(calls.filter((c) => c.url.endsWith("/access_tokens")).length).toBe(2);
  });
  test("permission maps unknown users to none", async () => {
    expect((await client(() => ({ status: 404, json: { message: "Not Found" } })).gh.getPermission(repo, "x"))).toBe("none");
    expect((await client(() => ({ json: { permission: "maintain" } })).gh.getPermission(repo, "x"))).toBe("maintain");
  });
  test("other errors throw", async () => {
    await expect(client(() => ({ status: 500, json: {} })).gh.createComment(repo, 1, "hi")).rejects.toThrow("500");
  });
  test("comments are created and edited in place", async () => {
    const { gh, calls } = client(() => ({ json: { id: 55 } }));
    expect(await gh.createComment(repo, 5, "hello")).toBe(55);
    await gh.updateComment(repo, 55, "edited");
    expect(calls.at(-1)).toMatchObject({ method: "PATCH", url: "/repos/acme/widgets/issues/comments/55", body: { body: "edited" } });
  });
  test("pull requests are mapped, including merged state", async () => {
    const { gh } = client(() => ({ json: { number: 7, title: "t", body: null, state: "closed", merged: true, merged_at: "2026-10-20T10:00:00Z", head: { sha: "abc" }, user: { id: 20, login: "mira" }, additions: 3, deletions: 1, changed_files: 2 } }));
    const p = await gh.getPull(repo, 7);
    expect(p).toMatchObject({ merged: true, state: "closed", headSha: "abc", authorId: 20, body: "" });
    expect(p.mergedAt).toBeInstanceOf(Date);
  });
  test("CI state: none, pending, failure, success; our own check is ignored", async () => {
    const run = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion });
    const state = async (runs: any[]) => (await client(() => ({ json: { check_runs: runs } })).gh.getCiStatus(repo, "sha")).state;
    expect(await state([])).toBe("none");
    expect(await state([run("Bountyline AI review", "in_progress", null)])).toBe("none");
    expect(await state([run("test", "in_progress", null)])).toBe("pending");
    expect(await state([run("test", "completed", "success"), run("lint", "completed", "failure")])).toBe("failure");
    expect(await state([run("test", "completed", "success"), run("lint", "completed", "skipped")])).toBe("success");
  });
  test("check runs: create vs update, never more than 3 actions, label lengths capped", async () => {
    const { gh, calls } = client(() => ({ json: { id: 9 } }));
    const actions = [1, 2, 3, 4].map((i) => ({ label: "x".repeat(30), description: "d".repeat(60), identifier: `id${i}` }));
    await gh.upsertCheckRun(repo, { name: "n", headSha: "s", status: "completed", conclusion: "success", title: "t", summary: "s", actions });
    expect(calls.at(-1)).toMatchObject({ method: "POST", url: "/repos/acme/widgets/check-runs" });
    expect(calls.at(-1)!.body.actions.length).toBe(3);
    expect(calls.at(-1)!.body.actions[0].label.length).toBe(20);
    expect(calls.at(-1)!.body.actions[0].description.length).toBe(40);
    await gh.upsertCheckRun(repo, { name: "n", headSha: "s", status: "in_progress", title: "t", summary: "s", existingId: 9 });
    expect(calls.at(-1)).toMatchObject({ method: "PATCH", url: "/repos/acme/widgets/check-runs/9" });
    expect(calls.at(-1)!.body.conclusion).toBeUndefined();
  });
  test("labels: removes stale managed ones, keeps the maintainers' own, adds missing", async () => {
    const { gh, calls } = client((c) => (c.method === "GET" ? { json: [{ name: "bug" }, { name: "bounty: $150" }, { name: "payout scheduled" }] } : { json: {} }));
    await gh.syncLabels(repo, 5, ["bounty: paid"], isManagedLabel);
    const deleted = calls.filter((c) => c.method === "DELETE").map((c) => decodeURIComponent(c.url.split("/labels/")[1]!));
    expect(deleted.sort()).toEqual(["bounty: $150", "payout scheduled"]);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/labels") && c.body.name === "bounty: paid")).toBe(true);
    expect(calls.at(-1)).toMatchObject({ method: "POST", url: "/repos/acme/widgets/issues/5/labels", body: { labels: ["bounty: paid"] } });
  });
});
