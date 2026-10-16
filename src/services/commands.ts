/** Slash commands and the amount picker. */
import { parseCommand, type ParsedCommand } from "../core/commands";
import { newlyChecked, pickerComment, readMarker, replies } from "../core/messages";
import { canManage, validateAmount, type Permission } from "../core/rules";
import { IllegalTransitionError } from "../core/state";
import type { Bounty, Picker, Repo } from "../domain";
import { bestEffort, isBot, logEvent, repoRef, type Deps } from "./context";
import { applyEvent, refreshView } from "./lifecycle";

export type Actor = { id: number; login: string };

export type CommentEventPayload = {
  action: string;
  issue: { number: number; pull_request?: unknown };
  comment: { id: number; body: string; user?: { id: number; login: string; type?: string } };
  changes?: { body?: { from?: string } };
  repository: { id: number; name: string; owner: { login: string } };
  installation?: { id: number };
  sender: { id: number; login: string; type?: string };
};

export async function upsertRepoFromPayload(d: Deps, p: Pick<CommentEventPayload, "repository" | "installation">): Promise<Repo> {
  if (!p.installation) throw new Error("webhook has no installation id");
  return d.store.upsertRepo({ id: p.repository.id, owner: p.repository.owner.login, name: p.repository.name, installationId: p.installation.id });
}

const reply = (d: Deps, repo: Repo, issueNumber: number, body: string) =>
  bestEffort(d, "reply", () => d.github.createComment(repoRef(repo), issueNumber, body));

/** A new comment: runs a slash command if there is one. */
export async function handleCommentCreated(d: Deps, p: CommentEventPayload): Promise<void> {
  if (isBot(p.sender)) return;
  const cmd = parseCommand(p.comment.body);
  if (!cmd) return;
  const repo = await upsertRepoFromPayload(d, p);
  const actor: Actor = { id: p.sender.id, login: p.sender.login };
  const isPull = !!p.issue.pull_request;
  const permission = await d.github.getPermission(repoRef(repo), actor.login);
  await runCommand(d, repo, p.issue.number, isPull, actor, permission, cmd);
}

export async function runCommand(d: Deps, repo: Repo, number: number, isPull: boolean, actor: Actor, permission: Permission, cmd: ParsedCommand): Promise<void> {
  switch (cmd.type) {
    case "bounty":
    case "picker":
    case "invalid": {
      if (!canManage(permission)) return void (await reply(d, repo, number, replies.noPermission(actor.login)));
      if (isPull) return void (await reply(d, repo, number, replies.notAnIssue));
      if (cmd.type === "invalid") return void (await reply(d, repo, number, cmd.reason));
      const existing = await d.store.findActiveBountyByIssue(repo.id, number);
      if (existing) return void (await reply(d, repo, number, replies.alreadyHasBounty(existing.status)));
      if (cmd.type === "picker") return void (await postPicker(d, repo, number, actor));
      const problem = validateAmount(cmd.amountCents, repo.settings);
      if (problem) return void (await reply(d, repo, number, problem));
      const created = await createBounty(d, repo, number, cmd.amountCents, actor, null);
      if (!created) await reply(d, repo, number, replies.alreadyHasBounty("open"));
      return;
    }
    case "cancel":
      return cancelBounty(d, repo, number, isPull, actor, permission);
    case "veto":
      return vetoBounty(d, repo, number, isPull, actor, permission);
    case "approve":
      return approveBounty(d, repo, number, isPull, actor, permission);
  }
}

/** Creates the bounty (one per issue) and posts or reuses the status comment. */
export async function createBounty(d: Deps, repo: Repo, issueNumber: number, amountCents: number, funder: Actor, existingCommentId: number | null): Promise<Bounty | null> {
  const bounty = await d.store.createBounty({
    id: d.newId(),
    repoId: repo.id,
    issueNumber,
    amountCents,
    currency: "USD",
    status: "created",
    funderGithubId: funder.id,
    funderLogin: funder.login,
    fundToken: d.newToken(),
    createdAt: d.clock.now(),
  });
  if (!bounty) return null;
  await logEvent(d, bounty.id, "created", funder.login, { amountCents });
  if (existingCommentId) await d.store.updateBounty(bounty.id, { issueCommentId: existingCommentId });
  await refreshView(d, bounty.id); // posts (or edits) the status comment with the funding link
  return d.store.getBounty(bounty.id);
}

async function postPicker(d: Deps, repo: Repo, issueNumber: number, actor: Actor) {
  const picker: Picker = {
    id: d.newId(),
    repoId: repo.id,
    issueNumber,
    commentId: null,
    optionsCents: d.config.pickerOptionsCents,
    createdByGithubId: actor.id,
    state: "open",
    createdAt: d.clock.now(),
  };
  await d.store.savePicker(picker);
  const commentId = await d.github.createComment(repoRef(repo), issueNumber, pickerComment(picker.id, actor.login, picker.optionsCents));
  await d.store.savePicker({ ...picker, commentId });
}

/**
 * An edited comment: the only edits we care about are ticks on our own picker.
 * The amount comes from our stored options, never from the comment text.
 */
