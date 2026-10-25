/**
 * Clock seam. Production uses the real one; tests inject FakeClock, whose time moves only when advance() is called,
 * so reconnect backoff schedules and stall timeouts are asserted exactly instead of slept through.
 */
export const realClock = {
  now: () => Date.now(),
  /** @param {() => void} fn @param {number} ms */
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  /** @param {any} h */
  clearTimeout: (h) => clearTimeout(h),
};

const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };

export class FakeClock {
  #t;
  #seq = 0;
  /** @type {{ id: number, due: number, fn: () => void }[]} */
  #timers = [];
  /** @param {number} [start] */
  constructor(start = 1_700_000_000_000) { this.#t = start; }
  now() { return this.#t; }
  /** @param {() => void} fn @param {number} ms */
  setTimeout(fn, ms) {
    const id = ++this.#seq;
    this.#timers.push({ id, due: this.#t + Math.max(0, ms), fn });
    return id;
  }
  /** @param {any} id */
  clearTimeout(id) { this.#timers = this.#timers.filter((t) => t.id !== id); }
  get pending() { return this.#timers.length; }
  /**
   * Move time forward, firing due timers in order and letting their async work settle between them.
   * @param {number} ms
   */
  async advance(ms) {
    const target = this.#t + ms;
    await settle();
    for (;;) {
      const next = this.#timers.filter((t) => t.due <= target).sort((a, b) => a.due - b.due || a.id - b.id)[0];
      if (!next) break;
      this.#timers = this.#timers.filter((t) => t.id !== next.id);
      this.#t = Math.max(this.#t, next.due);
      next.fn();
      await settle();
    }
    this.#t = target;
    await settle();
  }
}
