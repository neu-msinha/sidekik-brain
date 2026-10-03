import { describe, expect, it } from "vitest";
import { cleanDrafts, HaikuPlanner, MAX_QUESTION_WORDS, type PlannerInput } from "../src/planner.js";
import { fakeFetch, json } from "./jev/fakes.js";

const INPUT: PlannerInput = {
  language: "de",
  event_class: "judgment_call",
  event: { event_id: "se3", type: "field_changed", field: "cost_center", before: "4711", after: "0400", t_ms: 6400 },
  screen_state: { invoice_id: "4471", net_amount: 6350, category: "equipment" },
  recent_events: [{ event_id: "se1", type: "record_opened", t_ms: 1200 }],
  recent_turns: [{ role: "user", text: "…und dann geht die auf 0400." }],
  existing_questions: ["Warum hast du 0400 gewählt?"],
};

const reply = (questions: unknown) =>
  json(200, {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [{ type: "text", text: JSON.stringify({ questions }) }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 700, output_tokens: 60 },
  });

describe("HaikuPlanner", () => {
  it("sends the event as data with a structured schema and returns cleaned drafts", async () => {
    const f = fakeFetch(() =>
      reply([
        { text: "Ab welchem Betrag kommt eine Rechnung auf 0400?", qtype: "limit", anchors: ["se3"] },
        { text: "Wann würdest du hier den Controller fragen?", qtype: "stop_and_ask", anchors: ["nope"] },
        { text: "Third one", qtype: "other", anchors: [] },
      ]),
    );
    const planner = new HaikuPlanner({ apiKey: "k", model: "claude-haiku-4-5", fetch: f.fn });
    const res = await planner.draft(INPUT);

    const body = f.calls[0]!.body as { model: string; system: string; messages: { content: string }[]; output_config: { format: { type: string } } };
    expect(body.model).toBe("claude-haiku-4-5");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.system).toMatch(/untrusted_screen_text/);
    expect(JSON.parse(body.messages[0]!.content)).toEqual(INPUT);

    expect(res.drafts).toEqual([
      { text: "Ab welchem Betrag kommt eine Rechnung auf 0400?", qtype: "limit", anchors: ["se3"] },
      { text: "Wann würdest du hier den Controller fragen?", qtype: "stop_and_ask", anchors: ["se3"] },
    ]);
    expect(res.usage).toEqual({ input_tokens: 700, output_tokens: 60 });
  });
});

describe("cleanDrafts", () => {
  it("drops long, empty and repeated questions", () => {
    const long = Array.from({ length: MAX_QUESTION_WORDS + 1 }, () => "wort").join(" ");
    const out = cleanDrafts(
      [
        { text: long, qtype: "why", anchors: ["se3"] },
        { text: "   ", qtype: "why", anchors: [] },
        { text: "warum hast du 0400 gewählt", qtype: "why", anchors: ["se3"] },
        { text: "Was passiert bei unbekannten Lieferanten?", qtype: "exception", anchors: ["se1", "zzz"] },
      ],
      INPUT,
    );
    expect(out).toEqual([{ text: "Was passiert bei unbekannten Lieferanten?", qtype: "exception", anchors: ["se1"] }]);
  });
});
