import { describe, expect, test } from "bun:test";
import { decrypt } from "../src/core/crypto";
import { completeFunding, startFunding, FundingError } from "../src/services/funding";
import { runDueJobs, routeWebhook } from "../src/services/jobs";
import { decide } from "../src/services/dashboard";
import { applyEvent } from "../src/services/lifecycle";
import { runSweep } from "../src/services/sweeper";
import { INSTALL, MAINT, MIRA, REPO, KEY, addPayoutAccount, commentPayload, makeWorld, prPayload, type World } from "./world";

const hook = (w: World, event: string, body: unknown) => routeWebhook(w.d, event, body as Record<string, any>);

/** /bounty 150 by a maintainer, then the funder pays. */
async function fundedBounty(w: World, amount = 150) {
  await hook(w, "issue_comment", commentPayload({ body: `/bounty ${amount}`, sender: MAINT }));
  const created = (await w.store.findActiveBountyByIssue(1, 5))!;
  const { approveUrl } = await startFunding(w.d, created.fundToken, MAINT);
  expect(approveUrl).toContain("paypal.test");
  const bounty = (await w.store.getBounty(created.id))!;
  await completeFunding(w.d, created.fundToken, bounty.paypalOrderId!, MAINT);
  return (await w.store.getBounty(created.id))!;
}

async function openPr(w: World, n = 7, o: Parameters<typeof w.gh.addPull>[1] = {}, author = MIRA) {
  w.gh.addPull(n, { authorId: author.id, authorLogin: author.login, ...o });
  await hook(w, "pull_request", prPayload({ action: "opened", number: n, author, sha: `sha${n}a` }));
}
const merge = (w: World, n = 7) => hook(w, "pull_request", prPayload({ action: "closed", number: n, merged: true, sha: `sha${n}a` }));
const status = async (w: World, id: string) => (await w.store.getBounty(id))!.status;

