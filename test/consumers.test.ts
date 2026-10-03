import { STREAMS } from "@sidekik/contracts";
import { describe, expect, it, vi } from "vitest";
import { wireConsumers } from "../src/consumers.js";
import { SessionStore } from "../src/state.js";
import { ev, FakeBus, SID, silentLogger } from "./helpers.js";

const start = ev(STREAMS.lifecycle, 0, { event: "started", kind: "capture", phase: "capture", workflow_id: "wf1", mode: "browser", language: "de" });

function setup() {
  const bus = new FakeBus();
  const store = new SessionStore();
  const hooks = {
    onSessionStarted: vi.fn(async () => {}),
    onCaptureStopped: vi.fn(async () => {}),
    onScreenEvent: vi.fn(async () => {}),
    onTurn: vi.fn(async () => {}),
    onSpeech: vi.fn(async () => {}),
  };
  const stop = wireConsumers(bus, store, silentLogger(), hooks);
  return { bus, store, hooks, stop };
}

describe("wireConsumers", () => {
  it("routes all four streams into session state and hooks", async () => {
    const { bus, store, hooks } = setup();
    await bus.deliver(STREAMS.lifecycle, start);
    await bus.deliver(STREAMS.speech, ev(STREAMS.speech, 10, { kind: "user_speech_start", source: "sdk" }));
    await bus.deliver(STREAMS.screen, ev(STREAMS.screen, 20, { event_id: "e1", type: "record_opened", state: {}, confidence: 1, source: "dom" }));
    await bus.deliver(STREAMS.turns, ev(STREAMS.turns, 30, { turn_id: "t1", role: "user", text: "Hallo", lang: "de", source: "live", redacted: true }));

    const s = store.get(SID)!;
    expect(s.speech.userSpeaking).toBe(true);
    expect(s.screen.recent).toHaveLength(1);
    expect(s.turns).toHaveLength(1);
    expect(hooks.onSessionStarted).toHaveBeenCalledOnce();
    expect(hooks.onSpeech).toHaveBeenCalledOnce();
    expect(hooks.onScreenEvent).toHaveBeenCalledOnce();
    expect(hooks.onTurn).toHaveBeenCalledOnce();
  });

  it("calls onCaptureStopped on task_done and on ended", async () => {
    const { bus, hooks } = setup();
    await bus.deliver(STREAMS.lifecycle, start);
    await bus.deliver(STREAMS.lifecycle, ev(STREAMS.lifecycle, 99, { ...start.data, event: "task_done" }));
    await bus.deliver(STREAMS.lifecycle, ev(STREAMS.lifecycle, 120, { ...start.data, event: "ended", phase: "done" }));
    expect(hooks.onCaptureStopped).toHaveBeenCalledTimes(2);
  });

  it("does not call hooks for unknown or replay sessions", async () => {
    const { bus, hooks } = setup();
    await bus.deliver(STREAMS.turns, ev(STREAMS.turns, 30, { turn_id: "t1", role: "user", text: "x", lang: "de", source: "live", redacted: true }));
    await bus.deliver(STREAMS.lifecycle, ev(STREAMS.lifecycle, 0, { ...start.data, mode: "replay" }, "replayed"));
    await bus.deliver(STREAMS.screen, ev(STREAMS.screen, 5, { event_id: "e", type: "dialog", state: {}, confidence: 1, source: "dom" }, "replayed"));
    expect(hooks.onTurn).not.toHaveBeenCalled();
    expect(hooks.onSessionStarted).not.toHaveBeenCalled();
    expect(hooks.onScreenEvent).not.toHaveBeenCalled();
  });

  it("the stop function unsubscribes every stream", async () => {
    const { bus, stop } = setup();
    stop();
    await expect(bus.deliver(STREAMS.lifecycle, start)).rejects.toThrow(/no consumer/);
  });
});
