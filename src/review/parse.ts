import type { ReviewVerdict } from "../ports";
import { RUBRIC, RUBRIC_KEYS, totalScore } from "./rubric";

export class ReviewParseError extends Error {}

/** Validates the model's JSON. The total is computed here, never trusted from the model. */
export function parseVerdict(text: string, model: string): ReviewVerdict {
  const json = extractJson(text);
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new ReviewParseError("The answer was not valid JSON.");
  }
  if (!data || typeof data !== "object") throw new ReviewParseError("The answer was not an object.");
  const obj = data as Record<string, unknown>;

  const rubricIn = obj.rubric;
  if (!rubricIn || typeof rubricIn !== "object") throw new ReviewParseError("Missing rubric.");
  const rubric: Record<string, number> = {};
  for (const key of RUBRIC_KEYS) {
    const v = (rubricIn as Record<string, unknown>)[key];
    if (typeof v !== "number" || !Number.isFinite(v)) throw new ReviewParseError(`Missing or invalid score for ${key}.`);
    rubric[key] = Math.min(RUBRIC[key], Math.max(0, Math.round(v)));
  }

  const rec = obj.recommendation;
  if (rec !== "approve" && rec !== "needs_review") throw new ReviewParseError("Invalid recommendation.");

  const summary = typeof obj.summary === "string" ? obj.summary.trim().slice(0, 700) : "";
  if (!summary) throw new ReviewParseError("Missing summary.");

  const flagsIn = Array.isArray(obj.red_flags) ? obj.red_flags : [];
  const redFlags = flagsIn
    .filter((f): f is string => typeof f === "string" && f.trim().length > 0)
    .slice(0, 5)
    .map((f) => f.trim().slice(0, 200));

  return { rubric, score: totalScore(rubric), recommendation: rec, summary, redFlags, model };
}

function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new ReviewParseError("No JSON found in the answer.");
  return body.slice(start, end + 1);
}
