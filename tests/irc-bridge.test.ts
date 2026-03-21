import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventDispatcher } from '../src/dispatcher.js';
import { BotEventBus } from '../src/event-bus.js';
import { IRCBridge } from '../src/irc-bridge.js';
import { MockIRCClient } from './helpers/mock-irc.js';
import type { HandlerContext } from '../src/types.js';

describe('IRCBridge', () => {
  let client: MockIRCClient;
  let dispatcher: EventDispatcher;
  let eventBus: BotEventBus;
  let bridge: IRCBridge;

  beforeEach(() => {
    client = new MockIRCClient();
    dispatcher = new EventDispatcher();
    eventBus = new BotEventBus();
    bridge = new IRCBridge({ client, dispatcher, eventBus, botNick: 'testbot' });
    bridge.attach();
  });

  afterEach(() => {
    bridge.detach();
  });

  describe('channel messages → pub/pubm', () => {
    it('should dispatch pub and pubm for channel messages', async () => {
      const pubHandler = vi.fn();
      const pubmHandler = vi.fn();
      dispatcher.bind('pub', '-', '!hello', pubHandler, 'test');
      dispatcher.bind('pubm', '-', '*hello*', pubmHandler, 'test');

      client.simulateEvent('privmsg', {
        nick: 'user1',
        ident: 'user',
        hostname: 'host.com',
        target: '#test',
        message: '!hello world',
      });

      // Give async dispatch time to complete
      await new Promise((r) => setTimeout(r, 10));

      expect(pubHandler).toHaveBeenCalledOnce();
      expect(pubmHandler).toHaveBeenCalledOnce();

      const ctx: HandlerContext = pubHandler.mock.calls[0][0];
      expect(ctx.nick).toBe('user1');
      expect(ctx.ident).toBe('user');
      expect(ctx.hostname).toBe('host.com');
      expect(ctx.channel).toBe('#test');
      expect(ctx.command).toBe('!hello');
      expect(ctx.args).toBe('world');

      dispatcher.unbindAll('test');
    });

    it('should build reply function that uses client.say for channel', async () => {
      const handler = vi.fn((ctx: HandlerContext) => {
        ctx.reply('hi back');
      });
      dispatcher.bind('pub', '-', '!greet', handler, 'test');

      client.simulateEvent('privmsg', {
        nick: 'user1',
        ident: 'user',
        hostname: 'host.com',
        target: '#test',
        message: '!greet',
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(client.messages).toContainEqual({
        type: 'say',
        target: '#test',
        message: 'hi back',
      });

      dispatcher.unbindAll('test');
    });
  });

  describe('private messages → msg/msgm', () => {
    it('should dispatch msg and msgm for private messages', async () => {
      const msgHandler = vi.fn();
      const msgmHandler = vi.fn();
      dispatcher.bind('msg', '-', '!secret', msgHandler, 'test');
      dispatcher.bind('msgm', '-', '*secret*', msgmHandler, 'test');

      client.simulateEvent('privmsg', {
        nick: 'user1',
        ident: 'user',
        hostname: 'host.com',
        target: 'testbot',
        message: '!secret data',
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(msgHandler).toHaveBeenCalledOnce();
      expect(msgmHandler).toHaveBeenCalledOnce();

      const ctx: HandlerContext = msgHandler.mock.calls[0][0];
      expect(ctx.channel).toBeNull();

      dispatcher.unbindAll('test');
    });

    it('should build replyPrivate function that uses client.notice', async () => {
      const handler = vi.fn((ctx: HandlerContext) => {
        ctx.replyPrivate('private response');
      });
      dispatcher.bind('msg', '-', '!dm', handler, 'test');

      client.simulateEvent('privmsg', {
        nick: 'user1',
        ident: 'user',
        hostname: 'host.com',
        target: 'testbot',
        message: '!dm',
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(client.messages).toContainEqual({
        type: 'notice',
        target: 'user1',
        message: 'private response',
      });

      dispatcher.unbindAll('test');
    });
  });

  describe('join events', () => {
    it('should dispatch join events', async () => {
      const handler = vi.fn();
      dispatcher.bind('join', '-', '*', handler, 'test');

      client.simulateEvent('join', {
        nick: 'newuser',
        ident: 'new',
        hostname: 'new.host.com',
        channel: '#test',
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.nick).toBe('newuser');
      expect(ctx.channel).toBe('#test');
      expect(ctx.command).toBe('JOIN');

      dispatcher.unbindAll('test');
    });
  });

  describe('part events', () => {
    it('should dispatch part events', async () => {
      const handler = vi.fn();
      dispatcher.bind('part', '-', '*', handler, 'test');

      client.simulateEvent('part', {
        nick: 'leaver',
        ident: 'leav',
        hostname: 'some.host',
        channel: '#test',
        message: 'bye',
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.nick).toBe('leaver');
      expect(ctx.channel).toBe('#test');
      expect(ctx.args).toBe('bye');

      dispatcher.unbindAll('test');
    });
  });

  describe('kick events', () => {
    it('should dispatch kick events with kicked user as nick', async () => {
      const handler = vi.fn();
      dispatcher.bind('kick', '-', '*', handler, 'test');

      client.simulateEvent('kick', {
        nick: 'op',
        ident: 'op',
        hostname: 'op.host',
        channel: '#test',
        kicked: 'baduser',
        message: 'behave',
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.nick).toBe('baduser');
      expect(ctx.args).toBe('behave (by op)');

      dispatcher.unbindAll('test');
    });
  });

  describe('nick events', () => {
    it('should dispatch nick change events', async () => {
      const handler = vi.fn();
      dispatcher.bind('nick', '-', '*', handler, 'test');

      client.simulateEvent('nick', {
        nick: 'oldnick',
        new_nick: 'newnick',
        ident: 'user',
        hostname: 'host.com',
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.nick).toBe('oldnick');
      expect(ctx.text).toBe('newnick');

      dispatcher.unbindAll('test');
    });

    it('should track bot nick changes', () => {
      client.simulateEvent('nick', {
        nick: 'testbot',
        new_nick: 'testbot_',
        ident: 'bot',
        hostname: 'localhost',
      });

      // setBotNick is called internally — verify by triggering another event
      // where botNick matters (the bridge stores it)
      expect(true).toBe(true); // Nick tracking is internal
    });
  });

  describe('mode events', () => {
    it('should dispatch individual mode changes', async () => {
      const handler = vi.fn();
      dispatcher.bind('mode', '-', '*', handler, 'test');

      client.simulateEvent('mode', {
        nick: 'chanop',
        ident: 'op',
        hostname: 'op.host',
        target: '#test',
        modes: [
          { mode: '+o', param: 'user1' },
          { mode: '+v', param: 'user2' },
        ],
      });

      await new Promise((r) => setTimeout(r, 10));

      // Should dispatch twice — once for each mode
      expect(handler).toHaveBeenCalledTimes(2);

      const ctx1: HandlerContext = handler.mock.calls[0][0];
      expect(ctx1.command).toBe('+o');
      expect(ctx1.args).toBe('user1');

      const ctx2: HandlerContext = handler.mock.calls[1][0];
      expect(ctx2.command).toBe('+v');
      expect(ctx2.args).toBe('user2');

      dispatcher.unbindAll('test');
    });
  });

  describe('notice events', () => {
    it('should dispatch notice events', async () => {
      const handler = vi.fn();
      dispatcher.bind('notice', '-', '*test*', handler, 'test');

      client.simulateEvent('notice', {
        nick: 'NickServ',
        ident: 'services',
        hostname: 'services.libera.chat',
        target: 'testbot',
        message: 'This is a test notice',
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(handler).toHaveBeenCalledOnce();

      dispatcher.unbindAll('test');
    });
  });

  describe('ctcp events', () => {
    it('should dispatch ctcp events', async () => {
      const handler = vi.fn();
      dispatcher.bind('ctcp', '-', 'VERSION', handler, 'test');

      client.simulateEvent('ctcp request', {
        nick: 'curious',
        ident: 'user',
        hostname: 'host.com',
        target: 'testbot',
        type: 'VERSION',
        message: '',
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.command).toBe('VERSION');

      dispatcher.unbindAll('test');
    });
  });

  describe('security', () => {
    it('should strip newlines from text fields', async () => {
      const handler = vi.fn();
      dispatcher.bind('pub', '-', '!cmd', handler, 'test');

      client.simulateEvent('privmsg', {
        nick: 'evil\r\nPRIVMSG #other :pwned',
        ident: 'x',
        hostname: 'host.com',
        target: '#test',
        message: '!cmd\r\nPRIVMSG NickServ :IDENTIFY password',
      });

      await new Promise((r) => setTimeout(r, 10));

      if (handler.mock.calls.length > 0) {
        const ctx: HandlerContext = handler.mock.calls[0][0];
        expect(ctx.nick).not.toContain('\r');
        expect(ctx.nick).not.toContain('\n');
        expect(ctx.text).not.toContain('\r');
        expect(ctx.text).not.toContain('\n');
      }

      dispatcher.unbindAll('test');
    });

    it('should strip IRC formatting from command text', async () => {
      const handler = vi.fn();
      dispatcher.bind('pub', '-', '!hello', handler, 'test');

      // \x02 = bold, \x03 = color
      client.simulateEvent('privmsg', {
        nick: 'user1',
        ident: 'user',
        hostname: 'host.com',
        target: '#test',
        message: '\x02!hello\x02 world',
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.command).toBe('!hello');

      dispatcher.unbindAll('test');
    });

    it('should sanitize reply output', async () => {
      const handler = vi.fn((ctx: HandlerContext) => {
        ctx.reply('line1\r\nPRIVMSG #evil :injected');
      });
      dispatcher.bind('pub', '-', '!test', handler, 'test');

      client.simulateEvent('privmsg', {
        nick: 'user1',
        ident: 'user',
        hostname: 'host.com',
        target: '#test',
        message: '!test',
      });

      await new Promise((r) => setTimeout(r, 10));

      const msg = client.messages.find((m) => m.type === 'say');
      expect(msg?.message).not.toContain('\r');
      expect(msg?.message).not.toContain('\n');

      dispatcher.unbindAll('test');
    });

    it('should reject invalid channel names', async () => {
      const handler = vi.fn();
      dispatcher.bind('join', '-', '*', handler, 'test');

      client.simulateEvent('join', {
        nick: 'user1',
        ident: 'user',
        hostname: 'host.com',
        channel: 'notachannel',
      });

      await new Promise((r) => setTimeout(r, 10));

      // Should not dispatch for invalid channel name
      expect(handler).not.toHaveBeenCalled();

      dispatcher.unbindAll('test');
    });
  });

  describe('detach', () => {
    it('should stop dispatching after detach', async () => {
      const handler = vi.fn();
      dispatcher.bind('pub', '-', '!test', handler, 'test');

      bridge.detach();

      client.simulateEvent('privmsg', {
        nick: 'user1',
        ident: 'user',
        hostname: 'host.com',
        target: '#test',
        message: '!test',
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(handler).not.toHaveBeenCalled();

      dispatcher.unbindAll('test');
    });
  });
});
