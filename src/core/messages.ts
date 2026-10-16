/**
 * Everything the bot writes on GitHub. Pure functions, easy to review in one place.
 *
 * Never put in a comment: PayPal emails or ids, order numbers, secrets, or the
 * model's full reasoning. Amounts, status, score and dates only.
 */
import { fmtUsd } from "./rules";
import type { BountyStatus } from "./state";

export const marker = (kind: "picker" | "bounty" | "pr", id: string) => `<!-- bountyline:${kind}:${id} -->`;

export function readMarker(body: string, kind: "picker" | "bounty" | "pr"): string | null {
  const m = new RegExp(`<!-- bountyline:${kind}:([A-Za-z0-9_-]+) -->`).exec(body);
  return m ? m[1]! : null;
}

export function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/* ----------------------------- Labels ----------------------------- */

export const LABEL_SCHEDULED = "payout scheduled";
export const LABEL_PAID = "bounty: paid";
export const LABEL_REFUNDED = "bounty: refunded";

export const isManagedLabel = (name: string) => name.startsWith("bounty:") || name === LABEL_SCHEDULED;

export function desiredLabels(status: BountyStatus, amountCents: number): string[] {
  switch (status) {
    case "funded":
    case "claimed":
    case "reviewed":
    case "flagged":
      return [`bounty: ${fmtUsd(amountCents)}`];
    case "window":
      return [`bounty: ${fmtUsd(amountCents)}`, LABEL_SCHEDULED];
    case "paid":
      return [LABEL_PAID];
    case "refunded":
      return [LABEL_REFUNDED];
    default:
      return []; // created, cancelled, vetoed, expired: nothing (refund in progress shows no label)
  }
}

export function labelColor(name: string): string {
  if (name === LABEL_PAID) return "0e8a16";
  if (name === LABEL_REFUNDED) return "6a737d";
  if (name === LABEL_SCHEDULED) return "fbca04";
  return "0b6e4f";
}

/* ----------------------------- Picker ----------------------------- */

export function pickerComment(pickerId: string, actorLogin: string, optionsCents: number[]): string {
  const boxes = optionsCents.map((c) => `- [ ] ${fmtUsd(c)}`).join("\n");
  return [
    marker("picker", pickerId),
    `**Fund this issue.** @${actorLogin}, tick one amount to start a bounty. Only people with write access can do this.`,
    "",
    boxes,
    "",
    "Need a different amount? Comment `/bounty <amount>`, for example `/bounty 150`.",
  ].join("\n");
}

/** Checkbox states in the order they appear in a comment. */
export function readCheckboxes(body: string): boolean[] {
  const out: boolean[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s*[-*]\s+\[( |x|X)\]/.exec(line);
    if (m) out.push(m[1] !== " ");
  }
  return out;
}

/** Index of the box that was just ticked, comparing the old and new comment. */
export function newlyChecked(before: string, after: string): number | null {
  const a = readCheckboxes(before);
  const b = readCheckboxes(after);
  if (a.length !== b.length) return null;
  const changed = b.map((v, i) => (v && !a[i] ? i : -1)).filter((i) => i >= 0);
  return changed.length === 1 ? changed[0]! : null;
}

/* ------------------------- Status comments ------------------------- */

export type CommentView = {
  bountyId: string;
  status: BountyStatus;
  amountCents: number;
  funderLogin: string;
  /** Only shown while waiting for payment. */
  fundUrl?: string;
  pr?: { number: number; authorLogin: string };
  score?: number;
  threshold?: number;
  windowEndsAt?: Date | null;
  paidAt?: Date | null;
  payoutAddressUrl?: string;
};

function statusLine(v: CommentView): string {
  const amount = fmtUsd(v.amountCents);
  const pr = v.pr ? `#${v.pr.number} by @${v.pr.authorLogin}` : "the pull request";
  switch (v.status) {
    case "created":
      return `Waiting for @${v.funderLogin} to pay ${amount}. [Complete funding](${v.fundUrl ?? "#"}) (sign in with GitHub as @${v.funderLogin}).`;
    case "funded":
      return `Funded. Open a pull request that closes this issue (for example \`Closes #N\` in the description) to claim ${amount}.`;
    case "claimed":
      return `${pr} is being reviewed.`;
    case "reviewed":
      return `${pr} passed the AI review${v.score !== undefined ? ` (${v.score}/100)` : ""}. It is paid after the pull request is merged and the review window ends.`;
    case "flagged":
      return `${pr} needs a maintainer${v.score !== undefined ? ` (AI score ${v.score}/100, threshold ${v.threshold ?? 75})` : ""}. After it is merged, a maintainer can pay with \`/approve-bounty\` or refuse with \`/veto-bounty\`.`;
    case "window":
      return `${pr} was merged. ${amount} to @${v.pr?.authorLogin ?? "the contributor"} is scheduled for ${v.windowEndsAt ? fmtDate(v.windowEndsAt) : "after the review window"}. Maintainers can pay now with \`/approve-bounty\` or stop it with \`/veto-bounty\`.`;
    case "paid":
      return `Paid. ${amount} was sent to @${v.pr?.authorLogin ?? "the contributor"}${v.paidAt ? ` on ${fmtDate(v.paidAt)}` : ""}. Payouts are final.`;
    case "vetoed":
      return `A maintainer vetoed this payout. ${amount} is being refunded to @${v.funderLogin}.`;
    case "cancelled":
      return "This bounty was cancelled.";
    case "expired":
      return `This bounty ended without a payout. ${amount} is being refunded to @${v.funderLogin}.`;
    case "refunded":
      return `${amount} was refunded to @${v.funderLogin}.`;
  }
}

