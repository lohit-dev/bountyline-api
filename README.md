# bountyline-api

Bountyline's backend: a GitHub App webhook receiver, the bounty state machine, PayPal funding and payouts, the AI review pipeline, a small job queue, and the JSON API the dashboard uses.

Stack: Bun, Hono, Prisma 7 on Postgres. GitHub, PayPal and Anthropic are called with plain `fetch`, no SDKs.

## How a bounty works

1. A maintainer comments `/bounty 150` on an issue, or `/bounty` and ticks an amount in the checkbox comment the bot posts.
2. The bot replies with a funding link on this API (`/fund/<token>`). The funder signs in with GitHub and pays through PayPal. Only then is the bounty live.
3. A contributor opens a pull request that says `Closes #<issue>`. The AI reviews it (score out of 100, pass mark 75, CI must not be failing).
4. The contributor is paid only if the review passed **and** the pull request was merged, after a review window (default 48 h) in which any maintainer can `/veto-bounty`. `/approve-bounty` pays immediately.
5. Vetoed, cancelled and expired bounties are refunded to the funder.

**Payouts are final.** Once PayPal has been asked to send the money it cannot be recalled, so a veto after that point is refused.

Commands: `/bounty [amount]`, `/cancel-bounty`, `/veto-bounty`, `/approve-bounty`. Only people with write access can use them (the funder can also cancel before payout).

## Layout

```
src/core        pure logic: state machine, command parser, rules, crypto, bot messages
src/services    the use cases (commands, PRs, review, funding, payouts, sweeper, job router)
src/adapters    GitHub, PayPal, Postgres (Prisma) and in-memory implementations
src/review      AI review: rubric, prompt, diff filtering/chunking, verdict parsing
src/http        request handlers + Hono router
test/           scenario tests with fake GitHub / PayPal / AI
```

The services only depend on the interfaces in `src/ports.ts`, which is how the whole money path is tested without network or database.

## Run it

```sh
bun install
cp .env.example .env          # fill it in, see below
bun run db:generate           # generates ./generated/prisma
bun run db:migrate            # first time: creates prisma/migrations (commit them)
bun test
bun run dev
```

Prisma 7 does not load `.env` by itself, which is why the db scripts use `bunx --bun` (Bun loads it).

### GitHub App

Create it at Settings > Developer settings > GitHub Apps.

- Webhook URL: `<API_URL>/webhooks/github`, plus a webhook secret (`GITHUB_WEBHOOK_SECRET`).
- Callback URL: `<API_URL>/auth/callback`. Copy the client id and secret.
- Permissions: Issues (read and write), Pull requests (read and write), Checks (read and write), Metadata (read).
- Subscribe to events: Issue comment, Pull request, Check run, Issues, plus the installation events.
- Generate a private key and put it in `GITHUB_PRIVATE_KEY` on one line with `\n` between lines.

### PayPal

Create an app in the PayPal developer dashboard and use the **sandbox** credentials first (`PAYPAL_ENV=sandbox`). Funders pay with a sandbox buyer account; payouts need a sandbox business account with Payouts enabled.

### Deploy (Render)

Build: `bun install && bun run db:generate`. Start: `bun run db:deploy && bun run start`. Set the variables from `.env.example`. One instance runs both the web server and the worker.

## Settings (per repository, defaults)

Review window 48 h, pass score 75, bounty expires after 30 days unclaimed (60 once claimed), flagged reviews are refunded after 14 days, an unpaid bounty is cancelled after 3 days, at most 5 reviews per pull request, pull requests over 1500 changed lines are not sent to the AI, amounts from $5 to $500, USD only. See `src/core/config.ts`.

## Known limits and things to verify

- The Prisma store, the Hono router, and the real GitHub, PayPal and Anthropic calls were written from documentation and tested only against fakes. Try the whole flow in the PayPal sandbox on a test repository before trusting it.
- CI status comes from GitHub check runs only, not from legacy commit statuses.
- The payout race (a veto arriving at the same moment the payout starts) is handled by marking the payout "sending" and re-checking the bounty first, but this is not a single database transaction. The window is milliseconds wide.
- If PayPal captures a different amount than the bounty, funding is refused and the money has to be refunded by hand.
- A payout to a PayPal email without an account stays unclaimed in PayPal and is reported as failed; it is not retried automatically.
- The job queue is a Postgres table (`Job`) with `FOR UPDATE SKIP LOCKED`, not pg-boss.