export async function handleCommentEdited(d: Deps, p: CommentEventPayload): Promise<void> {
  if (isBot(p.sender)) return; // our own edits
  if (p.comment.user?.login !== `${d.config.appSlug}[bot]`) return; // only comments written by the bot
  const pickerId = readMarker(p.comment.body, "picker");
  if (!pickerId) return;
  const picker = await d.store.getPicker(pickerId);
  if (!picker || picker.state !== "open" || picker.commentId !== p.comment.id) return;
  const before = p.changes?.body?.from;
  if (!before) return;
  const index = newlyChecked(before, p.comment.body);
  if (index === null) return;
  const amountCents = picker.optionsCents[index];
  if (amountCents === undefined) return;

  const repo = await upsertRepoFromPayload(d, p);
  const ref = repoRef(repo);
  const actor: Actor = { id: p.sender.id, login: p.sender.login };
  const permission = await d.github.getPermission(ref, actor.login);
  if (!canManage(permission)) {
    // Undo the tick and say why.
    await bestEffort(d, "reset picker", () => d.github.updateComment(ref, p.comment.id, pickerComment(picker.id, picker.createdByGithubId === actor.id ? actor.login : "maintainer", picker.optionsCents)));
    return void (await reply(d, repo, picker.issueNumber, replies.noPermission(actor.login)));
  }
  if (!(await d.store.usePicker(picker.id))) return; // someone else ticked first
  const created = await createBounty(d, repo, picker.issueNumber, amountCents, actor, p.comment.id);
  if (!created) {
    await bestEffort(d, "picker conflict", () => d.github.updateComment(ref, p.comment.id, replies.alreadyHasBounty("open")));
  }
}

/* ----------------------------- Resolving ----------------------------- */

async function resolveBounty(d: Deps, repo: Repo, number: number, isPull: boolean): Promise<Bounty | null> {
  if (!isPull) return d.store.findActiveBountyByIssue(repo.id, number);
  for (const s of await d.store.findSubmissionsByPr(repo.id, number)) {
    const b = await d.store.getBounty(s.bountyId);
    if (b && b.status !== "refunded" && b.status !== "cancelled") return b;
  }
  return null;
}

async function payoutStarted(d: Deps, bountyId: string): Promise<boolean> {
  const p = await d.store.getPayout(bountyId);
  return !!p && (p.state === "sending" || p.state === "sent");
}

/* ----------------------------- Commands ----------------------------- */

export async function cancelBounty(d: Deps, repo: Repo, number: number, isPull: boolean, actor: Actor, permission: Permission) {
  const bounty = await resolveBounty(d, repo, number, isPull);
  if (!bounty) return void (await reply(d, repo, number, replies.noBounty));
  const allowed = actor.id === bounty.funderGithubId || permission === "admin" || permission === "maintain";
  if (!allowed) return void (await reply(d, repo, number, replies.notFunder));
  if (bounty.status === "paid" || (await payoutStarted(d, bounty.id))) return void (await reply(d, repo, number, replies.alreadyPaid));
  if (bounty.status === "window") return void (await reply(d, repo, number, replies.cannotCancelInWindow));
  await tryApply(d, repo, number, bounty.id, "CANCEL", actor.login);
}

export async function vetoBounty(d: Deps, repo: Repo, number: number, isPull: boolean, actor: Actor, permission: Permission) {
  if (!canManage(permission)) return void (await reply(d, repo, number, replies.noPermission(actor.login)));
  const bounty = await resolveBounty(d, repo, number, isPull);
  if (!bounty) return void (await reply(d, repo, number, replies.noBounty));
  if (bounty.status === "paid" || (await payoutStarted(d, bounty.id))) return void (await reply(d, repo, number, replies.alreadyPaid));
  if (bounty.status !== "window" && bounty.status !== "flagged") return void (await reply(d, repo, number, replies.nothingToVeto));
  await tryApply(d, repo, number, bounty.id, "VETO", actor.login);
}

export async function approveBounty(d: Deps, repo: Repo, number: number, isPull: boolean, actor: Actor, permission: Permission) {
  if (!canManage(permission)) return void (await reply(d, repo, number, replies.noPermission(actor.login)));
  const bounty = await resolveBounty(d, repo, number, isPull);
  if (!bounty) return void (await reply(d, repo, number, replies.noBounty));
  if (bounty.status === "paid") return void (await reply(d, repo, number, replies.alreadyPaid));
  if (bounty.status !== "window" && bounty.status !== "flagged") return void (await reply(d, repo, number, replies.nothingToApprove));
  await tryApply(d, repo, number, bounty.id, "APPROVE", actor.login);
}

async function tryApply(d: Deps, repo: Repo, number: number, bountyId: string, event: "CANCEL" | "VETO" | "APPROVE", login: string) {
  try {
    await applyEvent(d, bountyId, event, login);
  } catch (err) {
    if (err instanceof IllegalTransitionError) {
      const msg = err.message.includes("not merged") ? replies.needsMergeFirst : err.message.includes("already sent") ? replies.alreadyPaid : replies.nothingToApprove;
      return void (await reply(d, repo, number, msg));
    }
    throw err;
  }
}