export function issueComment(v: CommentView): string {
  return [
    marker("bounty", v.bountyId),
    `### Bountyline: ${fmtUsd(v.amountCents)} bounty`,
    `**Status: ${statusTitle(v.status)}**`,
    "",
    statusLine(v),
  ].join("\n");
}

export function prComment(v: CommentView & { prNumber: number }): string {
  const lines = [
    marker("pr", v.bountyId),
    `### Bountyline: ${fmtUsd(v.amountCents)} bounty`,
    `**Status: ${statusTitle(v.status)}**`,
    "",
    statusLine(v),
  ];
  if (v.payoutAddressUrl && ["claimed", "reviewed", "flagged", "window"].includes(v.status)) {
    lines.push("", `Contributor: set where to receive the payment once, privately: ${v.payoutAddressUrl}`);
  }
  return lines.join("\n");
}

export function statusTitle(s: BountyStatus): string {
  const titles: Record<BountyStatus, string> = {
    created: "waiting for payment",
    funded: "open",
    claimed: "in review",
    reviewed: "passed review",
    flagged: "needs a maintainer",
    window: "payout scheduled",
    paid: "paid",
    vetoed: "vetoed",
    cancelled: "cancelled",
    expired: "expired",
    refunded: "refunded",
  };
  return titles[s];
}

/* ------------------------- Check run output ------------------------- */

const RUBRIC_LABELS: Record<string, [string, number]> = {
  solves_issue: ["Solves the issue", 25],
  scope: ["Stays in scope", 20],
  tests_ci: ["Tests and CI", 30],
  quality: ["Code quality", 20],
  red_flags: ["No red flags", 5],
};

export function reviewSummary(input: {
  score: number;
  threshold: number;
  rubric: Record<string, number>;
  summary: string;
  redFlags: string[];
  ci: string;
  passed: boolean;
}): { title: string; text: string } {
  const rows = Object.entries(RUBRIC_LABELS).map(([k, [label, max]]) => `| ${label} | ${input.rubric[k] ?? 0} / ${max} |`);
  const text = [
    input.summary,
    "",
    "| Area | Score |",
    "|---|---|",
    ...rows,
    "",
    `CI: ${input.ci}. Threshold: ${input.threshold}.`,
    ...(input.redFlags.length ? ["", "Red flags:", ...input.redFlags.map((f) => `- ${f}`)] : []),
    "",
    "The AI only advises. A bounty is paid after the pull request is merged and the review window ends, and maintainers can veto.",
  ].join("\n");
  return {
    title: `${input.score}/100 ${input.passed ? "(passes)" : "(needs a maintainer)"}`,
    text,
  };
}

/* ------------------------- Short replies ------------------------- */

export const replies = {
  noPermission: (login: string) => `@${login} only people with write access to this repository can do that.`,
  notAnIssue: "Use `/bounty` on the issue, not on a pull request.",
  alreadyHasBounty: (status: string) => `This issue already has a bounty (${status}).`,
  noBounty: "There is no bounty on this issue.",
  cannotCancelInWindow: "The payout is already scheduled. Use `/veto-bounty` to stop it.",
  nothingToVeto: "There is nothing to veto yet. A payout is scheduled after the pull request is merged.",
  alreadyPaid: "The payout has already been sent and payouts are final, so it cannot be undone.",
  nothingToApprove: "There is nothing to approve right now.",
  needsMergeFirst: "The pull request must be merged before the bounty can be paid.",
  funderCannotClaim: (login: string) => `@${login} funded this bounty, so a pull request from them cannot claim it.`,
  notFunder: "Only the person who funded this bounty (or a maintainer) can cancel it.",
};
