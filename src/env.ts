import { DEFAULT_MODEL, KEY_ENV, PROVIDERS, isProvider, type Provider } from "./review/provider-config";

/** Reads and checks environment variables once at startup, so a typo fails loudly and early. */
export type Env = {
  port: number;
  databaseUrl: string;
  apiUrl: string;
  dashboardUrl: string;
  appSlug: string;
  githubAppId: string;
  githubPrivateKey: string;
  githubWebhookSecret: string;
  githubClientId: string;
  githubClientSecret: string;
  sessionSecret: string;
  encryptionKey: string;
  paypalClientId: string;
  paypalSecret: string;
  paypalEnv: "sandbox" | "live";
  reviewProvider: Provider;
  reviewModel: string;
  reviewApiKey: string;
  pickerOptionsCents: number[];
};

export function loadEnv(e: Record<string, string | undefined> = process.env): Env {
  const problems: string[] = [];
  const need = (k: string) => {
    const v = e[k]?.trim();
    if (!v) problems.push(`${k} is missing`);
    return v ?? "";
  };
  const url = (k: string) => need(k).replace(/\/+$/, "");

  const encryptionKey = need("ENCRYPTION_KEY");
  if (encryptionKey && !/^[0-9a-fA-F]{64}$/.test(encryptionKey)) problems.push("ENCRYPTION_KEY must be 64 hex characters (openssl rand -hex 32)");
  const sessionSecret = need("SESSION_SECRET");
  if (sessionSecret && sessionSecret.length < 32) problems.push("SESSION_SECRET must be at least 32 characters");
  const paypalEnv = (e["PAYPAL_ENV"] ?? "sandbox") as string;
  if (paypalEnv !== "sandbox" && paypalEnv !== "live") problems.push('PAYPAL_ENV must be "sandbox" or "live"');

  const providerName = (e["REVIEW_PROVIDER"] ?? "anthropic").trim().toLowerCase();
  if (!isProvider(providerName)) problems.push(`REVIEW_PROVIDER must be one of: ${PROVIDERS.join(", ")}`);
  const reviewProvider: Provider = isProvider(providerName) ? providerName : "anthropic";
  const reviewModel = e["REVIEW_MODEL"]?.trim() || DEFAULT_MODEL[reviewProvider] || "";
  if (!reviewModel) problems.push(`REVIEW_MODEL is missing (required for ${reviewProvider})`);

  const picker = (e["PICKER_AMOUNTS_USD"] ?? "25,50,100,250").split(",").map((s) => Math.round(Number(s.trim()) * 100));
  if (picker.some((c) => !Number.isFinite(c) || c <= 0)) problems.push("PICKER_AMOUNTS_USD must be a comma separated list of numbers");

  const env: Env = {
    port: Number(e["PORT"] ?? 3000),
    databaseUrl: need("DATABASE_URL"),
    apiUrl: url("API_URL"),
    dashboardUrl: url("DASHBOARD_URL"),
    appSlug: need("GITHUB_APP_SLUG"),
    githubAppId: need("GITHUB_APP_ID"),
    // Render and .env files store the key on one line with literal \n.
    githubPrivateKey: need("GITHUB_PRIVATE_KEY").replace(/\\n/g, "\n"),
    githubWebhookSecret: need("GITHUB_WEBHOOK_SECRET"),
    githubClientId: need("GITHUB_CLIENT_ID"),
    githubClientSecret: need("GITHUB_CLIENT_SECRET"),
    sessionSecret,
    encryptionKey,
    paypalClientId: need("PAYPAL_CLIENT_ID"),
    paypalSecret: need("PAYPAL_SECRET"),
    paypalEnv: paypalEnv === "live" ? "live" : "sandbox",
    reviewProvider,
    reviewModel,
    reviewApiKey: need(KEY_ENV[reviewProvider]),
    pickerOptionsCents: picker,
  };
  if (problems.length) throw new Error(`Bad configuration:\n- ${problems.join("\n- ")}`);
  return env;
}
