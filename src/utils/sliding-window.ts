/**
 * A true sliding-window event counter.
 * Tracks individual event timestamps and prunes entries older than the window.
 */
export class SlidingWindowCounter {
  private windows = new Map<string, number[]>();

  /**
   * Record one event for `key` and return true if the total count in the last
   * `windowMs` milliseconds (including this event) exceeds `limit`.
   */
  check(key: string, windowMs: number, limit: number): boolean {
    const now = Date.now();
    const timestamps = (this.windows.get(key) ?? []).filter((t) => now - t < windowMs);
    timestamps.push(now);
    this.windows.set(key, timestamps);
    return timestamps.length > limit;
  }

  /** Remove all timestamp history for a specific key. */
  clear(key: string): void {
    this.windows.delete(key);
  }

  /** Remove all timestamp history for all keys. */
  reset(): void {
    this.windows.clear();
  }
}
