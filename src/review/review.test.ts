import { describe, expect, test } from "bun:test";
import { chunkFiles, filterFiles, isIgnoredFile } from "./filter";
import { ReviewParseError, parseVerdict } from "./parse";
import { AiReviewer, anthropicComplete } from "./reviewer";
import { SYSTEM_PROMPT } from "./prompt";
import { issueComment, newlyChecked, pickerComment, readCheckboxes, readMarker, desiredLabels, isManagedLabel } from "../core/messages";

const good = JSON.stringify({
  rubric: { solves_issue: 22, scope: 18, tests_ci: 25, quality: 17, red_flags: 5 },
  recommendation: "approve",
  summary: "Fixes the race and adds a test.",
  red_flags: [],
});

describe("file filter", () => {
  test("drops lockfiles, generated, minified, snapshots and binaries", () => {
    for (const p of ["bun.lock", "web/package-lock.json", "dist/app.js", "src/a.min.js", "src/__snapshots__/a.snap", "logo.png", "vendor/x/y.go", "pkg/api.pb.go"]) {
      expect(isIgnoredFile(p)).toBe(true);
    }
    for (const p of ["src/index.ts", "README.md", "lib/builder.ts", "docs/guide.md"]) expect(isIgnoredFile(p)).toBe(false);
  });
  test("counts changed lines of kept files only", () => {
    const r = filterFiles([
      { filename: "src/a.ts", status: "modified", additions: 10, deletions: 2, patch: "@@ x" },
      { filename: "bun.lock", status: "modified", additions: 900, deletions: 1, patch: "@@" },
      { filename: "big.bin", status: "added", additions: 0, deletions: 0 },
    ]);
    expect(r.kept.map((f) => f.filename)).toEqual(["src/a.ts"]);
    expect(r.dropped).toEqual(["bun.lock", "big.bin"]);
    expect(r.changedLines).toBe(12);
  });
  test("chunks by size and truncates a huge file", () => {
    const files = [1, 2, 3].map((i) => ({ filename: `f${i}.ts`, patch: "x".repeat(400) }));
    expect(chunkFiles(files, 1000).length).toBe(2);
    const big = chunkFiles([{ filename: "big.ts", patch: "y".repeat(5000) }], 1000);
    expect(big[0]![0]!.patch.length).toBeLessThan(1100);
  });
});

describe("verdict parsing", () => {
  test("accepts valid JSON, also inside a code fence, and computes the total itself", () => {
    const v = parseVerdict("```json\n" + good + "\n```", "m");
    expect(v.score).toBe(87);
    expect(v.recommendation).toBe("approve");
  });
  test("clamps scores to the rubric maximums", () => {
    const bad = JSON.stringify({ rubric: { solves_issue: 999, scope: -4, tests_ci: 30, quality: 20, red_flags: 5 }, recommendation: "approve", summary: "ok" });
    const v = parseVerdict(bad, "m");
    expect(v.rubric.solves_issue).toBe(25);
    expect(v.rubric.scope).toBe(0);
    expect(v.score).toBe(80);
  });
  test("rejects garbage", () => {
    expect(() => parseVerdict("sure, looks great!", "m")).toThrow(ReviewParseError);
    expect(() => parseVerdict('{"rubric":{},"recommendation":"approve","summary":"x"}', "m")).toThrow(ReviewParseError);
    expect(() => parseVerdict(good.replace('"approve"', '"yes"'), "m")).toThrow(ReviewParseError);
  });
});

const input = {
  issue: { title: "Fix race", body: "body" },
  pr: { title: "Fix", body: "Closes #1" },
  files: [{ filename: "a.ts", patch: "+x" }],
  droppedFiles: [],
  ci: { state: "success" as const, failing: [] },
};

describe("AiReviewer", () => {
  test("single call for a small diff, with the injection defence in the system prompt", async () => {
    const calls: { system: string; user: string }[] = [];
    const r = new AiReviewer(async (system, user) => (calls.push({ system, user }), good), "m");
    const v = await r.review(input);
    expect(v.score).toBe(87);
    expect(calls.length).toBe(1);
    expect(calls[0]!.system).toBe(SYSTEM_PROMPT);
    expect(SYSTEM_PROMPT).toContain("untrusted");
    expect(calls[0]!.user).toContain("<diff>");
  });
  test("retries once on invalid output, then gives up", async () => {
    let n = 0;
    const flaky = new AiReviewer(async () => (++n === 1 ? "nope" : good), "m");
    expect((await flaky.review(input)).score).toBe(87);
    expect(n).toBe(2);
    const broken = new AiReviewer(async () => "nope", "m");
    await expect(broken.review(input)).rejects.toThrow(ReviewParseError);
  });
  test("large diffs are summarised in parts, then judged once", async () => {
    const files = [1, 2, 3].map((i) => ({ filename: `f${i}.ts`, patch: "z".repeat(500) }));
    let notes = 0;
    let finals = 0;
    const r = new AiReviewer(
      async (system) => {
        if (system.includes("split into parts")) return notes++, "- ok";
        finals++;
        return good;
      },
      "m",
      { maxChunkChars: 600 },
    );
    await r.review({ ...input, files });
    expect(notes).toBe(3);
    expect(finals).toBe(1);
  });
});

describe("anthropicComplete", () => {
  test("sends the right request and joins text blocks", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await anthropicComplete({ apiKey: "k", model: "claude-x", fetchImpl: f })("sys", "usr");
    expect(out).toBe("ab");
    expect(seen!.url).toBe("https://api.anthropic.com/v1/messages");
    expect((seen!.init.headers as Record<string, string>)["x-api-key"]).toBe("k");
    const body = JSON.parse(seen!.init.body as string);
    expect(body.system).toBe("sys");
    expect(body.messages[0].content).toBe("usr");
  });
  test("surfaces API errors", async () => {
    const f = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
    await expect(anthropicComplete({ apiKey: "k", model: "m", fetchImpl: f })("s", "u")).rejects.toThrow("429");
  });
});

describe("messages", () => {
  test("picker round trip", () => {
    const body = pickerComment("p1", "dev", [2500, 5000, 10000]);
    expect(readMarker(body, "picker")).toBe("p1");
    expect(readCheckboxes(body)).toEqual([false, false, false]);
    const ticked = body.replace("- [ ] $50", "- [x] $50");
    expect(newlyChecked(body, ticked)).toBe(1);
    expect(newlyChecked(body, body)).toBeNull();
    expect(newlyChecked(body, ticked.replace("- [ ] $25", "- [x] $25"))).toBeNull(); // two at once is ambiguous
  });
  test("labels follow the status", () => {
    expect(desiredLabels("funded", 15000)).toEqual(["bounty: $150"]);
    expect(desiredLabels("window", 15000)).toEqual(["bounty: $150", "payout scheduled"]);
    expect(desiredLabels("paid", 15000)).toEqual(["bounty: paid"]);
    expect(desiredLabels("refunded", 15000)).toEqual(["bounty: refunded"]);
    expect(isManagedLabel("bounty: $150")).toBe(true);
    expect(isManagedLabel("bug")).toBe(false);
  });
  test("status comments never leak payment details", () => {
    const c = issueComment({ bountyId: "b1", status: "window", amountCents: 15000, funderLogin: "maint", pr: { number: 7, authorLogin: "mira" }, windowEndsAt: new Date("2026-10-18T14:00:00Z") });
    expect(c).toContain("2026-10-18 14:00 UTC");
    expect(c).toContain("@mira");
    expect(c).not.toMatch(/paypal|[\w.]+@[\w-]+\.[a-z]+|order id/i);
  });
});
