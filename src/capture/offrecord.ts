import { sessionLogger, type Envelope, type Logger, type TranscriptTurn } from "@sidekik/contracts";
import type { Decider } from "../decide/decider.js";
import type { Thresholds } from "../decide/thresholds.js";
import type { SessionState } from "../state.js";
import type { GatewayClient } from "./gateway.js";

/** DESIGN D7 prefilter: only turns that mention recording reach Jev. */
export const OFF_RECORD_PATTERN =
  /off[\s-]the[\s-]record|inoffiziell|nicht aufnehmen|stop(?:p)? (?:the )?recording|nicht mitschneiden|aufnahme (?:stoppen|anhalten|pausieren)/i;
export const BACK_ON_RECORD_PATTERN =
  /back on (?:the )?record|resume recording|wieder aufnehmen|weiter aufnehmen|aufnahme (?:fortsetzen|wieder)|you can record again/i;

export type OffRecordDeps = { decider: Decider; gateway: GatewayClient; log: Logger; thresholds: Thresholds };

/**
 * DESIGN D7: regex prefilter, then Jev; at ≥ 0.5 brain calls the gateway, which owns off-record state.
 * Runs inline (not queued) on every user turn: going off record is the most urgent thing brain does.
 */
export class OffRecordWatcher {
  constructor(private readonly d: OffRecordDeps) {}

  async onTurn(state: SessionState, ev: Envelope<TranscriptTurn>): Promise<void> {
    if (ev.data.role !== "user") return;
    const text = ev.data.text;
    if (!OFF_RECORD_PATTERN.test(text) && !BACK_ON_RECORD_PATTERN.test(text)) return;

    const log = sessionLogger(this.d.log, state).child({ event_id: ev.id });
    const out = await this.d.decider.decide(
      [{ id: "D7", state: { utterance: text, currently_off_record: state.offRecord } }],
      { session_id: state.session_id, org_id: state.org_id, t_ms: ev.t_ms },
    );
    const off = out.D7?.questions.off_record_request?.p_true ?? 0;
    const back = out.D7?.questions.back_on_record?.p_true ?? 0;
    const t = this.d.thresholds.offRecord;

    if (!state.offRecord && off >= t) {
      // Stop asking right away; the gateway's offrecord_on lifecycle event confirms it.
      state.offRecord = true;
      try {
        await this.d.gateway.setOffRecord(state.session_id, true, ev.t_ms);
      } catch (err) {
        // The gateway owns off-record; if it didn't take it, don't stay silently paused.
        state.offRecord = false;
        throw err;
      }
      log.info({ p: off }, "off-record requested");
    } else if (state.offRecord && back >= t) {
      await this.d.gateway.setOffRecord(state.session_id, false, ev.t_ms);
      log.info({ p: back }, "back on record requested");
    } else {
      log.debug({ off, back }, "D7: no change");
    }
  }
}