describe("creating and funding", () => {
  test("/bounty creates a bounty and a funding link that never exposes PayPal", async () => {
    const w = makeWorld();
    await hook(w, "issue_comment", commentPayload({ body: "/bounty 150", sender: MAINT }));
    const b = (await w.store.findActiveBountyByIssue(1, 5))!;
    expect(b.status).toBe("created");
    expect(b.amountCents).toBe(15000);
    const text = w.gh.commentsOn(5).join("\n");
    expect(text).toContain(`https://api.test/fund/${b.fundToken}`);
    expect(text).not.toMatch(/paypal/i);
  });
  test("people without write access are refused and nothing is created", async () => {
    const w = makeWorld();
    await hook(w, "issue_comment", commentPayload({ body: "/bounty 150", sender: MIRA }));
    expect(await w.store.findActiveBountyByIssue(1, 5)).toBeNull();
    expect(w.gh.commentsOn(5)[0]).toContain("write access");
  });
  test("amount limits and one bounty per issue", async () => {
    const w = makeWorld();
    await hook(w, "issue_comment", commentPayload({ body: "/bounty 1", sender: MAINT }));
    expect(await w.store.findActiveBountyByIssue(1, 5)).toBeNull();
    await hook(w, "issue_comment", commentPayload({ body: "/bounty 20", sender: MAINT }));
    await hook(w, "issue_comment", commentPayload({ body: "/bounty 30", sender: MAINT }));
    expect((await w.store.findActiveBountyByIssue(1, 5))!.amountCents).toBe(2000);
    expect(w.gh.commentsOn(5).join("\n")).toContain("already has a bounty");
  });
  test("commands inside quotes or by the bot itself are ignored", async () => {
    const w = makeWorld();
    await hook(w, "issue_comment", commentPayload({ body: "> /bounty 150", sender: MAINT }));
    await hook(w, "issue_comment", commentPayload({ body: "/bounty 150", sender: { id: 1, login: "bountyline[bot]", type: "Bot" } }));
    expect(await w.store.findActiveBountyByIssue(1, 5)).toBeNull();
  });
  test("only the funder can pay, and funding labels the issue", async () => {
    const w = makeWorld();
    await hook(w, "issue_comment", commentPayload({ body: "/bounty 150", sender: MAINT }));
    const b = (await w.store.findActiveBountyByIssue(1, 5))!;
    await expect(startFunding(w.d, b.fundToken, MIRA)).rejects.toBeInstanceOf(FundingError);
    await expect(startFunding(w.d, "bogus", MAINT)).rejects.toBeInstanceOf(FundingError);
    const funded = await fundedBounty(makeWorld());
    expect(funded.status).toBe("funded");
    expect(funded.paypalCaptureId).toBeTruthy();
  });
  test("funding twice is harmless, and a wrong amount is refused", async () => {
    const w = makeWorld();
    const b = await fundedBounty(w);
    await completeFunding(w.d, b.fundToken, b.paypalOrderId!, MAINT);
    expect(w.pp.captures.size).toBe(1);
    expect(w.gh.labelsOn(5)).toEqual(["bounty: $150"]);

    const w2 = makeWorld();
    await hook(w2, "issue_comment", commentPayload({ body: "/bounty 150", sender: MAINT }));
    const c = (await w2.store.findActiveBountyByIssue(1, 5))!;
    await startFunding(w2.d, c.fundToken, MAINT);
    w2.pp.captureAmountOverride = 100;
    const order = (await w2.store.getBounty(c.id))!.paypalOrderId!;
    await expect(completeFunding(w2.d, c.fundToken, order, MAINT)).rejects.toBeInstanceOf(FundingError);
    expect(await status(w2, c.id)).toBe("created");
  });
  test("a PR opened before funding is linked once the bounty is paid", async () => {
    const w = makeWorld();
    await hook(w, "issue_comment", commentPayload({ body: "/bounty 150", sender: MAINT }));
    await openPr(w);
    const b0 = (await w.store.findActiveBountyByIssue(1, 5))!;
    expect(b0.status).toBe("created");
    const b = await fundedBounty(makeWorld());
    expect(b.status).toBe("funded");
    // same world: pay now
    const { approveUrl } = await startFunding(w.d, b0.fundToken, MAINT);
    expect(approveUrl).toBeTruthy();
    await completeFunding(w.d, b0.fundToken, (await w.store.getBounty(b0.id))!.paypalOrderId!, MAINT);
    expect(await status(w, b0.id)).toBe("claimed");
  });
});

describe("hardening", () => {
  test("a pull request author with write access cannot approve their own payout", async () => {
    const w = makeWorld();
    w.gh.permissions.set("mira", "write");
    w.reviewer.score = 60;
    const b = await fundedBounty(w);
    await openPr(w);
    await runDueJobs(w.d);
    await merge(w);
    expect(await status(w, b.id)).toBe("flagged");
    await hook(w, "issue_comment", commentPayload({ issue: 7, pull: true, body: "/approve-bounty", sender: MIRA }));
    expect(await status(w, b.id)).toBe("flagged");
    expect(w.gh.commentsOn(7).join("\n")).toContain("someone else needs to approve");
    const r = await decide(w.d, MIRA, b.id, "approve");
    expect(r.ok).toBe(false);
    expect(await status(w, b.id)).toBe("flagged");
    // A different maintainer still can.
    expect((await decide(w.d, MAINT, b.id, "approve")).ok).toBe(true);
    expect(await status(w, b.id)).toBe("window");
  });

  test("a payment captured after the bounty was cancelled is refunded, not lost", async () => {
    const w = makeWorld();
    await hook(w, "issue_comment", commentPayload({ body: "/bounty 150", sender: MAINT }));
    const created = (await w.store.findActiveBountyByIssue(1, 5))!;
    await startFunding(w.d, created.fundToken, MAINT);
    const order = (await w.store.getBounty(created.id))!.paypalOrderId!;
    // The unfunded sweep cancels the bounty while the money is being captured.
    const capture = w.pp.captureOrder.bind(w.pp);
    w.pp.captureOrder = async (...a: Parameters<typeof capture>) => {
      const r = await capture(...a);
      await applyEvent(w.d, created.id, "CANCEL", "system");
      return r;
    };
    await expect(completeFunding(w.d, created.fundToken, order, MAINT)).rejects.toBeInstanceOf(FundingError);
    await runDueJobs(w.d);
    expect(w.pp.refunds.length).toBe(1);
    expect(await status(w, created.id)).toBe("refunded");
  });
});

