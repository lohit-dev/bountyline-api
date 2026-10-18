/**
 * What the dashboard can see and do. Every function takes the signed-in GitHub user.
 * Views never contain the funding token, PayPal ids, payout emails or comment ids.
 */
import { encrypt, maskEmail, decrypt } from "../core/crypto";
import { canManage, type Permission } from "../core/rules";
import { IllegalTransitionError, AlreadyPaidError, type BountyStatus } from "../core/state";
import type { Bounty, Repo } from "../domain";
import { repoRef, type Deps } from "./context";
import { applyEvent } from "./lifecycle";

export type Viewer = { id: number; login: string };

export type BountyView = {
  id: string;
  repo: string;
  issueNumber: number;
  issueUrl: string;
  amountCents: number;
  status: BountyStatus;
  funderLogin: string;
  role: "funder" | "contributor" | "maintainer";
  createdAt: string;
  fundedAt: string | null;
  expiresAt: string | null;
  windowEndsAt: string | null;
  canDecide: boolean;
  submissions: { prNumber: number; prUrl: string; authorLogin: string; status: string; current: boolean }[];
  review: { score: number; passed: boolean; recommendation: string; ci: string; summary: string; redFlags: string[]; rubric: Record<string, number>; createdAt: string } | null;
  payout: { state: string; sentAt: string | null } | null;
  refund: { state: string; reason: string } | null;
};
export type BountyDetail = BountyView & {
  events: { type: string; actor: string; createdAt: string }[];
  settings: { reviewWindowHours: number; scoreThreshold: number; expiryDays: number };
  /** Whether the contributor has saved a payout address. The address itself is never shown to others. */
  payoutAddressSet: boolean;
};

export type ActivityItem = { bountyId: string; repo: string; issueNumber: number; type: string; actor: string; createdAt: string };

const iso = (d: Date | null) => (d ? d.toISOString() : null);

async function permissionOf(d: Deps, repo: Repo, login: string): Promise<Permission> {
  try {
    return await d.github.getPermission(repoRef(repo), login);
  } catch (err) {
    d.log("permission lookup failed", err);
    return "none";
  }
}

async function buildView(d: Deps, viewer: Viewer, b: Bounty, repo: Repo, role: BountyView["role"], permission: Permission): Promise<BountyView> {
  const subs = await d.store.listSubmissions(b.id);
  const current = subs.find((s) => s.id === b.submissionId) ?? null;
  const review = current ? await d.store.latestReview(current.id) : null;
  const payout = await d.store.getPayout(b.id);
  const refund = await d.store.getRefund(b.id);
  const slug = `${repo.owner}/${repo.name}`;
  return {
    id: b.id,
    repo: slug,
    issueNumber: b.issueNumber,
    issueUrl: `https://github.com/${slug}/issues/${b.issueNumber}`,
    amountCents: b.amountCents,
    status: b.status,
    funderLogin: b.funderLogin,
    role,
    createdAt: b.createdAt.toISOString(),
    fundedAt: iso(b.fundedAt),
    expiresAt: iso(b.expiresAt),
    windowEndsAt: iso(b.windowEndsAt),
    canDecide: canManage(permission) && (b.status === "window" || b.status === "flagged"),
    submissions: subs.map((s) => ({ prNumber: s.prNumber, prUrl: `https://github.com/${slug}/pull/${s.prNumber}`, authorLogin: s.authorLogin, status: s.status, current: s.id === b.submissionId })),
    review: review ? { score: review.score, passed: review.passed, recommendation: review.recommendation, ci: review.ci, summary: review.summary, redFlags: review.redFlags, rubric: review.rubric, createdAt: review.createdAt.toISOString() } : null,
    payout: payout ? { state: payout.state, sentAt: iso(payout.sentAt) } : null,
    refund: refund ? { state: refund.state, reason: refund.reason } : null,
  };
}

async function roleOf(d: Deps, viewer: Viewer, b: Bounty): Promise<BountyView["role"] | null> {
  if (b.funderGithubId === viewer.id) return "funder";
  const subs = await d.store.listSubmissions(b.id);
  if (subs.some((s) => s.authorGithubId === viewer.id)) return "contributor";
  return null;
}

