import { DECISION_SPECS, expandQuestions } from "@sidekik/contracts";
import type { JevAsk } from "../../src/jev/types.js";

/** D1 + D3 (2 candidates): one noul, one choice, two nouls, two scores. */
export const ASK: JevAsk = {
  state: { features: { ms_since_speech_end: 1850 }, last_utterance: "…und dann geht die auf 0400." },
  questions: { ...DECISION_SPECS.D1.questions, ...expandQuestions(DECISION_SPECS.D3, 2) },
};

export const WIRE_ANSWERS = {
  pause_now: { type: "noul", noul: 0.91 },
  activity: {
    type: "choice",
    choice: "finished_substep",
    confidence: 0.84,
    probabilities: { cannot_tell: 0.02, finished_substep: 0.84, navigating: 0.04, reading: 0.04, talking: 0.03, typing: 0.03 },
  },
  answered_q1: { type: "noul", noul: 0.08 },
  answered_q2: { type: "noul", noul: 0.7 },
  value_q1: { type: "score", score: 2.6, confidence: 0.7, probabilities: { "0": 0.02, "1": 0.08, "2": 0.18, "3": 0.72 } },
  value_q2: { type: "score", score: 0.4, confidence: 0.8, probabilities: { "0": 0.7, "1": 0.2, "2": 0.1, "3": 0 } },
};

export type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

/** A fetch that records calls and answers with `respond`. */
export function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const call = { url, init, body: init.body ? JSON.parse(String(init.body)) : {} };
    calls.push(call);
    return respond(call);
  };
  return { fn, calls };
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