describe("webhook ordering", () => {
  test("a merge that arrives before the last push event is reviewed again, not paid on the old review", async () => {
    const w = makeWorld();
    const b = await fundedBounty(w);
    await openPr(w);
    await runDueJobs(w.d);
    expect(await status(w, b.id)).toBe("reviewed");
    // The merge event reports a newer head commit than the one that was reviewed.
    w.gh.pulls.get(7)!.headSha = "sha7b";
    await hook(w, "pull_request", prPayload({ action: "closed", number: 7, merged: true, sha: "sha7b" }));
    expect(await status(w, b.id)).toBe("claimed");
    await runDueJobs(w.d);
    expect(w.reviewer.calls).toBe(2);
    expect(await status(w, b.id)).toBe("window");
  });
});

describe("the happy path to a payout", () => {
  test("fund, claim, review, merge, wait out the window, get paid exactly once", async () => {
    const w = makeWorld();
    const b = await fundedBounty(w);
    await openPr(w);
    expect(await status(w, b.id)).toBe("claimed");
    expect(w.gh.commentsOn(7).join("\n")).toContain("being reviewed");

    await runDueJobs(w.d);
    expect(await status(w, b.id)).toBe("reviewed");
    expect(w.reviewer.calls).toBe(1);
    const run = w.gh.checkRuns.at(-1)!;
    expect(run.status).toBe("completed");
    expect(run.conclusion).toBe("success");
    expect(run.actions?.map((a) => a.identifier)).toEqual(["approve", "veto"]);

    await merge(w);
    expect(await status(w, b.id)).toBe("window");
    expect(w.gh.labelsOn(5)).toEqual(["bounty: $150", "payout scheduled"]);
    expect(w.pp.payouts.length).toBe(0);

    await addPayoutAccount(w);
    w.hours(47);
    await runDueJobs(w.d);
    expect(await status(w, b.id)).toBe("window"); // still inside the window
    w.hours(2);
    await runDueJobs(w.d);
    expect(await status(w, b.id)).toBe("paid");
    expect(w.pp.payouts.length).toBe(1);
    expect(w.pp.payouts[0]!.amountCents).toBe(15000);
    expect(w.pp.payouts[0]!.email).toBe("mira@example.com");
    expect(w.gh.labelsOn(5)).toEqual(["bounty: paid"]);
    expect(w.gh.commentsOn(5).join("\n")).not.toContain("mira@example.com");

    await w.store.enqueue({ kind: "payout", key: "again", payload: { bountyId: b.id }, runAt: w.clock.now() });
    await runDueJobs(w.d);
    expect(w.pp.payouts.length).toBe(1);
  });
  test("merging before the review finished still ends in the window, with one review", async () => {
    const w = makeWorld();
    const b = await fundedBounty(w);
    await openPr(w);
    await merge(w);
    expect(await status(w, b.id)).toBe("claimed");
    await runDueJobs(w.d);
    expect(await status(w, b.id)).toBe("window");
    expect(w.reviewer.calls).toBe(1);
  });
  test("new commits after a passing review make it stale; merging triggers a fresh review", async () => {
    const w = makeWorld();
    const b = await fundedBounty(w);
    await openPr(w);
    await runDueJobs(w.d);
    expect(await status(w, b.id)).toBe("reviewed");
    w.gh.pulls.get(7)!.headSha = "sha7b";
    await hook(w, "pull_request", prPayload({ action: "synchronize", number: 7, sha: "sha7b" }));
    expect(await status(w, b.id)).toBe("claimed");
    await runDueJobs(w.d);
    expect(await status(w, b.id)).toBe("reviewed");
    expect(w.reviewer.calls).toBe(2);
  });
});

