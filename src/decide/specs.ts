import { DECISION_SPECS, expandQuestions, type DecisionId, type DecisionSpec } from "@sidekik/contracts";
import type { AskContext } from "../jev/router.js";
import type { JevAsk, JevQuestions } from "../jev/types.js";

export type DecisionItem = {
  id: DecisionId;
  state: unknown;
  /** Candidate count for per-candidate specs (D3). */
  candidates?: number;
};

/** Separator between decision id and question name in a batched request ("D1__pause_now"). */
const SEP = "__";

/**
 * Builds one Jev request from several decisions (DESIGN §2: all requested decisions in a single call).
 * Question names are prefixed with the decision id so batched decisions never collide.
 * When the decisions carry different states, the state is keyed by decision and each
 * question's instructions say which part of the state it is about.
 */
export function buildAsk(items: DecisionItem[]): { ask: JevAsk; decisions: AskContext["decisions"] } {
  if (items.length === 0) throw new Error("buildAsk: no decisions");
  const ids = items.map((i) => i.id);
  if (new Set(ids).size !== ids.length) throw new Error(`buildAsk: duplicate decision in one request (${ids.join(",")})`);

  const sharedState = items.every((i) => sameJson(i.state, items[0]!.state));
  const questions: JevQuestions = {};
  const decisions: AskContext["decisions"] = [];

  for (const item of items) {
    const spec: DecisionSpec = DECISION_SPECS[item.id];
    const qs = spec.per_candidate ? expandQuestions(spec, item.candidates ?? 1) : spec.questions;
    const names: string[] = [];
    for (const [name, q] of Object.entries(qs)) {
      const key = `${item.id}${SEP}${name}`;
      questions[key] = sharedState ? q : { ...q, instructions: `About state.${item.id}: ${q.instructions}` };
      names.push(key);
    }
    decisions.push({ id: item.id, questions: names });
  }

  const state = sharedState ? items[0]!.state : Object.fromEntries(items.map((i) => [i.id, i.state]));
  return { ask: { state, questions }, decisions };
}

/** "D1__pause_now" → "pause_now". */
export function questionName(key: string): string {
  const i = key.indexOf(SEP);
  return i === -1 ? key : key.slice(i + SEP.length);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
