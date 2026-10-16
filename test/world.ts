import { MemoryStore } from "../src/adapters/memory-store";
import { DEFAULT_SETTINGS } from "../src/core/config";
import { encrypt } from "../src/core/crypto";
import type { Permission } from "../src/core/rules";
import type { Deps } from "../src/services/context";
import type {
  CheckRunInput, CiStatus, GitHubPort, IssueInfo, PayPalPort, PullFile, PullInfo, ReviewInput, ReviewVerdict, ReviewerPort,
} from "../src/ports";
import type { RepoRef } from "../src/domain";

export const KEY = "11".repeat(32);

export class FakeGitHub implements GitHubPort {
  permissions = new Map<string, Permission>();
  comments = new Map<number, { number: number; body: string }>();
  labels = new Map<number, Set<string>>();
  pulls = new Map<number, PullInfo & { files: PullFile[] }>();
  issues = new Map<number, IssueInfo>();
  ci = new Map<string, CiStatus>();
  checkRuns: (CheckRunInput & { id: number })[] = [];
  private seq = 1000;

  async getPermission(_r: RepoRef, login: string) { return this.permissions.get(login) ?? "read"; }
  async createComment(_r: RepoRef, number: number, body: string) { const id = ++this.seq; this.comments.set(id, { number, body }); return id; }
  async updateComment(_r: RepoRef, id: number, body: string) { const c = this.comments.get(id); if (!c) throw new Error("no comment"); c.body = body; }
  async getIssue(_r: RepoRef, n: number) { return this.issues.get(n) ?? { number: n, title: "Issue", body: "Fix the thing", state: "open" as const, authorLogin: "x" }; }
  async getPull(_r: RepoRef, n: number) { const p = this.pulls.get(n); if (!p) throw new Error("no pr"); return p; }
  async listPullFiles(_r: RepoRef, n: number) { return this.pulls.get(n)?.files ?? []; }
  async listOpenPulls() { return [...this.pulls.values()].filter((p) => p.state === "open"); }
  async getCiStatus(_r: RepoRef, sha: string) { return this.ci.get(sha) ?? { state: "success" as const, failing: [] }; }
  async upsertCheckRun(_r: RepoRef, input: CheckRunInput) {
    if (input.existingId) { const c = this.checkRuns.find((x) => x.id === input.existingId); if (c) { Object.assign(c, input); return c.id; } }
    const id = ++this.seq; this.checkRuns.push({ ...input, id }); return id;
  }
  async syncLabels(_r: RepoRef, n: number, desired: string[], isManaged: (s: string) => boolean) {
    const cur = this.labels.get(n) ?? new Set<string>();
    for (const l of [...cur]) if (isManaged(l) && !desired.includes(l)) cur.delete(l);
    for (const l of desired) cur.add(l);
    this.labels.set(n, cur);
  }

  /** Test helpers */
  commentsOn(n: number) { return [...this.comments.values()].filter((c) => c.number === n).map((c) => c.body); }
  labelsOn(n: number) { return [...(this.labels.get(n) ?? [])].sort(); }
  addPull(n: number, o: Partial<PullInfo> & { files?: PullFile[] } = {}) {
    this.pulls.set(n, {
      number: n, title: "Fix it", body: "Closes #5", state: "open", draft: false, merged: false, mergedAt: null,
      headSha: `sha${n}a`, authorId: 20, authorLogin: "mira", additions: 10, deletions: 2, changedFiles: 1,
      files: [{ filename: "src/a.ts", status: "modified", additions: 10, deletions: 2, patch: "@@ +x" }],
      ...o,
    });
  }
}

export class FakePayPal implements PayPalPort {
  orders = new Map<string, { requestId: string; amountCents: number }>();
  captures = new Map<string, number>();
  payouts: { requestId: string; email: string; amountCents: number; batchId: string }[] = [];
  refunds: { captureId: string; requestId: string }[] = [];
  failNextPayouts = 0;
  failNextRefunds = 0;
  captureAmountOverride: number | null = null;
  batchStatus: "pending" | "success" | "failed" = "success";

