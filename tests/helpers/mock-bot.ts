// n0xb0t — Mock bot helper for testing
// Creates a Bot-like object with real modules but a mock IRC client.

import { EventDispatcher } from '../../src/dispatcher.js';
import { Permissions } from '../../src/core/permissions.js';
import { BotDatabase } from '../../src/database.js';
import { CommandHandler } from '../../src/command-handler.js';
import { BotEventBus } from '../../src/event-bus.js';
import { IRCBridge } from '../../src/irc-bridge.js';
import { MockIRCClient } from './mock-irc.js';
import { registerPermissionCommands } from '../../src/core/commands/permission-commands.js';
import { registerDispatcherCommands } from '../../src/core/commands/dispatcher-commands.js';
import { registerIRCAdminCommands } from '../../src/core/commands/irc-commands-admin.js';

export interface MockBot {
  client: MockIRCClient;
  db: BotDatabase;
  permissions: Permissions;
  dispatcher: EventDispatcher;
  commandHandler: CommandHandler;
  eventBus: BotEventBus;
  bridge: IRCBridge;
  cleanup(): void;
}

/**
 * Create a fully wired mock bot for testing.
 * Uses a real database (in-memory), real dispatcher, real permissions,
 * and a mock IRC client.
 */
export function createMockBot(options?: { botNick?: string }): MockBot {
  const botNick = options?.botNick ?? 'testbot';

  const db = new BotDatabase(':memory:');
  db.open();

  const permissions = new Permissions(db);
  const dispatcher = new EventDispatcher(permissions);
  const commandHandler = new CommandHandler();
  const eventBus = new BotEventBus();
  const client = new MockIRCClient();
  client.user.nick = botNick;

  // Wire up bridge
  const bridge = new IRCBridge({
    client,
    dispatcher,
    eventBus,
    botNick,
  });
  bridge.attach();

  // Register commands
  registerPermissionCommands(commandHandler, permissions);
  registerDispatcherCommands(commandHandler, dispatcher);
  registerIRCAdminCommands(commandHandler, client, {
    getUptime: () => 60_000,
    getChannels: () => ['#test'],
    getBindCount: () => dispatcher.listBinds().length,
    getUserCount: () => permissions.listUsers().length,
  });

  return {
    client,
    db,
    permissions,
    dispatcher,
    commandHandler,
    eventBus,
    bridge,
    cleanup() {
      bridge.detach();
      db.close();
    },
  };
}
