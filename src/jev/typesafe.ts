import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  RateLimitError,
  TypeSafeClient,
  type EntryType,
  type Fetch,
  type Questions,
} from "@typesafe-ai/sdk";
import { JevError, type AskOptions, type JevAsk, type JevClient, type JevResult } from "./types.js";
import { fromWireAnswers, toWireQuestions, WireResponseSchema } from "./wire.js";

export type TypeSafeJevOptions = { apiKey: string; model: string; timeoutMs: number; fetch?: Fetch };

/** Jev through the TypeSafe API (`@typesafe-ai/sdk`). Retries are off: the router's breaker decides. */
export class TypeSafeJev implements JevClient {
  readonly provider = "jev" as const;
  readonly model: string;
  private readonly client: TypeSafeClient;

  constructor(opts: TypeSafeJevOptions) {
    this.model = opts.model;
    this.client = new TypeSafeClient({
      apiKey: opts.apiKey,
      defaultModel: opts.model,
      timeout: opts.timeoutMs,
      retry: { maxRetries: 0 },
      logLevel: "off",
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  async ask(req: JevAsk, opts: AskOptions = {}): Promise<JevResult> {
    const started = performance.now();
    let raw: unknown;
    try {
      raw = await this.client.systemOne(
        { state: req.state as EntryType, questions: toWireQuestions(req.questions) as Questions, model: this.model },
        opts.signal ? { signal: opts.signal } : {},
      );
    } catch (err) {
      throw mapError(err);
    }
    const latency_ms = Math.round(performance.now() - started);
    const res = WireResponseSchema.safeParse(raw);
    if (!res.success) throw new JevError("unavailable", this.provider, `unexpected response: ${res.error.message}`);
    try {
      return {
        provider: this.provider,
        model: res.data.model,
        answers: fromWireAnswers(req.questions, res.data.answers),
        usage: { input_tokens: res.data.usage.input_tokens, output_tokens: res.data.usage.output_tokens },
        latency_ms,
      };
    } catch (err) {
      throw new JevError("unavailable", this.provider, (err as Error).message, { cause: err });
    }
  }
}

function mapError(err: unknown): JevError {
  const p = "jev" as const;
  if (err instanceof RateLimitError) return new JevError("rate_limit", p, err.message, { cause: err });
  if (err instanceof APITimeoutError) return new JevError("timeout", p, err.message, { cause: err });
  if (err instanceof APIConnectionError) return new JevError("unavailable", p, err.message, { cause: err });
  if (err instanceof APIError) {
    return new JevError(err.status >= 500 || err.status === 408 ? "unavailable" : "bad_request", p, err.message, { cause: err });
  }
  return new JevError("unavailable", p, err instanceof Error ? err.message : String(err), { cause: err });
}
