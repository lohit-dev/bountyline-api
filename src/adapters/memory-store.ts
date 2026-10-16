import { DEFAULT_SETTINGS } from "../core/config";
import type { BountyStatus } from "../core/state";
import {
  TERMINAL_FOR_ISSUE,
  type Bounty,
  type BountyEventRow,
  type Job,
  type JobKind,
  type Payout,
  type PayoutAccount,
  type Picker,
  type Refund,
  type Repo,
  type RepoRef,
  type Review,
  type Submission,
} from "../domain";
import type { NewBounty, Store } from "../ports";

const copy = <T>(v: T): T => structuredClone(v);

/** In-memory Store. Used by the tests and handy for running the app without a database. */
export class MemoryStore implements Store {
  repos = new Map<number, Repo>();
  bounties = new Map<string, Bounty>();
  submissions = new Map<string, Submission>();
  reviews: Review[] = [];
  payouts = new Map<string, Payout>(); // by bountyId
  refunds = new Map<string, Refund>(); // by bountyId
  events: BountyEventRow[] = [];
  pickers = new Map<string, Picker>();
  accounts = new Map<number, PayoutAccount>();
  jobs = new Map<string, Job>(); // by key
  private seq = 0;

  async upsertRepo(r: RepoRef): Promise<Repo> {
    const existing = this.repos.get(r.id);
    const repo: Repo = existing
      ? { ...existing, ...r }
      : { ...r, settings: { ...DEFAULT_SETTINGS }, createdAt: new Date() };
    this.repos.set(r.id, repo);
    return copy(repo);
  }
  async getRepo(id: number) {
    const r = this.repos.get(id);
    return r ? copy(r) : null;
  }
  async listRepos() {
    return [...this.repos.values()].map(copy);
  }

  async createBounty(b: NewBounty): Promise<Bounty | null> {
    if (await this.findActiveBountyByIssue(b.repoId, b.issueNumber)) return null;
    const bounty: Bounty = {
      ...b,
      submissionId: null,
      issueCommentId: null,
      paypalOrderId: null,
      paypalCaptureId: null,
      fundedAt: null,
      expiresAt: null,
      windowEndsAt: null,
    };
    this.bounties.set(bounty.id, bounty);
    return copy(bounty);
  }
  async getBounty(id: string) {
    const b = this.bounties.get(id);
    return b ? copy(b) : null;
  }
  async getBountyByToken(token: string) {
    for (const b of this.bounties.values()) if (b.fundToken === token) return copy(b);
    return null;
  }
  async findActiveBountyByIssue(repoId: number, issueNumber: number) {
    for (const b of this.bounties.values()) {
      if (b.repoId === repoId && b.issueNumber === issueNumber && !TERMINAL_FOR_ISSUE.includes(b.status)) return copy(b);
    }
    return null;
  }
  async updateBounty(id: string, patch: Partial<Bounty>) {
    const b = this.bounties.get(id);
    if (!b) throw new Error(`bounty ${id} not found`);
    Object.assign(b, patch);
    return copy(b);
  }
  async casBountyStatus(id: string, from: BountyStatus, to: BountyStatus, patch: Partial<Bounty> = {}) {
    const b = this.bounties.get(id);
    if (!b || b.status !== from) return null;
    Object.assign(b, patch, { status: to });
    return copy(b);
  }
  async listBountiesByStatus(statuses: BountyStatus[]) {
    return [...this.bounties.values()].filter((b) => statuses.includes(b.status)).map(copy);
  }
  async listBountiesByRepos(repoIds: number[]) {
    return [...this.bounties.values()].filter((b) => repoIds.includes(b.repoId)).map(copy);
  }
  async listBountiesForUser(userId: number) {
    const mine = new Set<string>();
    for (const s of this.submissions.values()) if (s.authorGithubId === userId) mine.add(s.bountyId);
    return [...this.bounties.values()].filter((b) => b.funderGithubId === userId || mine.has(b.id)).map(copy);
  }

