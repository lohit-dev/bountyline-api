import { describe, expect, test } from "bun:test";
import { linkedIssueNumbers, parseCommand } from "./commands";
import { decrypt, encrypt, maskEmail, signToken, verifyToken } from "./crypto";
import { centsToDecimal, fmtUsd, passesReview, validateAmount } from "./rules";
import { AlreadyPaidError, IllegalTransitionError, transition } from "./state";

const merged = { merged: true };
const open = { merged: false };

describe("parseCommand", () => {
  test("parses amounts", () => {
    expect(parseCommand("/bounty 150")).toEqual({ type: "bounty", amountCents: 15000 });
    expect(parseCommand("/bounty $150.5")).toEqual({ type: "bounty", amountCents: 15050 });
    expect(parseCommand("/bounty 25 USD")).toEqual({ type: "bounty", amountCents: 2500 });
  });
  test("bare /bounty asks for the picker", () => {
    expect(parseCommand("/bounty")).toEqual({ type: "picker" });
  });
  test("rejects unreadable amounts", () => {
    expect(parseCommand("/bounty lots")?.type).toBe("invalid");
    expect(parseCommand("/bounty -5")?.type).toBe("invalid");
  });
  test("other commands", () => {
    expect(parseCommand("/cancel-bounty")).toEqual({ type: "cancel" });
    expect(parseCommand("looks wrong\n/veto-bounty please")).toEqual({ type: "veto" });
    expect(parseCommand("/approve-bounty")).toEqual({ type: "approve" });
  });
  test("ignores quotes, code blocks, mid-line text and lookalikes", () => {
    expect(parseCommand("> /bounty 500")).toBeNull();
    expect(parseCommand("```\n/bounty 500\n```")).toBeNull();
    expect(parseCommand("please /bounty 500")).toBeNull();
    expect(parseCommand("/bounty-foo 5")).toBeNull();
  });
});

describe("linkedIssueNumbers", () => {
  const repo = { owner: "acme", name: "widgets" };
  test("finds closing keywords", () => {
    expect(linkedIssueNumbers("Closes #12 and fixes #7", repo)).toEqual([7, 12]);
    expect(linkedIssueNumbers("Resolved: #3", repo)).toEqual([3]);
  });
  test("handles other repos and code blocks", () => {
    expect(linkedIssueNumbers("fixes other/thing#4", repo)).toEqual([]);
    expect(linkedIssueNumbers("fixes Acme/Widgets#4", repo)).toEqual([4]);
    expect(linkedIssueNumbers("```\nCloses #9\n```", repo)).toEqual([]);
    expect(linkedIssueNumbers("see #9", repo)).toEqual([]);
  });
});

