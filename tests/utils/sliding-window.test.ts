import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SlidingWindowCounter } from '../../src/utils/sliding-window';

describe('SlidingWindowCounter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows events below the limit', () => {
    const counter = new SlidingWindowCounter();
    expect(counter.check('key', 1000, 3)).toBe(false);
    expect(counter.check('key', 1000, 3)).toBe(false);
    expect(counter.check('key', 1000, 3)).toBe(false);
  });

  it('returns true when the limit is exceeded', () => {
    const counter = new SlidingWindowCounter();
    counter.check('key', 1000, 2);
    counter.check('key', 1000, 2);
    expect(counter.check('key', 1000, 2)).toBe(true); // 3rd event > limit 2
  });

  it('prunes timestamps outside the window', () => {
    const counter = new SlidingWindowCounter();
    // Fill the window with 3 events
    counter.check('key', 1000, 2);
    counter.check('key', 1000, 2);
    counter.check('key', 1000, 2);

    // Advance past the window — old timestamps are pruned
    vi.advanceTimersByTime(1001);

    // New event should not trigger — previous events are gone
    expect(counter.check('key', 1000, 2)).toBe(false);
  });

  it('tracks separate keys independently', () => {
    const counter = new SlidingWindowCounter();
    counter.check('a', 1000, 1);
    counter.check('a', 1000, 1); // 'a' exceeds limit

    // 'b' should be unaffected
    expect(counter.check('b', 1000, 1)).toBe(false);
  });

  it('clear() removes history for a specific key', () => {
    const counter = new SlidingWindowCounter();
    counter.check('key', 1000, 1);
    counter.check('key', 1000, 1);
    counter.clear('key');
    // After clear, first event should not trigger
    expect(counter.check('key', 1000, 1)).toBe(false);
  });

  it('reset() removes all key history', () => {
    const counter = new SlidingWindowCounter();
    // Exceed limit for both keys
    counter.check('a', 1000, 1);
    counter.check('a', 1000, 1); // 2nd event exceeds limit=1
    counter.check('b', 1000, 1);
    counter.check('b', 1000, 1);
    counter.reset();
    // After reset, first event for each key is below limit
    expect(counter.check('a', 1000, 1)).toBe(false);
    expect(counter.check('b', 1000, 1)).toBe(false);
  });

  it('handles a limit of 0 — every event exceeds', () => {
    const counter = new SlidingWindowCounter();
    expect(counter.check('key', 1000, 0)).toBe(true);
  });
});
