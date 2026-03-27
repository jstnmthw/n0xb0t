import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandHandler } from '../../src/command-handler';
import type { CommandContext } from '../../src/command-handler';
import { ChannelSettings } from '../../src/core/channel-settings';
import { registerChannelCommands } from '../../src/core/commands/channel-commands';
import { Permissions } from '../../src/core/permissions';
import { BotDatabase } from '../../src/database';

function makeCtx(
  overrides?: Partial<CommandContext>,
): CommandContext & { reply: Mock<(msg: string) => void> } {
  const reply = vi.fn<(msg: string) => void>();
  return {
    source: 'repl',
    nick: 'admin',
    ident: 'admin',
    hostname: 'localhost',
    channel: null,
    reply,
    ...overrides,
  } as unknown as CommandContext & { reply: Mock<(msg: string) => void> };
}

describe('channel-commands', () => {
  let db: BotDatabase;
  let cs: ChannelSettings;
  let handler: CommandHandler;
  let permissions: Permissions;

  beforeEach(() => {
    db = new BotDatabase(':memory:');
    db.open();
    cs = new ChannelSettings(db);
    permissions = new Permissions(db);
    // Add an op user for IRC permission checks
    permissions.addUser('admin', '*!admin@localhost', 'o', 'test');
    handler = new CommandHandler(permissions);
    registerChannelCommands(handler, cs);

    // Register some test defs
    cs.register('testplugin', [
      {
        key: 'protect_topic',
        type: 'flag',
        default: false,
        description: 'Restore topic if changed',
      },
      { key: 'greet_msg', type: 'string', default: 'Welcome!', description: 'Join greeting' },
      { key: 'max_lines', type: 'int', default: 5, description: 'Max flood lines' },
    ]);
  });

  // ---------------------------------------------------------------------------
  // .chanset — flag operations
  // ---------------------------------------------------------------------------

  describe('.chanset flag operations', () => {
    it('+key sets flag to true', async () => {
      const ctx = makeCtx();
      await handler.execute('.chanset #test +protect_topic', ctx);
      expect(cs.get('#test', 'protect_topic')).toBe(true);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('ON'));
    });

    it('-key unsets the flag (reverts to default)', async () => {
      cs.set('#test', 'protect_topic', true);
      const ctx = makeCtx();
      await handler.execute('.chanset #test -protect_topic', ctx);
      expect(cs.isSet('#test', 'protect_topic')).toBe(false);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('reverted'));
    });

    it('+key on non-flag def → type error reply', async () => {
      const ctx = makeCtx();
      await handler.execute('.chanset #test +greet_msg', ctx);
      expect(cs.isSet('#test', 'greet_msg')).toBe(false);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('string settings'));
    });

    it('key value on flag def → type error reply', async () => {
      const ctx = makeCtx();
      await handler.execute('.chanset #test protect_topic true', ctx);
      expect(cs.isSet('#test', 'protect_topic')).toBe(false);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('+protect_topic'));
    });
  });

  // ---------------------------------------------------------------------------
  // .chanset — string operations
  // ---------------------------------------------------------------------------

  describe('.chanset string operations', () => {
    it('key value stores the string', async () => {
      const ctx = makeCtx();
      await handler.execute('.chanset #test greet_msg Hello {nick}!', ctx);
      expect(cs.get('#test', 'greet_msg')).toBe('Hello {nick}!');
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Hello {nick}!'));
    });

    it('key (no value) shows current value', async () => {
      cs.set('#test', 'greet_msg', 'Custom greeting');
      const ctx = makeCtx();
      await handler.execute('.chanset #test greet_msg', ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Custom greeting'));
    });

    it('key (no value) shows default when not set', async () => {
      const ctx = makeCtx();
      await handler.execute('.chanset #test greet_msg', ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('default'));
    });
  });

  // ---------------------------------------------------------------------------
  // .chanset — int operations
  // ---------------------------------------------------------------------------

  describe('.chanset int operations', () => {
    it('key value stores integer', async () => {
      const ctx = makeCtx();
      await handler.execute('.chanset #test max_lines 10', ctx);
      expect(cs.get('#test', 'max_lines')).toBe(10);
    });

    it('non-integer value → error reply', async () => {
      const ctx = makeCtx();
      await handler.execute('.chanset #test max_lines notanumber', ctx);
      expect(cs.isSet('#test', 'max_lines')).toBe(false);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('not a valid integer'));
    });
  });

  // ---------------------------------------------------------------------------
  // .chanset — error cases
  // ---------------------------------------------------------------------------

  describe('.chanset error cases', () => {
    it('missing channel → usage error', async () => {
      const ctx = makeCtx();
      await handler.execute('.chanset', ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Usage'));
    });

    it('non-channel arg → usage error', async () => {
      const ctx = makeCtx();
      await handler.execute('.chanset notachannel +protect_topic', ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Usage'));
    });

    it('unknown key → unknown setting reply', async () => {
      const ctx = makeCtx();
      await handler.execute('.chanset #test unknown_key', ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Unknown setting'));
    });

    it('missing key arg → usage error', async () => {
      const ctx = makeCtx();
      await handler.execute('.chanset #test', ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Usage'));
    });
  });

  // ---------------------------------------------------------------------------
  // .chaninfo
  // ---------------------------------------------------------------------------

  describe('.chaninfo', () => {
    it('lists all defs grouped by plugin with * markers for set values', async () => {
      cs.set('#test', 'protect_topic', true);
      const ctx = makeCtx();
      await handler.execute('.chaninfo #test', ctx);

      const calls = ctx.reply.mock.calls.map((c: string[]) => c[0]);
      const header = calls.find((l: string) => l.includes('Channel settings'));
      expect(header).toBeDefined();
      expect(header).toContain('1 set');
      expect(header).toContain('2 default');

      const protectLine = calls.find((l: string) => l.includes('protect_topic'));
      expect(protectLine).toBeDefined();
      expect(protectLine).toContain('ON');
      expect(protectLine).toContain('*');

      const greetLine = calls.find((l: string) => l.includes('greet_msg'));
      expect(greetLine).toBeDefined();
      expect(greetLine).not.toContain('*');
    });

    it('missing channel → usage error', async () => {
      const ctx = makeCtx();
      await handler.execute('.chaninfo', ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Usage'));
    });

    it('no defs registered → appropriate reply', async () => {
      cs.unregister('testplugin');
      const ctx = makeCtx();
      await handler.execute('.chaninfo #test', ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('No settings'));
    });

    it('permission check: user without +o is rejected', async () => {
      const ctx = makeCtx({ source: 'irc', nick: 'randuser', ident: 'rand', hostname: 'rand.com' });
      await handler.execute('.chaninfo #test', ctx);
      // No user registered with this hostmask → fails permission check
      const calls = ctx.reply.mock.calls.map((c: string[]) => c[0]);
      const settingsHeader = calls.find((l: string) => l.includes('Channel settings'));
      expect(settingsHeader).toBeUndefined();
    });
  });
});