describe("review outcomes", () => {
  test("a low score is flagged; after merge a maintainer approves and it pays now", async () => {
    const w = makeWorld();
    w.reviewer.score = 60;
    const b = await fundedBounty(w);
    await openPr(w);
    await runDueJobs(w.d);
    expect(await status(w, b.id)).toBe("flagged");
    expect(w.gh.checkRuns.at(-1)!.conclusion).toBe("neutral"); // never blocks merging

    await hook(w, "issue_comment", commentPayload({ issue: 7, pull: true, body: "/approve-bounty", sender: MAINT }));
    expect(await status(w, b.id)).toBe("flagged"); // not merged yet
    expect(w.gh.commentsOn(7).join("\n")).toContain("must be merged");

    await merge(w);
    expect(await status(w, b.id)).toBe("flagged");
    await hook(w, "issue_comment", commentPayload({ issue: 7, pull: true, body: "/approve-bounty", sender: MAINT }));
    expect(await status(w, b.id)).toBe("window");
    await addPayoutAccount(w);
    await runDueJobs(w.d);
    expect(await status(w, b.id)).toBe("paid");
  });
  test("failing CI blocks automatic payout even with a high score", async () => {
    const w = makeWorld();
    w.gh.ci.set("sha7a", { state: "failure", failing: ["test"] });
    const b = await fundedBounty(w);
    await openPr(w);
    await runDueJobs(w.d);
    expect(await status(w, b.id)).toBe("flagged");
  });
  test("pending CI is waited for, not judged", async () => {
    const w = makeWorld();
    w.gh.ci.set("sha7a", { state: "pending", failing: [] });
    const b = await fundedBounty(w);
    await openPr(w);
    await runDueJobs(w.d);
    expect(w.reviewer.calls).toBe(0);
    w.gh.ci.set("sha7a", { state: "success", failing: [] });
    w.advance(11 * 60_000);
    await runDueJobs(w.d);
    expect(await status(w, b.id)).toBe("reviewed");
  });
  test("oversized pull requests are not sent to the AI", async () => {
    const w = makeWorld();
    const b = await fundedBounty(w);
    await openPr(w, 7, { files: [{ filename: "src/big.ts", status: "added", additions: 2000, deletions: 0, patch: "@@" }] });
    await runDueJobs(w.d);
    expect(w.reviewer.calls).toBe(0);
    expect(await status(w, b.id)).toBe("flagged");
    expect(w.gh.checkRuns.at(-1)!.summary).toContain("above the limit");
  });
  test("if the AI keeps failing, a maintainer is asked to decide", async () => {
    const w = makeWorld();
    w.reviewer.fail = true;
    const b = await fundedBounty(w);
    await openPr(w);
    for (let i = 0; i < 8; i++) {
      await runDueJobs(w.d);
      w.advance(65 * 60_000);
    }
    expect(await status(w, b.id)).toBe("flagged");
  });
  test("reviews per PR are capped", async () => {
    const w = makeWorld();
    const b = await fundedBounty(w);
    await openPr(w);
    for (let i = 0; i < 7; i++) {
      await runDueJobs(w.d);
      const sha = `sha7-${i}`;
      w.gh.pulls.get(7)!.headSha = sha;
      await hook(w, "pull_request", prPayload({ action: "synchronize", number: 7, sha }));
    }
    await runDueJobs(w.d);
    expect(w.reviewer.calls).toBe(w.settings.maxReviewsPerPr);
    expect(b.id).toBeTruthy();
  });
});

describe("claiming rules", () => {
  test("the funder cannot claim their own bounty", async () => {
    const w = makeWorld();
    const b = await fundedBounty(w);
    await openPr(w, 8, {}, MAINT);
    expect(await status(w, b.id)).toBe("funded");
    expect(w.gh.commentsOn(8).join("\n")).toContain("funded this bounty");
  });
  test("a closed PR releases the bounty; a second PR can take over", async () => {
    const w = makeWorld();
    const b = await fundedBounty(w);
    await openPr(w, 7);
    expect(await status(w, b.id)).toBe("claimed");
    await hook(w, "pull_request", prPayload({ action: "closed", number: 7, merged: false }));
    expect(await status(w, b.id)).toBe("funded");
    await openPr(w, 8, {}, { id: 30, login: "sam" } as typeof MIRA);
    expect(await status(w, b.id)).toBe("claimed");
  });
  test("two PRs: the first one that merges wins and the other is superseded", async () => {
    const w = makeWorld();
    const b = await fundedBounty(w);
    await openPr(w, 7);
    await openPr(w, 8, {}, { id: 30, login: "sam", type: "User" });
    await runDueJobs(w.d);
    await merge(w, 8);
    await runDueJobs(w.d);
    const subs = await w.store.listSubmissions(b.id);
    expect(subs.find((s) => s.prNumber === 8)!.status).toBe("merged");
    expect(subs.find((s) => s.prNumber === 7)!.status).toBe("superseded");
    expect(await status(w, b.id)).toBe("window");
    expect((await w.store.getBounty(b.id))!.submissionId).toBe(subs.find((s) => s.prNumber === 8)!.id);
  });
});

