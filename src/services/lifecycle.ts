/**
 * The only place that changes a bounty's status. Every change goes through
 * the pure state machine, is written with compare-and-set, is logged, and then
 * its effects (jobs) and the visible GitHub state (comments, labels) follow.
 */
import { addHours } from "../core/rules";
import {
  desiredLabels,
  isManagedLabel,
  issueComment,
  prComment,
  type CommentView,
} from "../core/messages";
import { transition, type BountyEvent, type Effect, type TransitionResult } from "../core/state";
import type { Bounty } from "../domain";
import { bestEffort, logEvent, repoRef, type Deps } from "./context";

export type ApplyResult = { bounty: Bounty; result: TransitionResult };

export async function applyEvent(
  d: Deps,
  bountyId: string,
  event: BountyEvent,
  actor: string,
  opts: { data?: Record<string, unknown>; patch?: Partial<Bounty> } = {},
): Promise<ApplyResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const bounty = await d.store.getBounty(bountyId);
    if (!bounty) throw new Error(`bounty ${bountyId} not found`);
    const repo = await d.store.getRepo(bounty.repoId);
    if (!repo) throw new Error(`repo ${bounty.repoId} not found`);

    const sub = bounty.submissionId ? await d.store.getSubmission(bounty.submissionId) : null;
    const review = sub ? await d.store.latestReview(sub.id) : null;
    const result = transition(bounty.status, event, {
      merged: sub?.status === "merged",
      reviewCurrent: !!sub && review?.headSha === sub.headSha,
    });
    if (result.noop) return { bounty, result };

    const now = d.clock.now();
    const patch: Partial<Bounty> = { ...opts.patch };
    if (result.effects.includes("START_WINDOW")) patch.windowEndsAt = addHours(now, repo.settings.reviewWindowHours);
    if (result.effects.includes("PAY_NOW")) patch.windowEndsAt = now;

    const updated = await d.store.casBountyStatus(bounty.id, bounty.status, result.to, patch);
    if (!updated) continue; // someone else changed it first: re-read and try again

    await logEvent(d, bounty.id, event, actor, { from: result.from, to: result.to, ...opts.data });
    await runEffects(d, updated, result.effects);
    await refreshView(d, updated.id);
    return { bounty: updated, result };
  }
  throw new Error(`could not apply ${event} to bounty ${bountyId}: it keeps changing`);
}

async function runEffects(d: Deps, bounty: Bounty, effects: Effect[]) {
  const now = d.clock.now();
  for (const effect of effects) {
    switch (effect) {
      case "START_WINDOW":
        await d.store.enqueue({ kind: "payout", key: `payout:${bounty.id}`, payload: { bountyId: bounty.id }, runAt: bounty.windowEndsAt ?? now }, { replace: true });
        break;
      case "PAY_NOW":
        await d.store.enqueue({ kind: "payout", key: `payout:${bounty.id}`, payload: { bountyId: bounty.id }, runAt: now }, { replace: true });
        break;
      case "REFUND":
        // Only money that was actually captured can be refunded.
        if (bounty.paypalCaptureId) {
          await d.store.enqueue({ kind: "refund", key: `refund:${bounty.id}`, payload: { bountyId: bounty.id }, runAt: now }, { replace: true });
        }
        break;
      case "RUN_REVIEW": {
        const sub = bounty.submissionId ? await d.store.getSubmission(bounty.submissionId) : null;
        if (sub) {
          await d.store.enqueue({
            kind: "review",
            key: `review:${sub.id}:${sub.headSha}:after-merge`,
            payload: { submissionId: sub.id, headSha: sub.headSha },
            runAt: now,
          });
        }
        break;
      }
    }
  }
}

/** Brings the bot's comments and labels in line with the bounty. Never throws. */
export async function refreshView(d: Deps, bountyId: string): Promise<void> {
  const bounty = await d.store.getBounty(bountyId);
  if (!bounty) return;
  const repo = await d.store.getRepo(bounty.repoId);
  if (!repo) return;
  const ref = repoRef(repo);
  const sub = bounty.submissionId ? await d.store.getSubmission(bounty.submissionId) : null;
  const review = sub ? await d.store.latestReview(sub.id) : null;
  const payout = await d.store.getPayout(bounty.id);

  const view: CommentView = {
    bountyId: bounty.id,
    status: bounty.status,
    amountCents: bounty.amountCents,
    funderLogin: bounty.funderLogin,
    fundUrl: bounty.status === "created" ? `${d.config.apiUrl}/fund/${bounty.fundToken}` : undefined,
    pr: sub ? { number: sub.prNumber, authorLogin: sub.authorLogin } : undefined,
    score: review?.score,
    threshold: repo.settings.scoreThreshold,
    windowEndsAt: bounty.windowEndsAt,
    paidAt: payout?.sentAt ?? null,
    payoutAddressUrl: `${d.config.dashboardUrl}/payout`,
  };

  await bestEffort(d, "issue comment", async () => {
    const body = issueComment(view);
    if (bounty.issueCommentId) await d.github.updateComment(ref, bounty.issueCommentId, body);
    else {
      const id = await d.github.createComment(ref, bounty.issueNumber, body);
      await d.store.updateBounty(bounty.id, { issueCommentId: id });
    }
  });

  const labels = desiredLabels(bounty.status, bounty.amountCents);
  await bestEffort(d, "issue labels", () => d.github.syncLabels(ref, bounty.issueNumber, labels, isManagedLabel));

  if (sub) {
    await bestEffort(d, "pr comment", async () => {
      const body = prComment({ ...view, prNumber: sub.prNumber });
      if (sub.commentId) await d.github.updateComment(ref, sub.commentId, body);
      else {
        const id = await d.github.createComment(ref, sub.prNumber, body);
        await d.store.saveSubmission({ ...sub, commentId: id });
      }
    });
    await bestEffort(d, "pr labels", () => d.github.syncLabels(ref, sub.prNumber, labels, isManagedLabel));
  }
}
