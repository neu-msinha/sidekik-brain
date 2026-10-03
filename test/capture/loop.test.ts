import { describe, expect, it } from "vitest";
import { choice, harness, noul, score } from "./harness.js";

/** Expert explains, recodes 4711→0400, stops talking; candidate drafted at 6.4 s. */
async function judgmentCall(h: ReturnType<typeof harness>) {
  h.speech(1500, "user_speech_start");
  h.speech(4300, "user_speech_end");
  await h.screen(6400);
}

describe("capture loop: candidates", () => {
  it("a judgment call becomes a candidate with D4's qtype and a questions row", async () => {
    const h = harness({ qtype: choice("limit", 0.9) });
    await judgmentCall(h);

    const [c] = h.state().capture.candidates;
    expect(c).toMatchObject({ text: "Warum 0400 statt 4711?", qtype: "limit", anchors: ["se6400"], created_t_ms: 6400 });
    expect(h.repo.questions.get(c!.id)).toMatchObject({ status: "candidate", phase: "capture", qtype: "limit", anchor_event_ids: ["se6400"] });
    expect(h.repo.eventClasses.get("se6400")).toBe("judgment_call");
    expect(h.planner.inputs[0]).toMatchObject({ language: "de", event_class: "judgment_call" });
  });

  it("keeps the planner's qtype when D4 isn't confident", async () => {
    const h = harness({ qtype: choice("other", 0.5) });
    await judgmentCall(h);
    expect(h.state().capture.candidates[0]!.qtype).toBe("why");
  });

  it("routine events and low-confidence classes draft nothing", async () => {
    const h = harness({ event_class: choice("routine_navigation", 0.95) });
    await h.screen(1000);
    await h.screen(2000, "navigation");
    expect(h.state().capture.candidates).toHaveLength(0);
    expect(h.jevCalls("D2")).toBe(1); // navigation never reaches D2
    expect(h.planner.inputs).toHaveLength(0);

    const low = harness({ event_class: choice("judgment_call", 0.7) });
    await low.screen(1000);
    expect(low.state().capture.candidates).toHaveLength(0);
  });

  it("does nothing outside an active capture (off record, tutor phase)", async () => {
    const h = harness();
    await h.lifecycle(100, "offrecord_on");
    await h.screen(1000);
    expect(h.jevCalls("D2")).toBe(0);
  });
});

