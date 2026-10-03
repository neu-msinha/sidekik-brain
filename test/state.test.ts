import { STREAMS, type SessionLifecycle } from "@sidekik/contracts";
import { describe, expect, it } from "vitest";
import { isCaptureActive, nowT, RECENT_LIMIT, SessionStore } from "../src/state.js";
import { ev, SID } from "./helpers.js";

const lifecycle = (t: number, data: Partial<SessionLifecycle> & Pick<SessionLifecycle, "event">) =>
  ev(STREAMS.lifecycle, t, { kind: "capture", phase: "capture", workflow_id: "wf1", mode: "browser", language: "de", ...data });

function started(store = new SessionStore(), data: Partial<SessionLifecycle> = {}) {
  store.applyLifecycle(lifecycle(0, { event: "started", ...data }), 1000);
  return store;
}

describe("SessionStore lifecycle", () => {
  it("creates capture state on started", () => {
    const store = started();
    const s = store.get(SID)!;
    expect(s).toMatchObject({ kind: "capture", phase: "capture", language: "de", offRecord: false });
    expect(isCaptureActive(s)).toBe(true);
  });

  it("tutor sessions are tracked but never capture-active", () => {
    const s = started(undefined, { kind: "tutor", phase: "tutoring" }).get(SID)!;
    expect(isCaptureActive(s)).toBe(false);
  });

  it("ignores replay-mode sessions and all their events", () => {
    const store = started(undefined, { mode: "replay" });
    expect(store.get(SID)).toBeUndefined();
    expect(store.isIgnored(SID)).toBe(true);
    expect(store.applyLifecycle(lifecycle(5, { event: "task_done" })).kind).toBe("ignored_replay");
    expect(store.applySpeech(ev(STREAMS.speech, 5, { kind: "typing", source: "dom" }))).toBeUndefined();
  });

  it("off-record pauses capture without stopping it", () => {
    const store = started();
    const on = store.applyLifecycle(lifecycle(10, { event: "offrecord_on" }));
    expect(on).toMatchObject({ kind: "updated", captureStopped: false });
    expect(isCaptureActive(store.get(SID)!)).toBe(false);
    store.applyLifecycle(lifecycle(20, { event: "offrecord_off" }));
    expect(isCaptureActive(store.get(SID)!)).toBe(true);
  });

  it("task_done stops capture even if the phase is still capture", () => {
    const store = started();
    const out = store.applyLifecycle(lifecycle(30, { event: "task_done", phase: "capture" }));
    expect(out).toMatchObject({ kind: "updated", captureStopped: true });
    expect(store.get(SID)!.phase).toBe("building");
  });

  it("phase_changed to debrief stops capture once", () => {
    const store = started();
    expect(store.applyLifecycle(lifecycle(30, { event: "phase_changed", phase: "debrief" }))).toMatchObject({ captureStopped: true });
    expect(store.applyLifecycle(lifecycle(40, { event: "phase_changed", phase: "confirmed" }))).toMatchObject({ captureStopped: false });
  });

  it("ended removes the session", () => {
    const store = started();
    expect(store.applyLifecycle(lifecycle(50, { event: "ended" })).kind).toBe("ended");
    expect(store.get(SID)).toBeUndefined();
  });

  it("reports events for sessions it never saw start", () => {
    const store = new SessionStore();
    expect(store.applyLifecycle(lifecycle(5, { event: "task_done" })).kind).toBe("unknown_session");
    expect(store.applyTurn(ev(STREAMS.turns, 5, { turn_id: "t", role: "user", text: "x", lang: "de", source: "live", redacted: true }))).toBeUndefined();
  });

  it("a duplicate started keeps the existing state", () => {
    const store = started();
    store.applySpeech(ev(STREAMS.speech, 100, { kind: "user_speech_start", source: "sdk" }));
    started(store);
    expect(store.get(SID)!.speech.userSpeaking).toBe(true);
  });
});

describe("SessionStore inputs", () => {
  it("tracks speech timers", () => {
    const store = started();
    store.applySpeech(ev(STREAMS.speech, 100, { kind: "user_speech_start", source: "sdk" }));
    expect(store.get(SID)!.speech.userSpeaking).toBe(true);
    store.applySpeech(ev(STREAMS.speech, 900, { kind: "user_speech_end", source: "sdk" }));
    store.applySpeech(ev(STREAMS.speech, 950, { kind: "agent_speech_start", source: "sdk" }));
    store.applySpeech(ev(STREAMS.speech, 990, { kind: "typing", source: "dom" }));
    expect(store.get(SID)!.speech).toEqual({ userSpeaking: false, agentSpeaking: true, lastUserSpeechEndT: 900, lastTypingT: 990 });
  });

  it("idle screen events don't count as a screen change", () => {
    const store = started();
    const base = { state: { app: "MiniERP" }, confidence: 0.9, source: "dom" as const };
    store.applyScreen(ev(STREAMS.screen, 100, { ...base, event_id: "a", type: "field_changed", field: "cost_center", before: "4711", after: "0400" }));
    store.applyScreen(ev(STREAMS.screen, 200, { ...base, event_id: "b", type: "idle" }));
    store.applyScreen(ev(STREAMS.screen, 150, { ...base, event_id: "c", type: "typing_in_progress" }));
    const s = store.get(SID)!;
    expect(s.screen.lastChangeT).toBe(150);
    expect(s.screen.lastTypingT).toBe(150);
    expect(s.screen.recent.map((e) => e.event_id)).toEqual(["a", "c"]);
    expect(s.screen.recent[0]).toMatchObject({ field: "cost_center", before: "4711", after: "0400", t_ms: 100 });
    expect(s.lastT).toBe(200); // out-of-order event doesn't move the clock back
  });

  it("keeps only the most recent turns", () => {
    const store = started();
    for (let i = 0; i < RECENT_LIMIT + 5; i++) {
      store.applyTurn(ev(STREAMS.turns, i, { turn_id: `t${i}`, role: "user", text: `${i}`, lang: "de", source: "live", redacted: true }));
    }
    const turns = store.get(SID)!.turns;
    expect(turns).toHaveLength(RECENT_LIMIT);
    expect(turns[0]!.turn_id).toBe("t5");
  });

  it("nowT projects session time by wall-clock elapsed", () => {
    const store = new SessionStore();
    store.applyLifecycle(lifecycle(1000, { event: "started" }), 50_000);
    const s = store.get(SID)!;
    expect(nowT(s, 51_500)).toBe(2500);
    expect(nowT(s, 49_000)).toBe(1000);
  });
});
