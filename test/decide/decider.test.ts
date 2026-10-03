import { describe, expect, it } from "vitest";
import { Decider } from "../../src/decide/decider.js";
import { DEFAULT_THRESHOLDS } from "../../src/decide/thresholds.js";
import { ORG } from "../helpers.js";
import { choice, noul, routerWith, score, ScriptedClient } from "../support.js";

const CTX = { session_id: "s1", org_id: ORG, t_ms: 1000 };

describe("Decider", () => {
  it("returns outcomes per decision with bands", async () => {
    const jev = new ScriptedClient("jev", "jev-1.13.0", (q) =>
      ({
        pause_now: noul(0.92),
        activity: choice("finished_substep", 0.83),
        answered_q1: noul(0.05),
        value_q1: score(4, 0.7),
      })[q],
    );
    const { router, sink } = routerWith(jev);
    const out = await new Decider(router, DEFAULT_THRESHOLDS).decide(
      [
        { id: "D1", state: {} },
        { id: "D3", state: {}, candidates: 1 },
      ],
      CTX,
    );
    expect(out.D1!.questions.pause_now).toMatchObject({ answer: true, p_true: 0.92, band: "act", provider: "jev", escalated: false });
    expect(out.D1!.questions.activity).toMatchObject({ answer: "finished_substep", band: "act" });
    expect(out.D3!.questions.answered_q1).toMatchObject({ answer: false, band: "act" });
    expect(out.D3!.questions.value_q1).toMatchObject({ answer: 4, score: 4, band: "escalate" });
    await new Promise((r) => setTimeout(r, 0));
    expect(sink.rows.map((r) => r.decision)).toEqual(["D1", "D3"]);
  });

  it("escalates only mid-band answers to the LLM when asked to", async () => {
    const jev = new ScriptedClient("jev", "jev-1.13.0", (q) =>
      ({ event_class: choice("judgment_call", 0.7) })[q],
    );
    const llm = new ScriptedClient("llm", "claude-haiku-4-5", () => choice("judgment_call", 0.9));
    const { router, sink } = routerWith(jev, [llm]);
    const decider = new Decider(router, DEFAULT_THRESHOLDS);

    const noEsc = await decider.decide([{ id: "D2", state: { e: 1 } }], CTX);
    expect(noEsc.D2!.questions.event_class).toMatchObject({ band: "escalate", escalated: false });
    expect(llm.asks).toHaveLength(0);

    const esc = await decider.decide([{ id: "D2", state: { e: 2 } }], CTX, { escalate: true });
    expect(esc.D2).toMatchObject({ provider: "llm", escalated: true });
    expect(esc.D2!.questions.event_class).toMatchObject({ answer: "judgment_call", confidence: 0.9, band: "act", escalated: true });
    expect(Object.keys(llm.asks[0]!.questions)).toEqual(["D2__event_class"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(sink.rows.filter((r) => r.escalated)).toHaveLength(1);
  });

  it("an escalated answer still in the mid band falls to the safe default", async () => {
    const jev = new ScriptedClient("jev", "j", () => choice("judgment_call", 0.6));
    const llm = new ScriptedClient("llm", "h", () => choice("judgment_call", 0.65));
    const { router } = routerWith(jev, [llm]);
    const out = await new Decider(router, DEFAULT_THRESHOLDS).decide([{ id: "D2", state: {} }], CTX, { escalate: true });
    expect(out.D2!.questions.event_class!.band).toBe("default");
  });

  it("low-confidence choices are the safe default without escalation", async () => {
    const jev = new ScriptedClient("jev", "j", () => choice("judgment_call", 0.4));
    const llm = new ScriptedClient("llm", "h", () => choice("judgment_call", 0.99));
    const { router } = routerWith(jev, [llm]);
    const out = await new Decider(router, DEFAULT_THRESHOLDS).decide([{ id: "D2", state: {} }], CTX, { escalate: true });
    expect(out.D2!.questions.event_class!.band).toBe("default");
    expect(llm.asks).toHaveLength(0);
  });

  it("never escalates D7 and treats it as act", async () => {
    const jev = new ScriptedClient("jev", "j", () => noul(0.55));
    const llm = new ScriptedClient("llm", "h", () => noul(0.99));
    const { router } = routerWith(jev, [llm]);
    const out = await new Decider(router, DEFAULT_THRESHOLDS).decide([{ id: "D7", state: {} }], CTX, { escalate: true });
    expect(out.D7!.questions.off_record_request).toMatchObject({ p_true: 0.55, band: "act" });
    expect(llm.asks).toHaveLength(0);
  });
});
