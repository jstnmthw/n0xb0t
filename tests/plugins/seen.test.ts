import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventDispatcher } from '../../src/dispatcher.js';
import { BotDatabase } from '../../src/database.js';
import { BotEventBus } from '../../src/event-bus.js';
import { Permissions } from '../../src/core/permissions.js';
import { PluginLoader } from '../../src/plugin-loader.js';
import type { HandlerContext, BotConfig } from '../../src/types.js';
import { resolve } from 'node:path';

const MINIMAL_BOT_CONFIG: BotConfig = {
  irc: { host: 'localhost', port: 6667, tls: false, nick: 'test', username: 'test', realname: 'test', channels: [] },
  owner: { handle: 'admin', hostmask: '*!*@localhost' },
  identity: { method: 'hostmask', require_acc_for: [] },
  services: { type: 'none', nickserv: 'NickServ', password: '', sasl: false },
  database: ':memory:',
  pluginDir: './plugins',
  logging: { level: 'info', mod_actions: false },
};

function makePubCtx(nick: string, text: string, channel = '#test'): HandlerContext {
  const spaceIdx = text.indexOf(' ');
  const command = spaceIdx === -1 ? text : text.substring(0, spaceIdx);
  const args = spaceIdx === -1 ? '' : text.substring(spaceIdx + 1).trim();

  return {
    nick,
    ident: 'user',
    hostname: 'host.com',
    channel,
    text,
    command,
    args,
    reply: vi.fn(),
    replyPrivate: vi.fn(),
  };
}

describe('seen plugin', () => {
  let dispatcher: EventDispatcher;
  let loader: PluginLoader;
  let db: BotDatabase;

  beforeEach(async () => {
    db = new BotDatabase(':memory:');
    db.open();
    dispatcher = new EventDispatcher();
    const eventBus = new BotEventBus();

    loader = new PluginLoader({
      pluginDir: resolve('./plugins'),
      dispatcher,
      eventBus,
      db,
      permissions: new Permissions(db),
      botConfig: MINIMAL_BOT_CONFIG,
      ircClient: null,
    });

    const result = await loader.load(resolve('./plugins/seen/index.ts'));
    expect(result.status).toBe('ok');
  });

  afterEach(async () => {
    if (loader.isLoaded('seen')) {
      await loader.unload('seen');
    }
    db.close();
  });

  it('should track channel messages in the database', async () => {
    const ctx = makePubCtx('alice', 'hello everyone');
    await dispatcher.dispatch('pubm', ctx);

    const raw = db.get('seen', 'seen:alice');
    expect(raw).toBeTruthy();

    const record = JSON.parse(raw!);
    expect(record.nick).toBe('alice');
    expect(record.channel).toBe('#test');
    expect(record.text).toBe('hello everyone');
    expect(record.time).toBeGreaterThan(0);
  });

  it('should report last seen info for a known user', async () => {
    // Track a message from alice
    const msgCtx = makePubCtx('alice', 'hello there', '#dev');
    await dispatcher.dispatch('pubm', msgCtx);

    // Query !seen alice
    const queryCtx = makePubCtx('bob', '!seen alice');
    await dispatcher.dispatch('pub', queryCtx);

    expect(queryCtx.reply).toHaveBeenCalledOnce();
    const response = (queryCtx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(response).toContain('alice');
    expect(response).toContain('#dev');
    expect(response).toContain('hello there');
    expect(response).toMatch(/\d+s ago/);
  });

  it('should return "haven\'t seen" for unknown user', async () => {
    const ctx = makePubCtx('bob', '!seen nobody');
    await dispatcher.dispatch('pub', ctx);

    expect(ctx.reply).toHaveBeenCalledWith("I haven't seen nobody.");
  });

  it('should show usage when no nick provided', async () => {
    const ctx = makePubCtx('bob', '!seen');
    await dispatcher.dispatch('pub', ctx);

    expect(ctx.reply).toHaveBeenCalledWith('Usage: !seen <nick>');
  });

  it('should be case-insensitive for nick lookups', async () => {
    const msgCtx = makePubCtx('Alice', 'hi');
    await dispatcher.dispatch('pubm', msgCtx);

    const queryCtx = makePubCtx('bob', '!seen alice');
    await dispatcher.dispatch('pub', queryCtx);

    const response = (queryCtx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(response).toContain('Alice');
  });

  it('should persist data across plugin reload', async () => {
    // Track a message
    const msgCtx = makePubCtx('charlie', 'some message');
    await dispatcher.dispatch('pubm', msgCtx);

    // Reload plugin
    await loader.reload('seen');

    // Query should still work (data in DB persists)
    const queryCtx = makePubCtx('bob', '!seen charlie');
    await dispatcher.dispatch('pub', queryCtx);

    const response = (queryCtx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(response).toContain('charlie');
  });

  it('should isolate data from other plugins', async () => {
    // Track a message via the seen plugin
    const msgCtx = makePubCtx('alice', 'hello');
    await dispatcher.dispatch('pubm', msgCtx);

    // Data should be in the 'seen' namespace, not visible in other namespaces
    expect(db.get('seen', 'seen:alice')).toBeTruthy();
    expect(db.get('other-plugin', 'seen:alice')).toBeNull();
  });
});
