/**
 * GitHub App client using plain fetch + node:crypto (no SDK).
 * VERIFY against real GitHub: written from the REST docs, not run against the live API.
 */
import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import type { RepoRef } from "../domain";
import type { CheckRunInput, CiStatus, GitHubPort, IssueInfo, PullFile, PullInfo } from "../ports";
import type { Permission } from "../core/rules";

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Checks the X-Hub-Signature-256 header against the raw request body. */
export function verifyWebhookSignature(secret: string, rawBody: string, header: string | null | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  let given: Buffer;
  try {
    given = Buffer.from(header.slice(7), "hex");
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** RS256 JWT that identifies the app itself (valid up to 10 minutes). */
export function createAppJwt(appId: string, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat: nowSec - 30, exp: nowSec + 9 * 60, iss: appId }));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKeyPem);
  return `${head}.${body}.${b64url(sig)}`;
}

export class GitHubError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class GitHubClient implements GitHubPort {
  private tokens = new Map<number, { token: string; expires: number }>();
  private fetchFn: FetchFn;
  constructor(
    private opts: { appId: string; privateKey: string; apiBase?: string; fetch?: FetchFn; now?: () => number },
  ) {
    this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
  }
  private get base() {
    return this.opts.apiBase ?? "https://api.github.com";
  }
  private now() {
    return (this.opts.now ?? Date.now)();
  }

  private async installationToken(installationId: number): Promise<string> {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expires - 60_000 > this.now()) return cached.token;
    const jwt = createAppJwt(this.opts.appId, this.opts.privateKey, Math.floor(this.now() / 1000));
    const res = await this.fetchFn(`${this.base}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "bountyline" },
    });
    if (!res.ok) throw new GitHubError(res.status, `installation token: ${res.status}`);
    const data = (await res.json()) as { token: string; expires_at: string };
    this.tokens.set(installationId, { token: data.token, expires: Date.parse(data.expires_at) });
    return data.token;
  }

  private async api<T>(repo: RepoRef, method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<T> {
    const token = await this.installationToken(repo.installationId);
    const res = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "bountyline",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok && !okStatuses.includes(res.status)) {
      const text = await res.text().catch(() => "");
      throw new GitHubError(res.status, `${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json().catch(() => undefined)) as T;
  }

  private repoPath(r: RepoRef) {
    return `/repos/${r.owner}/${r.name}`;
  }

  async getPermission(repo: RepoRef, login: string): Promise<Permission> {
    const res = await this.api<{ permission?: string } | undefined>(repo, "GET", `${this.repoPath(repo)}/collaborators/${encodeURIComponent(login)}/permission`, undefined, [404]);
    const p = res?.permission;
    return p === "admin" || p === "maintain" || p === "write" || p === "triage" || p === "read" ? p : "none";
  }

  async createComment(repo: RepoRef, n: number, body: string): Promise<number> {
    const r = await this.api<{ id: number }>(repo, "POST", `${this.repoPath(repo)}/issues/${n}/comments`, { body });
    return r.id;
  }
  async updateComment(repo: RepoRef, id: number, body: string): Promise<void> {
    await this.api(repo, "PATCH", `${this.repoPath(repo)}/issues/comments/${id}`, { body });
  }

  async getIssue(repo: RepoRef, n: number): Promise<IssueInfo> {
    const i = await this.api<any>(repo, "GET", `${this.repoPath(repo)}/issues/${n}`);
    return { number: i.number, title: i.title ?? "", body: i.body ?? "", state: i.state === "closed" ? "closed" : "open", authorLogin: i.user?.login ?? "" };
  }

