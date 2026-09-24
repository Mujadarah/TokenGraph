export class KeyedOperationQueue {
  readonly #chains = new Map<string, Promise<void>>();

  get pendingKeyCount(): number {
    return this.#chains.size;
  }

  async enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(key) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    let settled!: Promise<void>;
    const cleanUp = () => {
      if (this.#chains.get(key) === settled) this.#chains.delete(key);
    };
    settled = current.then(cleanUp, cleanUp);
    this.#chains.set(key, settled);
    return current;
  }
}
