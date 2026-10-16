/** Routes GitHub webhooks and runs background jobs. */
import { addMinutes } from "../core/rules";
import type { Job } from "../domain";
import { upsertRepoFromPayload, approveBounty, handleCommentCreated, handleCommentEdited, vetoBounty, type CommentEventPayload } from "./commands";
import { isBot, repoRef, type Deps } from "./context";
import { applyEvent } from "./lifecycle";
import { runPayout, runPayoutCheck, runRefund } from "./money";
import { handlePullRequest, type PullPayload } from "./pulls";
import { flagForManualReview, runReview } from "./review";
import { runSweep } from "./sweeper";
import { IllegalTransitionError } from "../core/state";
import { canManage } from "../core/rules";

export const MAX_JOB_ATTEMPTS = 6;

/* ------------------------------ Webhooks ------------------------------ */

type AnyPayload = Record<string, any>;

export async function routeWebhook(d: Deps, event: string, body: AnyPayload): Promise<void> {
  switch (event) {
    case "issue_comment":
      if (body.action === "created") return handleCommentCreated(d, body as CommentEventPayload);
      if (body.action === "edited") return handleCommentEdited(d, body as CommentEventPayload);
      return;
    case "pull_request":
      return handlePullRequest(d, body as PullPayload);
    case "check_run":
      if (body.action === "requested_action") return handleCheckRunAction(d, body);
      return;
    case "issues":
      if (body.action === "deleted" || body.action === "transferred") return onIssueGone(d, body);
      return;
    case "installation":
    case "installation_repositories":
      return onInstallation(d, body);
  }
}

async function handleCheckRunAction(d: Deps, p: AnyPayload) {
  if (isBot(p.sender)) return;
  const identifier = p.requested_action?.identifier as string | undefined;
  const prNumber = p.check_run?.pull_requests?.[0]?.number as number | undefined;
  if (!prNumber || (identifier !== "approve" && identifier !== "veto")) return;
  const repo = await upsertRepoFromPayload(d, p as Pick<CommentEventPayload, "repository" | "installation">);
  const actor = { id: p.sender.id as number, login: p.sender.login as string };
  const permission = await d.github.getPermission(repoRef(repo), actor.login);
  if (!canManage(permission)) return;
  if (identifier === "approve") await approveBounty(d, repo, prNumber, true, actor, permission);
  else await vetoBounty(d, repo, prNumber, true, actor, permission);
}

async function onIssueGone(d: Deps, p: AnyPayload) {
  const repo = await upsertRepoFromPayload(d, p as Pick<CommentEventPayload, "repository" | "installation">);
  const bounty = await d.store.findActiveBountyByIssue(repo.id, p.issue.number as number);
  if (!bounty) return;
  try {
    await applyEvent(d, bounty.id, "CANCEL", "system", { data: { reason: `issue ${p.action}` } });
  } catch (err) {
    if (!(err instanceof IllegalTransitionError)) throw err;
  }
}

async function onInstallation(d: Deps, p: AnyPayload) {
  const installationId = p.installation?.id as number | undefined;
  if (!installationId || p.action === "deleted") return;
  const owner = (p.installation?.account?.login as string | undefined) ?? "";
  const repos = (p.repositories ?? p.repositories_added ?? []) as { id: number; name: string; full_name?: string }[];
  for (const r of repos) {
    const ownerName = r.full_name ? r.full_name.split("/")[0]! : owner;
    await d.store.upsertRepo({ id: r.id, owner: ownerName, name: r.name, installationId });
  }
}

/* -------------------------------- Jobs -------------------------------- */

export async function processJob(d: Deps, job: Job): Promise<void> {
  const payload = job.payload as AnyPayload;
  switch (job.kind) {
    case "webhook":
      return routeWebhook(d, payload.event as string, payload.body as AnyPayload);
    case "review":
      return runReview(d, payload.submissionId as string, payload.headSha as string, (payload.ciWaits as number | undefined) ?? 0);
    case "payout":
      return runPayout(d, payload.bountyId as string);
    case "payout-check":
      return runPayoutCheck(d, payload.bountyId as string, (payload.checks as number | undefined) ?? 0);
    case "refund":
      return runRefund(d, payload.bountyId as string);
    case "sweep":
      await runSweep(d);
      return void (await scheduleSweep(d, 60));
  }
}

export async function scheduleSweep(d: Deps, delayMinutes: number): Promise<void> {
  const at = addMinutes(d.clock.now(), delayMinutes);
  await d.store.enqueue({ kind: "sweep", key: `sweep:${at.toISOString().slice(0, 13)}`, runAt: at });
}

/** Runs the jobs that are due. Returns how many it processed. */
export async function runDueJobs(d: Deps, limit = 10): Promise<number> {
  const jobs = await d.store.claimDueJobs(d.clock.now(), limit);
  for (const job of jobs) {
    try {
      await processJob(d, job);
      await d.store.completeJob(job.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      d.log(`job ${job.kind} failed (attempt ${job.attempts})`, message);
      if (job.attempts >= MAX_JOB_ATTEMPTS) {
        await d.store.failJob(job.id, message, null);
        await onGiveUp(d, job, message);
      } else {
        await d.store.failJob(job.id, message, addMinutes(d.clock.now(), Math.min(60, 2 ** job.attempts)));
      }
    }
  }
  return jobs.length;
}

async function onGiveUp(d: Deps, job: Job, message: string) {
  if (job.kind === "review") {
    await flagForManualReview(d, job.payload.submissionId as string, message).catch((e) => d.log("flag after failure failed", e));
  }
}