  private toPull(p: any): PullInfo {
    return {
      number: p.number,
      title: p.title ?? "",
      body: p.body ?? "",
      state: p.state === "closed" ? "closed" : "open",
      draft: !!p.draft,
      merged: !!p.merged || !!p.merged_at,
      mergedAt: p.merged_at ? new Date(p.merged_at) : null,
      headSha: p.head?.sha ?? "",
      authorId: p.user?.id ?? 0,
      authorLogin: p.user?.login ?? "",
      additions: p.additions ?? 0,
      deletions: p.deletions ?? 0,
      changedFiles: p.changed_files ?? 0,
    };
  }
  async getPull(repo: RepoRef, n: number): Promise<PullInfo> {
    return this.toPull(await this.api<any>(repo, "GET", `${this.repoPath(repo)}/pulls/${n}`));
  }
  async listOpenPulls(repo: RepoRef): Promise<PullInfo[]> {
    const list = await this.api<any[]>(repo, "GET", `${this.repoPath(repo)}/pulls?state=open&per_page=100`);
    return list.map((p) => this.toPull(p));
  }
  async listPullFiles(repo: RepoRef, n: number): Promise<PullFile[]> {
    const out: PullFile[] = [];
    for (let page = 1; page <= 10; page++) {
      const files = await this.api<any[]>(repo, "GET", `${this.repoPath(repo)}/pulls/${n}/files?per_page=100&page=${page}`);
      for (const f of files) out.push({ filename: f.filename, status: f.status, additions: f.additions ?? 0, deletions: f.deletions ?? 0, patch: f.patch });
      if (files.length < 100) break;
    }
    return out;
  }

  async getCiStatus(repo: RepoRef, sha: string): Promise<CiStatus> {
    const res = await this.api<{ check_runs: { name: string; status: string; conclusion: string | null; app?: { slug?: string } }[] }>(
      repo, "GET", `${this.repoPath(repo)}/commits/${sha}/check-runs?per_page=100`,
    );
    // Ignore our own check run, otherwise the review would wait for itself.
    const runs = res.check_runs.filter((c) => c.name !== CHECK_NAME);
    if (runs.length === 0) return { state: "none", failing: [] };
    const failing = runs.filter((c) => c.status === "completed" && ["failure", "timed_out", "cancelled", "action_required"].includes(c.conclusion ?? "")).map((c) => c.name);
    if (failing.length) return { state: "failure", failing };
    if (runs.some((c) => c.status !== "completed")) return { state: "pending", failing: [] };
    return { state: "success", failing: [] };
  }

  async upsertCheckRun(repo: RepoRef, input: CheckRunInput): Promise<number> {
    const payload = {
      name: input.name,
      head_sha: input.headSha,
      status: input.status,
      ...(input.status === "completed" ? { conclusion: input.conclusion ?? "neutral" } : {}),
      output: { title: input.title, summary: input.summary.slice(0, 60_000) },
      // GitHub allows at most 3 actions, labels up to 20 chars, descriptions up to 40 chars.
      ...(input.actions ? { actions: input.actions.slice(0, 3).map((a) => ({ label: a.label.slice(0, 20), description: a.description.slice(0, 40), identifier: a.identifier.slice(0, 20) })) } : {}),
    };
    if (input.existingId) {
      const r = await this.api<{ id: number }>(repo, "PATCH", `${this.repoPath(repo)}/check-runs/${input.existingId}`, payload);
      return r.id;
    }
    const r = await this.api<{ id: number }>(repo, "POST", `${this.repoPath(repo)}/check-runs`, payload);
    return r.id;
  }

  async syncLabels(repo: RepoRef, n: number, desired: string[], isManaged: (name: string) => boolean): Promise<void> {
    const current = await this.api<{ name: string }[]>(repo, "GET", `${this.repoPath(repo)}/issues/${n}/labels?per_page=100`);
    const names = current.map((l) => l.name);
    for (const name of names) {
      if (isManaged(name) && !desired.includes(name)) {
        await this.api(repo, "DELETE", `${this.repoPath(repo)}/issues/${n}/labels/${encodeURIComponent(name)}`, undefined, [404]);
      }
    }
    for (const name of desired) {
      if (names.includes(name)) continue;
      // Creating a label that already exists returns 422, which is fine.
      await this.api(repo, "POST", `${this.repoPath(repo)}/labels`, { name, color: labelColorFor(name) }, [422]);
    }
    const toAdd = desired.filter((d) => !names.includes(d));
    if (toAdd.length) await this.api(repo, "POST", `${this.repoPath(repo)}/issues/${n}/labels`, { labels: toAdd });
  }
}

export const CHECK_NAME = "Bountyline AI review";

import { labelColor } from "../core/messages";
const labelColorFor = labelColor;
