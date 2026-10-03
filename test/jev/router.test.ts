import { STREAMS, type DecisionProvider } from "@sidekik/contracts";
import { describe, expect, it } from "vitest";
import { CircuitBreaker, DEFAULT_BREAKER } from "../../src/jev/breaker.js";
import { TtlLru } from "../../src/jev/cache.js";
import { RateLimiter } from "../../src/jev/limiter.js";
import { PRICES } from "../../src/jev/pricing.js";
import { JevRouter, type AskContext } from "../../src/jev/router.js";
import { MemoryDecisionSink } from "../../src/jev/sink.js";
import { JevError, type JevAsk, type JevClient, type JevErrorKind, type JevResult } from "../../src/jev/types.js";
import { FakeBus, ORG, silentLogger } from "../helpers.js";
import { ASK } from "./fakes.js";

class StubClient implements JevClient {
  calls = 0;
  constructor(
    readonly provider: DecisionProvider,
    readonly model: string,
    private readonly behave: (n: number) => JevErrorKind | { latency: number } = () => ({ latency: 200 }),
  ) {}

  async ask(req: JevAsk): Promise<JevResult> {
    const b = this.behave(++this.calls);
    if (typeof b === "string") throw new JevError(b, this.provider, "stub failure");
    const answers: JevResult["answers"] = {};
    for (const name of Object.keys(req.questions)) answers[name] = { type: "noul", p_true: 0.9, confidence: 0.9 };
    return { provider: this.provider, model: this.model, answers, usage: { input_tokens: 1000, output_tokens: this.provider === "llm" ? 100 : 0 }, latency_ms: b.latency };
  }
}

const CTX: AskContext = {
  session_id: "sess-1",
  org_id: ORG,
  t_ms: 4200,
  decisions: [
    { id: "D1", questions: ["pause_now", "activity"] },
    { id: "D3", questions: ["answered_q1", "value_q1", "answered_q2", "value_q2"] },
  ],
};

function setup(primary?: StubClient, fallbacks: StubClient[] = []) {
  const sink = new MemoryDecisionSink();
  const bus = new FakeBus();
  const router = new JevRouter({
    ...(primary ? { primary } : {}),
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

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("JevRouter", () => {
  it("uses the primary and writes one decisions_log row per decision", async () => {
    const jev = new StubClient("jev", "jev-1.13.0");
    const { router, sink, bus } = setup(jev);
    const res = await router.ask(ASK, CTX);
    await flush();

    expect(res.provider).toBe("jev");
    expect(sink.rows.map((r) => r.decision)).toEqual(["D1", "D3"]);
    const d1 = sink.rows[0]!;
    expect(Object.keys(d1.answer)).toEqual(["pause_now", "activity"]);
    expect(d1).toMatchObject({ org_id: ORG, session_id: "sess-1", provider: "jev", model: "jev-1.13.0", escalated: false, input_tokens: 1000 });
    // Cost of the batched call is split across the decisions in it.
    expect(d1.cost_usd).toBeCloseTo((1000 * PRICES.jev.in) / 2, 12);
    expect(d1.counterfactual_usd).toBeGreaterThan(d1.cost_usd * 10);

    const usage = bus.published.filter((p) => p.stream === STREAMS.usage);
    expect(usage).toHaveLength(1);
    expect(usage[0]!.ev).toMatchObject({ producer: "brain", t_ms: 4200, data: { vendor: "typesafe", unit: "tokens_in", units: 1000 } });
  });

  it("serves a repeat request from cache without logging", async () => {
    const jev = new StubClient("jev", "jev-1.13.0");
    const { router, sink } = setup(jev);
    await router.ask(ASK, CTX);
    const again = await router.ask({ ...ASK }, CTX);
    await flush();
    expect(again.cached).toBe(true);
    expect(jev.calls).toBe(1);
    expect(sink.rows).toHaveLength(2);
  });

  it("falls back in order when the primary fails", async () => {
    const jev = new StubClient("jev", "jev-1.13.0", () => "unavailable");
    const or = new StubClient("openrouter-jev", "typesafe/jev-1.13", () => "unavailable");
    const llm = new StubClient("llm", "claude-haiku-4-5");
    const { router, bus } = setup(jev, [or, llm]);
    const res = await router.ask(ASK, CTX);
    await flush();
    expect(res.provider).toBe("llm");
    expect([jev.calls, or.calls, llm.calls]).toEqual([1, 1, 1]);
    const vendors = bus.published.map((p) => (p.ev.data as { vendor: string; unit: string }));
    expect(vendors).toEqual([
      expect.objectContaining({ vendor: "anthropic", unit: "tokens_in" }),
      expect.objectContaining({ vendor: "anthropic", unit: "tokens_out", units: 100 }),
    ]);
  });

  it("skips the primary for 60 s after two rate limits", async () => {
    const jev = new StubClient("jev", "jev-1.13.0", () => "rate_limit");
    const or = new StubClient("openrouter-jev", "typesafe/jev-1.13");
    const { router } = setup(jev, [or]);
    await router.ask({ ...ASK, state: { n: 1 } }, CTX);
    await router.ask({ ...ASK, state: { n: 2 } }, CTX);
    await router.ask({ ...ASK, state: { n: 3 } }, CTX);
    expect(jev.calls).toBe(2);
    expect(or.calls).toBe(3);
  });

  it("a slow primary success opens the breaker", async () => {
    const jev = new StubClient("jev", "jev-1.13.0", () => ({ latency: 1700 }));
    const or = new StubClient("openrouter-jev", "typesafe/jev-1.13");
    const { router } = setup(jev, [or]);
    await router.ask({ ...ASK, state: { n: 1 } }, CTX);
    await router.ask({ ...ASK, state: { n: 2 } }, CTX);
    expect([jev.calls, or.calls]).toEqual([1, 1]);
  });

  it("throws the last error when every provider fails, and fails fast with none", async () => {
    const { router } = setup(new StubClient("jev", "j", () => "unavailable"), [new StubClient("llm", "h", () => "rate_limit")]);
    await expect(router.ask(ASK, CTX)).rejects.toMatchObject({ kind: "rate_limit", provider: "llm" });
    await expect(setup().router.ask(ASK, CTX)).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("escalate() asks the LLM and logs rows as escalated", async () => {
    const llm = new StubClient("llm", "claude-haiku-4-5");
    const { router, sink } = setup(new StubClient("jev", "jev-1.13.0"), [llm]);
    const res = await router.escalate(ASK, { ...CTX, decisions: [{ id: "D1", questions: ["pause_now", "activity"] }] });
    await flush();
    expect(res?.provider).toBe("llm");
    expect(sink.rows).toEqual([expect.objectContaining({ decision: "D1", escalated: true, provider: "llm" })]);
    expect(await setup(new StubClient("jev", "j")).router.escalate(ASK, CTX)).toBeUndefined();
  });

  it("without org_id, still answers but writes no rows or usage", async () => {
    const { router, sink, bus } = setup(new StubClient("jev", "jev-1.13.0"));
    await router.ask(ASK, { decisions: CTX.decisions });
    await flush();
    expect(sink.rows).toHaveLength(0);
    expect(bus.published).toHaveLength(0);
  });
});
