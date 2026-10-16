/**
 * Choose the AI provider for reviews with config, using the Vercel AI SDK.
 * Install once: bun add ai @ai-sdk/anthropic @ai-sdk/openai @ai-sdk/google @ai-sdk/xai
 * VERIFY: written from the AI SDK docs, not run (the packages could not be installed where this was written).
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import { generateText } from "ai";
import { aiSdkComplete } from "./complete";
import type { Complete } from "./reviewer";
import type { Provider } from "./provider-config";

export function buildComplete(opts: { provider: Provider; model: string; apiKey: string }): Complete {
  const { provider, model, apiKey } = opts;
  const languageModel = {
    anthropic: () => createAnthropic({ apiKey })(model),
    openai: () => createOpenAI({ apiKey })(model),
    google: () => createGoogleGenerativeAI({ apiKey })(model),
    xai: () => createXai({ apiKey })(model),
  }[provider]();
  return aiSdkComplete(languageModel, generateText as never);
}
