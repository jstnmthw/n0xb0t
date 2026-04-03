// HexBot — Message queue with flood protection
// Integer-millisecond token bucket rate limiter for outgoing IRC messages.
// Sits between the bot's say/notice/action methods and the IRC client to
// prevent excess-flood disconnects.
//
// Uses integer millisecond arithmetic to avoid floating-point drift that
// caused tokens to leak below threshold over many rapid enqueue() calls.
import type { Logger } from '../logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MessageQueueOptions {
  /** Max messages per second (steady-state). Default: 2 */
  rate?: number;
  /** Burst allowance — messages that can send immediately before throttling. Default: 4 */
  burst?: number;
  /** Logger instance */
  logger?: Logger | null;
}

// ---------------------------------------------------------------------------
// MessageQueue
// ---------------------------------------------------------------------------

export class MessageQueue {
  private static readonly MAX_DEPTH = 500;
  private readonly queue: Array<() => void> = [];
  /** Budget in milliseconds. Each message costs `costMs`. Integer arithmetic only. */
  private budgetMs: number;
  private lastRefill: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly rate: number;
  private readonly burst: number;
  /** Millisecond cost per message: floor(1000 / rate). */
  private readonly costMs: number;
  /** Maximum budget in milliseconds: burst * costMs. */
  private readonly capacityMs: number;
  private readonly logger: Logger | null;

  constructor(options: MessageQueueOptions = {}) {
    this.rate = options.rate ?? 2;
    this.burst = options.burst ?? 4;
    this.costMs = Math.floor(1000 / this.rate);
    // Capacity must allow at least 1 message so drain() can always accumulate enough budget
    this.capacityMs = Math.max(this.costMs, this.burst * this.costMs);
    this.budgetMs = this.burst * this.costMs;
    this.lastRefill = Date.now();
    this.logger = options.logger ?? null;

    this.start();
  }

  /** Number of messages waiting in the queue. */
  get pending(): number {
    return this.queue.length;
  }

  /** Push a send operation onto the queue. Sends immediately if budget allows. */
  enqueue(fn: () => void): void {
    this.refill();

    if (this.budgetMs >= this.costMs) {
      this.budgetMs -= this.costMs;
      fn();
      return;
    }

    if (this.queue.length >= MessageQueue.MAX_DEPTH) {
      this.logger?.warn(
        `Message queue full (${MessageQueue.MAX_DEPTH}), dropping outgoing message`,
      );
      return;
    }

    this.queue.push(fn);
  }

  /** Send all queued messages immediately (for graceful shutdown). */
  flush(): void {
    while (this.queue.length > 0) {
      const fn = this.queue.shift()!;
      fn();
    }
  }

  /** Discard all queued messages (for reconnect). */
  clear(): void {
    const dropped = this.queue.length;
    this.queue.length = 0;
    this.budgetMs = this.capacityMs;
    this.lastRefill = Date.now();
    if (dropped > 0) {
      this.logger?.debug(`Message queue cleared, ${dropped} messages dropped`);
    }
  }

  /** Stop the drain timer. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Start (or restart) the drain timer. */
  private start(): void {
    this.stop();
    this.timer = setInterval(() => this.drain(), this.costMs);
    // Don't keep the process alive just for the queue timer
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
  }

  /** Add elapsed milliseconds to the budget. Integer arithmetic, no floats. */
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed > 0) {
      this.budgetMs = Math.min(this.capacityMs, this.budgetMs + elapsed);
      this.lastRefill = now;
    }
  }

  /** Drain one message from the queue if budget allows. */
  private drain(): void {
    if (this.queue.length === 0) return;

    this.refill();

    if (this.budgetMs >= this.costMs) {
      this.budgetMs -= this.costMs;
      const fn = this.queue.shift()!;
      fn();
    }
  }
}
