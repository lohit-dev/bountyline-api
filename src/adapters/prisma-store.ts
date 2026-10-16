/**
 * Postgres implementation of Store using Prisma 7 (driver adapter).
 * VERIFY: this file could not be typechecked or run where it was written, because the
 * Prisma client is generated on your machine (`bunx --bun prisma generate`).
 * The behaviour it must match is pinned down by MemoryStore and test/services.test.ts.
 */
import { DEFAULT_SETTINGS } from "../core/config";
import type { BountyStatus } from "../core/state";
import {
  TERMINAL_FOR_ISSUE,
  type Bounty, type BountyEventRow, type Job, type JobKind, type Payout, type PayoutAccount, type Picker,
  type Refund, type Repo, type RepoRef, type Review, type Submission,
} from "../domain";
import type { NewBounty, Store } from "../ports";
import type { PrismaClient } from "../../generated/prisma/client";

const STALE_JOB_MS = 10 * 60_000;
const num = (v: bigint | number | null | undefined) => (v === null || v === undefined ? null : Number(v));
const big = (v: number | null | undefined) => (v === null || v === undefined ? null : BigInt(v));
const isUnique = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";

const toRepo = (r: any): Repo => ({ id: r.id, owner: r.owner, name: r.name, installationId: r.installationId, settings: { ...DEFAULT_SETTINGS, ...(r.settings as object) }, createdAt: r.createdAt });
const toBounty = (b: any): Bounty => ({
  id: b.id, repoId: b.repoId, issueNumber: b.issueNumber, amountCents: b.amountCents, currency: "USD", status: b.status,
  funderGithubId: b.funderGithubId, funderLogin: b.funderLogin, fundToken: b.fundToken,
  paypalOrderId: b.paypalOrderId, paypalCaptureId: b.paypalCaptureId, submissionId: b.submissionId,
  issueCommentId: num(b.issueCommentId), fundedAt: b.fundedAt, expiresAt: b.expiresAt, windowEndsAt: b.windowEndsAt, createdAt: b.createdAt,
});
const toSubmission = (s: any): Submission => ({
  id: s.id, bountyId: s.bountyId, repoId: s.repoId, prNumber: s.prNumber, authorGithubId: s.authorGithubId, authorLogin: s.authorLogin,
  headSha: s.headSha, status: s.status, mergedAt: s.mergedAt, commentId: num(s.commentId), createdAt: s.createdAt,
});
const toReview = (r: any): Review => ({
  id: r.id, submissionId: r.submissionId, headSha: r.headSha, score: r.score, rubric: r.rubric as Record<string, number>, summary: r.summary,
  redFlags: r.redFlags as string[], recommendation: r.recommendation, ci: r.ci, passed: r.passed, model: r.model, createdAt: r.createdAt,
});
const toPayout = (p: any): Payout => ({ ...p });
const toRefund = (r: any): Refund => ({ ...r });
const toJob = (j: any): Job => ({ id: j.id, kind: j.kind, key: j.key, payload: j.payload as Record<string, unknown>, runAt: j.runAt, attempts: j.attempts, state: j.state, lastError: j.lastError });

/** Converts a domain patch to Prisma data. Keeps activeKey in step with the status. */
function bountyData(patch: Partial<Bounty>, repoIdForKey?: { repoId: number; issueNumber: number }) {
  const { issueCommentId, ...rest } = patch as Partial<Bounty> & { issueCommentId?: number | null };
  const data: Record<string, unknown> = { ...rest };
  if ("issueCommentId" in patch) data.issueCommentId = big(issueCommentId);
  if (patch.status && TERMINAL_FOR_ISSUE.includes(patch.status)) data.activeKey = null;
  void repoIdForKey;
  return data;
}

export class PrismaStore implements Store {
  constructor(private db: PrismaClient) {}

  async upsertRepo(r: RepoRef): Promise<Repo> {
    const row = await this.db.repo.upsert({
      where: { id: r.id },
      create: { id: r.id, owner: r.owner, name: r.name, installationId: r.installationId, settings: { ...DEFAULT_SETTINGS } as any },
      update: { owner: r.owner, name: r.name, installationId: r.installationId },
    });
    return toRepo(row);
  }
  async getRepo(id: number) {
    const r = await this.db.repo.findUnique({ where: { id } });
    return r ? toRepo(r) : null;
  }
  async listRepos() {
    return (await this.db.repo.findMany()).map(toRepo);
  }