describe("veto, cancel and refunds", () => {
  async function inWindow(w: World) {
    const b = await fundedBounty(w);
    await openPr(w);
    await runDueJobs(w.d);
    await merge(w);
    expect(await status(w, b.id)).toBe("window");
    return b;
  }
  test("a veto in the window refunds the funder", async () => {
    const w = makeWorld();
    const b = await inWindow(w);
    await hook(w, "issue_comment", commentPayload({ body: "/veto-bounty", sender: MIRA }));
    expect(await status(w, b.id)).toBe("window"); // no write access
    await hook(w, "issue_comment", commentPayload({ body: "/veto-bounty", sender: MAINT }));
    expect(await status(w, b.id)).toBe("vetoed");
    await runDueJobs(w.d);
    expect(await status(w, b.id)).toBe("refunded");
    expect(w.pp.refunds.length).toBe(1);
    expect(w.pp.payouts.length).toBe(0);
    expect(w.gh.labelsOn(5)).toEqual(["bounty: refunded"]);
    // the payout job that was waiting does nothing
    await addPayoutAccount(w);
    w.hours(50);
    await runDueJobs(w.d);
    expect(w.pp.payouts.length).toBe(0);
  });
  test("a veto after payment is refused and nothing is refunded", async () => {
    const w = makeWorld();
    const b = await inWindow(w);
    await addPayoutAccount(w);
    w.hours(49);
    await runDueJobs(w.d);
    expect(await status(w, b.id)).toBe("paid");
    await hook(w, "issue_comment", commentPayload({ body: "/veto-bounty", sender: MAINT }));
    expect(await status(w, b.id)).toBe("paid");
    expect(w.pp.refunds.length).toBe(0);
    expect(w.gh.commentsOn(5).join("\n")).toContain("payouts are final");
  });
  test("approve pays immediately", async () => {
    const w = makeWorld();
    const b = await inWindow(w);
    await addPayoutAccount(w);
    await hook(w, "issue_comment", commentPayload({ body: "/approve-bounty", sender: MAINT }));
    await runDueJobs(w.d);
    expect(await status(w, b.id)).toBe("paid");
  });
  test("cancelling an unfunded bounty needs no refund and stays cancelled", async () => {
    const w = makeWorld();
    await hook(w, "issue_comment", commentPayload({ body: "/bounty 50", sender: MAINT }));
    const b = (await w.store.findActiveBountyByIssue(1, 5))!;
    await hook(w, "issue_comment", commentPayload({ body: "/cancel-bounty", sender: MAINT }));
    expect(await status(w, b.id)).toBe("cancelled");
    await runSweep(w.d);
    await runDueJobs(w.d);
    expect(await status(w, b.id)).toBe("cancelled");
    expect(w.pp.refunds.length).toBe(0);
  });
  test("cancelling a funded bounty refunds it, but not inside the window", async () => {
    const w = makeWorld();
    const b = await fundedBounty(w);
    await hook(w, "issue_comment", commentPayload({ body: "/cancel-bounty", sender: MAINT }));
    await runDueJobs(w.d);
    expect(await status(w, b.id)).toBe("refunded");
    const w2 = makeWorld();
    const b2 = await inWindow(w2);
    await hook(w2, "issue_comment", commentPayload({ body: "/cancel-bounty", sender: MAINT }));
    expect(await status(w2, b2.id)).toBe("window");
    expect(w2.gh.commentsOn(5).join("\n")).toContain("/veto-bounty");
  });
  test("a deleted issue cancels and refunds its bounty", async () => {
    const w = makeWorld();
    const b = await fundedBounty(w);
    await hook(w, "issues", { action: "deleted", issue: { number: 5 }, repository: REPO, installation: INSTALL, sender: MAINT });
    await runDueJobs(w.d);
    expect(await status(w, b.id)).toBe("refunded");
  });
  test("refund failures retry instead of losing the refund", async () => {
    const w = makeWorld();
    const b = await fundedBounty(w);
    w.pp.failNextRefunds = 2;
    await hook(w, "issue_comment", commentPayload({ body: "/cancel-bounty", sender: MAINT }));
    for (let i = 0; i < 5; i++) { await runDueJobs(w.d); w.advance(10 * 60_000); }
    expect(await status(w, b.id)).toBe("refunded");
    expect(w.pp.refunds.length).toBe(1);
  });
});

