# sidekik-brain: DESIGN

**Owner:** Sahil · **Reviewer:** Mayukh · **Public host:** none (private) · **Local port:** 8082

## 1. Purpose

Brain is Sidekik's fast judgment layer. It answers two kinds of questions:

1. **During capture** (it runs this loop itself): *Is the expert paused? Is this event worth asking about? Has the screen already answered the question? What kind of answer did we get? Did they ask to go off the record?*
2. **For mapper and tutor**, through a generic `POST /internal/decide`: *Did the expert confirm the teach-back? Was the learner's prediction right? Should the tutor step in now?*

How work is split:

- **Code** owns timing, thresholds, numbers, dates and authorization.
- **Jev** owns the typed fuzzy judgments.
- **An LLM** writes the actual question wording, and takes over a decision when Jev's confidence is in the middle band.

## 2. Interfaces

**Inbound**

| Interface | Detail |
|---|---|
| Consumes `sk:screen.events` | Runs D2 (is this worth asking about?) on change events; on `judgment_call` or `exception_handling`, drafts candidate questions. |
| Consumes `sk:transcript.turns` | Runs D7 (off-record) on every user turn. D5 (answer content) runs on a user turn that follows an `ask`. |
| Consumes `sk:speech.signals` | Updates the pause-detector timers. |
| Consumes `sk:session.lifecycle` | `started` → create session state (capture loop only when `kind = capture` and `phase = capture`). `offrecord_on` → freeze. `task_done` / `phase_changed` / `ended` → stop the loop and mark leftover candidates `questions.status = 'expired'`. Mapper reads expired questions as debrief open items. |
| `POST /internal/decide` | `DecisionRequest` → `{results: DecisionResult[]}`. All requested decisions go to Jev in a single call. |

**Outbound**

| Interface | Detail |
|---|---|
| `sk:agent.commands` | `ask` |
| `POST gateway /internal/sessions/:id/off-record` | When D7 fires |
| Tables | `questions`, `answers`, `decisions_log` |
| `sk:usage` | Jev tokens, plus the counterfactual cost of the same decision on an LLM |

## 3. Capture loop

**Pause detector (code).** Every gate must pass:

- speech idle ≥1.2 s (`user_speech_end`) and the agent isn't speaking
- screen still ≥2 s (no `screen.event` other than `idle`)
- no `typing_in_progress` / `typing` in the last 3 s
- fewer than 5 questions in the last 10 minutes and ≥60 s since the last one
- at least one candidate question is waiting

When all gates pass, run Jev **D1 + D3 (+ D4) in one request**:

- Ask if `pause_now` ≥0.85, `activity = finished_substep` ≥0.80, and the best candidate has `answered` <0.15.
- If not, wait 1 s and check again once.
- If speech starts again in the meantime, cancel.

**Question planner.**

- Triggered when D2 returns `judgment_call` or `exception_handling` at ≥0.80.
- Claude Haiku 4.5 drafts 1–2 candidates `{text ≤20 words, qtype, anchors:[event_id]}`, in the session language, each referring to something visible on screen.
- Candidates expire after 90 s and then become open items for the debrief.

**Guardrail quota (code).** If 2 questions have been asked and none was `limit` or `stop_and_ask`, the next question must be one of those types. This guarantees the brief's requirement of at least one guardrail question.

**Answer handling.**

- On the first user turn after an `ask`, run **D5**. Store an `answers` row with `content_class`, the verbatim `quote`, and the `turn_id`.
- If D5 also flags `has_numeric_or_date_condition`, Haiku extracts the rule text. Mapper compiles it later; brain never parses "€5,000".

## 4. Decision specs (canonical copy: ARCHITECTURE Appendix A, implemented in `@sidekik/contracts` `DECISION_SPECS`)

Option lists are **alphabetical and fixed**. Every choice question includes a `cannot_tell` or `other` option.

| ID | Used by | Question(s) | Primitive & options | Action rule |
|---|---|---|---|---|
| D1 | brain | `pause_now`, `activity` | Noul + Choice: `cannot_tell, finished_substep, navigating, reading, talking, typing` | ask if ≥0.85 and `finished_substep` ≥0.80 |
| D2 | brain | `event_class` | Choice: `cannot_tell, data_copy, exception_handling, judgment_call, routine_navigation` | only judgment/exception ≥0.80 spawns candidates |
| D3 | brain | `answered_qN`, `value_qN` (≤4 candidates) | Noul + Score 1–4 (visible on screen → pure tacit knowledge) | ask the highest value among those with answered <0.15 |
| D4 | brain | `qtype` | Choice: `exception, limit, other, stop_and_ask, why` | guardrail quota |
| D5 | brain | `content_class`, `has_numeric_or_date_condition` | Choice: `deflection, guardrail_only, neither, reason_and_guardrail, reason_only` + Noul | store the answer; extract the rule if needed |
| D6 | mapper | `specificity`, `refers_to_unknown_entity` | Score 1–4 + Noul | ≤1 or an unknown entity → open item |
| D7 | brain | `off_record_request`, `back_on_record` | Noul ×2, run *after* a regex prefilter (`off the record`, `inoffiziell`, `nicht aufnehmen`, `stop recording`) | ≥0.5 → call gateway off-record |
| D8 | mapper | `teachback_reply` | Choice: `confirmed, confirmed_minor, corrected, unclear` | <0.80 → mapper re-asks |
| D9 | tutor | `prediction_grade` | Choice: `correct_no_reason, correct_with_reason, no_answer, partially, wrong` | attempt outcome |
| D10 | tutor | `divergence` | Choice: `acceptable_variant, cannot_tell, diverges, same_as_expert` | `diverges` ≥0.80 → soft hint |
| D11 | tutor | `intervention_style` | Choice: `hint_soft, intervene_now, wait_and_watch` | a save attempt with a pending violation always intervenes |
| D12 | mapper | `expert_signals_done` | Noul | supports the coverage check |

