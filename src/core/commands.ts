/**
 * Parsing for slash commands in comments and for "Closes #N" links in PR text.
 * Pure functions, no dependencies. See PROJECT_CONTEXT.md section 5.2.
 */

export type ParsedCommand =
  | { type: "bounty"; amountCents: number }
  | { type: "picker" }
  | { type: "invalid"; command: "bounty"; reason: string }
  | { type: "cancel" }
  | { type: "veto" }
  | { type: "approve" };

const COMMAND_RE = /^\/(bounty|cancel-bounty|veto-bounty|approve-bounty)(?=\s|$)(.*)$/i;
const AMOUNT_RE = /^\$?\s*(\d{1,6})(?:\.(\d{1,2}))?\s*(?:usd)?$/i;

/** Remove fenced code blocks so commands or links inside them are ignored. */
function stripFences(text: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out.join("\n");
}

/**
 * Finds the first slash command in a comment body.
 * A command must start a line. Quoted lines (">") and code blocks are ignored,
 * so replying to someone else's `/bounty` quote never triggers anything.
 */
export function parseCommand(body: string): ParsedCommand | null {
  for (const raw of stripFences(body).split("\n")) {
    const line = raw.trim();
    if (line.startsWith(">")) continue;
    const match = COMMAND_RE.exec(line);
    if (!match) continue;

    const name = match[1]!.toLowerCase();
    const args = (match[2] ?? "").trim();

    switch (name) {
      case "bounty":
        return parseBountyArgs(args);
      case "cancel-bounty":
        return { type: "cancel" };
      case "veto-bounty":
        return { type: "veto" };
      default:
        return { type: "approve" };
    }
  }
  return null;
}

function parseBountyArgs(args: string): ParsedCommand {
  if (!args) return { type: "picker" }; // bare /bounty: the bot posts the amount picker
  const m = AMOUNT_RE.exec(args);
  if (!m) {
    return {
      type: "invalid",
      command: "bounty",
      reason: "I could not read that amount. Use a number in USD, for example `/bounty 150`.",
    };
  }
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? "").padEnd(2, "0") || "0");
  return { type: "bounty", amountCents: whole * 100 + frac };
}

const CLOSING_RE =
  /\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s*:?\s+(?:([\w.-]+)\/([\w.-]+))?#(\d+)/gi;

/**
 * Issue numbers a PR closes, using GitHub's closing keywords ("Closes #12",
 * "fixes owner/repo#12"). References to other repos are ignored.
 */
export function linkedIssueNumbers(
  prBody: string,
  repo: { owner: string; name: string },
): number[] {
  const found = new Set<number>();
  for (const m of stripFences(prBody ?? "").matchAll(CLOSING_RE)) {
    const owner = m[1];
    const name = m[2];
    if (owner && name) {
      const same =
        owner.toLowerCase() === repo.owner.toLowerCase() &&
        name.toLowerCase() === repo.name.toLowerCase();
      if (!same) continue;
    }
    found.add(Number(m[3]));
  }
  return [...found].sort((a, b) => a - b);
}
