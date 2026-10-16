/** Hourly safety net: expiries, and anything that fell through a crack. */
import { addDays } from "../core/rules";
import { IllegalTransitionError } from "../core/state";
import type { Deps } from "./context";
import { applyEvent } from "./lifecycle";

async function tryApply(d: Deps, id: string, event: Parameters<typeof applyEvent>[2], data: Record<string, unknown>) {
  try {
    await applyEvent(d, id, event, "system", { data });
  } catch (err) {
    if (!(err instanceof IllegalTransitionError)) d.log("sweep failed for a bounty", { id, error: err instanceof Error ? err.message : err });
  }
}

export async function runSweep(d: Deps): Promise<void> {
  const now = d.clock.now();
  const live = await d.store.listBountiesByStatus(["created", "funded", "claimed", "reviewed", "flagged", "window", "vetoed", "cancelled", "expired"]);

  for (const b of live) {
    const repo = await d.store.getRepo(b.repoId);
    if (!repo) continue;
    const s = repo.settings;

    switch (b.status) {
      case "created":
        // Nobody paid. No money involved, so just cancel.
        if (now >= addDays(b.createdAt, s.unfundedExpiryDays)) await tryApply(d, b.id, "CANCEL", { reason: "never funded" });
        break;
      case "funded":
      case "claimed":
      case "reviewed":
        if (b.expiresAt && now >= b.expiresAt) await tryApply(d, b.id, "EXPIRE", { reason: "no merged solution in time" });
        break;
      case "flagged": {
        const events = await d.store.listEvents(b.id);
        const flaggedAt = [...events].reverse().find((e) => e.type === "REVIEW_FLAGGED")?.createdAt ?? b.createdAt;
        if (now >= addDays(flaggedAt, s.flaggedExpiryDays)) await tryApply(d, b.id, "REJECT", { reason: "no maintainer decision in time" });
        break;
      }
      case "window":
        // Make sure a payout job exists (no-op if it does).
        await d.store.enqueue({ kind: "payout", key: `payout:${b.id}`, payload: { bountyId: b.id }, runAt: b.windowEndsAt ?? now });
        break;
      case "vetoed":
      case "cancelled":
      case "expired":
        // A bounty cancelled before payment has nothing to refund and stays "cancelled".
        if (b.paypalCaptureId) await d.store.enqueue({ kind: "refund", key: `refund:${b.id}`, payload: { bountyId: b.id }, runAt: now });
        break;
    }
  }
}
