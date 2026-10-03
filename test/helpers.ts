import { makeEvent, type Bus, type Envelope, type EventHandler, type StreamKey, type StreamPayload, EVENT_TYPES, createLogger } from "@sidekik/contracts";

export const ORG = "00000000-0000-4000-8000-000000000001";
export const SID = "sess-1";

export const silentLogger = () => createLogger("brain", { level: "silent" });

export function ev<K extends StreamKey>(stream: K, t_ms: number, data: StreamPayload<K>, session_id = SID): Envelope<StreamPayload<K>> {
  return makeEvent({ type: EVENT_TYPES[stream], org_id: ORG, session_id, t_ms, producer: "gateway", data });
}

/** In-memory Bus: `deliver` calls the registered handler directly, in order. */
export class FakeBus implements Bus {
  readonly published: { stream: StreamKey; ev: Envelope<unknown> }[] = [];
  private readonly handlers = new Map<StreamKey, EventHandler<StreamKey>>();

  async publish<K extends StreamKey>(stream: K, e: Envelope<StreamPayload<K>>): Promise<string> {
    this.published.push({ stream, ev: e });
    return `${this.published.length}-0`;
  }

  consume<K extends StreamKey>(stream: K, handler: EventHandler<K>): () => void {
    this.handlers.set(stream, handler as unknown as EventHandler<StreamKey>);
    return () => this.handlers.delete(stream);
  }

  async deliver<K extends StreamKey>(stream: K, e: Envelope<StreamPayload<K>>): Promise<void> {
    const h = this.handlers.get(stream);
    if (!h) throw new Error(`no consumer for ${stream}`);
    await h(e as Envelope<StreamPayload<StreamKey>>);
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }
}
