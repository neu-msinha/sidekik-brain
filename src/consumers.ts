import {
  eventLogger,
  STREAMS,
  type Bus,
  type Envelope,
  type Logger,
  type ScreenEvent,
  type TranscriptTurn,
} from "@sidekik/contracts";
import type { SessionState, SessionStore } from "./state.js";

/**
 * Extension points for the capture loop, answer handling and off-record.
 * Each is called after the session state has been updated for the event.
 */
export type BrainHooks = {
  onSessionStarted?(state: SessionState): Promise<void>;
  /** Capture ended for good (task_done, phase change, ended): expire leftover candidates. */
  onCaptureStopped?(state: SessionState): Promise<void>;
  onScreenEvent?(state: SessionState, ev: Envelope<ScreenEvent>): Promise<void>;
  onTurn?(state: SessionState, ev: Envelope<TranscriptTurn>): Promise<void>;
  onSpeech?(state: SessionState): Promise<void>;
};

/** Subscribes brain to its four input streams. Returns a function that stops all consumers. */
export function wireConsumers(bus: Bus, store: SessionStore, log: Logger, hooks: BrainHooks = {}): () => void {
  const stops = [
    bus.consume(STREAMS.lifecycle, async (ev) => {
      const elog = eventLogger(log, ev);
      const out = store.applyLifecycle(ev);
      switch (out.kind) {
        case "created":
          elog.info({ kind: out.state.kind, phase: out.state.phase, mode: out.state.mode }, "session started");
          await hooks.onSessionStarted?.(out.state);
          break;
        case "ignored_replay":
          elog.debug({ event: ev.data.event }, "replay session, ignored");
          break;
        case "unknown_session":
          elog.debug({ event: ev.data.event }, "lifecycle for unknown session, ignored");
          break;
        case "updated":
          elog.info({ event: ev.data.event, phase: out.state.phase, off_record: out.state.offRecord }, "session updated");
          if (out.captureStopped) await hooks.onCaptureStopped?.(out.state);
          break;
        case "ended":
          elog.info("session ended");
          await hooks.onCaptureStopped?.(out.state);
          break;
      }
    }),

    bus.consume(STREAMS.speech, async (ev) => {
      const state = store.applySpeech(ev);
      if (state) await hooks.onSpeech?.(state);
    }),

    bus.consume(STREAMS.screen, async (ev) => {
      const state = store.applyScreen(ev);
      if (state) await hooks.onScreenEvent?.(state, ev);
    }),

    bus.consume(STREAMS.turns, async (ev) => {
      const state = store.applyTurn(ev);
      if (state) await hooks.onTurn?.(state, ev);
    }),
  ];
  return () => stops.forEach((stop) => stop());
}
