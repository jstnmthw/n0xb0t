import { describe, expect, it, vi } from 'vitest';

import type {
  RelayDCCView,
  RelayHandlerDeps,
  RelaySessionMap,
} from '../../src/core/botlink-relay-handler';
import { handleRelayFrame } from '../../src/core/botlink-relay-handler';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createDeps(overrides?: Partial<RelayHandlerDeps>): RelayHandlerDeps {
  return {
    permissions: {
      getUser: (handle: string) => ({ hostmasks: [`${handle}!user@host`] }),
    },
    commandHandler: { execute: vi.fn().mockResolvedValue(undefined) },
    dccManager: {
      getSessionList: () => [],
      getSession: () => undefined,
      announce: vi.fn(),
    },
    botname: 'testbot',
    sender: { sendTo: vi.fn().mockReturnValue(true), send: vi.fn() },
    stripFormatting: (t: string) => t,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleRelayFrame', () => {
  it('ignores non-RELAY frames', () => {
    const deps = createDeps();
    const sessions: RelaySessionMap = new Map();
    handleRelayFrame({ type: 'PARTY_CHAT' }, deps, sessions);
    expect(sessions.size).toBe(0);
    expect(deps.sender.send).not.toHaveBeenCalled();
  });

  describe('RELAY_REQUEST', () => {
    it('creates a virtual session and sends RELAY_ACCEPT', () => {
      const deps = createDeps();
      const sessions: RelaySessionMap = new Map();
      handleRelayFrame(
        { type: 'RELAY_REQUEST', handle: 'alice', fromBot: 'leafbot' },
        deps,
        sessions,
      );
      expect(sessions.has('alice')).toBe(true);
      expect(deps.sender.sendTo).toHaveBeenCalledWith('leafbot', {
        type: 'RELAY_ACCEPT',
        handle: 'alice',
        toBot: 'testbot',
      });
    });

    it('rejects if user not found in permissions', () => {
      const deps = createDeps({ permissions: { getUser: () => null } });
      const sessions: RelaySessionMap = new Map();
      handleRelayFrame(
        { type: 'RELAY_REQUEST', handle: 'unknown', fromBot: 'leafbot' },
        deps,
        sessions,
      );
      expect(sessions.has('unknown')).toBe(false);
      expect(deps.sender.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'RELAY_END', handle: 'unknown' }),
      );
    });

    it('does nothing without dccManager', () => {
      const deps = createDeps({ dccManager: null });
      const sessions: RelaySessionMap = new Map();
      handleRelayFrame(
        { type: 'RELAY_REQUEST', handle: 'alice', fromBot: 'leafbot' },
        deps,
        sessions,
      );
      expect(sessions.size).toBe(0);
    });
  });

  describe('RELAY_INPUT', () => {
    it('routes dot-commands through commandHandler', async () => {
      const deps = createDeps();
      const sessions: RelaySessionMap = new Map();
      sessions.set('alice', { fromBot: 'leafbot', sendOutput: vi.fn() });

      handleRelayFrame({ type: 'RELAY_INPUT', handle: 'alice', line: '.status' }, deps, sessions);

      // Wait for the async execute call
      await vi.waitFor(() => {
        expect(deps.commandHandler.execute).toHaveBeenCalledWith(
          '.status',
          expect.objectContaining({ source: 'botlink', nick: 'alice' }),
        );
      });
    });

    it('broadcasts plain text as party line chat', () => {
      const deps = createDeps();
      const sendOutput = vi.fn();
      const sessions: RelaySessionMap = new Map();
      sessions.set('alice', { fromBot: 'leafbot', sendOutput });

      handleRelayFrame(
        { type: 'RELAY_INPUT', handle: 'alice', line: 'hello everyone' },
        deps,
        sessions,
      );

      expect((deps.dccManager as RelayDCCView).announce).toHaveBeenCalledWith(
        '<alice@relay> hello everyone',
      );
      expect(sendOutput).toHaveBeenCalledWith('<alice> hello everyone');
    });

    it('ignores input for unknown session', () => {
      const deps = createDeps();
      const sessions: RelaySessionMap = new Map();
      handleRelayFrame({ type: 'RELAY_INPUT', handle: 'nobody', line: 'hi' }, deps, sessions);
      expect(deps.commandHandler.execute).not.toHaveBeenCalled();
    });
  });

  describe('RELAY_OUTPUT', () => {
    it('writes output to matching DCC session', () => {
      const writeLine = vi.fn();
      const deps = createDeps({
        dccManager: {
          getSessionList: () => [{ handle: 'alice', nick: 'Alice', connectedAt: 0 }],
          getSession: () => ({ writeLine, isRelaying: true, exitRelay: vi.fn() }),
          announce: vi.fn(),
        },
      });
      const sessions: RelaySessionMap = new Map();

      handleRelayFrame(
        { type: 'RELAY_OUTPUT', handle: 'alice', line: 'response text' },
        deps,
        sessions,
      );

      expect(writeLine).toHaveBeenCalledWith('response text');
    });

    it('does nothing without dccManager', () => {
      const deps = createDeps({ dccManager: null });
      const sessions: RelaySessionMap = new Map();
      handleRelayFrame({ type: 'RELAY_OUTPUT', handle: 'alice', line: 'text' }, deps, sessions);
      // No error thrown
    });
  });

  describe('RELAY_END', () => {
    it('removes virtual session', () => {
      const deps = createDeps();
      const sessions: RelaySessionMap = new Map();
      sessions.set('alice', { fromBot: 'leafbot', sendOutput: vi.fn() });

      handleRelayFrame({ type: 'RELAY_END', handle: 'alice', reason: 'done' }, deps, sessions);

      expect(sessions.has('alice')).toBe(false);
    });

    it('exits relay mode on DCC session if relaying', () => {
      const exitRelay = vi.fn();
      const writeLine = vi.fn();
      const deps = createDeps({
        dccManager: {
          getSessionList: () => [{ handle: 'alice', nick: 'Alice', connectedAt: 0 }],
          getSession: () => ({ writeLine, isRelaying: true, exitRelay }),
          announce: vi.fn(),
        },
      });
      const sessions: RelaySessionMap = new Map();

      handleRelayFrame(
        { type: 'RELAY_END', handle: 'alice', reason: 'disconnected' },
        deps,
        sessions,
      );

      expect(exitRelay).toHaveBeenCalled();
      expect(writeLine).toHaveBeenCalledWith('*** Relay to disconnected lost.');
    });

    it('does not exit relay if session is not relaying', () => {
      const exitRelay = vi.fn();
      const deps = createDeps({
        dccManager: {
          getSessionList: () => [{ handle: 'alice', nick: 'Alice', connectedAt: 0 }],
          getSession: () => ({
            writeLine: vi.fn(),
            isRelaying: false,
            exitRelay,
          }),
          announce: vi.fn(),
        },
      });
      const sessions: RelaySessionMap = new Map();

      handleRelayFrame({ type: 'RELAY_END', handle: 'alice' }, deps, sessions);

      expect(exitRelay).not.toHaveBeenCalled();
    });
  });

  describe('RELAY_OUTPUT from virtual session sendOutput', () => {
    it('session sendOutput sends RELAY_OUTPUT frame to originating bot', () => {
      const deps = createDeps();
      const sessions: RelaySessionMap = new Map();

      handleRelayFrame(
        { type: 'RELAY_REQUEST', handle: 'bob', fromBot: 'remoteleaf' },
        deps,
        sessions,
      );

      const vs = sessions.get('bob')!;
      vs.sendOutput('hello from remote');

      expect(deps.sender.sendTo).toHaveBeenCalledWith('remoteleaf', {
        type: 'RELAY_OUTPUT',
        handle: 'bob',
        line: 'hello from remote',
      });
    });
  });
});
