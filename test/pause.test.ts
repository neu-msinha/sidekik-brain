import { describe, expect, it } from "vitest";
import { DEFAULT_PAUSE, interrupted, pauseGate, type Gate } from "../src/pause.js";
import type { SessionState } from "../src/state.js";

function session(over: {
  speech?: Partial<SessionState["speech"]>;
  screen?: Partial<SessionState["screen"]>;
  asked?: number[];
  candidates?: number;
}): SessionState {
  return {
    session_id: "s",
    org_id: "o",
    kind: "capture",
    phase: "capture",
    mode: "browser",
    language: "de",
    workflow_id: "wf",
    offRecord: false,
    lastT: 0,
    lastWallMs: 0,
    speech: { userSpeaking: false, agentSpeaking: false, ...over.speech },
    screen: { recent: [], ...over.screen },
    turns: [],
    capture: {
      candidates: Array.from({ length: over.candidates ?? 1 }, (_, i) => ({ id: `c${i}`, text: "Warum 0400?", qtype: "why" as const, anchors: [], created_t_ms: 0 })),
      asked: (over.asked ?? []).map((t, i) => ({ question_id: `q${i}`, text: "x", qtype: "why" as const, asked_t_ms: t })),
      checking: false,
    },
  };
}

const NOW = 700_000;

// [name, session overrides, expected failed gates]
const cases: [string, Parameters<typeof session>[0], Gate[]][] = [
  ["all quiet: open", { speech: { lastUserSpeechEndT: NOW - 1850 }, screen: { lastChangeT: NOW - 2400 } }, []],
  ["fresh session, nothing happened yet", {}, []],
  ["user speaking", { speech: { userSpeaking: true } }, ["user_speaking"]],
  ["agent speaking", { speech: { agentSpeaking: true } }, ["agent_speaking"]],
  ["speech ended 1.1 s ago", { speech: { lastUserSpeechEndT: NOW - 1100 } }, ["speech_recent"]],
  ["speech ended exactly 1.2 s ago", { speech: { lastUserSpeechEndT: NOW - 1200 } }, []],
  ["screen changed 1.9 s ago", { screen: { lastChangeT: NOW - 1900 } }, ["screen_moving"]],
  ["screen changed exactly 2 s ago", { screen: { lastChangeT: NOW - 2000 } }, []],
  ["dom typing 2.9 s ago", { speech: { lastTypingT: NOW - 2900 } }, ["typing"]],
  ["vision typing 2.5 s ago", { screen: { lastTypingT: NOW - 2500 } }, ["typing"]],
  ["typing 3 s ago", { speech: { lastTypingT: NOW - 3000 } }, []],
  ["asked 59 s ago", { asked: [NOW - 59_000] }, ["question_gap"]],
  ["asked 60 s ago", { asked: [NOW - 60_000] }, []],
  ["5 questions in the last 10 min", { asked: [NOW - 590_000, NOW - 480_000, NOW - 360_000, NOW - 240_000, NOW - 120_000] }, ["question_rate"]],
  ["5 questions but the first is older than 10 min", { asked: [NOW - 600_000, NOW - 480_000, NOW - 360_000, NOW - 240_000, NOW - 120_000] }, []],
  ["no candidates", { candidates: 0 }, ["no_candidates"]],
  [
    "everything at once",
    { speech: { userSpeaking: true, agentSpeaking: true, lastUserSpeechEndT: NOW - 10, lastTypingT: NOW }, screen: { lastChangeT: NOW }, asked: [NOW - 1], candidates: 0 },
    ["user_speaking", "agent_speaking", "speech_recent", "screen_moving", "typing", "question_gap", "no_candidates"],
  ],
];

describe("pauseGate", () => {
  it.each(cases)("%s", (_name, over, failed) => {
    expect(pauseGate(session(over), NOW, DEFAULT_PAUSE)).toEqual({ open: failed.length === 0, failed });
  });
});

describe("interrupted", () => {
  it("is true once speech starts or typing happens after the check began", () => {
    expect(interrupted(session({}), NOW)).toBe(false);
    expect(interrupted(session({ speech: { userSpeaking: true } }), NOW)).toBe(true);
    expect(interrupted(session({ speech: { lastTypingT: NOW + 10 } }), NOW)).toBe(true);
    expect(interrupted(session({ speech: { lastTypingT: NOW - 10 } }), NOW)).toBe(false);
  });
});
