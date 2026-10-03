import { DECISION_SPECS } from "@sidekik/contracts";
import { describe, expect, it } from "vitest";
import { fromWireAnswers, toWireQuestions, WireResponseSchema } from "../../src/jev/wire.js";
import { ASK, WIRE_ANSWERS } from "./fakes.js";

describe("toWireQuestions", () => {
  it("keeps choice options in the spec's fixed order", () => {
    const wire = toWireQuestions({ activity: DECISION_SPECS.D1.questions.activity });
    expect(wire.activity!.type).toBe("choice");
    expect(Object.keys(wire.activity!.criteria)).toEqual(DECISION_SPECS.D1.questions.activity.options);
  });

  it("turns 1-based score criteria into a 0-indexed array", () => {
    const wire = toWireQuestions({ specificity: DECISION_SPECS.D6.questions.specificity });
    expect(wire.specificity).toEqual({
      type: "score",
      instructions: DECISION_SPECS.D6.questions.specificity.instructions,
      criteria: ["1", "2", "3", "4"].map((k) => DECISION_SPECS.D6.questions.specificity.criteria[k as "1"]),
    });
  });

  it("passes noul criteria through", () => {
    expect(toWireQuestions({ q: DECISION_SPECS.D12.questions.expert_signals_done }).q).toMatchObject({
      type: "noul",
      criteria: { true: expect.any(String), false: expect.any(String) },
    });
  });
});

describe("fromWireAnswers", () => {
  const answers = fromWireAnswers(ASK.questions, WireResponseSchema.parse({ model: "m", answers: WIRE_ANSWERS, usage: { input_tokens: 1, output_tokens: 0 } }).answers);

  it("noul: p_true and confidence = max(p, 1-p)", () => {
    expect(answers.pause_now).toEqual({ type: "noul", p_true: 0.91, confidence: 0.91 });
    expect(answers.answered_q1).toMatchObject({ p_true: 0.08, confidence: 0.92 });
  });

  it("choice keeps probabilities and confidence", () => {
    expect(answers.activity).toMatchObject({ choice: "finished_substep", confidence: 0.84 });
  });

  it("score is shifted to 1-based levels", () => {
    expect(answers.value_q1).toMatchObject({ type: "score", score: 3.6, level: 4, confidence: 0.7 });
    expect((answers.value_q1 as { probabilities: Record<string, number> }).probabilities).toEqual({ "1": 0.02, "2": 0.08, "3": 0.18, "4": 0.72 });
    expect(answers.value_q2).toMatchObject({ score: 1.4, level: 1 });
  });

  it("rejects missing answers, wrong types and unknown options", () => {
    const { pause_now: _, ...missing } = WIRE_ANSWERS;
    expect(() => fromWireAnswers(ASK.questions, missing as never)).toThrow(/missing answer for pause_now/);
    expect(() => fromWireAnswers(ASK.questions, { ...WIRE_ANSWERS, pause_now: { type: "choice", choice: "x" } } as never)).toThrow(/expected noul/);
    expect(() =>
      fromWireAnswers(ASK.questions, { ...WIRE_ANSWERS, activity: { type: "choice", choice: "dancing", confidence: 1 } } as never),
    ).toThrow(/unknown option/);
  });
});
