/** Which providers are supported and which env var holds each one's key. No dependencies. */
export const PROVIDERS = ["anthropic", "openai", "google", "xai"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const KEY_ENV: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  xai: "XAI_API_KEY",
};

export const DEFAULT_MODEL: Partial<Record<Provider, string>> = { anthropic: "claude-sonnet-5-5" };

export const isProvider = (v: string): v is Provider => (PROVIDERS as readonly string[]).includes(v);