  async createOrder(i: { amountCents: number; requestId: string }) {
    for (const [id, o] of this.orders) if (o.requestId === i.requestId) return { orderId: id, approveUrl: `https://paypal.test/approve/${id}` };
    const id = `ORDER${this.orders.size + 1}`; this.orders.set(id, { requestId: i.requestId, amountCents: i.amountCents });
    return { orderId: id, approveUrl: `https://paypal.test/approve/${id}` };
  }
  async captureOrder(orderId: string) {
    const o = this.orders.get(orderId); if (!o) throw new Error("unknown order");
    const captureId = `CAP-${orderId}`; this.captures.set(captureId, o.amountCents);
    return { captureId, completed: true, amountCents: this.captureAmountOverride ?? o.amountCents };
  }
  async refundCapture(captureId: string, requestId: string) {
    if (this.failNextRefunds > 0) { this.failNextRefunds--; throw new Error("PayPal 500"); }
    const existing = this.refunds.find((r) => r.requestId === requestId);
    if (!existing) this.refunds.push({ captureId, requestId });
    return { refundId: `REF-${requestId}` };
  }
  async sendPayout(i: { email: string; amountCents: number; requestId: string }) {
    if (this.failNextPayouts > 0) { this.failNextPayouts--; throw new Error("PayPal 500"); }
    const existing = this.payouts.find((p) => p.requestId === i.requestId);
    if (existing) return { batchId: existing.batchId }; // PayPal replays the same answer for the same request id
    const batchId = `BATCH${this.payouts.length + 1}`;
    this.payouts.push({ requestId: i.requestId, email: i.email, amountCents: i.amountCents, batchId });
    return { batchId };
  }
  async getPayoutBatch() { return { status: this.batchStatus }; }
}

export class FakeReviewer implements ReviewerPort {
  calls = 0;
  score = 90;
  recommendation: "approve" | "needs_review" = "approve";
  fail = false;
  async review(_i: ReviewInput): Promise<ReviewVerdict> {
    this.calls++;
    if (this.fail) throw new Error("AI down");
    const s = this.score;
    const rubric = { solves_issue: Math.round(s * 0.25), scope: Math.round(s * 0.2), tests_ci: Math.round(s * 0.3), quality: Math.round(s * 0.2), red_flags: Math.round(s * 0.05) };
    return { rubric, score: Object.values(rubric).reduce((a, b) => a + b, 0), recommendation: this.recommendation, summary: "Looks fine.", redFlags: [], model: "fake" };
  }
}

export function makeWorld() {
  const store = new MemoryStore();
  const gh = new FakeGitHub();
  const pp = new FakePayPal();
  const reviewer = new FakeReviewer();
  const clock = { t: new Date("2026-10-20T10:00:00Z"), now() { return this.t; } };
  let n = 0;
  const d: Deps = {
    store, github: gh, paypal: pp, reviewer, clock,
    config: { appSlug: "bountyline", apiUrl: "https://api.test", dashboardUrl: "https://app.test", encryptionKey: KEY, pickerOptionsCents: [2500, 5000, 10000, 25000] },
    newId: () => `id${++n}`, newToken: () => `tok${++n}`,
    log: () => {},
  };
  gh.permissions.set("maint", "write");
  gh.permissions.set("mira", "read");
  const advance = (ms: number) => { clock.t = new Date(clock.t.getTime() + ms); };
  const hours = (h: number) => advance(h * 3_600_000);
  return { d, store, gh, pp, reviewer, clock, advance, hours, settings: DEFAULT_SETTINGS };
}

export type World = ReturnType<typeof makeWorld>;

export const REPO = { id: 1, name: "widgets", owner: { login: "acme" } };
export const INSTALL = { id: 99 };

export function commentPayload(o: { action?: string; issue?: number; pull?: boolean; body: string; sender: { id: number; login: string; type?: string }; commentId?: number; from?: string; author?: { id: number; login: string; type?: string } }) {
  return {
    action: o.action ?? "created",
    issue: { number: o.issue ?? 5, ...(o.pull ? { pull_request: {} } : {}) },
    comment: { id: o.commentId ?? 1, body: o.body, user: o.author ?? o.sender },
    ...(o.from !== undefined ? { changes: { body: { from: o.from } } } : {}),
    repository: REPO, installation: INSTALL, sender: o.sender,
  };
}

export function prPayload(o: { action: string; number: number; body?: string; sha?: string; author?: { id: number; login: string }; merged?: boolean; draft?: boolean }) {
  const a = o.author ?? { id: 20, login: "mira" };
  return {
    action: o.action, number: o.number,
    pull_request: { number: o.number, title: "Fix it", body: o.body ?? "Closes #5", state: o.action === "closed" ? "closed" : "open", draft: !!o.draft, merged: !!o.merged, head: { sha: o.sha ?? `sha${o.number}a` }, user: a },
    repository: REPO, installation: INSTALL, sender: { ...a, type: "User" },
  };
}

export const MAINT = { id: 10, login: "maint", type: "User" };
export const MIRA = { id: 20, login: "mira", type: "User" };

export async function addPayoutAccount(w: World, user = MIRA, email = "mira@example.com") {
  await w.store.savePayoutAccount({ githubUserId: user.id, githubLogin: user.login, paypalEmailEnc: encrypt(email, KEY), createdAt: w.clock.now(), updatedAt: w.clock.now() });
}
