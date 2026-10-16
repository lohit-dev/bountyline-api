/** Wires the real adapters together and starts the HTTP server and the job worker. */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { GitHubClient } from "./adapters/github";
import { PayPalClient } from "./adapters/paypal";
import { PrismaStore } from "./adapters/prisma-store";
import { randomToken } from "./core/crypto";
import { loadEnv } from "./env";
import { createApp } from "./http/app";
import { Api } from "./http/handlers";
import { AiReviewer, anthropicComplete } from "./review/reviewer";
import type { Deps } from "./services/context";
import { runDueJobs, scheduleSweep } from "./services/jobs";

const env = loadEnv();
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.databaseUrl }) });

const deps: Deps = {
  store: new PrismaStore(db),
  github: new GitHubClient({ appId: env.githubAppId, privateKey: env.githubPrivateKey }),
  paypal: new PayPalClient({ clientId: env.paypalClientId, secret: env.paypalSecret, env: env.paypalEnv }),
  reviewer: new AiReviewer(anthropicComplete({ apiKey: env.anthropicApiKey, model: env.reviewModel }), env.reviewModel),
  clock: { now: () => new Date() },
  config: { appSlug: env.appSlug, apiUrl: env.apiUrl, dashboardUrl: env.dashboardUrl, encryptionKey: env.encryptionKey, pickerOptionsCents: env.pickerOptionsCents },
  newId: () => crypto.randomUUID(),
  newToken: () => randomToken(),
  log: (message, data) => console.log(message, data ?? ""),
};

const api = new Api(deps, {
  webhookSecret: env.githubWebhookSecret,
  sessionSecret: env.sessionSecret,
  githubOAuth: { clientId: env.githubClientId, clientSecret: env.githubClientSecret },
});

// Worker: process due jobs every 2 seconds. One tick at a time, so a slow job never overlaps itself.
let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    while ((await runDueJobs(deps)) > 0) { /* keep going while there is work */ }
  } catch (err) {
    console.error("worker tick failed", err);
  } finally {
    busy = false;
  }
}

await scheduleSweep(deps, 1);
setInterval(tick, 2000);

export default { port: env.port, fetch: createApp(api, env.dashboardUrl).fetch };
console.log(`Bountyline API listening on :${env.port}`);
