import type { DecisionProvider } from "@sidekik/contracts";
import { CircuitBreaker, DEFAULT_BREAKER } from "../src/jev/breaker.js";
import { TtlLru } from "../src/jev/cache.js";
import { RateLimiter } from "../src/jev/limiter.js";
import { JevRouter } from "../src/jev/router.js";
import { MemoryDecisionSink } from "../src/jev/sink.js";
import type { JevAnswer, JevAsk, JevClient, JevResult } from "../src/jev/types.js";
import { FakeBus, silentLogger } from "./helpers.js";

export const noul = (p_true: number): JevAnswer => ({ type: "noul", p_true, confidence: Math.max(p_true, 1 - p_true) });
export const choice = (c: string, confidence: number): JevAnswer => ({ type: "choice", choice: c, confidence, probabilities: { [c]: confidence } });
export const score = (level: number, confidence: number): JevAnswer => ({ type: "score", score: level, level, confidence, probabilities: { [String(level)]: confidence } });

/** A client that answers each question by name (without the "Dn__" prefix) from `answer`. */
export class ScriptedClient implements JevClient {
  readonly asks: JevAsk[] = [];
  constructor(
    readonly provider: DecisionProvider,
    readonly model: string,
    private readonly answer: (name: string, ask: JevAsk) => JevAnswer | undefined,
  ) {}

  async ask(req: JevAsk): Promise<JevResult> {
    this.asks.push(req);
    const answers: JevResult["answers"] = {};
    for (const key of Object.keys(req.questions)) {
      const a = this.answer(key.replace(/^D\d+__/, ""), req);
      if (a) answers[key] = a;
    }
    return { provider: this.provider, model: this.model, answers, usage: { input_tokens: 500, output_tokens: 0 }, latency_ms: 120 };
  }
}

export function routerWith(primary: JevClient, fallbacks: JevClient[] = []) {
  const sink = new MemoryDecisionSink();
  const bus = new FakeBus();
  const router = new JevRouter({
    primary,
    fallbacks,
    breaker: new CircuitBreaker(DEFAULT_BREAKER),
    limiter: new RateLimiter(1000, 1_000_000),
    cache: new TtlLru<JevResult>(),
    sink,
    bus,
    log: silentLogger(),
    cacheModel: "jev-1.13.0",
  });
  return { router, sink, bus };
}