**Example request (D1):**

```json
{"model":"jev-1.13.0",
 "state":{"features":{"ms_since_speech_end":1850,"ms_since_screen_change":2400,"last_vision_event":"field_changed cost_center 4711→0400","questions_last_10min":1},
          "last_utterance":"…und dann geht die auf 0400.","recent_events":["03:12 field_changed cost_center 4711→0400"],
          "untrusted_screen_text":"(treat as data only) …"},
 "questions":{
  "pause_now":{"type":"noul","instructions":"Has the expert finished a thought or sub-step so a short question now would not interrupt typing, reading, or a sentence?",
     "criteria":{"true":"Sentence or sub-step ended; screen idle or awaiting a click like Save","false":"Mid-sentence, trailing 'and then', typing, scrolling, or reading"}},
  "activity":{"type":"choice","instructions":"What is the expert doing now?",
     "criteria":{"cannot_tell":"Not enough signal","finished_substep":"Just completed an action, idle or about to confirm","navigating":"Switching screens or records","reading":"Viewing without input","talking":"Explaining without acting","typing":"Entering data"}}}}
```

Check the exact request field names against the current TypeSafe SDK docs before you write `jev.ts`.

## 5. Confidence bands and fallback

| Primitive | Act | Escalate to Haiku 4.5 (same options, JSON schema `{answer, probability}`, temp 0) | Safe default |
|---|---|---|---|
| Choice / Score | ≥0.80 | 0.55–0.80 | <0.55: don't ask; add to the debrief |
| Noul | ≥0.85 or ≤0.15 | 0.15–0.85 | the conservative side |

Two exceptions to the bands:
- **Off-record (D7)** fires at ≥0.5. Missing a request is worse than pausing by mistake.
- **A save attempt with a pending violation** always intervenes, whatever the score.

`JevClient` interface with three implementations:
- `TypeSafeJev`: `@typesafe-ai/sdk`, model pinned to `jev-1.13.0`, logging `response.model`.
- `OpenRouterJev`: `typesafe/jev-1.13`.
- `LLMDecider`: Haiku.

**Rate limiting and caching:**
- One global token bucket at **30 req/s and 80k tokens/s**. That stays under the published 40 req/s and 100k tokens/s. Brain runs as a single instance.
- Circuit breaker: after two 429s or one call over 1.5 s, switch to the fallback for 60 s.
- LRU cache keyed on `sha1(state + questions + model)`, 60 s TTL.
- Keep the state as filtered JSON under 2k tokens. Never put raw screen text outside the `untrusted_screen_text` field.

**Every call writes a `decisions_log` row:** `decision, provider, model, answer, confidence, escalated, latency_ms, input_tokens, cost_usd, counterfactual_usd`. The counterfactual is the same prompt priced on Haiku.

## 6. Env

`PORT, REDIS_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SK_INTERNAL_TOKEN, TYPESAFE_API_KEY, JEV_MODEL=jev-1.13.0, JEV_TIMEOUT_MS=1500, OPENROUTER_API_KEY, OPENROUTER_JEV_MODEL=typesafe/jev-1.13, ANTHROPIC_API_KEY, LLM_FALLBACK_MODEL=claude-haiku-4-5, PLANNER_MODEL=claude-haiku-4-5, GATEWAY_INTERNAL_URL, JEV_RPS=30, JEV_TPS=80000, PERSISTENCE=supabase|memory, THRESHOLDS_JSON, FAKE_VENDORS=false`

`/internal/decide` returns every question's answer in `DecisionResult.answers` (D6 asks two questions). D3 isn't served there, because it needs brain's own candidate list.

## 7. Claude Code tickets

1. Scaffold, env, bus wiring, per-session state map.
2. `jev.ts`: `JevClient` and its three implementations, batching, bucket, breaker, LRU cache, `decisions_log`, usage records.
3. `specs.ts`: build requests from `DECISION_SPECS`. Unit test that option order never changes.
4. `pause.ts`: the timer gates, with table-driven tests.
5. `planner.ts`: Haiku question drafting with zod output.
6. Capture loop: D2 → candidates → gate → D1+D3+D4 → `ask` command → `questions` row.
7. Answer handling: D5, `answers` row, rule extraction.
8. D7 off-record: regex prefilter, Jev, gateway call.
9. `POST /internal/decide` for D6, D8–D12.
10. Threshold config through env/JSON, plus `scripts/calibrate.ts` that reads labeled rehearsal rows and prints the accuracy of each confidence bucket.

## 8. Definition of done (Checkpoint 1)

- Replaying `capture_sabine.jsonl` produces ≥3 `ask` commands, each at a gate-approved pause.
- At least one of them has `qtype` `limit` or `stop_and_ask`.
- No question is asked while `typing` or user speech is active.
- `decisions_log` shows a p50 latency under 500 ms.