describe("capture loop: asking at a pause", () => {
  it("asks once every gate is open and Jev agrees it's a pause", async () => {
    const h = harness();
    await judgmentCall(h);
    await h.tick(7000); // screen changed 0.6 s ago: gate closed
    expect(h.jevCalls("D1")).toBe(0);
    await h.tick(8500); // speech idle 4.2 s, screen still 2.1 s, no typing
    const [ask] = h.asks();
    const c = h.state().capture;
    expect(ask).toMatchObject({ type: "ask", text: "Warum 0400 statt 4711?", qtype: "why" });
    expect(c.candidates).toHaveLength(0);
    expect(c.awaitingAnswer).toMatchObject({ question_id: ask!.question_id, asked_t_ms: 8500 });
    expect(h.repo.questions.get(ask!.question_id)).toMatchObject({ status: "asked", asked_t_ms: 8500, jev_scores: { pause_now: 0.93, answered: 0.05 } });
    // D1 and D3 went out in one request
    expect(Object.keys(h.jev.asks.at(-1)!.questions)).toEqual(["D1__pause_now", "D1__activity", "D3__answered_q1", "D3__value_q1"]);
  });

  it("never checks while the expert is speaking or typing", async () => {
    const h = harness();
    await judgmentCall(h);
    h.speech(8000, "user_speech_start");
    await h.tick(9000);
    h.speech(9500, "user_speech_end");
    h.speech(9600, "typing");
    await h.tick(11_000);
    expect(h.jevCalls("D1")).toBe(0);
    await h.tick(12_700);
    expect(h.asks()).toHaveLength(1);
  });

  it("cancels the ask when speech starts while Jev is deciding", async () => {
    const h = harness({
      pause_now: () => {
        h.speech(8600, "user_speech_start");
        return noul(0.95);
      },
    });
    await judgmentCall(h);
    await h.tick(8500);
    expect(h.asks()).toHaveLength(0);
    expect(h.state().capture.candidates).toHaveLength(1);
  });

  it("not a pause: re-checks once after 1 s, then holds until something changes", async () => {
    let pause = 0.4;
    const h = harness({ pause_now: () => noul(pause) });
    await judgmentCall(h);
    await h.tick(8500);
    await h.tick(9000); // before the 1 s re-check
    expect(h.jevCalls("D1")).toBe(1);
    await h.tick(9500);
    expect(h.jevCalls("D1")).toBe(2);
    await h.tick(12_000);
    await h.screen(12_100, "idle"); // idle events don't release the hold
    await h.tick(13_000);
    expect(h.jevCalls("D1")).toBe(2);

    pause = 0.95;
    h.speech(13_500, "user_speech_start");
    h.speech(14_000, "user_speech_end");
    await h.tick(15_300);
    expect(h.jevCalls("D1")).toBe(3);
    expect(h.asks()).toHaveLength(1);
  });

  it("asks the most valuable unanswered candidate and drops answered ones", async () => {
    const h = harness({ qtype: choice("other", 0.5) });
    h.planner.drafts = [
      { text: "Warum 0400?", qtype: "why", anchors: [] },
      { text: "Ab welchem Betrag gilt das?", qtype: "limit", anchors: [] },
    ];
    await judgmentCall(h);
    h.planner.drafts = [{ text: "Steht das auf der Rechnung?", qtype: "other", anchors: [] }];
    await h.screen(6500);
    expect(h.state().capture.candidates).toHaveLength(3);

    // q1 low value, q2 high value, q3 already answered by the screen.
    const h2Answers: Record<string, ReturnType<typeof noul>> = { answered_q1: noul(0.05), answered_q2: noul(0.1), answered_q3: noul(0.97) };
    const values: Record<string, ReturnType<typeof score>> = { value_q1: score(2, 0.9), value_q2: score(4, 0.9), value_q3: score(4, 0.9) };
    h.setAnswers({ ...h2Answers, ...values });

    await h.tick(9000);
    expect(h.asks().map((a) => a.text)).toEqual(["Ab welchem Betrag gilt das?"]);
    const left = h.state().capture.candidates.map((c) => c.text);
    expect(left).toEqual(["Warum 0400?"]);
    expect([...h.repo.questions.values()].find((q) => q.text === "Steht das auf der Rechnung?")!.status).toBe("expired");
  });

  it("guardrail quota: after two non-guardrail asks only limit/stop_and_ask qualify", async () => {
    const h = harness({ qtype: choice("other", 0.5) }); // D4 unsure: planner qtypes stand
    const ask = async (t: number, drafts: { text: string; qtype: "why" | "limit" | "other" }[]) => {
      h.planner.drafts = drafts.map((d) => ({ ...d, anchors: [] }));
      h.speech(t - 3000, "user_speech_end");
      await h.screen(t - 2500);
      await h.tick(t);
    };
    await ask(10_000, [{ text: "Warum eins?", qtype: "why" }]);
    await ask(80_000, [{ text: "Warum zwei?", qtype: "why" }]);
    expect(h.asks()).toHaveLength(2);

    await ask(150_000, [{ text: "Warum drei?", qtype: "why" }]);
    expect(h.asks()).toHaveLength(2); // only a "why" is waiting: no ask
    expect(h.jevCalls("D1")).toBe(2);

    h.planner.drafts = [{ text: "Ab welchem Betrag?", qtype: "limit", anchors: [] }];
    await h.screen(151_000);
    await h.tick(154_000);
    expect(h.asks().map((a) => a.qtype)).toEqual(["why", "why", "limit"]);
  });

  it("rate gates: 60 s between questions", async () => {
    const h = harness();
    await judgmentCall(h);
    await h.tick(8500);
    h.planner.drafts = [{ text: "Noch eine Frage?", qtype: "limit", anchors: [] }];
    await h.screen(20_000);
    await h.tick(30_000);
    expect(h.asks()).toHaveLength(1);
    await h.tick(68_500);
    expect(h.asks()).toHaveLength(2);
  });
});

describe("capture loop: expiry", () => {
  it("opening another record expires candidates about the previous one", async () => {
    const h = harness();
    h.speech(100, "user_speech_start");
    await h.screenOn(6400, "4471");
    const id = h.state().capture.candidates[0]!.id;
    await h.recordOpened(7000, "4471"); // same record: kept
    expect(h.state().capture.candidates).toHaveLength(1);
    await h.recordOpened(8000, "4480");
    expect(h.state().capture.candidates).toHaveLength(0);
    expect(h.repo.questions.get(id)!.status).toBe("expired");
  });

  it("candidates expire after 90 s", async () => {
    const h = harness();
    h.speech(100, "user_speech_start"); // keeps the gate closed
    await h.screen(6400);
    const id = h.state().capture.candidates[0]!.id;
    await h.tick(96_399);
    expect(h.state().capture.candidates).toHaveLength(1);
    await h.tick(96_400);
    expect(h.state().capture.candidates).toHaveLength(0);
    expect(h.repo.questions.get(id)!.status).toBe("expired");
  });

  it("task_done expires every waiting candidate (mapper reads them as open items)", async () => {
    const h = harness();
    await judgmentCall(h);
    const id = h.state().capture.candidates[0]!.id;
    await h.lifecycle(7000, "task_done");
    expect(h.repo.questions.get(id)!.status).toBe("expired");
    await h.tick(20_000);
    expect(h.jevCalls("D1")).toBe(0);
  });
});
