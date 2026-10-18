/** Paying for a bounty. The funder signs in on our site, then pays through PayPal. */
import { addDays } from "../core/rules";
import { IllegalTransitionError } from "../core/state";
import type { Bounty } from "../domain";
import type { Deps } from "./context";
import { applyEvent } from "./lifecycle";
import { linkOpenPulls } from "./pulls";

export class FundingError extends Error {
  constructor(public readonly code: "not_found" | "forbidden" | "wrong_state" | "payment_failed", message: string) {
    super(message);
  }
}

type User = { id: number; login: string };

async function loadFor(d: Deps, token: string, user: User): Promise<Bounty> {
  const bounty = await d.store.getBountyByToken(token);
  if (!bounty) throw new FundingError("not_found", "This funding link is not valid.");
  if (bounty.funderGithubId !== user.id) {
    throw new FundingError("forbidden", `Only @${bounty.funderLogin} can fund this bounty. Sign in with that GitHub account.`);
  }
  return bounty;
}

/** Creates the PayPal order and returns where to send the funder to approve it. */
export async function startFunding(d: Deps, token: string, user: User): Promise<{ approveUrl: string }> {
  const bounty = await loadFor(d, token, user);
  if (bounty.status !== "created") throw new FundingError("wrong_state", "This bounty is already funded or closed.");
  // The request id makes a repeat click return the same order instead of creating a second one.
  const order = await d.paypal.createOrder({
    amountCents: bounty.amountCents,
    referenceId: bounty.id,
    requestId: `order-${bounty.id}`,
    returnUrl: `${d.config.apiUrl}/paypal/return?b=${encodeURIComponent(token)}`,
    cancelUrl: `${d.config.apiUrl}/fund/${encodeURIComponent(token)}`,
  });
  await d.store.updateBounty(bounty.id, { paypalOrderId: order.orderId });
  return { approveUrl: order.approveUrl };
}

/** PayPal sent the funder back: capture the payment and mark the bounty funded. Safe to call twice. */
export async function completeFunding(d: Deps, token: string, orderId: string, user: User): Promise<Bounty> {
  const bounty = await loadFor(d, token, user);
  if (bounty.status !== "created") return bounty; // already done
  if (!orderId || bounty.paypalOrderId !== orderId) throw new FundingError("payment_failed", "That payment does not belong to this bounty.");

  const capture = await d.paypal.captureOrder(orderId, `capture-${bounty.id}`);
  if (!capture.completed) throw new FundingError("payment_failed", "PayPal did not complete the payment.");
  if (capture.amountCents !== bounty.amountCents) {
    // Never fund a bounty with the wrong amount. The captured money is refunded by hand.
    d.log("captured amount differs from the bounty amount", { bountyId: bounty.id, expected: bounty.amountCents, got: capture.amountCents });
    throw new FundingError("payment_failed", "The amount paid did not match the bounty.");
  }

  const repo = await d.store.getRepo(bounty.repoId);
  const now = d.clock.now();
  let funded: Bounty;
  try {
    ({ bounty: funded } = await applyEvent(d, bounty.id, "FUNDED", user.login, {
      patch: { paypalCaptureId: capture.captureId, fundedAt: now, expiresAt: addDays(now, repo?.settings.expiryDays ?? 30) },
    }));
  } catch (err) {
    // The bounty was closed (for example cancelled as unfunded) while the funder was on PayPal.
    // The money is already captured, so keep the capture id and refund it.
    if (err instanceof IllegalTransitionError) {
      await d.store.updateBounty(bounty.id, { paypalCaptureId: capture.captureId });
      await d.store.enqueue({ kind: "refund", key: `refund:${bounty.id}`, payload: { bountyId: bounty.id }, runAt: now });
      throw new FundingError("wrong_state", "This bounty was closed before the payment finished. The payment is being refunded automatically.");
    }
    throw err;
  }
  await linkOpenPulls(d, funded);
  return (await d.store.getBounty(funded.id)) ?? funded;
}
