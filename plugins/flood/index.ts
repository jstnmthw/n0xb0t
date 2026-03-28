// flood — Inbound flood protection plugin.
// Detects message floods, join/part spam, and nick-change spam.
// Escalating responses: warn → kick → tempban (configurable).
import type { HandlerContext, PluginAPI } from '../../src/types';
import { SlidingWindowCounter } from '../../src/utils/sliding-window';

export const name = 'flood';
export const version = '1.0.0';
export const description = 'Inbound flood protection: message rate, join spam, nick-change spam';

let api: PluginAPI;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OffenceEntry {
  count: number;
  lastSeen: number;
}

interface BanRecord {
  mask: string;
  channel: string;
  ts: number;
  expires: number;
}

// ---------------------------------------------------------------------------
// State (reset on each init)
// Intentional module-level mutable state: plugin is single-instance per process;
// state lives at module scope for performance (avoids per-call allocations).
// ---------------------------------------------------------------------------

let msgTracker: SlidingWindowCounter;
let joinTracker: SlidingWindowCounter;
let nickTracker: SlidingWindowCounter;
let offenceTracker: Map<string, OffenceEntry>; // `${nick}@${channel}` or `${hostmask}`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getBotNick(): string {
  return api.botConfig.irc.nick;
}

function isBotNick(nick: string): boolean {
  return api.ircLower(nick) === api.ircLower(getBotNick());
}

function botHasOps(channel: string): boolean {
  const ch = api.getChannel(channel);
  if (!ch) return false;
  const botNick = api.ircLower(getBotNick());
  const botUser = ch.users.get(botNick);
  return botUser?.modes?.includes('o') ?? false;
}

/** Return true if the nick has any privileged flag (n/m/o) in the channel. */
function isPrivileged(nick: string, channel: string, ignoreOps: boolean): boolean {
  if (!ignoreOps) return false;
  const hostmask = api.getUserHostmask(channel, nick);
  if (!hostmask) return false;
  const user = api.permissions.findByHostmask(hostmask);
  if (!user) return false;
  const flags = user.global + (user.channels[channel] ?? '');
  return /[nmo]/.test(flags);
}

/**
 * Build a simple *!*@host ban mask from a hostmask.
 * For cloaked hosts (containing '/'), use exact cloak.
 */
function buildFloodBanMask(hostmask: string): string | null {
  const atIdx = hostmask.lastIndexOf('@');
  if (atIdx === -1) return null;
  const host = hostmask.substring(atIdx + 1);
  if (!host) return null;
  return `*!*@${host}`;
}

// ---------------------------------------------------------------------------
// Timed ban helpers (self-contained in flood plugin namespace)
// ---------------------------------------------------------------------------

function banDbKey(channel: string, mask: string): string {
  return `ban:${api.ircLower(channel)}:${mask}`;
}

function storeFloodBan(channel: string, mask: string, durationMinutes: number): void {
  const now = Date.now();
  const expires = durationMinutes === 0 ? 0 : now + durationMinutes * 60_000;
  const record: BanRecord = { mask, channel: api.ircLower(channel), ts: now, expires };
  api.db.set(banDbKey(channel, mask), JSON.stringify(record));
}

