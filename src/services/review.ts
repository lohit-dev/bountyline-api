/** Runs the AI review for one commit of a pull request and moves the bounty on. */
import { reviewSummary } from "../core/messages";
import { passesReview } from "../core/rules";
import { IllegalTransitionError } from "../core/state";
import type { Review } from "../domain";
import { filterFiles } from "../review/filter";
import { bestEffort, logEvent, repoRef, type Deps } from "./context";
import { applyEvent, refreshView } from "./lifecycle";

const CHECK_NAME = "Bountyline AI review";
const MAX_CI_WAITS = 6;

export async function runReview(d: Deps, submissionId: string, headSha: string, ciWaits = 0): Promise<void> {
  const sub = await d.store.getSubmission(submissionId);
  if (!sub || sub.headSha !== headSha) return; // newer commits: a newer job exists
  if (sub.status === "superseded" || sub.status === "closed") return;
  const bounty = await d.store.getBounty(sub.bountyId);
  if (!bounty || !["claimed", "reviewed", "flagged"].includes(bounty.status)) return;
  const repo = await d.store.getRepo(bounty.repoId);
  if (!repo) return;
  const ref = repoRef(repo);
  const settings = repo.settings;

  let review = await d.store.reviewForSha(sub.id, headSha);
  let checkRunId: number | null = null;

  if (!review) {
    if ((await d.store.countReviews(sub.id)) >= settings.maxReviewsPerPr) {
      await logEvent(d, bounty.id, "review_limit", "system", { pr: sub.prNumber });
      return;
    }
    const pr = await d.github.getPull(ref, sub.prNumber);
    if (pr.headSha !== headSha) return;

    const ci = await d.github.getCiStatus(ref, headSha);
    if (ci.state === "pending" && ciWaits < MAX_CI_WAITS) {
      // CI is still running: look again in ten minutes instead of judging half a picture.
      await d.store.enqueue({
        kind: "review",
        key: `review:${sub.id}:${headSha}:ci${ciWaits + 1}`,
        payload: { submissionId: sub.id, headSha, ciWaits: ciWaits + 1 },
        runAt: new Date(d.clock.now().getTime() + 10 * 60_000),
      });
      return;
    }
    const ciState = ci.state === "pending" ? "none" : ci.state;

    checkRunId = await d.github.upsertCheckRun(ref, {
      name: CHECK_NAME,
      headSha,
      status: "in_progress",
      title: "Reviewing",
      summary: "The AI review is running.",
    }).catch(() => null);

    const filtered = filterFiles(await d.github.listPullFiles(ref, sub.prNumber));
    let rubric: Record<string, number> = { solves_issue: 0, scope: 0, tests_ci: 0, quality: 0, red_flags: 0 };
    let score = 0;
    let summary: string;
    let redFlags: string[] = [];
    let recommendation: "approve" | "needs_review" = "needs_review";
    let model = "none";

    if (filtered.changedLines > settings.maxChangedLines) {
      summary = `This pull request changes ${filtered.changedLines} lines, above the limit of ${settings.maxChangedLines} for automatic review. A maintainer needs to decide, or the author can split it.`;
    } else if (filtered.kept.length === 0) {
      summary = "There are no reviewable code changes in this pull request (only lockfiles, generated or binary files). A maintainer needs to decide.";
    } else {
      const issue = await d.github.getIssue(ref, bounty.issueNumber);
      const verdict = await d.reviewer.review({
        issue: { title: issue.title, body: issue.body },
        pr: { title: pr.title, body: pr.body },
        files: filtered.kept.map((f) => ({ filename: f.filename, patch: f.patch })),
        droppedFiles: filtered.dropped,
        ci,
      });
      ({ rubric, score, summary, redFlags, recommendation, model } = verdict);
    }

    const passed = passesReview({ score, threshold: settings.scoreThreshold, recommendation, ci: ciState });
    const row: Review = {
      id: d.newId(),
      submissionId: sub.id,
      headSha,
      score,
      rubric,
      summary,
      redFlags,
      recommendation,
      ci: ciState,
      passed,
      model,
      createdAt: d.clock.now(),
    };
    review = await d.store.addReview(row);
    await logEvent(d, bounty.id, "review", "ai", { pr: sub.prNumber, score, passed, sha: headSha.slice(0, 7) });
  }

  const out = reviewSummary({
    score: review.score,
    threshold: settings.scoreThreshold,
    rubric: review.rubric,
    summary: review.summary,
    redFlags: review.redFlags,
    ci: review.ci,
    passed: review.passed,
  });
  const isCurrent = bounty.submissionId === sub.id;
  await bestEffort(d, "check run", () =>
    d.github.upsertCheckRun(ref, {
      name: CHECK_NAME,
      headSha,
      status: "completed",
      // Never "failure": this check must not block merging.
      conclusion: review!.passed ? "success" : "neutral",
      title: out.title,
      summary: out.text,
      existingId: checkRunId,
      actions: isCurrent
        ? [
            { label: "Approve payout", description: "Pay once merged", identifier: "approve" },
            { label: "Veto payout", description: "Refund the funder", identifier: "veto" },
          ]
        : undefined,
    }),
  );

  if (isCurrent) {
    try {
      await applyEvent(d, bounty.id, review.passed ? "REVIEW_PASSED" : "REVIEW_FLAGGED", "ai", { data: { score: review.score } });
    } catch (err) {
      if (!(err instanceof IllegalTransitionError)) throw err;
    }
  }
  await refreshView(d, bounty.id);
}

/** The review kept failing (for example the AI service is down): a maintainer decides. */
export async function flagForManualReview(d: Deps, submissionId: string, reason: string): Promise<void> {
  const sub = await d.store.getSubmission(submissionId);
  if (!sub) return;
  const bounty = await d.store.getBounty(sub.bountyId);
  if (!bounty || bounty.submissionId !== sub.id || !["claimed", "reviewed"].includes(bounty.status)) return;
  await logEvent(d, bounty.id, "review_unavailable", "system", { reason });
  try {
    await applyEvent(d, bounty.id, "REVIEW_FLAGGED", "system", { data: { reason } });
  } catch (err) {
    if (!(err instanceof IllegalTransitionError)) throw err;
  }
}