describe("payout edge cases", () => {
  test("a failing payout retries with the same idempotency key and pays once", async () => {
    const w = makeWorld();
    const b = await fundedBounty(w);
    await openPr(w);
    await runDueJobs(w.d);
    await merge(w);
    await addPayoutAccount(w);
    w.pp.failNextPayouts = 2;
    w.hours(49);
    for (let i = 0; i < 5; i++) { await runDueJobs(w.d); w.advance(10 * 60_000); }
    expect(await status(w, b.id)).toBe("paid");
    expect(w.pp.payouts.length).toBe(1);
  });
  test("no payout address: remind once, wait, then refund", async () => {
    const w = makeWorld();
    const b = await fundedBounty(w);
    await openPr(w);
    await runDueJobs(w.d);
    await merge(w);
    w.hours(49);
    await runDueJobs(w.d);
    expect(await status(w, b.id)).toBe("window");
    w.hours(24);
    await runDueJobs(w.d);
    expect(w.gh.commentsOn(7).filter((c) => c.includes("has not set where to receive")).length).toBe(1);
    w.advance(15 * 24 * 3_600_000);
    await runDueJobs(w.d);
    await runDueJobs(w.d);
    expect(await status(w, b.id)).toBe("refunded");
    expect(w.pp.payouts.length).toBe(0);
  });
  test("payout emails are stored encrypted", async () => {
    const w = makeWorld();
    await addPayoutAccount(w);
    const acc = (await w.store.getPayoutAccount(20))!;
    expect(acc.paypalEmailEnc).not.toContain("mira");
    expect(decrypt(acc.paypalEmailEnc, KEY)).toBe("mira@example.com");
  });
});

describe("timers", () => {
  test("a bounty nobody claims expires and is refunded", async () => {
    const w = makeWorld();
    const b = await fundedBounty(w);
    w.advance(31 * 24 * 3_600_000);
    await runSweep(w.d);
    expect(await status(w, b.id)).toBe("expired");
    await runDueJobs(w.d);
    expect(await status(w, b.id)).toBe("refunded");
  });
  test("an unpaid bounty is cancelled after a few days", async () => {
    const w = makeWorld();
    await hook(w, "issue_comment", commentPayload({ body: "/bounty 50", sender: MAINT }));
    const b = (await w.store.findActiveBountyByIssue(1, 5))!;
    w.advance(4 * 24 * 3_600_000);
    await runSweep(w.d);
    expect(await status(w, b.id)).toBe("cancelled");
  });
  test("a flagged bounty nobody decides on is refunded", async () => {
    const w = makeWorld();
    w.reviewer.score = 50;
    const b = await fundedBounty(w);
    await openPr(w);
    await runDueJobs(w.d);
    w.advance(15 * 24 * 3_600_000);
    await runSweep(w.d);
    await runDueJobs(w.d);
    expect(await status(w, b.id)).toBe("refunded");
  });
  test("the same webhook delivered twice is processed once", async () => {
    const w = makeWorld();
    const job = { kind: "webhook" as const, key: "webhook:abc", payload: { event: "issue_comment", body: commentPayload({ body: "/bounty 50", sender: MAINT }) }, runAt: w.clock.now() };
    expect(await w.store.enqueue(job)).toBe(true);
    expect(await w.store.enqueue(job)).toBe(false);
    await runDueJobs(w.d);
    expect(w.store.bounties.size).toBe(1);
  });
});

