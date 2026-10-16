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
