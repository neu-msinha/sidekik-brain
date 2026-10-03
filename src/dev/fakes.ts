/**
 * Offline stand-ins for Jev and the Haiku planner/rule extractor, for dev:mock and the
 * Checkpoint 1 replay test. Enabled with FAKE_VENDORS=true; never used otherwise.
 * They follow simple, visible rules so a replay is deterministic.
 */
import type { QType } from "@sidekik/contracts";
import { noulAnswer } from "../jev/wire.js";
import type { JevAnswer, JevAsk, JevClient, JevResult } from "../jev/types.js";
import type { PlannerInput, PlannerResult, QuestionPlanner } from "../planner.js";
import type { RuleExtractor, RuleInput, RuleResult } from "../rules.js";

const JUDGMENT_FIELDS = /cost_center|approv|status|hold|asset/i;
const EXCEPTION_FIELDS = /status|hold/i;

export class HeuristicJev implements JevClient {
  readonly provider = "jev" as const;
  readonly model = "fake-jev";

  async ask(req: JevAsk): Promise<JevResult> {
    const state = (req.state ?? {}) as Record<string, unknown>;
    const answers: Record<string, JevAnswer> = {};
    for (const key of Object.keys(req.questions)) {
      const name = key.replace(/^D\d+__/, "");
      answers[key] = this.answer(name, state);
    }
    return { provider: this.provider, model: this.model, answers, usage: { input_tokens: Math.ceil(JSON.stringify(req).length / 4), output_tokens: 0 }, latency_ms: 5 };
  }

  private answer(name: string, s: Record<string, unknown>): JevAnswer {
    const text = JSON.stringify(s);
    switch (name) {
      case "pause_now": {
        const f = (s.features ?? {}) as { ms_since_speech_end?: number | null; ms_since_screen_change?: number | null };
        const quiet = (f.ms_since_speech_end ?? 99_999) >= 1200 && (f.ms_since_screen_change ?? 99_999) >= 2000;
        return noulAnswer(quiet ? 0.92 : 0.3);
      }
      case "activity":
        return choice("finished_substep", 0.88);
      case "event_class": {
        const ev = String(s.event ?? "");
        if (!JUDGMENT_FIELDS.test(ev)) return choice("routine_navigation", 0.9);
        return choice(EXCEPTION_FIELDS.test(ev) ? "exception_handling" : "judgment_call", 0.9);
      }
      case "qtype":
        return choice(qtypeOf(String(s.question ?? "")), 0.9);
      case "content_class":
        return choice(/\d|tausend|thousand/i.test(text) ? "reason_and_guardrail" : "reason_only", 0.85);
      case "has_numeric_or_date_condition":
        return noulAnswer(/\d|tausend|thousand|dezember|december/i.test(String(s.answer ?? "")) ? 0.9 : 0.1);
      case "off_record_request":
        return noulAnswer(/off the record|inoffiziell|nicht aufnehmen|stop recording/i.test(text) ? 0.9 : 0.05);
      case "back_on_record":
        return noulAnswer(0.05);
      default:
        if (name.startsWith("answered_q")) return noulAnswer(0.05);
        if (name.startsWith("value_q")) return { type: "score", score: 3, level: 3, confidence: 0.85, probabilities: { "3": 0.85 } };
        return noulAnswer(0.5);
    }
  }
}

export class TemplatePlanner implements QuestionPlanner {
  async draft(input: PlannerInput): Promise<PlannerResult> {
    const e = input.event;
    const field = e.field ?? "das";
    const after = e.after ?? "";
    const drafts =
      input.language.startsWith("de")
        ? [
            /cost_center/.test(field)
              ? { text: `Ab welchem Betrag kommt so eine Rechnung auf ${after}?`, qtype: "limit" as QType }
              : /approv/.test(field)
                ? { text: "Wann holst du hier eine zweite Freigabe ein?", qtype: "stop_and_ask" as QType }
                : { text: `Wann setzt du ${field} auf ${after}?`, qtype: "exception" as QType },
            { text: `Warum hast du ${field} auf ${after} geändert?`, qtype: "why" as QType },
          ]
        : [{ text: `Why did you change ${field} to ${after}?`, qtype: "why" as QType }];
    const existing = new Set(input.existing_questions);
    return {
      drafts: drafts.filter((d) => !existing.has(d.text)).map((d) => ({ ...d, anchors: [e.event_id] })),
      usage: { input_tokens: 0, output_tokens: 0 },
      model: "template",
    };
  }
}

export class EchoRuleExtractor implements RuleExtractor {
  async extract(input: RuleInput): Promise<RuleResult> {
    return { rule: `Rule (unparsed): ${input.answer}`, usage: { input_tokens: 0, output_tokens: 0 } };
  }
}

function qtypeOf(q: string): QType {
  if (/betrag|ab welchem|limit|threshold|how much/i.test(q)) return "limit";
  if (/freigabe|frag|controller|approval|ask someone/i.test(q)) return "stop_and_ask";
  if (/wann setzt|ausnahme|exception|when do you/i.test(q)) return "exception";
  return "why";
}

function choice(c: string, confidence: number): JevAnswer {
  return { type: "choice", choice: c, confidence, probabilities: { [c]: confidence } };
}
