import { describe, expect, test } from "bun:test";
import { loadEnv } from "../src/env";

const good = {
  DATABASE_URL: "postgresql://x", API_URL: "https://api.example.com/", DASHBOARD_URL: "https://app.example.com", GITHUB_APP_SLUG: "bountyline", GITHUB_APP_ID: "1",
  GITHUB_PRIVATE_KEY: "-----BEGIN-----\\nabc\\n-----END-----", GITHUB_WEBHOOK_SECRET: "w", GITHUB_CLIENT_ID: "c", GITHUB_CLIENT_SECRET: "s",
  SESSION_SECRET: "s".repeat(32), ENCRYPTION_KEY: "ab".repeat(32), PAYPAL_CLIENT_ID: "p", PAYPAL_SECRET: "q", ANTHROPIC_API_KEY: "k",
};

describe("loadEnv", () => {
  test("accepts a complete config and normalizes it", () => {
    const e = loadEnv(good);
    expect(e.apiUrl).toBe("https://api.example.com");
    expect(e.githubPrivateKey).toContain("\nabc\n");
    expect(e.paypalEnv).toBe("sandbox");
    expect(e.pickerOptionsCents).toEqual([2500, 5000, 10000, 25000]);
  });
  test("lists every problem at once", () => {
    let message = "";
    try {
      loadEnv({ ...good, ENCRYPTION_KEY: "short", SESSION_SECRET: "x", ANTHROPIC_API_KEY: "", PAYPAL_ENV: "prod" });
    } catch (e) {
      message = (e as Error).message;
    }
    for (const k of ["ENCRYPTION_KEY", "SESSION_SECRET", "ANTHROPIC_API_KEY", "PAYPAL_ENV"]) expect(message).toContain(k);
  });
});

describe("AI provider choice", () => {
  const { ANTHROPIC_API_KEY: _drop, ...base } = good;
  test("defaults to anthropic with a default model", () => {
    const e = loadEnv({ ...base, ANTHROPIC_API_KEY: "k" });
    expect([e.reviewProvider, e.reviewModel, e.reviewApiKey]).toEqual(["anthropic", "claude-sonnet-5-5", "k"]);
  });
  test("other providers need their own key and an explicit model", () => {
    expect(() => loadEnv({ ...base, REVIEW_PROVIDER: "google", ANTHROPIC_API_KEY: "k" })).toThrow(/REVIEW_MODEL[\s\S]*GOOGLE_GENERATIVE_AI_API_KEY/);
    const e = loadEnv({ ...base, REVIEW_PROVIDER: "xai", REVIEW_MODEL: "grok-x", XAI_API_KEY: "x" });
    expect([e.reviewProvider, e.reviewModel, e.reviewApiKey]).toEqual(["xai", "grok-x", "x"]);
  });
  test("an unknown provider is rejected", () => {
    expect(() => loadEnv({ ...base, REVIEW_PROVIDER: "mistral", ANTHROPIC_API_KEY: "k" })).toThrow("REVIEW_PROVIDER");
  });
});