  async findSubmission(bountyId: string, prNumber: number) {
    for (const s of this.submissions.values()) if (s.bountyId === bountyId && s.prNumber === prNumber) return copy(s);
    return null;
  }
  async findSubmissionsByPr(repoId: number, prNumber: number) {
    return [...this.submissions.values()].filter((s) => s.repoId === repoId && s.prNumber === prNumber).map(copy);
  }
  async getSubmission(id: string) {
    const s = this.submissions.get(id);
    return s ? copy(s) : null;
  }
  async listSubmissions(bountyId: string) {
    return [...this.submissions.values()].filter((s) => s.bountyId === bountyId).map(copy);
  }
  async saveSubmission(s: Submission) {
    this.submissions.set(s.id, copy(s));
    return copy(s);
  }

  async addReview(r: Review) {
    this.reviews.push(copy(r));
    return copy(r);
  }
  async latestReview(submissionId: string) {
    const all = this.reviews.filter((r) => r.submissionId === submissionId);
    const last = all[all.length - 1];
    return last ? copy(last) : null;
  }
  async reviewForSha(submissionId: string, headSha: string) {
    const r = this.reviews.find((x) => x.submissionId === submissionId && x.headSha === headSha);
    return r ? copy(r) : null;
  }
  async countReviews(submissionId: string) {
    return this.reviews.filter((r) => r.submissionId === submissionId).length;
  }

  async getPayout(bountyId: string) {
    const p = this.payouts.get(bountyId);
    return p ? copy(p) : null;
  }
  async savePayout(p: Payout) {
    this.payouts.set(p.bountyId, copy(p));
    return copy(p);
  }
  async getRefund(bountyId: string) {
    const r = this.refunds.get(bountyId);
    return r ? copy(r) : null;
  }
  async saveRefund(r: Refund) {
    this.refunds.set(r.bountyId, copy(r));
    return copy(r);
  }

  async addEvent(e: BountyEventRow) {
    this.events.push(copy(e));
  }
  async listEvents(bountyId: string) {
    return this.events.filter((e) => e.bountyId === bountyId).map(copy);
  }

  async savePicker(p: Picker) {
    this.pickers.set(p.id, copy(p));
    return copy(p);
  }
  async getPicker(id: string) {
    const p = this.pickers.get(id);
    return p ? copy(p) : null;
  }
  async usePicker(id: string) {
    const p = this.pickers.get(id);
    if (!p || p.state !== "open") return false;
    p.state = "used";
    return true;
  }

  async getPayoutAccount(id: number) {
    const a = this.accounts.get(id);
    return a ? copy(a) : null;
  }
  async savePayoutAccount(a: PayoutAccount) {
    this.accounts.set(a.githubUserId, copy(a));
  }

  async enqueue(job: { kind: JobKind; key: string; payload?: Record<string, unknown>; runAt: Date }, opts: { replace?: boolean } = {}) {
    const existing = this.jobs.get(job.key);
    if (existing) {
      if (opts.replace && existing.state === "pending") {
        existing.runAt = job.runAt;
        existing.payload = job.payload ?? existing.payload;
        return true;
      }
      return false;
    }
    this.jobs.set(job.key, {
      id: `job_${++this.seq}`,
      kind: job.kind,
      key: job.key,
      payload: job.payload ?? {},
      runAt: job.runAt,
      attempts: 0,
      state: "pending",
      lastError: null,
    });
    return true;
  }
  async claimDueJobs(now: Date, limit: number) {
    const due = [...this.jobs.values()]
      .filter((j) => j.state === "pending" && j.runAt <= now)
      .sort((a, b) => a.runAt.getTime() - b.runAt.getTime())
      .slice(0, limit);
    for (const j of due) {
      j.state = "running";
      j.attempts += 1;
    }
    return due.map(copy);
  }
  async completeJob(id: string) {
    for (const j of this.jobs.values()) if (j.id === id) j.state = "done";
  }
  async failJob(id: string, error: string, retryAt: Date | null) {
    for (const j of this.jobs.values()) {
      if (j.id !== id) continue;
      j.lastError = error;
      if (retryAt) {
        j.state = "pending";
        j.runAt = retryAt;
      } else {
        j.state = "failed";
      }
    }
  }

  /** Test helper: pending jobs of a kind. */
  pending(kind?: JobKind) {
    return [...this.jobs.values()].filter((j) => j.state === "pending" && (!kind || j.kind === kind));
  }
}
