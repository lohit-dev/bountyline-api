/** Review rubric. Total 100. See PROJECT_CONTEXT.md section 12. */
export const RUBRIC = {
  solves_issue: 25,
  scope: 20,
  tests_ci: 30,
  quality: 20,
  red_flags: 5,
} as const;
export type RubricKey = keyof typeof RUBRIC;
export const RUBRIC_KEYS = Object.keys(RUBRIC) as RubricKey[];

export const totalScore = (rubric: Record<string, number>) =>
  RUBRIC_KEYS.reduce((sum, k) => sum + (rubric[k] ?? 0), 0);