describe("state machine", () => {
  test("happy path needs a merge before the window", () => {
    expect(transition("created", "FUNDED", open).to).toBe("funded");
    expect(transition("funded", "PR_LINKED", open).to).toBe("claimed");
    expect(transition("claimed", "REVIEW_PASSED", open).to).toBe("reviewed");
    const w = transition("reviewed", "PR_MERGED", merged);
    expect(w.to).toBe("window");
    expect(w.effects).toEqual(["START_WINDOW"]);
    expect(transition("window", "PAYOUT_SENT", merged).to).toBe("paid");
  });
  test("a passing review on an already-merged PR starts the window", () => {
    const r = transition("claimed", "REVIEW_PASSED", merged);
    expect(r.to).toBe("window");
    expect(r.effects).toEqual(["START_WINDOW"]);
  });
  test("merging with a stale review triggers a new review", () => {
    const r = transition("reviewed", "PR_MERGED", { merged: true, reviewCurrent: false });
    expect(r.to).toBe("claimed");
    expect(r.effects).toEqual(["RUN_REVIEW"]);
    expect(transition("claimed", "PR_MERGED", merged).effects).toEqual(["RUN_REVIEW"]);
  });
  test("flagged needs a merge to be approved, then pays now", () => {
    expect(() => transition("flagged", "APPROVE", open)).toThrow(IllegalTransitionError);
    const r = transition("flagged", "APPROVE", merged);
    expect(r.to).toBe("window");
    expect(r.effects).toEqual(["PAY_NOW"]);
    expect(transition("flagged", "PR_MERGED", merged).to).toBe("flagged");
  });
  test("veto refunds, and a veto after payment is refused", () => {
    expect(transition("window", "VETO", merged).effects).toEqual(["REFUND"]);
    expect(() => transition("paid", "VETO", merged)).toThrow(AlreadyPaidError);
    expect(() => transition("paid", "CANCEL", merged)).toThrow(AlreadyPaidError);
  });
  test("cancel before funding has nothing to refund", () => {
    expect(transition("created", "CANCEL", open).effects).toEqual([]);
    expect(transition("funded", "CANCEL", open).effects).toEqual(["REFUND"]);
    expect(() => transition("window", "CANCEL", merged)).toThrow(IllegalTransitionError);
  });
  test("repeating an applied event is a no-op", () => {
    expect(transition("funded", "FUNDED", open).noop).toBe(true);
    expect(transition("refunded", "REFUNDED", open).noop).toBe(true);
    expect(transition("window", "PR_MERGED", merged).noop).toBe(true);
    expect(transition("vetoed", "VETO", merged).noop).toBe(true);
  });
  test("illegal jumps throw", () => {
    expect(() => transition("created", "PAYOUT_SENT", open)).toThrow(IllegalTransitionError);
    expect(() => transition("funded", "PAYOUT_SENT", open)).toThrow(IllegalTransitionError);
    expect(() => transition("refunded", "FUNDED", open)).toThrow(IllegalTransitionError);
  });
  test("a closed PR releases the bounty", () => {
    expect(transition("claimed", "PR_CLOSED", open).to).toBe("funded");
    expect(transition("flagged", "SUBMISSION_CHANGED", open).to).toBe("claimed");
  });
  test("abandoned payout refunds", () => {
    const r = transition("window", "PAYOUT_ABANDONED", merged);
    expect(r.to).toBe("expired");
    expect(r.effects).toEqual(["REFUND"]);
    expect(transition("expired", "REFUNDED", merged).to).toBe("refunded");
  });
});

describe("rules", () => {
  const limits = { minAmountCents: 500, maxAmountCents: 50000 };
  test("amount limits", () => {
    expect(validateAmount(2500, limits)).toBeNull();
    expect(validateAmount(100, limits)).toContain("minimum");
    expect(validateAmount(60000, limits)).toContain("maximum");
    expect(validateAmount(0, limits)).not.toBeNull();
  });
  test("money formatting", () => {
    expect(fmtUsd(15000)).toBe("$150");
    expect(fmtUsd(15050)).toBe("$150.50");
    expect(centsToDecimal(15000)).toBe("150.00");
  });
  test("passing needs score, approval and non-failing CI", () => {
    const base = { score: 80, threshold: 75, recommendation: "approve" as const, ci: "success" as const };
    expect(passesReview(base)).toBe(true);
    expect(passesReview({ ...base, score: 74 })).toBe(false);
    expect(passesReview({ ...base, ci: "failure" })).toBe(false);
    expect(passesReview({ ...base, ci: "none" })).toBe(true);
    expect(passesReview({ ...base, recommendation: "needs_review" })).toBe(false);
  });
});

describe("crypto", () => {
  const key = "00".repeat(32);
  test("round trip and tamper detection", () => {
    const c = encrypt("dev@example.com", key);
    expect(c).not.toContain("dev@example.com");
    expect(decrypt(c, key)).toBe("dev@example.com");
    expect(() => decrypt(c.slice(0, -2) + "AA", key)).toThrow();
    expect(() => encrypt("x", "abcd")).toThrow();
  });
  test("mask", () => expect(maskEmail("dev@example.com")).toBe("d***@example.com"));
  test("signed tokens expire and resist tampering", () => {
    const now = new Date("2026-10-16T00:00:00Z");
    const t = signToken("s3cret", { uid: 5 }, 60, now);
    expect(verifyToken<{ uid: number }>("s3cret", t, now)?.uid).toBe(5);
    expect(verifyToken("other", t, now)).toBeNull();
    expect(verifyToken("s3cret", t, new Date(now.getTime() + 120_000))).toBeNull();
    expect(verifyToken("s3cret", "x." + t.split(".")[1], now)).toBeNull();
  });
});
