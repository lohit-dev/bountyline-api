/**
 * Bounty state machine. See PROJECT_CONTEXT.md section 6.
 *
 * Rules:
 * - This is the ONLY place that decides bounty status changes.
 * - `transition()` is pure: it returns the new status plus "effects" the caller
 *   must perform (start the review window, pay now, refund). It does no I/O.
 * - Applying an event that was already applied returns `noop: true` (idempotent).
 * - A payout needs BOTH a passing review AND a merged PR. Nothing reaches the
 *   `window` state (and so nothing is paid) before the PR is merged.
 */

export const BOUNTY_STATUSES = [
  "created",
  "funded",
  "claimed",
  "reviewed",
  "flagged",
  "window",
  "paid",
  "vetoed",
  "cancelled",
  "expired",
  "refunded",
] as const;
export type BountyStatus = (typeof BOUNTY_STATUSES)[number];

export type BountyEvent =
  | "FUNDED" // PayPal capture succeeded
  | "PR_LINKED" // a PR that closes the issue was opened
  | "REVIEW_PASSED" // AI score >= threshold for the current head SHA
  | "REVIEW_FLAGGED" // AI score below threshold, or review not possible
  | "REVIEW_STALE" // new commits pushed after a passing review
  | "PR_MERGED"
  | "APPROVE" // maintainer approves (and pays now)
  | "REJECT" // maintainer rejects a flagged bounty
  | "VETO" // maintainer vetoes during the window
  | "PAYOUT_SENT" // PayPal payout succeeded
  | "CANCEL"
  | "EXPIRE"
  | "REFUNDED" // PayPal refund succeeded
  | "PR_CLOSED" // the current PR was closed without merging
  | "SUBMISSION_CHANGED" // a different PR is now the one that counts
  | "PAYOUT_ABANDONED"; // contributor never set a payout address

export type Effect =
  | "START_WINDOW" // schedule payout at merge time + review window
  | "PAY_NOW" // maintainer approved: pay immediately
  | "REFUND" // refund the funder
  | "RUN_REVIEW"; // run a fresh AI review for the current head SHA

export type TransitionContext = {
  /** Is the linked PR merged right now? */
  merged: boolean;
  /**
   * Does the latest review match the PR's head SHA? Only matters for PR_MERGED.
   * Defaults to true when omitted.
   */
  reviewCurrent?: boolean;
};

type Rule = {
  to: BountyStatus;
  effects?: Effect[];
  /** Used instead of `to`/`effects` when the PR is already merged. */
  whenMerged?: { to: BountyStatus; effects?: Effect[] };
  /** Refuse unless the PR is merged. */
  needsMerged?: boolean;
};

const REFUND: Effect[] = ["REFUND"];
const START_WINDOW: Effect[] = ["START_WINDOW"];

