// Per-session serial queue: events of one session (the lead and all of its parallel subagents
// share a session_id) run one at a time in arrival order; different sessions run concurrently.

export class SessionQueue {
  #tails = new Map<string, Promise<void>>();

  run<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.#tails.get(key) ?? Promise.resolve();
    const result = prev.then(fn);
    const tail = result.then(() => undefined, () => undefined);
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return result;
  }

  /** Resolves when every queued task (including ones queued while waiting) has finished. */
  async drain(): Promise<void> {
    while (this.#tails.size) await Promise.all([...this.#tails.values()]);
  }

  get size(): number {
    return this.#tails.size;
  }
}
