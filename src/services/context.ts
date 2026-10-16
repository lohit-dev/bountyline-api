import type { BountyEventRow, Repo, RepoRef } from "../domain";
import type { Clock, GitHubPort, PayPalPort, ReviewerPort, Store } from "../ports";

export type AppConfig = {
  /** The GitHub App's slug. The bot's login is `${appSlug}[bot]`. */
  appSlug: string;
  /** Public URL of this API, no trailing slash. */
  apiUrl: string;
  /** Public URL of the dashboard, no trailing slash. */
  dashboardUrl: string;
  /** 64 hex characters. Encrypts payout emails. */
  encryptionKey: string;
  /** Amounts offered by the checkbox picker. */
  pickerOptionsCents: number[];
};

export type Deps = {
  store: Store;
  github: GitHubPort;
  paypal: PayPalPort;
  reviewer: ReviewerPort;
  clock: Clock;
  config: AppConfig;
  newId: () => string;
  newToken: () => string;
  log: (message: string, data?: unknown) => void;
};

export const repoRef = (r: Repo): RepoRef => ({ id: r.id, owner: r.owner, name: r.name, installationId: r.installationId });

export async function logEvent(d: Deps, bountyId: string, type: string, actor: string, data: Record<string, unknown> = {}) {
  const row: BountyEventRow = { id: d.newId(), bountyId, type, actor, data, createdAt: d.clock.now() };
  await d.store.addEvent(row);
}

/** Runs a side effect whose failure must not undo or block the state change (comments, labels). */
export async function bestEffort(d: Deps, what: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    d.log(`best-effort step failed: ${what}`, err instanceof Error ? err.message : err);
  }
}

export const isBot = (u: { type?: string; login?: string } | undefined) => !!u && (u.type === "Bot" || (u.login ?? "").endsWith("[bot]"));
