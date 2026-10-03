/** The gateway calls brain makes (ARCHITECTURE §4.3). Behind an interface so dev:mock runs without the gateway. */
export interface GatewayClient {
  setOffRecord(sessionId: string, on: boolean, t_ms: number): Promise<void>;
}

export class HttpGatewayClient implements GatewayClient {
  constructor(
    private readonly baseUrl: string,
    private readonly internalToken: string,
    private readonly timeoutMs = 1000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async setOffRecord(sessionId: string, on: boolean, t_ms: number): Promise<void> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/internal/sessions/${encodeURIComponent(sessionId)}/off-record`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": this.internalToken },
      body: JSON.stringify({ on, source: "brain", t_ms }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`gateway off-record: HTTP ${res.status}`);
  }
}

/** Records calls instead of making them (tests, dev:mock). */
export class RecordingGatewayClient implements GatewayClient {
  readonly calls: { sessionId: string; on: boolean; t_ms: number }[] = [];

  async setOffRecord(sessionId: string, on: boolean, t_ms: number): Promise<void> {
    this.calls.push({ sessionId, on, t_ms });
  }
}
