/**
 * Runs async work one task at a time per session, in submission order, without
 * blocking the bus consumer that submitted it. Failures are reported, never thrown.
 */
export class SessionQueue {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly onError: (sessionId: string, err: unknown) => void) {}

  run(sessionId: string, task: () => Promise<void>): Promise<void> {
    const prev = this.tails.get(sessionId) ?? Promise.resolve();
    const next = prev.then(task).catch((err: unknown) => this.onError(sessionId, err));
    this.tails.set(sessionId, next);
    void next.then(() => {
      if (this.tails.get(sessionId) === next) this.tails.delete(sessionId);
    });
    return next;
  }

  /** Resolves when everything queued so far has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.tails.size > 0) await Promise.all([...this.tails.values()]);
  }
}
