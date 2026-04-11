// HexBot — IRC commands core module
// Convenience wrappers for common IRC operations with mod action logging.
import type { BotDatabase } from '../database';
import type { Logger } from '../logger';
import { sanitize } from '../utils/sanitize';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal IRC client interface for IRC commands. */
export interface IRCCommandsClient {
  say(target: string, message: string): void;
  notice(target: string, message: string): void;
  join(channel: string): void;
  part(channel: string, message?: string): void;
  raw(line: string): void;
  mode?(target: string, mode: string, ...params: string[]): void;
}

// ---------------------------------------------------------------------------
// Mode-string parsing
// ---------------------------------------------------------------------------

interface ModeSegment {
  dir: '+' | '-';
  chars: string[];
}

/**
 * Split a mode string into per-direction segments.
 * `"+o-v"` → `[{dir:'+',chars:['o']},{dir:'-',chars:['v']}]`
 * Throws if the string does not start with a direction indicator.
 */
function parseModeString(s: string): ModeSegment[] {
  const segments: ModeSegment[] = [];
  let dir: '+' | '-' | null = null;
  let chars: string[] = [];

  for (const ch of s) {
    if (ch === '+' || ch === '-') {
      if (dir !== null && chars.length > 0) {
        segments.push({ dir, chars });
      }
      dir = ch;
      chars = [];
      continue;
    }
    if (dir === null) {
      throw new Error(`IRCCommands.mode(): mode string "${s}" is missing a leading + or -`);
    }
    chars.push(ch);
  }

  if (dir !== null && chars.length > 0) {
    segments.push({ dir, chars });
  }

  return segments;
}

// ---------------------------------------------------------------------------
// IRCCommands
// ---------------------------------------------------------------------------

export class IRCCommands {
  private client: IRCCommandsClient;
  private db: BotDatabase | null;
  private logger: Logger | null;
  private modesPerLine: number;

  constructor(
    client: IRCCommandsClient,
    db: BotDatabase | null,
    modesPerLine?: number,
    logger?: Logger | null,
  ) {
    this.client = client;
    this.db = db;
    this.logger = logger?.child('irc-commands') ?? null;
    this.modesPerLine = modesPerLine ?? 4; // Safe default; updated from ISUPPORT
  }

  /** Update the max modes per line from ISUPPORT. */
  setModesPerLine(n: number): void {
    this.modesPerLine = n;
  }

  // -------------------------------------------------------------------------
  // Channel operations
  // -------------------------------------------------------------------------

  say(target: string, message: string): void {
    this.client.say(target, message);
  }

  notice(target: string, message: string): void {
    this.client.notice(target, message);
  }

  join(channel: string, key?: string): void {
    if (key) {
      this.client.raw(`JOIN ${sanitize(channel)} ${sanitize(key)}`);
    } else {
      this.client.join(channel);
    }
  }

  part(channel: string, message?: string): void {
    this.client.part(channel, message);
  }

  kick(channel: string, nick: string, reason?: string): void {
    const safe = sanitize(reason ?? '');
    this.client.raw(`KICK ${sanitize(channel)} ${sanitize(nick)} :${safe}`);
    this.logMod('kick', channel, nick, 'bot', reason ?? null);
  }

  ban(channel: string, mask: string): void {
    this.sendMode(channel, '+b', mask);
    this.logMod('ban', channel, mask, 'bot', null);
  }

  unban(channel: string, mask: string): void {
    this.sendMode(channel, '-b', mask);
    this.logMod('unban', channel, mask, 'bot', null);
  }

  op(channel: string, nick: string): void {
    this.sendMode(channel, '+o', nick);
    this.logMod('op', channel, nick, 'bot', null);
  }

  deop(channel: string, nick: string): void {
    this.sendMode(channel, '-o', nick);
    this.logMod('deop', channel, nick, 'bot', null);
  }

  voice(channel: string, nick: string): void {
    this.sendMode(channel, '+v', nick);
  }

  devoice(channel: string, nick: string): void {
    this.sendMode(channel, '-v', nick);
  }

