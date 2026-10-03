import { DECISION_SPECS } from "@sidekik/contracts";
import { describe, expect, it } from "vitest";
import { buildAsk, questionName } from "../../src/decide/specs.js";

describe("buildAsk", () => {
  it("batches decisions with a shared state and prefixes question names", () => {
    const state = { last_utterance: "x" };
    const { ask, decisions } = buildAsk([
      { id: "D1", state },
      { id: "D3", state, candidates: 2 },
    ]);
    expect(ask.state).toBe(state);
    expect(Object.keys(ask.questions)).toEqual([
      "D1__pause_now",
      "D1__activity",
      "D3__answered_q1",
      "D3__value_q1",
      "D3__answered_q2",
      "D3__value_q2",
    ]);
    expect(decisions).toEqual([
      { id: "D1", questions: ["D1__pause_now", "D1__activity"] },
      { id: "D3", questions: ["D3__answered_q1", "D3__value_q1", "D3__answered_q2", "D3__value_q2"] },
    ]);
    // Specs pass through unchanged: option order is DECISION_SPECS' order.
    expect(ask.questions.D1__activity).toBe(DECISION_SPECS.D1.questions.activity);
  });

  it("keys different states by decision and points each question at its part", () => {
    const { ask } = buildAsk([
      { id: "D8", state: { reply: "Ja, genau so." } },
      { id: "D12", state: { last_turn: "Das war's." } },
    ]);
    expect(ask.state).toEqual({ D8: { reply: "Ja, genau so." }, D12: { last_turn: "Das war's." } });
    expect(ask.questions.D8__teachback_reply!.instructions).toMatch(/^About state\.D8: /);
  });

  it("rejects empty and duplicate requests", () => {
    expect(() => buildAsk([])).toThrow();
    expect(() => buildAsk([{ id: "D8", state: 1 }, { id: "D8", state: 2 }])).toThrow(/duplicate/);
  });

  it("questionName strips the prefix", () => {
    expect(questionName("D3__answered_q2")).toBe("answered_q2");
    expect(questionName("plain")).toBe("plain");
  });
});
