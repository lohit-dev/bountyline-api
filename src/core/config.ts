/** Default per-repo settings. See PROJECT_CONTEXT.md section 5.5. */
export const DEFAULT_SETTINGS = {
  /** Hours between merge and payout, during which a maintainer can veto. */
  reviewWindowHours: 48,
  /** AI score (0-100) needed to schedule a payout automatically. */
  scoreThreshold: 75,
  /** Days an unclaimed bounty stays open before it is refunded. */
  expiryDays: 30,
  /** Days a bounty with an open PR can sit before it is refunded. */
  claimExpiryDays: 60,
  /** Days a flagged bounty waits for a maintainer decision before it is refunded. */
  flaggedExpiryDays: 14,
  /** Days a bounty can wait for funding before it is cancelled (no money involved). */
  unfundedExpiryDays: 3,
  /** Maximum AI reviews per PR, so pushing commits cannot run up cost. */
  maxReviewsPerPr: 5,
  /** PRs with more changed lines than this are not reviewed automatically. */
  maxChangedLines: 1500,
  /** Amount limits in cents (USD only). */
  minAmountCents: 500,
  maxAmountCents: 50_000,
  /** Days to wait for a contributor to set a payout address before refunding. */
  payoutAddressWaitDays: 14,
} as const;

export type RepoSettings = {
  reviewWindowHours: number;
  scoreThreshold: number;
  expiryDays: number;
  claimExpiryDays: number;
  flaggedExpiryDays: number;
  unfundedExpiryDays: number;
  maxReviewsPerPr: number;
  maxChangedLines: number;
  minAmountCents: number;
  maxAmountCents: number;
  payoutAddressWaitDays: number;
};

export const CURRENCY = "USD" as const;