  halfop(channel: string, nick: string): void {
    this.sendMode(channel, '+h', nick);
  }

  dehalfop(channel: string, nick: string): void {
    this.sendMode(channel, '-h', nick);
  }

  invite(channel: string, nick: string): void {
    this.client.raw(`INVITE ${sanitize(nick)} ${sanitize(channel)}`);
    this.logMod('invite', channel, nick, 'bot', null);
  }

  topic(channel: string, text: string): void {
    const safe = sanitize(text);
    this.client.raw(`TOPIC ${sanitize(channel)} :${safe}`);
  }

  quiet(channel: string, mask: string): void {
    this.sendMode(channel, '+q', mask);
  }

  /** Request the current channel modes from the server (triggers RPL_CHANNELMODEIS). */
  requestChannelModes(channel: string): void {
    this.client.raw(`MODE ${sanitize(channel)}`);
  }

  /**
   * Raw mode change. Respects ISUPPORT MODES limit by batching.
   *
   * Mode strings with mixed directions (e.g. `"+o-v"`) are segmented so each
   * batch contains a single direction — the server would otherwise re-apply
   * the leading sign to every subsequent char, producing the wrong modes.
   *
   * When `params` is non-empty, every mode char in `modeString` is expected
   * to carry exactly one param. A count mismatch throws rather than silently
   * truncating the excess. Phase 2 will replace this rule with per-mode
   * CHANMODES awareness so flag modes like `+m` can coexist with parameter
   * modes in a single call.
   *
   * @param channel - Target channel
   * @param modeString - Mode string, e.g. `'+ov'`, `'+oo'`, `'+o-v'`, `'+i'`
   * @param params - Mode parameters (nicks, masks, etc.)
   */
  mode(channel: string, modeString: string, ...params: string[]): void {
    const segments = parseModeString(modeString);
    const totalModes = segments.reduce((n, seg) => n + seg.chars.length, 0);

    if (params.length === 0) {
      // No-param modes only (e.g. `+mn`, `-t`). Batching by modesPerLine still
      // applies in case a caller passes a long run like `+mntslk`.
      for (const seg of segments) {
        for (let i = 0; i < seg.chars.length; i += this.modesPerLine) {
          const batchChars = seg.chars.slice(i, i + this.modesPerLine);
          this.sendModeRaw(channel, seg.dir + batchChars.join(''), []);
        }
      }
      return;
    }

    if (totalModes !== params.length) {
      throw new Error(
        `IRCCommands.mode(): mode string "${modeString}" has ${totalModes} mode char(s) ` +
          `but ${params.length} param(s) were supplied — must match 1:1`,
      );
    }

    let paramIdx = 0;
    for (const seg of segments) {
      for (let i = 0; i < seg.chars.length; i += this.modesPerLine) {
        const batchChars = seg.chars.slice(i, i + this.modesPerLine);
        const batchParams = params.slice(paramIdx, paramIdx + batchChars.length);
        paramIdx += batchChars.length;
        this.sendModeRaw(channel, seg.dir + batchChars.join(''), batchParams);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private sendMode(channel: string, mode: string, param: string): void {
    if (this.client.mode) {
      this.client.mode(sanitize(channel), sanitize(mode), sanitize(param));
    } else {
      this.client.raw(`MODE ${sanitize(channel)} ${sanitize(mode)} ${sanitize(param)}`);
    }
  }

  private sendModeRaw(channel: string, modeString: string, params: string[]): void {
    const safeChannel = sanitize(channel);
    const safeModes = sanitize(modeString);
    const safeParams = params.map((p) => sanitize(p));
    const line =
      safeParams.length > 0
        ? `MODE ${safeChannel} ${safeModes} ${safeParams.join(' ')}`
        : `MODE ${safeChannel} ${safeModes}`;
    this.client.raw(line);
  }

  private logMod(
    action: string,
    channel: string,
    target: string,
    by: string,
    reason: string | null,
  ): void {
    if (this.db) {
      try {
        this.db.logModAction(action, channel, target, by, reason);
      } catch (err) {
        this.logger?.error('Failed to log mod action:', err);
      }
    }
  }
}