  async createBounty(b: NewBounty): Promise<Bounty | null> {
    try {
      const row = await this.db.bounty.create({ data: { ...b, activeKey: `${b.repoId}:${b.issueNumber}` } });
      return toBounty(row);
    } catch (e) {
      if (isUnique(e) && !(await this.getBountyByToken(b.fundToken))) return null; // the activeKey index: issue already has a live bounty
      throw e;
    }
  }
  async getBounty(id: string) {
    const b = await this.db.bounty.findUnique({ where: { id } });
    return b ? toBounty(b) : null;
  }
  async getBountyByToken(token: string) {
    const b = await this.db.bounty.findUnique({ where: { fundToken: token } });
    return b ? toBounty(b) : null;
  }
  async findActiveBountyByIssue(repoId: number, issueNumber: number) {
    const b = await this.db.bounty.findUnique({ where: { activeKey: `${repoId}:${issueNumber}` } });
    return b ? toBounty(b) : null;
  }
  async updateBounty(id: string, patch: Partial<Bounty>) {
    return toBounty(await this.db.bounty.update({ where: { id }, data: bountyData(patch) as any }));
  }
  async casBountyStatus(id: string, from: BountyStatus, to: BountyStatus, patch: Partial<Bounty> = {}) {
    const res = await this.db.bounty.updateMany({ where: { id, status: from }, data: bountyData({ ...patch, status: to }) as any });
    if (res.count === 0) return null;
    return this.getBounty(id);
  }
  async listBountiesByStatus(statuses: BountyStatus[]) {
    return (await this.db.bounty.findMany({ where: { status: { in: statuses } } })).map(toBounty);
  }
  async listBountiesByRepos(repoIds: number[]) {
    return (await this.db.bounty.findMany({ where: { repoId: { in: repoIds } }, orderBy: { createdAt: "desc" } })).map(toBounty);
  }
  async listBountiesForUser(userId: number) {
    const rows = await this.db.bounty.findMany({
      where: { OR: [{ funderGithubId: userId }, { submissions: { some: { authorGithubId: userId } } }] },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toBounty);
  }

  async findSubmission(bountyId: string, prNumber: number) {
    const s = await this.db.submission.findUnique({ where: { bountyId_prNumber: { bountyId, prNumber } } });
    return s ? toSubmission(s) : null;
  }
  async findSubmissionsByPr(repoId: number, prNumber: number) {
    return (await this.db.submission.findMany({ where: { repoId, prNumber } })).map(toSubmission);
  }
  async getSubmission(id: string) {
    const s = await this.db.submission.findUnique({ where: { id } });
    return s ? toSubmission(s) : null;
  }
  async listSubmissions(bountyId: string) {
    return (await this.db.submission.findMany({ where: { bountyId }, orderBy: { createdAt: "asc" } })).map(toSubmission);
  }
  async saveSubmission(s: Submission) {
    const data = { ...s, commentId: big(s.commentId) };
    const { id, ...update } = data;
    return toSubmission(await this.db.submission.upsert({ where: { id }, create: data, update }));
  }

  async addReview(r: Review) {
    return toReview(await this.db.review.create({ data: { ...r, rubric: r.rubric as any, redFlags: r.redFlags as any } }));
  }
  async latestReview(submissionId: string) {
    const r = await this.db.review.findFirst({ where: { submissionId }, orderBy: { createdAt: "desc" } });
    return r ? toReview(r) : null;
  }
  async reviewForSha(submissionId: string, headSha: string) {
    const r = await this.db.review.findFirst({ where: { submissionId, headSha } });
    return r ? toReview(r) : null;
  }
  async countReviews(submissionId: string) {
    return this.db.review.count({ where: { submissionId } });
  }

  async getPayout(bountyId: string) {
    const p = await this.db.payout.findUnique({ where: { bountyId } });
    return p ? toPayout(p) : null;
  }
  async savePayout(p: Payout) {
    const { id, ...update } = p;
    return toPayout(await this.db.payout.upsert({ where: { bountyId: p.bountyId }, create: p, update }));
  }
  async getRefund(bountyId: string) {
    const r = await this.db.refund.findUnique({ where: { bountyId } });
    return r ? toRefund(r) : null;
  }
  async saveRefund(r: Refund) {
    const { id, ...update } = r;
    return toRefund(await this.db.refund.upsert({ where: { bountyId: r.bountyId }, create: r, update }));
  }

  async addEvent(e: BountyEventRow) {
    await this.db.bountyEvent.create({ data: { ...e, data: e.data as any } });
  }
  async listEvents(bountyId: string) {
    const rows = await this.db.bountyEvent.findMany({ where: { bountyId }, orderBy: { createdAt: "asc" } });
    return rows.map((e: any) => ({ id: e.id, bountyId: e.bountyId, type: e.type, actor: e.actor, data: e.data as Record<string, unknown>, createdAt: e.createdAt }));
  }

  private toPicker(p: any): Picker {
    return { id: p.id, repoId: p.repoId, issueNumber: p.issueNumber, commentId: num(p.commentId), optionsCents: p.optionsCents as number[], createdByGithubId: p.createdByGithubId, state: p.state, createdAt: p.createdAt };
  }
  async savePicker(p: Picker) {
    const data = { ...p, commentId: big(p.commentId), optionsCents: p.optionsCents as any };
    const { id, ...update } = data;
    return this.toPicker(await this.db.picker.upsert({ where: { id }, create: data, update }));
  }
  async getPicker(id: string) {
    const p = await this.db.picker.findUnique({ where: { id } });
    return p ? this.toPicker(p) : null;
  }
  async usePicker(id: string) {
    const res = await this.db.picker.updateMany({ where: { id, state: "open" }, data: { state: "used" } });
    return res.count === 1;
  }

  async getPayoutAccount(id: number): Promise<PayoutAccount | null> {
    const a = await this.db.payoutAccount.findUnique({ where: { githubUserId: id } });
    return a ? { githubUserId: a.githubUserId, githubLogin: a.githubLogin, paypalEmailEnc: a.paypalEmailEnc, createdAt: a.createdAt, updatedAt: a.updatedAt } : null;
  }
  async savePayoutAccount(a: PayoutAccount) {
    await this.db.payoutAccount.upsert({
      where: { githubUserId: a.githubUserId },
      create: a,
      update: { githubLogin: a.githubLogin, paypalEmailEnc: a.paypalEmailEnc, updatedAt: a.updatedAt },
    });
  }

  async enqueue(job: { kind: JobKind; key: string; payload?: Record<string, unknown>; runAt: Date }, opts: { replace?: boolean } = {}) {
    try {
      await this.db.job.create({ data: { id: crypto.randomUUID(), kind: job.kind, key: job.key, payload: (job.payload ?? {}) as any, runAt: job.runAt } });
      return true;
    } catch (e) {
      if (!isUnique(e)) throw e;
      if (!opts.replace) return false;
      const res = await this.db.job.updateMany({
        where: { key: job.key, state: { not: "running" } },
        data: { state: "pending", attempts: 0, lastError: null, runAt: job.runAt, ...(job.payload ? { payload: job.payload as any } : {}) },
      });
      return res.count > 0;
    }
  }
  /** FOR UPDATE SKIP LOCKED lets several workers run safely. Jobs stuck "running" for 10 minutes are taken again. */
  async claimDueJobs(now: Date, limit: number) {
    const stale = new Date(now.getTime() - STALE_JOB_MS);
    const rows = await this.db.$queryRaw<any[]>`
      UPDATE "Job" SET "state" = 'running', "attempts" = "attempts" + 1, "lockedAt" = ${now}
      WHERE "id" IN (
        SELECT "id" FROM "Job"
        WHERE ("state" = 'pending' AND "runAt" <= ${now}) OR ("state" = 'running' AND "lockedAt" < ${stale})
        ORDER BY "runAt" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "kind", "key", "payload", "runAt", "attempts", "state", "lastError"`;
    return rows.map(toJob);
  }
  async completeJob(id: string) {
    await this.db.job.update({ where: { id }, data: { state: "done", lockedAt: null } });
  }
  async failJob(id: string, error: string, retryAt: Date | null) {
    await this.db.job.update({
      where: { id },
      data: retryAt ? { state: "pending", runAt: retryAt, lastError: error, lockedAt: null } : { state: "failed", lastError: error, lockedAt: null },
    });
  }
}
