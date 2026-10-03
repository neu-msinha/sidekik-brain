import { JevError, type AskOptions, type JevAsk, type JevClient, type JevResult } from "./types.js";
import { fromWireAnswers, toWireQuestions, WireResponseSchema } from "./wire.js";

export const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

export type OpenRouterJevOptions = {
  apiKey: string;
  model: string;
  timeoutMs: number;
  url?: string;
  fetch?: typeof fetch;
};

/** Jev through OpenRouter's Decisions API (same question/answer shapes as TypeSafe). */
export class OpenRouterJev implements JevClient {
  readonly provider = "openrouter-jev" as const;
  readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OpenRouterJevOptions) {
    this.model = opts.model;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async ask(req: JevAsk, opts: AskOptions = {}): Promise<JevResult> {
    const started = performance.now();
    const timeout = AbortSignal.timeout(this.opts.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.url ?? OPENROUTER_DECISIONS_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${this.opts.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, state: req.state, questions: toWireQuestions(req.questions) }),
        signal,
      });
    } catch (err) {
      const kind = timeout.aborted ? "timeout" : "unavailable";
      throw new JevError(kind, this.provider, err instanceof Error ? err.message : String(err), { cause: err });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const kind = res.status === 429 ? "rate_limit" : res.status >= 500 || res.status === 408 ? "unavailable" : "bad_request";
      throw new JevError(kind, this.provider, `HTTP ${res.status} ${body.slice(0, 200)}`);
    }

    const parsed = WireResponseSchema.safeParse(await res.json().catch(() => null));
    const latency_ms = Math.round(performance.now() - started);
    if (!parsed.success) throw new JevError("unavailable", this.provider, `unexpected response: ${parsed.error.message}`);
    try {
      return {
        provider: this.provider,
        model: parsed.data.model,
        answers: fromWireAnswers(req.questions, parsed.data.answers),
        usage: {
          input_tokens: parsed.data.usage.input_tokens,
          output_tokens: parsed.data.usage.output_tokens,
          ...(parsed.data.usage.cost !== undefined ? { cost_usd: parsed.data.usage.cost } : {}),
        },
        latency_ms,
      };
    } catch (err) {
      throw new JevError("unavailable", this.provider, (err as Error).message, { cause: err });
    }
  }
}
