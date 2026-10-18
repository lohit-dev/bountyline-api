/** Pull request events: claiming a bounty, new commits, merge, close. */
import { linkedIssueNumbers } from "../core/commands";
import { replies } from "../core/messages";
import { addDays } from "../core/rules";
import { IllegalTransitionError } from "../core/state";
import type { Bounty, Repo, Submission } from "../domain";
import { bestEffort, isBot, logEvent, repoRef, type Deps } from "./context";
import { applyEvent } from "./lifecycle";
import { upsertRepoFromPayload } from "./commands";

export type PullPayload = {
  action: string;
  number: number;
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    state: string;
    draft?: boolean;
    merged?: boolean;
    merged_at?: string | null;
    head: { sha: string };
    user: { id: number; login: string };
  };
  repository: { id: number; name: string; owner: { login: string } };
  installation?: { id: number };
  sender: { id: number; login: string; type?: string };
};

type PullLite = { number: number; title: string; body: string; draft: boolean; headSha: string; authorId: number; authorLogin: string };

const OPEN_STATES = ["funded", "claimed", "reviewed", "flagged"];

export async function handlePullRequest(d: Deps, p: PullPayload): Promise<void> {
  if (isBot(p.sender) && p.action !== "closed") return;
  const repo = await upsertRepoFromPayload(d, p);
  const pr = p.pull_request;
  const lite: PullLite = {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? "",
    draft: !!pr.draft,
    headSha: pr.head.sha,
    authorId: pr.user.id,
    authorLogin: pr.user.login,
  };
  switch (p.action) {
    case "opened":
    case "reopened":
    case "edited":
    case "ready_for_review":
    case "synchronize":
      return syncPull(d, repo, lite, p.action);
    case "closed":
      return onClosed(d, repo, lite, !!pr.merged);
  }
}

async function syncPull(d: Deps, repo: Repo, pr: PullLite, action: string) {
  // Already-linked submissions: track new commits even if the description changed.
  for (const sub of await d.store.findSubmissionsByPr(repo.id, pr.number)) {
    if (sub.status !== "open") continue;
    const bounty = await d.store.getBounty(sub.bountyId);
    if (!bounty) continue;
    if (sub.headSha !== pr.headSha) await onNewCommits(d, bounty, sub, pr.headSha, pr.draft);
    else if (action === "ready_for_review") await enqueueReview(d, sub);
  }
  // New links through "Closes #N".
  for (const issueNumber of linkedIssueNumbers(pr.body, repo)) {
    const bounty = await d.store.findActiveBountyByIssue(repo.id, issueNumber);
    if (bounty) await claimPull(d, repo, bounty, pr, action === "opened");
  }
}

export async function claimPull(d: Deps, repo: Repo, bounty: Bounty, pr: PullLite, announce: boolean): Promise<void> {
  // Ignore until funded; funding links open PRs later (see linkOpenPulls).
  if (!OPEN_STATES.includes(bounty.status)) return;
  if (pr.authorId === bounty.funderGithubId) {
    if (announce) await bestEffort(d, "funder claim", () => d.github.createComment(repoRef(repo), pr.number, replies.funderCannotClaim(pr.authorLogin)));
    return;
  }
  if (await d.store.findSubmission(bounty.id, pr.number)) return;

  const sub: Submission = {
    id: d.newId(),
    bountyId: bounty.id,
    repoId: repo.id,
    prNumber: pr.number,
    authorGithubId: pr.authorId,
    authorLogin: pr.authorLogin,
    headSha: pr.headSha,
    status: "open",
    mergedAt: null,
    commentId: null,
    createdAt: d.clock.now(),
  };
  await d.store.saveSubmission(sub);
  await logEvent(d, bounty.id, "pr_linked", pr.authorLogin, { pr: pr.number });

  if (bounty.status === "funded") {
    await applyEvent(d, bounty.id, "PR_LINKED", pr.authorLogin, {
      patch: { submissionId: sub.id, expiresAt: addDays(d.clock.now(), repo.settings.claimExpiryDays) },
      data: { pr: pr.number },
    });
  } else {
    await bestEffort(d, "second pr note", () =>
      d.github.createComment(repoRef(repo), pr.number, `Another pull request currently carries this bounty. This one is reviewed too, and the first one that is merged and passes review is paid.`),
    );
  }
  if (!pr.draft) await enqueueReview(d, sub);
}

