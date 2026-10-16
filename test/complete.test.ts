import { describe, expect, test } from "bun:test";
import { aiSdkComplete } from "../src/review/complete";

describe("aiSdkComplete", () => {
  test("sends system and user as messages and returns the text", async () => {
    let seen: any;
    const complete = aiSdkComplete("MODEL", async (args) => ((seen = args), { text: '{"ok":true}' }));
    expect(await complete("be strict", "review this")).toBe('{"ok":true}');
    expect(seen.model).toBe("MODEL");
    expect(seen.messages).toEqual([{ role: "system", content: "be strict" }, { role: "user", content: "review this" }]);
    expect(seen.temperature).toBe(0);
  });
  test("empty output is an error, so the job retries", async () => {
    const complete = aiSdkComplete("M", async () => ({ text: "  " }));
    await expect(complete("s", "u")).rejects.toThrow("no text");
  });
});