function liftExpiredFloodBans(): void {
  const now = Date.now();
  for (const { key, value } of api.db.list('ban:')) {
    const record = JSON.parse(value) as BanRecord;
    if (record.expires > 0 && record.expires <= now) {
      if (botHasOps(record.channel)) {
        api.mode(record.channel, '-b', record.mask);
        api.db.del(key);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Offence tracking
// ---------------------------------------------------------------------------

function getAction(actions: string[], offenceCount: number): string {
  if (actions.length === 0) return 'warn';
  return actions[Math.min(offenceCount, actions.length - 1)];
}

function recordOffence(actions: string[], offenceWindowMs: number, key: string): string {
  const now = Date.now();
  const entry = offenceTracker.get(key);
  if (entry && now - entry.lastSeen < offenceWindowMs) {
    entry.count++;
    entry.lastSeen = now;
    return getAction(actions, entry.count - 1);
  }
  offenceTracker.set(key, { count: 1, lastSeen: now });
  return getAction(actions, 0);
}

// ---------------------------------------------------------------------------
// Flood actions
// ---------------------------------------------------------------------------

async function applyAction(
  banDurationMinutes: number,
  action: string,
  channel: string,
  nick: string,
  reason: string,
): Promise<void> {
  if (!botHasOps(channel)) return;

  if (action === 'warn') {
    api.notice(nick, `[flood] ${reason}`);
    api.log(`Warned ${nick} in ${channel}: ${reason}`);
  } else if (action === 'kick') {
    api.kick(channel, nick, `[flood] ${reason}`);
    api.log(`Kicked ${nick} from ${channel}: ${reason}`);
  } else if (action === 'tempban') {
    const hostmask = api.getUserHostmask(channel, nick);
    if (!hostmask) {
      api.kick(channel, nick, `[flood] ${reason}`);
      return;
    }
    const banMask = buildFloodBanMask(hostmask);
    if (!banMask) {
      api.kick(channel, nick, `[flood] ${reason}`);
      return;
    }
    api.ban(channel, banMask);
    storeFloodBan(channel, banMask, banDurationMinutes);
    api.kick(channel, nick, `[flood] ${reason}`);
    api.log(`Tempbanned ${nick} (${banMask}) from ${channel}: ${reason}`);
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function init(pluginApi: PluginAPI): void {
  api = pluginApi;

  // Fresh state on each load/reload
  msgTracker = new SlidingWindowCounter();
  joinTracker = new SlidingWindowCounter();
  nickTracker = new SlidingWindowCounter();
  offenceTracker = new Map();

  const msgThreshold = (api.config.msg_threshold as number | undefined) ?? 5;
  const msgWindowSecs = (api.config.msg_window_secs as number | undefined) ?? 3;
  const joinThreshold = (api.config.join_threshold as number | undefined) ?? 3;
  const joinWindowSecs = (api.config.join_window_secs as number | undefined) ?? 60;
  const nickThreshold = (api.config.nick_threshold as number | undefined) ?? 3;
  const nickWindowSecs = (api.config.nick_window_secs as number | undefined) ?? 60;
  const banDurationMinutes = (api.config.ban_duration_minutes as number | undefined) ?? 10;
  const ignoreOps = (api.config.ignore_ops as boolean | undefined) ?? true;
  const actions = (api.config.actions as string[] | undefined) ?? ['warn', 'kick', 'tempban'];
  const offenceWindowMs = (api.config.offence_window_ms as number | undefined) ?? 300_000;

  const msgWindowMs = msgWindowSecs * 1000;
  const joinWindowMs = joinWindowSecs * 1000;
  const nickWindowMs = nickWindowSecs * 1000;

  api.bind('pubm', '-', '*', async (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    if (isBotNick(ctx.nick)) return;
    if (isPrivileged(ctx.nick, ctx.channel, ignoreOps)) return;
    const key = `${api.ircLower(ctx.nick)}@${api.ircLower(ctx.channel ?? '')}`;
    if (!msgTracker.check(key, msgWindowMs, msgThreshold)) return;
    const action = recordOffence(actions, offenceWindowMs, key);
    await applyAction(
      banDurationMinutes,
      action,
      ctx.channel,
      ctx.nick,
      `message flood (${msgThreshold}+ msgs/${msgWindowSecs}s)`,
    );
  });

  api.bind('join', '-', '*', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    if (isBotNick(ctx.nick)) return;
    const hostmask = `${ctx.nick}!${ctx.ident}@${ctx.hostname}`;
    const key = `join:${api.ircLower(hostmask)}`;
    if (!joinTracker.check(key, joinWindowMs, joinThreshold)) return;
    if (isPrivileged(ctx.nick, ctx.channel, ignoreOps)) return;
    const action = recordOffence(actions, offenceWindowMs, key);
    applyAction(
      banDurationMinutes,
      action,
      ctx.channel,
      ctx.nick,
      `join flood (${joinThreshold}+ joins/${joinWindowSecs}s)`,
    ).catch((err) => api.error('Join flood action error:', err));
  });

  api.bind('nick', '-', '*', (ctx: HandlerContext) => {
    const { ident, hostname } = ctx;
    if (!ident && !hostname) return; // Incomplete hostmask data — skip
    const hostmask = `${ctx.nick}!${ident}@${hostname}`;
    const key = `nick:${api.ircLower(hostmask)}`;
    if (!nickTracker.check(key, nickWindowMs, nickThreshold)) return;
    // Use the new nick (ctx.args) for channel lookup and punishment — the old nick is gone
    const newNick = ctx.args || ctx.nick;
    // Nick changes are global — punish in the first channel where we have ops
    for (const channel of api.botConfig.irc.channels) {
      if (isPrivileged(newNick, channel, ignoreOps)) return;
      if (!botHasOps(channel)) continue;
      const action = recordOffence(actions, offenceWindowMs, key);
      applyAction(
        banDurationMinutes,
        action,
        channel,
        newNick,
        `nick-change spam (${nickThreshold}+ changes/${nickWindowSecs}s)`,
      ).catch((err) => api.error('Nick flood action error:', err));
      break;
    }
  });

  api.bind('time', '-', '60', () => {
    liftExpiredFloodBans();
  });
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

export function teardown(): void {
  msgTracker.reset();
  joinTracker.reset();
  nickTracker.reset();
  offenceTracker.clear();
}
