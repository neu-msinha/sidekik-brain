import { fileURLToPath } from "node:url";
import { STREAMS, type AgentCommand, type Envelope, type StreamKey, type StreamPayload } from "@sidekik/contracts";
import { describe, expect, it } from "vitest";
import { readFixture } from "../scripts/replay.js";
import { assembleBrain } from "../src/brain.js";
import { RecordingGatewayClient } from "../src/capture/gateway.js";
import { MemoryCaptureRepo } from "../src/capture/repo.js";
import { wireConsumers } from "../src/consumers.js";
import { loadBrainEnv } from "../src/env.js";
import { createJevRouter } from "../src/jev/index.js";
import { SessionStore } from "../src/state.js";
import { FakeBus, silentLogger } from "./helpers.js";

/**
 * DESIGN §8 Definition of done (Checkpoint 1), on the offline fakes:
 * replaying a capture session yields ≥ 3 asks at gate-approved pauses, at least one limit/stop_and_ask,
 * none while the expert is typing or speaking. Runs on simulated time, 250 ms ticks.
 */
describe("Checkpoint 1 replay (FAKE_VENDORS)", () => {
  it("asks ≥ 3 grounded questions at pauses, including a guardrail question", async () => {
    const env = loadBrainEnv({
      PORT: "18082",
      REDIS_URL: "redis://localhost:6379",
      SUPABASE_URL: "http://localhost:54321",
      SUPABASE_SERVICE_ROLE_KEY: "x",
      SK_INTERNAL_TOKEN: "test-internal-token-1234",
      GATEWAY_INTERNAL_URL: "http://localhost:8080",
      PERSISTENCE: "memory",
      FAKE_VENDORS: "true",
    });
    const log = silentLogger();
    const bus = new FakeBus();
    const store = new SessionStore();
    const repo = new MemoryCaptureRepo();
    let clock = 0;
    const jev = createJevRouter(env, { log, bus });
    const parts = assembleBrain(env, { store, bus, jev, log }, { repo, gateway: new RecordingGatewayClient(), now: () => clock });
    wireConsumers(bus, store, log, parts.hooks);

    const lines = readFixture(fileURLToPath(new URL("./fixtures/capture_sabine_mock.jsonl", import.meta.url))).sort((a, b) => a.ev.t_ms - b.ev.t_ms);
    // Timeline of what the expert was doing, to judge each ask.
    const speaking: [number, number][] = [];
    const typing: number[] = [];
    let start: number | undefined;
    for (const l of lines) {
      const d = (l.ev as unknown as { data: { kind?: string; type?: string } }).data;
      if (d.kind === "user_speech_start") start = l.ev.t_ms;
      if (d.kind === "user_speech_end" && start !== undefined) speaking.push([start, l.ev.t_ms]);
      if (d.kind === "typing" || d.type === "typing_in_progress") typing.push(l.ev.t_ms);
    }

    for (const l of lines) {
      while (clock + 250 <= l.ev.t_ms) {
        clock += 250;
        parts.loop.tickAll();
        await parts.queue.idle();
      }
      clock = l.ev.t_ms;
      await bus.deliver(l.stream as StreamKey, l.ev as unknown as Envelope<StreamPayload<StreamKey>>);
      await parts.queue.idle();
    }

    const asks = bus.published
      .filter((p) => p.stream === STREAMS.commands)
      .map((p) => ({ t: p.ev.t_ms, ...(p.ev.data as Extract<AgentCommand, { type: "ask" }>) }));

    expect(asks.length).toBeGreaterThanOrEqual(3);
    expect(asks.some((a) => a.qtype === "limit" || a.qtype === "stop_and_ask")).toBe(true);
    for (const a of asks) {
      expect(speaking.some(([s, e]) => a.t >= s && a.t <= e), `ask at ${a.t} during speech`).toBe(false);
      expect(typing.some((t) => a.t - t >= 0 && a.t - t < 3000), `ask at ${a.t} within 3 s of typing`).toBe(false);
    }
    // The routine invoice (#4501) produced no question; every ask is ≥ 60 s apart.
    expect(asks.every((a, i) => i === 0 || a.t - asks[i - 1]!.t >= 60_000)).toBe(true);
    // Answers were stored against the asked questions, with a rule where the expert gave numbers.
    expect(repo.answers.length).toBeGreaterThanOrEqual(3);
    expect(repo.answers.some((r) => r.has_condition && r.extracted_rule)).toBe(true);
    // task_done expired the rest.
    expect([...repo.questions.values()].filter((q) => q.status === "candidate")).toHaveLength(0);

    console.log(asks.map((a) => `${(a.t / 1000).toFixed(1)}s [${a.qtype}] ${a.text}`).join("\n"));
  });
});
