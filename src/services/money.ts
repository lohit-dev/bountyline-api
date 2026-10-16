/** Payout and refund jobs. Both are idempotent and safe to retry. */
import { decrypt } from "../core/crypto";
import { addDays, addMinutes } from "../core/rules";
import type { Payout, Refund, RefundReason } from "../domain";
import { bestEffort, logEvent, repoRef, type Deps } from "./context";
import { applyEvent } from "./lifecycle";

export const MAX_MONEY_ATTEMPTS = 5;

export async function runPayout(d: Deps, bountyId: string): Promise<void> {
  const bounty = await d.store.getBounty(bountyId);
  if (!bounty || bounty.status !== "window") return; // vetoed, paid, or never scheduled
  const now = d.clock.now();
  const due = bounty.windowEndsAt ?? now;
  if (now < due) {
    await d.store.enqueue({ kind: "payout", key: `payout:${bounty.id}`, payload: { bountyId }, runAt: due }, { replace: true });
    return;
  }
  const repo = await d.store.getRepo(bounty.repoId);
  const sub = bounty.submissionId ? await d.store.getSubmission(bounty.submissionId) : null;
  if (!repo || !sub || sub.status !== "merged") {
    d.log("payout skipped: no merged pull request", { bountyId });
    return;
  }

  let payout = await d.store.getPayout(bounty.id);
  if (payout?.state === "sent") {
    await applyEvent(d, bounty.id, "PAYOUT_SENT", "system"); // finish a half-applied payout
    return;
  }

  const account = await d.store.getPayoutAccount(sub.authorGithubId);
  if (!account) return handleMissingAddress(d, bountyId, due, repo.settings.payoutAddressWaitDays, sub.prNumber);

  payout ??= {
    id: d.newId(),
    bountyId: bounty.id,
    recipientGithubId: sub.authorGithubId,
    amountCents: bounty.amountCents,
    state: "scheduled",
    idempotencyKey: `payout-${bounty.id}`,
    paypalBatchId: null,
    attempts: 0,
    lastError: null,
    sentAt: null,
    createdAt: now,
  } satisfies Payout;

  // Mark the payout as started, then look again: a veto that arrived a moment ago must win.
  payout = await d.store.savePayout({ ...payout, state: "sending" });
  const recheck = await d.store.getBounty(bounty.id);
  if (!recheck || recheck.status !== "window") {
    await d.store.savePayout({ ...payout, state: "scheduled" });
    return;
  }

  try {
    const email = decrypt(account.paypalEmailEnc, d.config.encryptionKey);
    const sent = await d.paypal.sendPayout({
      senderBatchId: payout.idempotencyKey,
      itemId: payout.id,
      email,
      amountCents: payout.amountCents,
      note: `Bountyline payout for ${repo.owner}/${repo.name}#${bounty.issueNumber}`,
      requestId: payout.idempotencyKey,
    });
    payout = await d.store.savePayout({ ...payout, state: "sent", paypalBatchId: sent.batchId, sentAt: d.clock.now(), attempts: payout.attempts + 1, lastError: null });
    await applyEvent(d, bounty.id, "PAYOUT_SENT", "system", { data: { batchId: sent.batchId } });
    await d.store.enqueue({ kind: "payout-check", key: `payout-check:${bounty.id}:0`, payload: { bountyId, checks: 0 }, runAt: addMinutes(d.clock.now(), 2) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = payout.attempts + 1;
    await d.store.savePayout({ ...payout, state: attempts >= MAX_MONEY_ATTEMPTS ? "failed" : "scheduled", attempts, lastError: message.slice(0, 500) });
    await logEvent(d, bounty.id, "payout_error", "system", { attempts, message: message.slice(0, 200) });
    if (attempts >= MAX_MONEY_ATTEMPTS) {
      await bestEffort(d, "payout failed note", () =>
        d.github.createComment(repoRef(repo), sub.prNumber, "The payout could not be sent. Maintainers: open the dashboard, or run `/approve-bounty` to try again."),
      );
      return;
    }
    throw err; // the job runner retries with a delay
  }
}

async function handleMissingAddress(d: Deps, bountyId: string, due: Date, waitDays: number, prNumber: number) {
  const now = d.clock.now();
  if (now >= addDays(due, waitDays)) {
    await applyEvent(d, bountyId, "PAYOUT_ABANDONED", "system", { data: { waitDays } });
    return;
  }
  const events = await d.store.listEvents(bountyId);
  if (!events.some((e) => e.type === "payout_address_missing")) {
    await logEvent(d, bountyId, "payout_address_missing", "system");
    const bounty = await d.store.getBounty(bountyId);
    const repo = bounty ? await d.store.getRepo(bounty.repoId) : null;
    if (repo) {
      await bestEffort(d, "address reminder", () =>
        d.github.createComment(repoRef(repo), prNumber, `The review window is over, but the contributor has not set where to receive the payment. Set it here: ${d.config.dashboardUrl}/payout. If nothing is set within ${waitDays} days the bounty is refunded.`),
      );
    }
  }
  // A new key per retry: the job that is running right now owns `payout:<id>` and cannot be replaced.
  const next = addDays(now, 1);
  await d.store.enqueue({ kind: "payout", key: `payout:${bountyId}:retry:${next.toISOString()}`, payload: { bountyId }, runAt: next });
}

export async function runPayoutCheck(d: Deps, bountyId: string, checks: number): Promise<void> {
  const payout = await d.store.getPayout(bountyId);
  if (!payout?.paypalBatchId || payout.state !== "sent") return;
  const batch = await d.paypal.getPayoutBatch(payout.paypalBatchId);
  if (batch.status === "pending") {
    if (checks < 12) {
      await d.store.enqueue({ kind: "payout-check", key: `payout-check:${bountyId}:${checks + 1}`, payload: { bountyId, checks: checks + 1 }, runAt: addMinutes(d.clock.now(), 10) });
    }
    return;
  }
  if (batch.status === "success") return void (await logEvent(d, bountyId, "payout_confirmed", "paypal"));
  await d.store.savePayout({ ...payout, state: "failed", lastError: (batch.detail ?? "PayPal reported the payout as failed").slice(0, 500) });
  await logEvent(d, bountyId, "payout_failed_after_send", "paypal", { detail: batch.detail });
  const bounty = await d.store.getBounty(bountyId);
  const repo = bounty ? await d.store.getRepo(bounty.repoId) : null;
  const sub = bounty?.submissionId ? await d.store.getSubmission(bounty.submissionId) : null;
  if (repo && sub) {
    await bestEffort(d, "payout failure note", () =>
      d.github.createComment(repoRef(repo), sub.prNumber, "PayPal could not deliver this payout (for example the PayPal email is wrong). The contributor should check their payout address; maintainers can see details on the dashboard."),
    );
  }
}

export async function runRefund(d: Deps, bountyId: string): Promise<void> {
  const bounty = await d.store.getBounty(bountyId);
  if (!bounty || !["vetoed", "cancelled", "expired"].includes(bounty.status)) return;
  if (!bounty.paypalCaptureId) return; // nothing was ever captured, so there is nothing to refund
  const reason = ({ vetoed: "vetoed", cancelled: "cancelled", expired: "expired" } as Record<string, RefundReason>)[bounty.status]!;
  let refund: Refund =
    (await d.store.getRefund(bounty.id)) ?? {
      id: d.newId(),
      bountyId: bounty.id,
      amountCents: bounty.amountCents,
      reason,
      state: "pending",
      idempotencyKey: `refund-${bounty.id}`,
      paypalRefundId: null,
      attempts: 0,
      lastError: null,
      createdAt: d.clock.now(),
    };
  if (refund.state === "sent") {
    await applyEvent(d, bounty.id, "REFUNDED", "system");
    return;
  }
  refund = await d.store.saveRefund(refund);
  try {
    const done = await d.paypal.refundCapture(bounty.paypalCaptureId, refund.idempotencyKey);
    await d.store.saveRefund({ ...refund, state: "sent", paypalRefundId: done.refundId, attempts: refund.attempts + 1, lastError: null });
    await applyEvent(d, bounty.id, "REFUNDED", "system", { data: { refundId: done.refundId } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = refund.attempts + 1;
    await d.store.saveRefund({ ...refund, state: attempts >= MAX_MONEY_ATTEMPTS ? "failed" : "pending", attempts, lastError: message.slice(0, 500) });
    await logEvent(d, bounty.id, "refund_error", "system", { attempts, message: message.slice(0, 200) });
    if (attempts < MAX_MONEY_ATTEMPTS) throw err;
  }
}
