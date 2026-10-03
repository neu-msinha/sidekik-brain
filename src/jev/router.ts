import {
  EVENT_TYPES,
  makeEvent,
  STREAMS,
  type Bus,
  type DecisionId,
  type Logger,
  type UsageRecord,
} from "@sidekik/contracts";
import type { CircuitBreaker } from "./breaker.js";
import { cacheKey, type TtlLru } from "./cache.js";
import { estimateTokens, type RateLimiter } from "./limiter.js";
import { costUsd, counterfactualUsd } from "./pricing.js";
import type { DecisionLogRow, DecisionSink } from "./sink.js";
import { JevError, type AskOptions, type JevAsk, type JevClient, type JevResult } from "./types.js";

/** Who asked, and which decisions the batched questions belong to (one decisions_log row each). */
export type AskContext = {
  session_id?: string;
  org_id?: string;
  /** Session time for the usage event. */
  t_ms?: number;
  decisions: { id: DecisionId; questions: string[] }[];
};

export type JevRouterDeps = {
  /** TypeSafe Jev; omitted when no TYPESAFE_API_KEY. */
  primary?: JevClient;
  /** Tried in order when the primary fails or the breaker is open (OpenRouter Jev, then the LLM). */
  fallbacks: JevClient[];
  breaker: CircuitBreaker;
  limiter: RateLimiter;
  cache: TtlLru<JevResult>;
  sink: DecisionSink;
  bus?: Bus;
  log: Logger;
  /** Model name in the cache key (cache hits are provider-independent). */
  cacheModel: string;
};

/**
 * The one entry point for Jev decisions: cache → breaker → rate limit → provider chain,
 * then a decisions_log row per decision and sk:usage records.
 */
export class JevRouter {
  constructor(private readonly d: JevRouterDeps) {}

  /** The LLM decider used for escalation, when configured. */
  get llm(): JevClient | undefined {
    return [this.d.primary, ...this.d.fallbacks].find((c) => c?.provider === "llm");
  }

  get providers(): string[] {
    return [this.d.primary, ...this.d.fallbacks].filter((c): c is JevClient => !!c).map((c) => `${c.provider}:${c.model}`);
  }

  async ask(req: JevAsk, ctx: AskContext, opts: AskOptions = {}): Promise<JevResult> {
    const key = cacheKey(req.state, req.questions, this.d.cacheModel);
    const hit = this.d.cache.get(key);
    if (hit) {
      this.d.log.debug({ session_id: ctx.session_id, org_id: ctx.org_id, decisions: ctx.decisions.map((d) => d.id) }, "jev cache hit");
      return { ...hit, cached: true, latency_ms: 0 };
    }

    const chain = this.chain();
    if (chain.length === 0) throw new JevError("unavailable", "jev", "no decision provider configured");

    let lastErr: unknown;
    for (const client of chain) {
      try {
        const result = await this.call(client, req, opts);
        if (client === this.d.primary) this.d.breaker.recordSuccess(result.latency_ms);
        this.d.cache.set(key, result);
        this.record(result, req, ctx, false);
        return result;
      } catch (err) {
        lastErr = err;
        const kind = err instanceof JevError ? err.kind : "unavailable";
        const tripped = client === this.d.primary ? this.d.breaker.recordFailure(kind) : false;
        this.d.log.warn(
          { session_id: ctx.session_id, org_id: ctx.org_id, provider: client.provider, kind, tripped, err },
          "jev provider failed",
        );
      }
    }
    throw lastErr;
  }

  /** Re-asks the same questions on the LLM decider (mid-band confidence). Logged with escalated = true. */
  async escalate(req: JevAsk, ctx: AskContext, opts: AskOptions = {}): Promise<JevResult | undefined> {
    const llm = this.llm;
    if (!llm) return undefined;
    const result = await llm.ask(req, opts);
    this.record(result, req, ctx, true);
    return result;
  }

  private chain(): JevClient[] {
    const primary = this.d.primary && !this.d.breaker.isOpen() ? [this.d.primary] : [];
    return [...primary, ...this.d.fallbacks];
  }

  private async call(client: JevClient, req: JevAsk, opts: AskOptions): Promise<JevResult> {
    if (client.provider !== "llm") await this.d.limiter.acquire(estimateTokens(req));
    return client.ask(req, opts);
  }

  private record(result: JevResult, req: JevAsk, ctx: AskContext, escalated: boolean): void {
    const questionCount = Object.keys(req.questions).length;
    const cost = costUsd(result.provider, result.usage);
    const counterfactual = counterfactualUsd(result.provider, result.usage, questionCount);
    const share = ctx.decisions.length || 1;
    const logCtx = { session_id: ctx.session_id, org_id: ctx.org_id, provider: result.provider, latency_ms: result.latency_ms };

    if (ctx.org_id) {
      const rows: DecisionLogRow[] = ctx.decisions.map((d) => {
        const answer: Record<string, unknown> = {};
        let confidence = 1;
        for (const q of d.questions) {
          const a = result.answers[q];
          if (!a) continue;
          answer[q] = a;
          confidence = Math.min(confidence, a.confidence);
        }
        return {
          org_id: ctx.org_id!,
          session_id: ctx.session_id ?? null,
          decision: d.id,
          provider: result.provider,
          model: result.model,
          answer,
          confidence,
          escalated,
          latency_ms: result.latency_ms,
          input_tokens: result.usage.input_tokens,
          cost_usd: cost / share,
          counterfactual_usd: counterfactual / share,
        };
      });
      this.d.sink.write(rows).catch((err: unknown) => this.d.log.error({ ...logCtx, err }, "decisions_log write failed"));
    } else {
      this.d.log.warn(logCtx, "decision without org_id: not written to decisions_log");
    }

    if (this.d.bus && ctx.org_id && ctx.session_id) {
      const vendor = result.provider === "llm" ? "anthropic" : "typesafe";
      const records: UsageRecord[] = [
        { service: "brain", vendor, units: result.usage.input_tokens, unit: "tokens_in", cost_usd: cost, counterfactual_usd: counterfactual },
      ];
      if (result.usage.output_tokens > 0) {
        records.push({ service: "brain", vendor, units: result.usage.output_tokens, unit: "tokens_out", cost_usd: 0 });
      }
      for (const data of records) {
        const ev = makeEvent({
          type: EVENT_TYPES[STREAMS.usage],
          org_id: ctx.org_id,
          session_id: ctx.session_id,
          t_ms: ctx.t_ms ?? 0,
          producer: "brain",
          data,
        });
        this.d.bus.publish(STREAMS.usage, ev).catch((err: unknown) => this.d.log.error({ ...logCtx, err }, "usage publish failed"));
      }
    }
  }
}
