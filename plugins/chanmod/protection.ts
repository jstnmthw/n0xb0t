// chanmod — adversarial protection: rejoin on kick, revenge
import type { HandlerContext, PluginAPI } from '../../src/types';
import { storeBan } from './bans';
import {
  botHasOps,
  buildBanMask,
  getBotNick,
  getUserFlags,
  isBotNick,
  markIntentional,
} from './helpers';
import type { ChanmodConfig, SharedState } from './state';

interface RejoinRecord {
  count: number;
  windowStart: number;
}

/** Extract the kicker's nick from kick ctx.args ("reason (by Nick)" or "by Nick"). */
function parseKicker(args: string): string {
  const m = args.match(/\(by ([^)]+)\)$/) ?? args.match(/^by (.+)$/);
  return m?.[1]?.trim() ?? '';
}

export function setupProtection(
  api: PluginAPI,
  config: ChanmodConfig,
  state: SharedState,
): () => void {
  // ---------------------------------------------------------------------------
  // Rejoin on kick + revenge
  // ---------------------------------------------------------------------------

  api.bind('kick', '-', '*', (ctx: HandlerContext) => {
    const { nick: kicked, channel, args } = ctx;
    if (!channel) return;

    // Only act when the bot itself is kicked
    if (!isBotNick(api, kicked)) return;
    if (!config.rejoin_on_kick) return;

    const kickerNick = parseKicker(args);

    // Rate-limiting: track rejoin attempts per channel in the DB
    const dbKey = `rejoin_attempts:${api.ircLower(channel)}`;
    const now = Date.now();
    let record: RejoinRecord = { count: 0, windowStart: now };
    try {
      const stored = api.db.get(dbKey);
      if (stored) record = JSON.parse(stored) as RejoinRecord;
    } catch {
      /* corrupt entry — start fresh */
    }

    // Reset window if expired
    if (now - record.windowStart > config.rejoin_attempt_window_ms) {
      record = { count: 0, windowStart: now };
    }

    if (record.count >= config.max_rejoin_attempts) {
      api.warn(
        `Rejoin suppressed for ${channel} — reached ${config.max_rejoin_attempts} attempts in window`,
      );
      return;
    }

    record.count++;
    api.db.set(dbKey, JSON.stringify(record));

    // Schedule rejoin
    const rejoinTimer = setTimeout(() => {
      api.join(channel);
      api.log(`Rejoined ${channel} after being kicked`);

      // Schedule revenge after rejoin (if configured)
      if (!config.revenge_on_kick || !kickerNick) return;

      const revengeTimer = setTimeout(() => {
        // Verify kicker is still in the channel
        const ch = api.getChannel(channel);
        if (!ch) return;
        const kickerLower = api.ircLower(kickerNick);
        if (!ch.users.has(kickerLower)) return;

        // Check bot has ops
        if (!botHasOps(api, channel)) {
          api.log(`Revenge skipped for ${kickerNick} in ${channel} — no ops`);
          return;
        }

        // Check exempt flags
        if (config.revenge_exempt_flags) {
          const flags = getUserFlags(api, channel, kickerNick);
          if (flags && [...config.revenge_exempt_flags].some((f) => flags.includes(f))) {
            api.log(`Revenge skipped for ${kickerNick} in ${channel} — exempt flag`);
            return;
          }
        }

        markIntentional(state, api, channel, kickerNick);

        if (config.revenge_action === 'deop') {
          api.deop(channel, kickerNick);
          api.log(`Revenge: deopped ${kickerNick} in ${channel} for kicking bot`);
        } else if (config.revenge_action === 'kick') {
          api.kick(channel, kickerNick, config.revenge_kick_reason);
          api.log(`Revenge: kicked ${kickerNick} from ${channel} for kicking bot`);
        } else if (config.revenge_action === 'kickban') {
          const hostmask = api.getUserHostmask(channel, kickerNick);
          if (hostmask) {
            const full = hostmask.includes('!') ? hostmask : `${kickerNick}!${hostmask}`;
            const mask = buildBanMask(full, 1); // *!*@host
            if (mask) {
              api.ban(channel, mask);
              storeBan(api, channel, mask, getBotNick(api), config.default_ban_duration);
            }
          }
          api.kick(channel, kickerNick, config.revenge_kick_reason);
          api.log(`Revenge: kickbanned ${kickerNick} from ${channel} for kicking bot`);
        }
      }, config.revenge_delay_ms);

      state.cycleTimers.push(revengeTimer);
    }, config.rejoin_delay_ms);

    state.cycleTimers.push(rejoinTimer);
  });

  return () => {};
}
