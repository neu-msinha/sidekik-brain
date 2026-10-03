import type {
  Envelope,
  QType,
  Phase,
  ScreenEvent,
  SessionKind,
  SessionLifecycle,
  SessionMode,
  SpeechSignal,
  TranscriptTurn,
} from "@sidekik/contracts";

/** How many recent screen events / turns each session keeps for Jev state. */
export const RECENT_LIMIT = 20;

export type RecentScreenEvent = Pick<ScreenEvent, "event_id" | "type" | "field" | "before" | "after" | "entity"> & {
  t_ms: number;
};
export type RecentTurn = Pick<TranscriptTurn, "turn_id" | "role" | "text" | "lang"> & { t_ms: number };

/** A drafted question waiting for a pause (DESIGN §3). Ids are `questions.id` UUIDs. */
export type Candidate = {
  id: string;
  text: string;
  qtype: QType;
  anchors: string[];
  created_t_ms: number;
  /** Record the question is about; it expires when the expert opens another one. */
  entity_id?: string;
};

export type AskedQuestion = { question_id: string; text: string; qtype: QType; asked_t_ms: number };

export type CaptureState = {
  candidates: Candidate[];
  asked: AskedQuestion[];
  /** The last ask, until the expert's first reply is handled (D5). */
  awaitingAnswer?: AskedQuestion;
  /** A D1+D3 check is in flight. */
  checking: boolean;
  /** Session time of the one allowed re-check after a "not yet" (DESIGN §3: wait 1 s, check once more). */
  recheckAt?: number;
  /**
   * After a failed re-check: don't check again until the expert speaks, the screen changes
   * or a candidate is added (see `holdSignature`). Idle events alone don't release it.
   */
  heldAt?: string;
};

export type SessionState = {
  session_id: string;
  org_id: string;
  kind: SessionKind;
  phase: Phase;
  mode: SessionMode;
  language: string;
  workflow_id: string;
  workmap_id?: string;
  offRecord: boolean;
  /** Latest t_ms seen on any stream, plus the wall clock when it arrived (to project "now"). */
  lastT: number;
  lastWallMs: number;
  speech: {
    userSpeaking: boolean;
    agentSpeaking: boolean;
    lastUserSpeechEndT?: number;
    lastTypingT?: number;
  };
  screen: {
    /** t_ms of the last screen.event other than `idle`. */
    lastChangeT?: number;
    lastTypingT?: number;
    recent: RecentScreenEvent[];
  };
  turns: RecentTurn[];
  capture: CaptureState;
};

/** True while brain should run its own capture loop for this session. */
export function isCaptureActive(s: SessionState): boolean {
  return s.kind === "capture" && s.phase === "capture" && !s.offRecord;
}

/** What has to change before a held gate is checked again. */
export function holdSignature(s: SessionState): string {
  return `${s.speech.lastUserSpeechEndT ?? -1}|${s.screen.lastChangeT ?? -1}|${s.capture.candidates.length}`;
}

/** Session time now, projected from the last event by wall-clock elapsed time. */
export function nowT(s: SessionState, wallNowMs = Date.now()): number {
  return s.lastT + Math.max(0, wallNowMs - s.lastWallMs);
}

export type LifecycleOutcome =
  | { kind: "created"; state: SessionState }
  | { kind: "ignored_replay" }
  | { kind: "updated"; state: SessionState; captureStopped: boolean }
  | { kind: "ended"; state: SessionState }
  | { kind: "unknown_session" };

/** Per-session state, keyed by session_id. Single brain instance, so in memory is enough. */
export class SessionStore {
  private readonly sessions = new Map<string, SessionState>();
  /** Sessions started in replay mode: brain ignores every event for them. */
  private readonly replaySessions = new Set<string>();