/** Bounties the user funded or is working on. */
export async function listBounties(d: Deps, viewer: Viewer): Promise<BountyView[]> {
  const out: BountyView[] = [];
  for (const b of await d.store.listBountiesForUser(viewer.id)) {
    const repo = await d.store.getRepo(b.repoId);
    const role = await roleOf(d, viewer, b);
    if (!repo || !role) continue;
    const permission = role === "funder" ? await permissionOf(d, repo, viewer.login) : "none";
    out.push(await buildView(d, viewer, b, repo, role, permission));
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getBountyDetail(d: Deps, viewer: Viewer, id: string): Promise<BountyDetail | null> {
  const b = await d.store.getBounty(id);
  if (!b) return null;
  const repo = await d.store.getRepo(b.repoId);
  if (!repo) return null;
  const permission = await permissionOf(d, repo, viewer.login);
  const role = (await roleOf(d, viewer, b)) ?? (canManage(permission) ? "maintainer" : null);
  if (!role) return null; // same answer as "does not exist", so ids cannot be probed
  const view = await buildView(d, viewer, b, repo, role, permission);
  const events = (await d.store.listEvents(b.id)).map((e) => ({ type: e.type, actor: e.actor, createdAt: e.createdAt.toISOString() }));
  const sub = b.submissionId ? await d.store.getSubmission(b.submissionId) : null;
  const account = sub ? await d.store.getPayoutAccount(sub.authorGithubId) : null;
  const { reviewWindowHours, scoreThreshold, expiryDays } = repo.settings;
  return { ...view, events, settings: { reviewWindowHours, scoreThreshold, expiryDays }, payoutAddressSet: !!account };
}

/** Latest events across the user's own bounties. Event data is not included, only what happened. */
export async function listActivity(d: Deps, viewer: Viewer, limit = 20): Promise<ActivityItem[]> {
  const out: ActivityItem[] = [];
  for (const b of await d.store.listBountiesForUser(viewer.id)) {
    const repo = await d.store.getRepo(b.repoId);
    if (!repo || !(await roleOf(d, viewer, b))) continue;
    for (const e of await d.store.listEvents(b.id)) {
      out.push({ bountyId: b.id, repo: `${repo.owner}/${repo.name}`, issueNumber: b.issueNumber, type: e.type, actor: e.actor, createdAt: e.createdAt.toISOString() });
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.min(Math.max(limit, 1), 50));
}

export type DecisionResult = { ok: true } | { ok: false; status: 403 | 404 | 409; error: string };

export async function decide(d: Deps, viewer: Viewer, id: string, action: "approve" | "veto"): Promise<DecisionResult> {
  const b = await d.store.getBounty(id);
  const repo = b ? await d.store.getRepo(b.repoId) : null;
  if (!b || !repo) return { ok: false, status: 404, error: "Bounty not found." };
  const permission = await permissionOf(d, repo, viewer.login);
  if (!canManage(permission)) {
    const visible = (await roleOf(d, viewer, b)) !== null;
    return visible ? { ok: false, status: 403, error: "Only maintainers of this repository can do that." } : { ok: false, status: 404, error: "Bounty not found." };
  }
  const payout = await d.store.getPayout(b.id);
  if (b.status === "paid" || payout?.state === "sending" || payout?.state === "sent") {
    return { ok: false, status: 409, error: "The payout has already been sent and payouts are final." };
  }
  if (b.status !== "window" && b.status !== "flagged") return { ok: false, status: 409, error: "There is nothing to decide on right now." };
  if (action === "approve") {
    const current = b.submissionId ? await d.store.getSubmission(b.submissionId) : null;
    if (current && current.authorGithubId === viewer.id) return { ok: false, status: 403, error: "You wrote this pull request, so someone else needs to approve its payout." };
  }
  try {
    await applyEvent(d, b.id, action === "approve" ? "APPROVE" : "VETO", viewer.login);
  } catch (err) {
    if (err instanceof AlreadyPaidError) return { ok: false, status: 409, error: "The payout has already been sent and payouts are final." };
    if (err instanceof IllegalTransitionError) {
      return { ok: false, status: 409, error: err.message.includes("not merged") ? "The pull request must be merged first." : "That is not possible in the current state." };
    }
    throw err;
  }
  return { ok: true };
}

/* ---------------------------- Payout address ---------------------------- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function getPayoutAddress(d: Deps, viewer: Viewer): Promise<{ set: boolean; masked: string | null }> {
  const a = await d.store.getPayoutAccount(viewer.id);
  if (!a) return { set: false, masked: null };
  return { set: true, masked: maskEmail(decrypt(a.paypalEmailEnc, d.config.encryptionKey)) };
}

export async function setPayoutAddress(d: Deps, viewer: Viewer, email: unknown): Promise<{ ok: true; masked: string } | { ok: false; error: string }> {
  const e = typeof email === "string" ? email.trim() : "";
  if (e.length > 254 || !EMAIL_RE.test(e)) return { ok: false, error: "Enter the email address of your PayPal account." };
  const now = d.clock.now();
  const existing = await d.store.getPayoutAccount(viewer.id);
  await d.store.savePayoutAccount({ githubUserId: viewer.id, githubLogin: viewer.login, paypalEmailEnc: encrypt(e, d.config.encryptionKey), createdAt: existing?.createdAt ?? now, updatedAt: now });
  // A payout may be waiting for this address: try again now instead of tomorrow.
  for (const b of await d.store.listBountiesForUser(viewer.id)) {
    if (b.status !== "window" || !b.windowEndsAt || b.windowEndsAt > now) continue;
    const subs = await d.store.listSubmissions(b.id);
    if (!subs.some((s) => s.id === b.submissionId && s.authorGithubId === viewer.id)) continue;
    await d.store.enqueue({ kind: "payout", key: `payout:${b.id}:addr:${now.toISOString().slice(0, 16)}`, payload: { bountyId: b.id }, runAt: now });
  }
  return { ok: true, masked: maskEmail(e) };
}
