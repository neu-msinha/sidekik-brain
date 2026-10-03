import type { SessionState } from "./state.js";

/** DESIGN §3 pause-detector gates. Everything is in session time (t_ms). */
export type PauseConfig = {
  speechIdleMs: number;
  screenStillMs: number;
  typingQuietMs: number;
  maxQuestionsPerWindow: number;
  windowMs: number;
  minGapMs: number;
};

export const DEFAULT_PAUSE: PauseConfig = {
  speechIdleMs: 1200,
  screenStillMs: 2000,
  typingQuietMs: 3000,
  maxQuestionsPerWindow: 5,
  windowMs: 10 * 60_000,
  minGapMs: 60_000,
};

export type Gate = "user_speaking" | "agent_speaking" | "speech_recent" | "screen_moving" | "typing" | "question_rate" | "question_gap" | "no_candidates";

export type GateResult = { open: boolean; failed: Gate[] };

/** Pure check of every gate; `failed` lists all that block, for logs and tests. */
export function pauseGate(s: SessionState, now: number, cfg: PauseConfig = DEFAULT_PAUSE): GateResult {
  const failed: Gate[] = [];
  const { speech, screen, capture } = s;

  if (speech.userSpeaking) failed.push("user_speaking");
  if (speech.agentSpeaking) failed.push("agent_speaking");
  if (speech.lastUserSpeechEndT !== undefined && now - speech.lastUserSpeechEndT < cfg.speechIdleMs) failed.push("speech_recent");

  if (screen.lastChangeT !== undefined && now - screen.lastChangeT < cfg.screenStillMs) failed.push("screen_moving");

  const lastTyping = Math.max(speech.lastTypingT ?? -Infinity, screen.lastTypingT ?? -Infinity);
  if (now - lastTyping < cfg.typingQuietMs) failed.push("typing");

  const recent = capture.asked.filter((q) => now - q.asked_t_ms < cfg.windowMs);
  if (recent.length >= cfg.maxQuestionsPerWindow) failed.push("question_rate");
  const lastAsk = capture.asked.at(-1);
  if (lastAsk && now - lastAsk.asked_t_ms < cfg.minGapMs) failed.push("question_gap");

  if (capture.candidates.length === 0) failed.push("no_candidates");

  return { open: failed.length === 0, failed };
}

/** True while the expert is mid-utterance or typing: a started check must be cancelled. */
export function interrupted(s: SessionState, since: number): boolean {
  if (s.speech.userSpeaking) return true;
  const lastTyping = Math.max(s.speech.lastTypingT ?? -Infinity, s.screen.lastTypingT ?? -Infinity);
  return lastTyping > since;
}
