import type { RepoSettings } from "./core/config";
import type { CiState, Permission } from "./core/rules";
import type { BountyStatus } from "./core/state";

export type { Permission, CiState, BountyStatus, RepoSettings };

/** What is needed to talk to a repo through the GitHub App. */
export type RepoRef = { id: number; owner: string; name: string; installationId: number };
export type Repo = RepoRef & { settings: RepoSettings; createdAt: Date };

export type Bounty = {
  id: string;
  repoId: number;
  issueNumber: number;
  amountCents: number;
  currency: "USD";
  status: BountyStatus;
  funderGithubId: number;
  funderLogin: string;
  /** Secret in the funding link. Only the funder can use it (they must also sign in). */
  fundToken: string;
  paypalOrderId: string | null;
  paypalCaptureId: string | null;
  /** The pull request that currently carries this bounty. */
  submissionId: string | null;
  /** The bot's status comment on the issue, edited in place. */
  issueCommentId: number | null;
  fundedAt: Date | null;
  expiresAt: Date | null;
  windowEndsAt: Date | null;
  createdAt: Date;
};

export type SubmissionStatus = "open" | "merged" | "superseded" | "closed";
export type Submission = {
  id: string;
  bountyId: string;
  repoId: number;
  prNumber: number;
  authorGithubId: number;
  authorLogin: string;
  headSha: string;
  status: SubmissionStatus;
  mergedAt: Date | null;
  /** The bot's status comment on the PR, edited in place. */
  commentId: number | null;
  createdAt: Date;
};

export type Review = {
  id: string;
  submissionId: string;
  headSha: string;
  score: number;
  rubric: Record<string, number>;
  summary: string;
  redFlags: string[];
  recommendation: "approve" | "needs_review";
  ci: CiState;
  passed: boolean;
  model: string;
  createdAt: Date;
};

export type PayoutState = "scheduled" | "sending" | "sent" | "failed";
export type Payout = {
  id: string;
  bountyId: string;
  recipientGithubId: number;
  amountCents: number;
  state: PayoutState;
  idempotencyKey: string;
  paypalBatchId: string | null;
  attempts: number;
  lastError: string | null;
  sentAt: Date | null;
  createdAt: Date;
};

export type RefundReason = "cancelled" | "expired" | "vetoed";
export type RefundState = "pending" | "sent" | "failed";
export type Refund = {
  id: string;
  bountyId: string;
  amountCents: number;
  reason: RefundReason;
  state: RefundState;
  idempotencyKey: string;
  paypalRefundId: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
};

/** Audit log row. Feeds the dashboard activity list. */
export type BountyEventRow = {
  id: string;
  bountyId: string;
  type: string;
  actor: string;
  data: Record<string, unknown>;
  createdAt: Date;
};

export type Picker = {
  id: string;
  repoId: number;
  issueNumber: number;
  commentId: number | null;
  /** The amounts offered, in order. The comment text is never trusted. */
  optionsCents: number[];
  createdByGithubId: number;
  state: "open" | "used";
  createdAt: Date;
};

export type PayoutAccount = {
  githubUserId: number;
  githubLogin: string;
  /** Encrypted with ENCRYPTION_KEY. Never posted on GitHub. */
  paypalEmailEnc: string;
  createdAt: Date;
  updatedAt: Date;
};

export type JobKind = "webhook" | "review" | "payout" | "payout-check" | "refund" | "sweep";
export type JobState = "pending" | "running" | "done" | "failed";
export type Job = {
  id: string;
  kind: JobKind;
  /** Unique. Enqueuing the same key twice does nothing (or replaces, see Store.enqueue). */
  key: string;
  payload: Record<string, unknown>;
  runAt: Date;
  attempts: number;
  state: JobState;
  lastError: string | null;
};

export const TERMINAL_FOR_ISSUE: BountyStatus[] = ["cancelled", "refunded", "expired", "vetoed"];