  get(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  list(): SessionState[] {
    return [...this.sessions.values()];
  }

  get size(): number {
    return this.sessions.size;
  }

  isIgnored(sessionId: string): boolean {
    return this.replaySessions.has(sessionId);
  }

  applyLifecycle(ev: Envelope<SessionLifecycle>, wallNowMs = Date.now()): LifecycleOutcome {
    const d = ev.data;
    if (this.replaySessions.has(ev.session_id)) {
      if (d.event === "ended") this.replaySessions.delete(ev.session_id);
      return { kind: "ignored_replay" };
    }

    if (d.event === "started") {
      if (d.mode === "replay") {
        this.replaySessions.add(ev.session_id);
        this.sessions.delete(ev.session_id);
        return { kind: "ignored_replay" };
      }
      const existing = this.sessions.get(ev.session_id);
      if (existing) return { kind: "updated", state: existing, captureStopped: false };
      const state: SessionState = {
        session_id: ev.session_id,
        org_id: ev.org_id,
        kind: d.kind,
        phase: d.phase,
        mode: d.mode,
        language: d.language,
        workflow_id: d.workflow_id,
        ...(d.workmap_id ? { workmap_id: d.workmap_id } : {}),
        offRecord: false,
        lastT: ev.t_ms,
        lastWallMs: wallNowMs,
        speech: { userSpeaking: false, agentSpeaking: false },
        screen: { recent: [] },
        turns: [],
        capture: { candidates: [], asked: [], checking: false },
      };
      this.sessions.set(ev.session_id, state);
      return { kind: "created", state };
    }

    const state = this.sessions.get(ev.session_id);
    if (!state) return { kind: "unknown_session" };
    touch(state, ev.t_ms, wallNowMs);
    const wasActive = isCaptureActive(state);

    switch (d.event) {
      case "ended":
        this.sessions.delete(ev.session_id);
        return { kind: "ended", state };
      case "offrecord_on":
        state.offRecord = true;
        break;
      case "offrecord_off":
        state.offRecord = false;
        break;
      case "task_done":
        // The expert finished the task: capture questions stop even if the phase hasn't flipped yet.
        state.phase = d.phase === "capture" ? "building" : d.phase;
        break;
      case "phase_changed":
        state.phase = d.phase;
        if (d.workmap_id) state.workmap_id = d.workmap_id;
        break;
      default:
        break;
    }
    // Off-record pauses the loop but doesn't end it, so it doesn't count as "stopped".
    const captureStopped = wasActive && !isCaptureActive(state) && !state.offRecord;
    return { kind: "updated", state, captureStopped };
  }

  applySpeech(ev: Envelope<SpeechSignal>, wallNowMs = Date.now()): SessionState | undefined {
    const state = this.sessions.get(ev.session_id);
    if (!state) return undefined;
    touch(state, ev.t_ms, wallNowMs);
    const sp = state.speech;
    switch (ev.data.kind) {
      case "user_speech_start":
        sp.userSpeaking = true;
        break;
      case "user_speech_end":
        sp.userSpeaking = false;
        sp.lastUserSpeechEndT = ev.t_ms;
        break;
      case "agent_speech_start":
        sp.agentSpeaking = true;
        break;
      case "agent_speech_end":
        sp.agentSpeaking = false;
        break;
      case "typing":
        sp.lastTypingT = ev.t_ms;
        break;
    }
    return state;
  }

  applyScreen(ev: Envelope<ScreenEvent>, wallNowMs = Date.now()): SessionState | undefined {
    const state = this.sessions.get(ev.session_id);
    if (!state) return undefined;
    touch(state, ev.t_ms, wallNowMs);
    const d = ev.data;
    if (d.type === "idle") return state;
    state.screen.lastChangeT = ev.t_ms;
    if (d.type === "typing_in_progress") state.screen.lastTypingT = ev.t_ms;
    pushRecent(state.screen.recent, {
      event_id: d.event_id,
      type: d.type,
      t_ms: ev.t_ms,
      ...(d.field !== undefined ? { field: d.field } : {}),
      ...(d.before !== undefined ? { before: d.before } : {}),
      ...(d.after !== undefined ? { after: d.after } : {}),
      ...(d.entity !== undefined ? { entity: d.entity } : {}),
    });
    return state;
  }

  applyTurn(ev: Envelope<TranscriptTurn>, wallNowMs = Date.now()): SessionState | undefined {
    const state = this.sessions.get(ev.session_id);
    if (!state) return undefined;
    touch(state, ev.t_ms, wallNowMs);
    const d = ev.data;
    pushRecent(state.turns, { turn_id: d.turn_id, role: d.role, text: d.text, lang: d.lang, t_ms: ev.t_ms });
    return state;
  }
}

function touch(state: SessionState, t: number, wallNowMs: number): void {
  if (t >= state.lastT) {
    state.lastT = t;
    state.lastWallMs = wallNowMs;
  }
}

function pushRecent<T>(list: T[], item: T): void {
  list.push(item);
  if (list.length > RECENT_LIMIT) list.splice(0, list.length - RECENT_LIMIT);
}
