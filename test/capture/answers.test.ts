import { describe, expect, it } from "vitest";
import { choice, harness, noul } from "./harness.js";

async function asked(h: ReturnType<typeof harness>) {
  h.speech(4300, "user_speech_end");
  await h.screen(6400);
  await h.tick(8500);
  return h.asks()[0]!;
}

describe("answer handling (D5)", () => {
  it("stores the first user turn after an ask, with the extracted rule", async () => {
    const h = harness({ content_class: choice("reason_and_guardrail", 0.9), has_numeric_or_date_condition: noul(0.92) });
    const ask = await asked(h);
    await h.turn(9000, "Ab welchem Betrag?", "agent");
    await h.turn(12_000, "Alles über fünftausend netto ist Anlagevermögen, das geht auf 0400.");

    expect(h.repo.answers).toEqual([
      expect.objectContaining({
        question_id: ask.question_id,
        turn_ids: ["t12000"],
        content_class: "reason_and_guardrail",
        quote: "Alles über fünftausend netto ist Anlagevermögen, das geht auf 0400.",
        has_condition: true,
        extracted_rule: "Equipment invoices over €5,000 net are coded to cost center 0400.",
      }),
    ]);
    expect(h.repo.questions.get(ask.question_id)!.status).toBe("answered");
    expect(h.state().capture.awaitingAnswer).toBeUndefined();
  });

  it("no rule extraction without a numeric/date condition; only the first turn counts", async () => {
    const h = harness({ content_class: choice("reason_only", 0.9), has_numeric_or_date_condition: noul(0.1) });
    await asked(h);
    await h.turn(12_000, "Weil das eine Maschine ist.");
    await h.turn(14_000, "Und die bleibt lange im Haus.");
    expect(h.repo.answers).toHaveLength(1);
    expect(h.repo.answers[0]).toMatchObject({ content_class: "reason_only", has_condition: false, extracted_rule: null });
    expect(h.rules.calls).toBe(0);
  });

  it("an unclear content class falls back to 'neither'", async () => {
    const h = harness({ content_class: choice("reason_only", 0.3), has_numeric_or_date_condition: noul(0.1) });
    await asked(h);
    await h.turn(12_000, "Hm, ja.");
    expect(h.repo.answers[0]!.content_class).toBe("neither");
  });

  it("ignores user turns when nothing was asked", async () => {
    const h = harness();
    await h.turn(1000, "Hallo.");
    expect(h.repo.answers).toHaveLength(0);
    expect(h.jevCalls("D5")).toBe(0);
  });
});