describe("the amount picker", () => {
  async function picker(w: World) {
    await hook(w, "issue_comment", commentPayload({ body: "/bounty", sender: MAINT }));
    const [id, c] = [...w.gh.comments.entries()][0]!;
    return { id, body: c.body };
  }
  const bot = { id: 1, login: "bountyline[bot]", type: "Bot" };

  test("ticking a box starts a bounty with the stored amount, even if the text was tampered with", async () => {
    const w = makeWorld();
    const { id, body } = await picker(w);
    expect(body).toContain("- [ ] $50");
    const tampered = body.replace("- [ ] $50", "- [x] $50000");
    w.gh.comments.get(id)!.body = tampered;
    await hook(w, "issue_comment", commentPayload({ action: "edited", commentId: id, body: tampered, from: body, sender: MAINT, author: bot }));
    const b = (await w.store.findActiveBountyByIssue(1, 5))!;
    expect(b.amountCents).toBe(5000);
    expect(b.funderLogin).toBe("maint");
    expect(b.issueCommentId).toBe(id);
    expect(w.gh.comments.get(id)!.body).toContain("/fund/");
  });
  test("the bot's own edits are ignored", async () => {
    const w = makeWorld();
    const { id, body } = await picker(w);
    const ticked = body.replace("- [ ] $25", "- [x] $25");
    await hook(w, "issue_comment", commentPayload({ action: "edited", commentId: id, body: ticked, from: body, sender: bot, author: bot }));
    expect(await w.store.findActiveBountyByIssue(1, 5)).toBeNull();
  });
  test("a person without write access cannot tick, and the picker is reset", async () => {
    const w = makeWorld();
    const { id, body } = await picker(w);
    const ticked = body.replace("- [ ] $25", "- [x] $25");
    w.gh.comments.get(id)!.body = ticked;
    await hook(w, "issue_comment", commentPayload({ action: "edited", commentId: id, body: ticked, from: body, sender: MIRA, author: bot }));
    expect(await w.store.findActiveBountyByIssue(1, 5)).toBeNull();
    expect(w.gh.comments.get(id)!.body).toContain("- [ ] $25");
  });
  test("a lookalike comment written by a person is not treated as a picker", async () => {
    const w = makeWorld();
    const { id, body } = await picker(w);
    const ticked = body.replace("- [ ] $25", "- [x] $25");
    await hook(w, "issue_comment", commentPayload({ action: "edited", commentId: id, body: ticked, from: body, sender: MAINT, author: MAINT }));
    expect(await w.store.findActiveBountyByIssue(1, 5)).toBeNull();
  });
  test("a picker works once", async () => {
    const w = makeWorld();
    const { id, body } = await picker(w);
    const ticked = body.replace("- [ ] $25", "- [x] $25");
    const p = commentPayload({ action: "edited", commentId: id, body: ticked, from: body, sender: MAINT, author: bot });
    await hook(w, "issue_comment", p);
    await hook(w, "issue_comment", p);
    expect(w.store.bounties.size).toBe(1);
  });
});

describe("check-run buttons", () => {
  test("Veto and Approve buttons work for maintainers only", async () => {
    const w = makeWorld();
    const b = await fundedBounty(w);
    await openPr(w);
    await runDueJobs(w.d);
    await merge(w);
    const payload = (sender: typeof MAINT, identifier: string) => ({
      action: "requested_action", requested_action: { identifier }, check_run: { head_sha: "sha7a", pull_requests: [{ number: 7 }] },
      repository: REPO, installation: INSTALL, sender,
    });
    await hook(w, "check_run", payload(MIRA, "veto"));
    expect(await status(w, b.id)).toBe("window");
    await hook(w, "check_run", payload(MAINT, "veto"));
    expect(await status(w, b.id)).toBe("vetoed");
  });
});
