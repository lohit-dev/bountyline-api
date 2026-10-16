import type { RepoSettings } from "./config";

export type Permission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

/** Only people who can write to the repo may run maintainer commands. */
export function canManage(permission: Permission): boolean {
  return permission === "admin" || permission === "maintain" || permission === "write";
}

/** Returns an error message, or null when the amount is allowed. */
export function validateAmount(
  cents: number,
  s: Pick<RepoSettings, "minAmountCents" | "maxAmountCents">,
): string | null {
  if (!Number.isInteger(cents) || cents <= 0) return "The amount must be a positive number of dollars.";
  if (cents < s.minAmountCents) return `The minimum bounty is ${fmtUsd(s.minAmountCents)}.`;
  if (cents > s.maxAmountCents) return `The maximum bounty is ${fmtUsd(s.maxAmountCents)}.`;
  return null;
}

export function fmtUsd(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const rest = cents % 100;
  return rest === 0 ? `$${dollars}` : `$${dollars}.${String(rest).padStart(2, "0")}`;
}

/** PayPal wants decimal strings like "150.00". */
export function centsToDecimal(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function decimalToCents(value: string): number {
  return Math.round(Number(value) * 100);
}

export type CiState = "success" | "failure" | "pending" | "none";

/**
 * A review passes only if the score reaches the threshold, the model did not ask
 * for a human look, and CI is not failing. A passing review alone never pays:
 * the PR must also be merged (see state.ts).
 */
export function passesReview(input: {
  score: number;
  threshold: number;
  recommendation: "approve" | "needs_review";
  ci: CiState;
}): boolean {
  return (
    input.score >= input.threshold &&
    input.recommendation === "approve" &&
    input.ci !== "failure"
  );
}

/** A review only counts for the exact commit it looked at. */
export function reviewIsCurrent(reviewedSha: string | undefined, headSha: string): boolean {
  return !!reviewedSha && reviewedSha === headSha;
}

export const addHours = (d: Date, hours: number) => new Date(d.getTime() + hours * 3_600_000);
export const addDays = (d: Date, days: number) => addHours(d, days * 24);
export const addMinutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