/** After funding: link pull requests that were opened before the bounty was paid. */
export async function linkOpenPulls(d: Deps, bounty: Bounty): Promise<void> {
  const repo = await d.store.getRepo(bounty.repoId);
  if (!repo) return;
  const pulls = await d.github.listOpenPulls(repoRef(repo));
  for (const pr of pulls) {
    if (!linkedIssueNumbers(pr.body, repo).includes(bounty.issueNumber)) continue;
    const fresh = await d.store.getBounty(bounty.id);
    if (!fresh) return;
    await claimPull(d, repo, fresh, { number: pr.number, title: pr.title, body: pr.body, draft: pr.draft, headSha: pr.headSha, authorId: pr.authorId, authorLogin: pr.authorLogin }, false);
  }
}

export async function enqueueReview(d: Deps, sub: Submission, delayMinutes = 0): Promise<void> {
  await d.store.enqueue({
    kind: "review",
    key: `review:${sub.id}:${sub.headSha}`,
    payload: { submissionId: sub.id, headSha: sub.headSha },
    runAt: new Date(d.clock.now().getTime() + delayMinutes * 60_000),
  });
}

async function onNewCommits(d: Deps, bounty: Bounty, sub: Submission, newSha: string, draft: boolean) {
  const updated = await d.store.saveSubmission({ ...sub, headSha: newSha });
  await logEvent(d, bounty.id, "new_commits", "github", { pr: sub.prNumber, sha: newSha.slice(0, 7) });
  if (bounty.submissionId === sub.id && bounty.status === "reviewed") {
    await applyEvent(d, bounty.id, "REVIEW_STALE", "system", { data: { pr: sub.prNumber } });
  }
  if (!draft) await enqueueReview(d, updated);
}

async function onClosed(d: Deps, repo: Repo, pr: PullLite, merged: boolean) {
  for (const sub of await d.store.findSubmissionsByPr(repo.id, pr.number)) {
    if (sub.status !== "open") continue;
    const bounty = await d.store.getBounty(sub.bountyId);
    if (!bounty) continue;
    if (merged) await onMerged(d, bounty, sub, pr.headSha);
    else await onClosedUnmerged(d, bounty, sub);
  }
}

async function onMerged(d: Deps, bounty: Bounty, sub: Submission, finalSha: string) {
  const now = d.clock.now();
  // GitHub does not guarantee webhook order: the "merged" event can arrive before the last
  // "synchronize". The merge event carries the final head commit, so trust it. If it differs
  // from what was reviewed, the state machine sends the bounty back for a fresh review.
  await d.store.saveSubmission({ ...sub, headSha: finalSha || sub.headSha, status: "merged", mergedAt: now });
  await logEvent(d, bounty.id, "pr_merged", "github", { pr: sub.prNumber });
  if (!["claimed", "reviewed", "flagged"].includes(bounty.status)) return; // already decided another way

  // The first PR that merges wins; the others are superseded.
  for (const other of await d.store.listSubmissions(bounty.id)) {
    if (other.id !== sub.id && other.status === "open") await d.store.saveSubmission({ ...other, status: "superseded" });
  }
  if (bounty.submissionId !== sub.id) {
    await d.store.updateBounty(bounty.id, { submissionId: sub.id });
    if (bounty.status !== "claimed") await applyEvent(d, bounty.id, "SUBMISSION_CHANGED", "system", { data: { pr: sub.prNumber } });
  }
  try {
    await applyEvent(d, bounty.id, "PR_MERGED", "github", { data: { pr: sub.prNumber } });
  } catch (err) {
    if (!(err instanceof IllegalTransitionError)) throw err;
  }
}

async function onClosedUnmerged(d: Deps, bounty: Bounty, sub: Submission) {
  await d.store.saveSubmission({ ...sub, status: "closed" });
  await logEvent(d, bounty.id, "pr_closed", "github", { pr: sub.prNumber });
  if (bounty.submissionId !== sub.id || !["claimed", "reviewed", "flagged"].includes(bounty.status)) return;

  const next = (await d.store.listSubmissions(bounty.id)).find((s) => s.id !== sub.id && s.status === "open");
  if (next) {
    await d.store.updateBounty(bounty.id, { submissionId: next.id });
    await applyEvent(d, bounty.id, "SUBMISSION_CHANGED", "system", { data: { pr: next.prNumber } });
    await enqueueReview(d, next);
  } else {
    const repo = await d.store.getRepo(bounty.repoId);
    await applyEvent(d, bounty.id, "PR_CLOSED", "github", {
      patch: { submissionId: null, expiresAt: addDays(d.clock.now(), repo?.settings.expiryDays ?? 30) },
    });
  }
}
