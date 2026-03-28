import { describe, expect, it, vi } from 'vitest';

import { BotEventBus } from '../src/event-bus';

describe('BotEventBus', () => {
  it('emit/on: listener receives event args', () => {
    const bus = new BotEventBus();
    const fn = vi.fn();
    bus.on('bot:disconnected', fn);
    bus.emit('bot:disconnected', 'ping timeout');
    expect(fn).toHaveBeenCalledWith('ping timeout');
  });

  it('once: listener fires exactly once', () => {
    const bus = new BotEventBus();
    const fn = vi.fn();
    bus.once('bot:connected', fn);
    bus.emit('bot:connected');
    bus.emit('bot:connected');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('off: removes a listener', () => {
    const bus = new BotEventBus();
    const fn = vi.fn();
    bus.on('bot:connected', fn);
    bus.off('bot:connected', fn);
    bus.emit('bot:connected');
    expect(fn).not.toHaveBeenCalled();
  });

  it('off: only removes the specified listener', () => {
    const bus = new BotEventBus();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    bus.on('bot:connected', fn1);
    bus.on('bot:connected', fn2);
    bus.off('bot:connected', fn1);
    bus.emit('bot:connected');
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it('once: listener can be removed before firing', () => {
    const bus = new BotEventBus();
    const fn = vi.fn();
    bus.once('bot:connected', fn);
    bus.off('bot:connected', fn);
    bus.emit('bot:connected');
    expect(fn).not.toHaveBeenCalled();
  });
});
