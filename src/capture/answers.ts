import { sessionLogger, type Envelope, type Logger, type TranscriptTurn } from "@sidekik/contracts";
import type { Decider } from "../decide/decider.js";
import type { Thresholds } from "../decide/thresholds.js";
import type { RuleExtractor } from "../rules.js";
import type { SessionState } from "../state.js";
import type { SessionQueue } from "./queue.js";
import type { CaptureRepo } from "./repo.js";

export type AnswerHandlerDeps = {
  decider: Decider;
  rules?: RuleExtractor;
  repo: CaptureRepo;
  queue: SessionQueue;
  log: Logger;
  thresholds: Thresholds;
};

/**
 * DESIGN §3 answer handling: the first user turn after an `ask` is the answer.
 * D5 classifies it; the verbatim quote is stored; a numeric/date condition gets its rule text extracted.
 */
export class AnswerHandler {
  constructor(private readonly d: AnswerHandlerDeps) {}

  async onTurn(state: SessionState, ev: Envelope<TranscriptTurn>): Promise<void> {
    const pending = state.capture.awaitingAnswer;
    if (ev.data.role !== "user" || !pending || ev.t_ms < pending.asked_t_ms) return;
    // Claim it now so a second turn arriving during D5 isn't treated as another answer.
    state.capture.awaitingAnswer = undefined;
    void this.d.queue.run(state.session_id, () => this.handle(state, pending, ev));
  }

  private async handle(state: SessionState, q: NonNullable<SessionState["capture"]["awaitingAnswer"]>, ev: Envelope<TranscriptTurn>): Promise<void> {
    const log = sessionLogger(this.d.log, state).child({ event_id: ev.id, question_id: q.question_id });
    const answer = ev.data.text;
    const out = await this.d.decider.decide(
      [{ id: "D5", state: { question: q.text, question_type: q.qtype, answer, language: ev.data.lang } }],
      { session_id: state.session_id, org_id: state.org_id, t_ms: ev.t_ms },
      { escalate: true },
    );
    const content = out.D5?.questions.content_class;
    const cond = out.D5?.questions.has_numeric_or_date_condition;
    const contentClass = content && content.band !== "default" ? String(content.answer) : "neither";
    const hasCondition = (cond?.p_true ?? 0) >= this.d.thresholds.hasCondition;

    let rule: string | null = null;
    if (hasCondition && this.d.rules) {
      try {
        const lastScreen = state.screen.recent.at(-1);
        rule = (await this.d.rules.extract({ language: ev.data.lang, question: q.text, answer, ...(lastScreen ? { screen_state: lastScreen } : {}) })).rule;
      } catch (err) {
        log.warn({ err }, "rule extraction failed; answer stored without rule");
      }
    }

    await this.d.repo.insertAnswer({
      org_id: state.org_id,
      session_id: state.session_id,
      question_id: q.question_id,
      turn_ids: [ev.data.turn_id],
      content_class: contentClass,
      quote: answer,
      has_condition: hasCondition,
      extracted_rule: rule,
    });
    await this.d.repo.setStatus([q.question_id], "answered");
    log.info({ content_class: contentClass, has_condition: hasCondition, rule }, "answer stored");
  }
}