const TABLE: Record<BountyStatus, Partial<Record<BountyEvent, Rule>>> = {
  created: {
    FUNDED: { to: "funded" },
    CANCEL: { to: "cancelled" }, // nothing was paid, nothing to refund
  },
  funded: {
    PR_LINKED: { to: "claimed" },
    CANCEL: { to: "cancelled", effects: REFUND },
    EXPIRE: { to: "expired", effects: REFUND },
  },
  claimed: {
    REVIEW_PASSED: {
      to: "reviewed",
      whenMerged: { to: "window", effects: START_WINDOW },
    },
    REVIEW_FLAGGED: { to: "flagged" },
    PR_MERGED: { to: "claimed", effects: ["RUN_REVIEW"] },
    PR_CLOSED: { to: "funded" },
    SUBMISSION_CHANGED: { to: "claimed" },
    CANCEL: { to: "cancelled", effects: REFUND },
    EXPIRE: { to: "expired", effects: REFUND },
  },
  reviewed: {
    PR_MERGED: { to: "window", effects: START_WINDOW }, // see transition(): stale review check
    REVIEW_FLAGGED: { to: "flagged" },
    REVIEW_STALE: { to: "claimed" },
    PR_CLOSED: { to: "funded" },
    SUBMISSION_CHANGED: { to: "claimed" },
    CANCEL: { to: "cancelled", effects: REFUND },
    EXPIRE: { to: "expired", effects: REFUND },
  },
  flagged: {
    REVIEW_PASSED: {
      to: "reviewed",
      whenMerged: { to: "window", effects: START_WINDOW },
    },
    PR_MERGED: { to: "flagged" }, // merged, but waits for a maintainer decision
    APPROVE: { to: "window", effects: ["PAY_NOW"], needsMerged: true },
    REJECT: { to: "vetoed", effects: REFUND },
    VETO: { to: "vetoed", effects: REFUND },
    PR_CLOSED: { to: "funded" },
    SUBMISSION_CHANGED: { to: "claimed" },
    CANCEL: { to: "cancelled", effects: REFUND },
  },
  window: {
    APPROVE: { to: "window", effects: ["PAY_NOW"] },
    VETO: { to: "vetoed", effects: REFUND },
    PAYOUT_SENT: { to: "paid" },
    PAYOUT_ABANDONED: { to: "expired", effects: REFUND },
  },
  paid: {},
  vetoed: { REFUNDED: { to: "refunded" } },
  cancelled: { REFUNDED: { to: "refunded" } },
  expired: { REFUNDED: { to: "refunded" } },
  refunded: {},
};

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: BountyStatus,
    public readonly event: BountyEvent,
    detail?: string,
  ) {
    super(
      `Illegal transition: ${event} not allowed from "${from}"${detail ? ` (${detail})` : ""}`,
    );
    this.name = "IllegalTransitionError";
  }
}

/** Thrown when someone tries to undo a payout. Payouts are final. */
export class AlreadyPaidError extends IllegalTransitionError {
  constructor(from: BountyStatus, event: BountyEvent) {
    super(from, event, "payout already sent and cannot be reversed");
    this.name = "AlreadyPaidError";
  }
}

export type TransitionResult = {
  from: BountyStatus;
  to: BountyStatus;
  event: BountyEvent;
  effects: Effect[];
  /** True when the event had already been applied. Do not write or run effects. */
  noop: boolean;
};

const UNDO_EVENTS: BountyEvent[] = ["VETO", "REJECT", "CANCEL", "EXPIRE"];

export function transition(
  from: BountyStatus,
  event: BountyEvent,
  ctx: TransitionContext,
): TransitionResult {
  const rule = TABLE[from][event];

  if (!rule) {
    if (from === "paid" && UNDO_EVENTS.includes(event)) {
      throw new AlreadyPaidError(from, event);
    }
    // Idempotency: the event was already applied if some rule for it ends in `from`.
    if (alreadyApplied(from, event)) {
      return { from, to: from, event, effects: [], noop: true };
    }
    throw new IllegalTransitionError(from, event);
  }

  if (rule.needsMerged && !ctx.merged) {
    throw new IllegalTransitionError(from, event, "the PR is not merged yet");
  }

  // A merged PR whose review is out of date must be reviewed again before the window.
  if (from === "reviewed" && event === "PR_MERGED" && ctx.reviewCurrent === false) {
    return { from, to: "claimed", event, effects: ["RUN_REVIEW"], noop: false };
  }

  const picked = ctx.merged && rule.whenMerged ? rule.whenMerged : rule;
  return {
    from,
    to: picked.to,
    event,
    effects: [...(picked.effects ?? [])],
    noop: false,
  };
}

function alreadyApplied(state: BountyStatus, event: BountyEvent): boolean {
  // The event was already applied if some rule for it ends in the current state.
  // (Effects only run on the first application, so callers skip them on a no-op.)
  for (const rules of Object.values(TABLE)) {
    const rule = rules[event];
    if (!rule) continue;
    if (rule.to === state || rule.whenMerged?.to === state) return true;
  }
  return false;
}

/** Statuses from which no further payout or refund will happen. */
export function isTerminal(status: BountyStatus): boolean {
  return status === "paid" || status === "refunded";
}
