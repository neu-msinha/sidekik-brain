import { describe, expect, it } from "vitest";
import { LLMDecider } from "../../src/jev/llm.js";
import { OpenRouterJev, OPENROUTER_DECISIONS_URL } from "../../src/jev/openrouter.js";
import { TypeSafeJev } from "../../src/jev/typesafe.js";
import { JevError } from "../../src/jev/types.js";
import { ASK, fakeFetch, json, WIRE_ANSWERS } from "./fakes.js";

const wireOk = (model: string, cost?: number) =>
  json(200, { model, answers: WIRE_ANSWERS, usage: { input_tokens: 812, output_tokens: 0, ...(cost !== undefined ? { cost } : {}) } });

describe("TypeSafeJev", () => {
  it("posts state + wire questions to /v1/systemone with the pinned model", async () => {
    const f = fakeFetch(() => wireOk("jev-1.13.0"));
    const jev = new TypeSafeJev({ apiKey: "ts-key", model: "jev-1.13.0", timeoutMs: 1500, fetch: f.fn });
    const res = await jev.ask(ASK);

    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toMatch(/\/v1\/systemone$/);
    expect(f.calls[0]!.body).toMatchObject({ model: "jev-1.13.0", state: ASK.state });
    expect((f.calls[0]!.body.questions as Record<string, { criteria: unknown }>).value_q1!.criteria).toHaveLength(4);
    expect(res).toMatchObject({ provider: "jev", model: "jev-1.13.0", usage: { input_tokens: 812, output_tokens: 0 } });
    expect(res.answers.value_q1).toMatchObject({ level: 4 });
  });

  it("maps 429 to rate_limit without retrying", async () => {
    const f = fakeFetch(() => json(429, { error: "slow down" }));
    const jev = new TypeSafeJev({ apiKey: "k", model: "jev-1.13.0", timeoutMs: 1500, fetch: f.fn });
    await expect(jev.ask(ASK)).rejects.toMatchObject({ kind: "rate_limit", provider: "jev" });
    expect(f.calls).toHaveLength(1);
  });

  it("maps a slow response to timeout", async () => {
    const f = fakeFetch(
      (call) =>
        new Promise<Response>((_, reject) => {
          call.init.signal?.addEventListener("abort", () => reject(call.init.signal?.reason));
        }),
    );
    const jev = new TypeSafeJev({ apiKey: "k", model: "jev-1.13.0", timeoutMs: 30, fetch: f.fn });
    await expect(jev.ask(ASK)).rejects.toMatchObject({ kind: "timeout" });
  });

  it("maps 400 to bad_request and a malformed body to unavailable", async () => {
    const bad = new TypeSafeJev({ apiKey: "k", model: "m", timeoutMs: 1500, fetch: fakeFetch(() => json(400, { error: "no" })).fn });
    await expect(bad.ask(ASK)).rejects.toMatchObject({ kind: "bad_request" });
    const junk = new TypeSafeJev({ apiKey: "k", model: "m", timeoutMs: 1500, fetch: fakeFetch(() => json(200, { hello: 1 })).fn });
    await expect(junk.ask(ASK)).rejects.toBeInstanceOf(JevError);
  });
});

describe("OpenRouterJev", () => {
  it("posts to the Decisions API with a bearer key and uses the reported cost", async () => {
    const f = fakeFetch(() => wireOk("typesafe/jev-1.13", 0.0000341));
    const jev = new OpenRouterJev({ apiKey: "or-key", model: "typesafe/jev-1.13", timeoutMs: 1500, fetch: f.fn });
    const res = await jev.ask(ASK);

    expect(f.calls[0]!.url).toBe(OPENROUTER_DECISIONS_URL);
    expect(new Headers(f.calls[0]!.init.headers).get("authorization")).toBe("Bearer or-key");
    expect(f.calls[0]!.body).toMatchObject({ model: "typesafe/jev-1.13" });
    expect(res).toMatchObject({ provider: "openrouter-jev", usage: { cost_usd: 0.0000341 } });
  });

  it("maps status codes and timeouts", async () => {
    const mk = (status: number) =>
      new OpenRouterJev({ apiKey: "k", model: "m", timeoutMs: 1500, fetch: fakeFetch(() => json(status, {})).fn });
    await expect(mk(429).ask(ASK)).rejects.toMatchObject({ kind: "rate_limit" });
    await expect(mk(503).ask(ASK)).rejects.toMatchObject({ kind: "unavailable" });
    await expect(mk(422).ask(ASK)).rejects.toMatchObject({ kind: "bad_request" });

    const hang = fakeFetch(
      (call) => new Promise<Response>((_, reject) => call.init.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    const slow = new OpenRouterJev({ apiKey: "k", model: "m", timeoutMs: 20, fetch: hang.fn });
    await expect(slow.ask(ASK)).rejects.toMatchObject({ kind: "timeout" });
  });
});

describe("LLMDecider", () => {
  const llmAnswers = {
    pause_now: { answer: true, probability: 0.8 },
    activity: { answer: "finished_substep", probability: 0.7 },
    answered_q1: { answer: false, probability: 0.9 },
    answered_q2: { answer: true, probability: 0.6 },
    value_q1: { answer: "4", probability: 0.75 },
    value_q2: { answer: "1", probability: 0.65 },
  };
  const message = (text: string, stop_reason = "end_turn") =>
    json(200, {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5",
      content: [{ type: "text", text }],
      stop_reason,
      stop_sequence: null,
      usage: { input_tokens: 900, output_tokens: 120 },
    });

  it("asks Haiku at temperature 0 with a structured output schema and normalizes answers", async () => {
    const f = fakeFetch(() => message(JSON.stringify(llmAnswers)));
    const llm = new LLMDecider({ apiKey: "sk-test", model: "claude-haiku-4-5", timeoutMs: 5000, fetch: f.fn });
    const res = await llm.ask(ASK);

    const body = f.calls[0]!.body as { model: string; temperature: number; output_config: { format: { type: string; schema: { properties: Record<string, unknown> } } } };
    expect(f.calls[0]!.url).toMatch(/\/v1\/messages$/);
    expect(body.model).toBe("claude-haiku-4-5");
    expect(body.temperature).toBe(0);
    expect(body.output_config.format.type).toBe("json_schema");
    expect(Object.keys(body.output_config.format.schema.properties)).toEqual(Object.keys(ASK.questions));

    expect(res.provider).toBe("llm");
    expect(res.answers.pause_now).toEqual({ type: "noul", p_true: 0.8, confidence: 0.8 });
    expect(res.answers.answered_q1).toMatchObject({ p_true: expect.closeTo(0.1, 5) });
    expect(res.answers.activity).toMatchObject({ choice: "finished_substep", confidence: 0.7 });
    expect(res.answers.value_q1).toMatchObject({ score: 4, level: 4, confidence: 0.75 });
    expect(res.usage).toEqual({ input_tokens: 900, output_tokens: 120 });
  });

  it("treats a refusal as unavailable", async () => {
    const llm = new LLMDecider({ apiKey: "k", model: "claude-haiku-4-5", timeoutMs: 5000, fetch: fakeFetch(() => message("{}", "refusal")).fn });
    await expect(llm.ask(ASK)).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("maps 429 to rate_limit", async () => {
    const llm = new LLMDecider({
      apiKey: "k",
      model: "claude-haiku-4-5",
      timeoutMs: 5000,
      fetch: fakeFetch(() => json(429, { type: "error", error: { type: "rate_limit_error", message: "slow" } })).fn,
    });
    await expect(llm.ask(ASK)).rejects.toMatchObject({ kind: "rate_limit", provider: "llm" });
  });
});
