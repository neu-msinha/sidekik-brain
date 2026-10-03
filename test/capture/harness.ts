import { STREAMS, type AgentCommand, type SessionLifecycle } from "@sidekik/contracts";
import { AnswerHandler } from "../../src/capture/answers.js";
import { RecordingGatewayClient } from "../../src/capture/gateway.js";
import { CaptureLoop } from "../../src/capture/loop.js";
import { OffRecordWatcher } from "../../src/capture/offrecord.js";
import { SessionQueue } from "../../src/capture/queue.js";
import { MemoryCaptureRepo } from "../../src/capture/repo.js";
import { Decider } from "../../src/decide/decider.js";
import { DEFAULT_THRESHOLDS } from "../../src/decide/thresholds.js";
import type { JevAnswer, JevAsk } from "../../src/jev/types.js";
import { DEFAULT_PAUSE } from "../../src/pause.js";
import type { Draft, PlannerInput, QuestionPlanner } from "../../src/planner.js";
import type { RuleExtractor } from "../../src/rules.js";
import { SessionStore } from "../../src/state.js";
import { ev, SID, silentLogger } from "../helpers.js";
import { choice, noul, routerWith, score, ScriptedClient } from "../support.js";

export { choice, noul, score };

export class FakePlanner implements QuestionPlanner {
  inputs: PlannerInput[] = [];
  constructor(public drafts: Draft[] = [{ text: "Warum 0400 statt 4711?", qtype: "why", anchors: [] }]) {}
  async draft(input: PlannerInput) {
    this.inputs.push(input);
    return { drafts: this.drafts.map((d) => ({ ...d, anchors: [input.event.event_id] })), usage: { input_tokens: 700, output_tokens: 50 }, model: "fake" };
  }
}

/**
 * A capture session with scripted Jev answers. `answers` maps question names to answers;
 * functions get the ask so tests can vary answers by candidate.
 */
export function harness(answers: Record<string, JevAnswer | ((ask: JevAsk) => JevAnswer)> = {}) {
  let now = 0;
  const jevAnswers: Record<string, JevAnswer | ((ask: JevAsk) => JevAnswer)> = {
    event_class: choice("judgment_call", 0.9),
    qtype: choice("why", 0.9),
    pause_now: noul(0.93),
    activity: choice("finished_substep", 0.88),
    ...answers,
  };
  const jev = new ScriptedClient("jev", "jev-1.13.0", (name, ask) => {
    const key = name.replace(/_q\d+$/, "_qN");
    const a = jevAnswers[name] ?? jevAnswers[key] ?? (name.startsWith("answered_q") ? noul(0.05) : name.startsWith("value_q") ? score(3, 0.8) : undefined);
    return typeof a === "function" ? a(ask) : a;
  });
  const { router, bus } = routerWith(jev);
  const store = new SessionStore();
  const repo = new MemoryCaptureRepo();
  const planner = new FakePlanner();
  const gateway = new RecordingGatewayClient();
  const log = silentLogger();
  const queue = new SessionQueue((_s, err) => {
    throw err;
  });
  const decider = new Decider(router, DEFAULT_THRESHOLDS);
  const rules: RuleExtractor & { calls: number } = {
    calls: 0,
    async extract() {
      this.calls++;
      return { rule: "Equipment invoices over €5,000 net are coded to cost center 0400.", usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
  const loop = new CaptureLoop({ store, decider, planner, repo, bus, queue, log, thresholds: DEFAULT_THRESHOLDS, pause: DEFAULT_PAUSE, now: () => now });
  const answersHandler = new AnswerHandler({ decider, rules, repo, queue, log, thresholds: DEFAULT_THRESHOLDS });
  const offRecord = new OffRecordWatcher({ decider, gateway, log, thresholds: DEFAULT_THRESHOLDS });

  const lifecycle = (t: number, data: Partial<SessionLifecycle> & Pick<SessionLifecycle, "event">) =>
    ev(STREAMS.lifecycle, t, { kind: "capture", phase: "capture", workflow_id: "wf", mode: "browser", language: "de", ...data });
  store.applyLifecycle(lifecycle(0, { event: "started" }));
  const state = () => store.get(SID)!;

  const h = {
    jev,
    bus,
    store,
    repo,
    planner,
    gateway,
    rules,
    loop,
    state,
    setNow: (t: number) => (now = t),
    /** Overrides scripted Jev answers from now on. */
    setAnswers: (more: Record<string, JevAnswer | ((ask: JevAsk) => JevAnswer)>) => Object.assign(jevAnswers, more),
    idle: () => queue.idle(),
    lifecycle: async (t: number, event: SessionLifecycle["event"], extra: Partial<SessionLifecycle> = {}) => {
      const out = store.applyLifecycle(lifecycle(t, { event, ...extra }));
      if ((out.kind === "updated" && out.captureStopped) || out.kind === "ended") await loop.onCaptureStopped(out.state);
    },
    /** A field change the expert made (a judgment call by default). */
    screen: async (t: number, type: "field_changed" | "navigation" | "idle" | "typing_in_progress" = "field_changed", id = `se${t}`) => {
      now = Math.max(now, t);
      const e = ev(STREAMS.screen, t, { event_id: id, type, field: "cost_center", before: "4711", after: "0400", state: { app: "MiniERP" }, confidence: 0.95, source: "dom" });
      store.applyScreen(e);
      await loop.onScreenEvent(state(), e);
      await queue.idle();
    },
    /** A judgment-call field change on a specific invoice. */
    screenOn: async (t: number, invoice: string) => {
      now = Math.max(now, t);
      const e = ev(STREAMS.screen, t, { event_id: `se${t}`, type: "field_changed", entity: { kind: "invoice", id: invoice }, field: "cost_center", before: "4711", after: "0400", state: { app: "MiniERP" }, confidence: 0.95, source: "dom" });
      store.applyScreen(e);
      await loop.onScreenEvent(state(), e);
      await queue.idle();
    },
    recordOpened: async (t: number, invoice: string) => {
      now = Math.max(now, t);
      const e = ev(STREAMS.screen, t, { event_id: `ro${t}`, type: "record_opened", entity: { kind: "invoice", id: invoice }, state: { app: "MiniERP" }, confidence: 0.95, source: "dom" });
      store.applyScreen(e);
      await loop.onScreenEvent(state(), e);
      await queue.idle();
    },
    speech: (t: number, kind: "user_speech_start" | "user_speech_end" | "agent_speech_start" | "agent_speech_end" | "typing") => {
      now = Math.max(now, t);
      store.applySpeech(ev(STREAMS.speech, t, { kind, source: "sdk" }));
    },
    turn: async (t: number, text: string, role: "user" | "agent" = "user") => {
      now = Math.max(now, t);
      const e = ev(STREAMS.turns, t, { turn_id: `t${t}`, role, text, lang: "de", source: "live", redacted: true });
      store.applyTurn(e);
      await offRecord.onTurn(state(), e);
      await answersHandler.onTurn(state(), e);
      await queue.idle();
    },
    /** Advances the clock to `t` and runs one tick. */
    tick: async (t: number) => {
      now = t;
      loop.tick(state());
      await queue.idle();
    },
    asks: () => bus.published.filter((p) => p.stream === STREAMS.commands).map((p) => p.ev.data as Extract<AgentCommand, { type: "ask" }>),
    jevCalls: (decision: string) => jev.asks.filter((a) => Object.keys(a.questions).some((k) => k.startsWith(`${decision}__`))).length,
  };
  return h;
}
