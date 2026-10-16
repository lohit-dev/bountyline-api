/**
 * Interfaces between the business logic and the outside world.
 * The logic in src/services only depends on these, so it can be tested with fakes.
 */
import type {
  Bounty,
  BountyEventRow,
  CiState,
  Job,
  JobKind,
  Payout,
  PayoutAccount,
  Permission,
  Picker,
  Refund,
  Repo,
  RepoRef,
  Review,
  Submission,
} from "./domain";
import type { BountyStatus } from "./core/state";

export interface Clock {
  now(): Date;
}

/* ------------------------------- Store -------------------------------- */

export type NewBounty = Omit<Bounty, "submissionId" | "issueCommentId" | "paypalOrderId" | "paypalCaptureId" | "fundedAt" | "expiresAt" | "windowEndsAt">;

export interface Store {
  upsertRepo(r: RepoRef): Promise<Repo>;
  getRepo(id: number): Promise<Repo | null>;
  listRepos(): Promise<Repo[]>;

  /** Returns null when the issue already has an active bounty (one per issue). */
  createBounty(b: NewBounty): Promise<Bounty | null>;
  getBounty(id: string): Promise<Bounty | null>;
  getBountyByToken(token: string): Promise<Bounty | null>;
  /** The bounty that is still live for this issue (not cancelled, expired, vetoed or refunded). */
  findActiveBountyByIssue(repoId: number, issueNumber: number): Promise<Bounty | null>;
  updateBounty(id: string, patch: Partial<Bounty>): Promise<Bounty>;
  /** Compare-and-set on status. Returns null if the status was not `from`. */
  casBountyStatus(id: string, from: BountyStatus, to: BountyStatus, patch?: Partial<Bounty>): Promise<Bounty | null>;
  listBountiesByStatus(statuses: BountyStatus[]): Promise<Bounty[]>;
  listBountiesByRepos(repoIds: number[]): Promise<Bounty[]>;
  listBountiesForUser(githubUserId: number): Promise<Bounty[]>;

  findSubmission(bountyId: string, prNumber: number): Promise<Submission | null>;
  findSubmissionsByPr(repoId: number, prNumber: number): Promise<Submission[]>;
  getSubmission(id: string): Promise<Submission | null>;
  listSubmissions(bountyId: string): Promise<Submission[]>;
  saveSubmission(s: Submission): Promise<Submission>;

  addReview(r: Review): Promise<Review>;
  latestReview(submissionId: string): Promise<Review | null>;
  reviewForSha(submissionId: string, headSha: string): Promise<Review | null>;
  countReviews(submissionId: string): Promise<number>;

  getPayout(bountyId: string): Promise<Payout | null>;
  savePayout(p: Payout): Promise<Payout>;
  getRefund(bountyId: string): Promise<Refund | null>;
  saveRefund(r: Refund): Promise<Refund>;

  addEvent(e: BountyEventRow): Promise<void>;
  listEvents(bountyId: string): Promise<BountyEventRow[]>;

  savePicker(p: Picker): Promise<Picker>;
  getPicker(id: string): Promise<Picker | null>;
  /** Marks an open picker used. Returns false if it was already used. */
  usePicker(id: string): Promise<boolean>;

  getPayoutAccount(githubUserId: number): Promise<PayoutAccount | null>;
  savePayoutAccount(a: PayoutAccount): Promise<void>;

  /**
   * Adds a job. If the key exists: do nothing and return false, unless
   * `replace` is set and the job is still pending (then its time is updated).
   */
  enqueue(job: { kind: JobKind; key: string; payload?: Record<string, unknown>; runAt: Date }, opts?: { replace?: boolean }): Promise<boolean>;
  /** Claims due jobs (marks them running). */
  claimDueJobs(now: Date, limit: number): Promise<Job[]>;
  completeJob(id: string): Promise<void>;
  /** Schedules a retry at `retryAt`, or marks the job failed when it is null. */
  failJob(id: string, error: string, retryAt: Date | null): Promise<void>;
}

/* ------------------------------- GitHub ------------------------------- */

export type IssueInfo = { number: number; title: string; body: string; state: "open" | "closed"; authorLogin: string };
export type PullInfo = {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  mergedAt: Date | null;
  headSha: string;
  authorId: number;
  authorLogin: string;
  additions: number;
  deletions: number;
  changedFiles: number;
};
export type PullFile = { filename: string; status: string; additions: number; deletions: number; patch?: string };
export type CiStatus = { state: CiState; failing: string[] };
export type CheckRunInput = {
  name: string;
  headSha: string;
  status: "in_progress" | "completed";
  /** Never "failure": the bot must not block merging. */
  conclusion?: "success" | "neutral";
  title: string;
  summary: string;
  actions?: { label: string; description: string; identifier: string }[];
  existingId?: number | null;
};

export interface GitHubPort {
  getPermission(repo: RepoRef, login: string): Promise<Permission>;
  createComment(repo: RepoRef, issueNumber: number, body: string): Promise<number>;
  updateComment(repo: RepoRef, commentId: number, body: string): Promise<void>;
  getIssue(repo: RepoRef, issueNumber: number): Promise<IssueInfo>;
  getPull(repo: RepoRef, prNumber: number): Promise<PullInfo>;
  listPullFiles(repo: RepoRef, prNumber: number): Promise<PullFile[]>;
  listOpenPulls(repo: RepoRef): Promise<PullInfo[]>;
  getCiStatus(repo: RepoRef, sha: string): Promise<CiStatus>;
  upsertCheckRun(repo: RepoRef, input: CheckRunInput): Promise<number>;
  /** Makes the bot-managed labels on an issue or PR match `desired`. */
  syncLabels(repo: RepoRef, number: number, desired: string[], isManaged: (name: string) => boolean): Promise<void>;
}

/* ------------------------------- PayPal ------------------------------- */

export interface PayPalPort {
  createOrder(input: { amountCents: number; referenceId: string; requestId: string; returnUrl: string; cancelUrl: string }): Promise<{ orderId: string; approveUrl: string }>;
  captureOrder(orderId: string, requestId: string): Promise<{ captureId: string; completed: boolean; amountCents: number }>;
  refundCapture(captureId: string, requestId: string): Promise<{ refundId: string }>;
  sendPayout(input: { senderBatchId: string; itemId: string; email: string; amountCents: number; note: string; requestId: string }): Promise<{ batchId: string }>;
  getPayoutBatch(batchId: string): Promise<{ status: "pending" | "success" | "failed"; detail?: string }>;
}

/* --------------------------------- AI ---------------------------------- */

export type ReviewInput = {
  issue: { title: string; body: string };
  pr: { title: string; body: string };
  files: { filename: string; patch: string }[];
  droppedFiles: string[];
  ci: CiStatus;
};
export type ReviewVerdict = {
  rubric: Record<string, number>;
  score: number;
  recommendation: "approve" | "needs_review";
  summary: string;
  redFlags: string[];
  model: string;
};
export interface ReviewerPort {
  review(input: ReviewInput): Promise<ReviewVerdict>;
}
