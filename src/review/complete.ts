import type { Complete } from "./reviewer";

type Generate = (args: { model: unknown; messages: { role: "system" | "user"; content: string }[]; maxOutputTokens?: number; temperature?: number }) => Promise<{ text: string }>;

/**
 * Turns an AI SDK model into the (system, user) => text function the reviewer needs.
 * The system prompt is sent as a system message, which works across AI SDK versions.
 * `generate` is the SDK's generateText, passed in so this can be tested without the package.
 */
export function aiSdkComplete(model: unknown, generate: Generate, opts: { maxOutputTokens?: number } = {}): Complete {
  return async (system, user) => {
    const { text } = await generate({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      maxOutputTokens: opts.maxOutputTokens ?? 1500,
      temperature: 0,
    });
    if (!text?.trim()) throw new Error("The AI provider returned no text");
    return text;
  };
}
