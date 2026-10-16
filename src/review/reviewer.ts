import type { ReviewInput, ReviewVerdict, ReviewerPort } from "../ports";
import { chunkFiles } from "./filter";
import { ReviewParseError, parseVerdict } from "./parse";
import { NOTES_SYSTEM_PROMPT, SYSTEM_PROMPT, finalPrompt, notesPrompt, singleCallPrompt } from "./prompt";

/** One model call: system prompt in, text out. */
export type Complete = (system: string, user: string) => Promise<string>;

export class AiReviewer implements ReviewerPort {
  constructor(
    private readonly complete: Complete,
    private readonly model: string,
    private readonly opts: { maxChunkChars?: number; concurrency?: number } = {},
  ) {}

  async review(input: ReviewInput): Promise<ReviewVerdict> {
    const chunks = chunkFiles(input.files, this.opts.maxChunkChars ?? 60_000);
    let user: string;
    if (chunks.length <= 1) {
      user = singleCallPrompt(input, chunks[0] ?? []);
    } else {
      const notes = await mapLimit(chunks, this.opts.concurrency ?? 3, (chunk, i) =>
        this.complete(NOTES_SYSTEM_PROMPT, notesPrompt(input, chunk, i + 1, chunks.length)),
      );
      user = finalPrompt(input, notes, input.files.map((f) => f.filename));
    }
    return this.askForVerdict(user);
  }

  /** Asks once, and once more if the answer is not valid. */
  private async askForVerdict(user: string): Promise<ReviewVerdict> {
    const first = await this.complete(SYSTEM_PROMPT, user);
    try {
      return parseVerdict(first, this.model);
    } catch (err) {
      if (!(err instanceof ReviewParseError)) throw err;
      const retry = await this.complete(
        SYSTEM_PROMPT,
        `${user}\n\nYour previous answer was rejected: ${err.message} Reply again with only the JSON object.`,
      );
      return parseVerdict(retry, this.model);
    }
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Completer for the Anthropic Messages API, using plain fetch. */
export function anthropicComplete(opts: {
  apiKey: string;
  model: string;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}): Complete {
  const f = opts.fetchImpl ?? fetch;
  return async (system, user) => {
    const res = await f("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": opts.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 1500,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = (data.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    if (!text) throw new Error("Anthropic API returned no text");
    return text;
  };
}
