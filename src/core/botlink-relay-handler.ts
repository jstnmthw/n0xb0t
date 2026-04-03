// HexBot — Bot link relay frame handler
// Extracted from bot.ts for testability. Handles incoming RELAY_* frames
// that create and manage virtual relay sessions between linked bots.
import type { CommandContext } from '../command-handler';
import type { stripFormatting as StripFormattingFn } from '../utils/strip-formatting';
import type { LinkFrame } from './botlink-protocol';
import type { DCCSessionEntry } from './dcc';

/** Minimal command executor — just the .execute() method. */
export interface RelayCommandExecutor {
  execute(commandString: string, ctx: CommandContext): Promise<void>;
}

/** Minimal permissions lookup for relay — getUser by handle. */
export interface RelayPermissionsProvider {
  getUser(handle: string): { hostmasks: string[] } | null;
}

/** Minimal DCC view for relay — session listing, lookup, and announcement. */
export interface RelayDCCView {
  getSessionList(): Array<{ handle: string; nick: string; connectedAt: number }>;
  getSession(
    nick: string,
  ): Pick<DCCSessionEntry, 'writeLine' | 'isRelaying' | 'exitRelay'> | undefined;
  announce(message: string): void;
}

/** Callback to send a frame to a specific bot or to broadcast. */
export interface RelaySender {
  /** Send a frame to a specific bot (hub.send). Returns false if bot not found. */
  sendTo(botname: string, frame: LinkFrame): boolean;
  /** Send a frame via the default path (leaf.send or hub.broadcast). */
  send(frame: LinkFrame): void;
}

export interface RelayHandlerDeps {
  permissions: RelayPermissionsProvider;
  commandHandler: RelayCommandExecutor;
  dccManager: RelayDCCView | null;
  botname: string;
  sender: RelaySender;
  stripFormatting: typeof StripFormattingFn;
}

/** Per-handle virtual session state tracked on the target bot. */
export interface RelayVirtualSession {
  fromBot: string;
  sendOutput: (line: string) => void;
}

/** Map of handle -> virtual session, keyed by relay handle. */
export type RelaySessionMap = Map<string, RelayVirtualSession>;

/**
 * Handle an incoming RELAY_* frame.
 * Manages virtual relay sessions, command execution, and party line chat
 * for relayed DCC users across the bot link.
 *
 * Mutates `sessions` in place (adds/removes virtual sessions).
 */
export function handleRelayFrame(
  frame: LinkFrame,
  deps: RelayHandlerDeps,
  sessions: RelaySessionMap,
): void {
  const handle = String(frame.handle ?? '');

  if (frame.type === 'RELAY_REQUEST' && deps.dccManager) {
    // This bot is the target — create a virtual relay session
    const user = deps.permissions.getUser(handle);
    if (!user) {
      const rejectFrame = { type: 'RELAY_END', handle, reason: 'User not found' };
      deps.sender.send(rejectFrame);
      return;
    }
    // Send RELAY_ACCEPT
    const acceptFrame = { type: 'RELAY_ACCEPT', handle, toBot: deps.botname };
    const fromBot = String(frame.fromBot ?? '');
    deps.sender.sendTo(fromBot, acceptFrame);

    // Process incoming RELAY_INPUT via a relay session map (tracked below)
    sessions.set(handle, {
      fromBot,
      sendOutput: (line: string) => {
        const outputFrame = { type: 'RELAY_OUTPUT', handle, line };
        deps.sender.sendTo(fromBot, outputFrame);
      },
    });
  }

  if (frame.type === 'RELAY_INPUT') {
    const vs = sessions.get(handle);
    if (vs) {
      const line = String(frame.line ?? '');
      if (line.startsWith('.')) {
        const user = deps.permissions.getUser(handle);
        deps.commandHandler
          .execute(line, {
            source: 'botlink',
            nick: user?.hostmasks[0]?.split('!')[0] || handle,
            ident: 'relay',
            hostname: 'relay',
            channel: null,
            reply: (msg: string) => {
              for (const part of msg.split('\n')) vs.sendOutput(part);
            },
          })
          .catch(() => {});
      } else {
        // Party line chat from relayed user — strip formatting to prevent injection
        const safeHandle = deps.stripFormatting(handle);
        const safeLine = deps.stripFormatting(line);
        if (deps.dccManager) {
          deps.dccManager.announce(`<${safeHandle}@relay> ${safeLine}`);
        }
        vs.sendOutput(`<${safeHandle}> ${safeLine}`);
      }
    }
  }

  if (frame.type === 'RELAY_OUTPUT' && deps.dccManager) {
    // This bot is the origin — display output to the DCC session
    for (const session of deps.dccManager.getSessionList()) {
      if (session.handle === handle) {
        const dccSession = deps.dccManager.getSession(session.nick);
        dccSession?.writeLine(String(frame.line ?? ''));
      }
    }
  }

  if (frame.type === 'RELAY_END') {
    // Clean up virtual session if we're the target
    sessions.delete(handle);
    // Exit relay mode if we're the origin
    if (deps.dccManager) {
      for (const s of deps.dccManager.getSessionList()) {
        if (s.handle === handle) {
          const session = deps.dccManager.getSession(s.nick);
          if (session?.isRelaying) {
            session.exitRelay();
            session.writeLine(`*** Relay to ${frame.reason ?? 'remote bot'} lost.`);
          }
        }
      }
    }
  }
}
