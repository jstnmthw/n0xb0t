// chanmod — mode enforcement: re-op, channel modes, cycle-on-deop, bitch mode, punish deop, enforcebans
import type { HandlerContext, PluginAPI } from '../../src/types';
import { wildcardMatch } from '../../src/utils/wildcard';
import { storeBan } from './bans';
import {
  botCanHalfop,
  botHasOps,
  buildBanMask,
  getBotNick,
  getUserFlags,
  isBotNick,
  markIntentional,
  parseModesSet,
  wasIntentional,
} from './helpers';
import {
  COOLDOWN_WINDOW_MS,
  type ChanmodConfig,
  MAX_ENFORCEMENTS,
  type SharedState,
} from './state';

const PUNISH_MAX = 2;
const PUNISH_COOLDOWN_MS = 30_000;

export function setupModeEnforce(
  api: PluginAPI,
  config: ChanmodConfig,
  state: SharedState,
): () => void {
  api.bind('mode', '-', '*', (ctx: HandlerContext) => {
    const { nick: setter, channel, command: modeStr, args: target } = ctx;
    if (!channel) return;

    // Read per-channel settings (fall back to config default via channelSettings)
    const channelModes = api.channelSettings.get(channel, 'channel_modes') as string;
    const enforceChannelModeSet = parseModesSet(channelModes);

    // --- Channel mode enforcement (e.g. +nt) ---
    if (enforceChannelModeSet.size > 0 && modeStr.startsWith('-') && modeStr.length === 2) {
      const modeChar = modeStr[1];
      if (enforceChannelModeSet.has(modeChar)) {
        const enforceModes = api.channelSettings.get(channel, 'enforce_modes') as boolean;
        const isNodesynch = config.nodesynch_nicks.some(
          (n) => api.ircLower(n) === api.ircLower(setter),
        );
        if (enforceModes && !isNodesynch && !isBotNick(api, setter) && botHasOps(api, channel)) {
          api.log(`Re-enforcing +${modeChar} on ${channel} (removed by ${setter})`);
          const timer = setTimeout(() => {
            api.mode(channel, '+' + modeChar);
          }, config.enforce_delay_ms);
          state.enforcementTimers.push(timer);
        }
      }
    }

    // --- Bot self-deop → cycle ---
    if (modeStr === '-o' && isBotNick(api, target)) {
      if (config.cycle_on_deop && !state.cycleScheduled.has(api.ircLower(channel))) {
        const cooldownKey = `${api.ircLower(channel)}:cycle`;
        const now = Date.now();
        const cooldown = state.enforcementCooldown.get(cooldownKey);
        if (cooldown && now < cooldown.expiresAt) {
          cooldown.count++;
          if (cooldown.count >= MAX_ENFORCEMENTS) {
            const ch = api.getChannel(channel);
            const isInviteOnly = ch?.modes.includes('i') ?? false;
            if (!isInviteOnly) {
              api.log(`Cycling ${channel} to regain ops`);
              state.cycleScheduled.add(api.ircLower(channel));
              const timer = setTimeout(() => {
                api.part(channel, 'Cycling to regain ops');
                const rejoinTimer = setTimeout(() => {
                  api.join(channel);
                  state.cycleScheduled.delete(api.ircLower(channel));
                  state.enforcementCooldown.delete(cooldownKey);
                }, 2000);
                state.cycleTimers.push(rejoinTimer);
              }, config.cycle_delay_ms);
              state.cycleTimers.push(timer);
            }
          }
        } else {
          state.enforcementCooldown.set(cooldownKey, {
            count: 1,
            expiresAt: now + COOLDOWN_WINDOW_MS,
          });
        }
      }
      return; // Don't apply user-flag enforcement for bot self-deop
    }

    // --- Bitch mode: strip unauthorized +o / +h ---
    const bitch = api.channelSettings.get(channel, 'bitch') as boolean;
    if (bitch && (modeStr === '+o' || modeStr === '+h') && target) {
      if (isBotNick(api, setter) || isBotNick(api, target)) return;
      const isNodesynch = config.nodesynch_nicks.some(
        (n) => api.ircLower(n) === api.ircLower(setter),
      );
      if (!isNodesynch && botHasOps(api, channel)) {
        const targetFlags = getUserFlags(api, channel, target);
        const isAuthorized =
          modeStr === '+o'
            ? targetFlags && config.op_flags.some((f) => targetFlags.includes(f))
            : targetFlags &&
              config.halfop_flags.length > 0 &&
              config.halfop_flags.some((f) => targetFlags.includes(f));

        if (!isAuthorized) {
          api.log(`Bitch: stripping ${modeStr} from ${target} in ${channel} (not flagged)`);
          markIntentional(state, api, channel, target);
          const timer = setTimeout(() => {
            if (modeStr === '+o') api.deop(channel, target);
            else api.dehalfop(channel, target);
          }, config.enforce_delay_ms);
          state.enforcementTimers.push(timer);
        }
      }
      return;
    }

    // --- Enforcebans: kick channel members matching a new ban mask ---
    const enforcebans = api.channelSettings.get(channel, 'enforcebans') as boolean;
    if (enforcebans && modeStr === '+b' && target && botHasOps(api, channel)) {
      const ch = api.getChannel(channel);
      if (ch) {
        for (const user of ch.users.values()) {
          if (isBotNick(api, user.nick)) continue;
          const hostmask = `${user.nick}!${user.ident}@${user.hostname}`;
          if (wildcardMatch(target, hostmask, true)) {
            api.log(`Enforcebans: kicking ${user.nick} from ${channel} (matches ${target})`);
            markIntentional(state, api, channel, user.nick);
            api.kick(channel, user.nick, 'You are banned');
          }
        }
      }
      return;
    }

    // --- User op/halfop/voice enforcement (+ optional punish deop) ---
    if (modeStr !== '-o' && modeStr !== '-h' && modeStr !== '-v') return;
    if (!target) return;
    if (isBotNick(api, setter)) return;
    if (wasIntentional(state, api, channel, target)) return;

    // -h/-v: only enforce if enforce_modes is on; punish_deop only applies to -o
    const enforceModes = api.channelSettings.get(channel, 'enforce_modes') as boolean;
    const protectOps = api.channelSettings.get(channel, 'protect_ops') as boolean;
    if ((modeStr === '-h' || modeStr === '-v') && !enforceModes) return;
    // -o: process if either feature is enabled
    if (modeStr === '-o' && !enforceModes && !protectOps) return;

    const flags = getUserFlags(api, channel, target);
    if (!flags) return; // Unknown user — neither feature applies

    const cooldownKey = `${api.ircLower(channel)}:${api.ircLower(target)}`;
    const now = Date.now();
    const cooldown = state.enforcementCooldown.get(cooldownKey);
    if (cooldown && now < cooldown.expiresAt) {
      if (cooldown.count >= MAX_ENFORCEMENTS) {
        api.warn(`Suppressing mode enforcement for ${target} in ${channel} — possible mode war`);
        return;
      }
      cooldown.count++;
    } else {
      state.enforcementCooldown.set(cooldownKey, { count: 1, expiresAt: now + COOLDOWN_WINDOW_MS });
    }

    if (modeStr === '-o') {
      if (!botHasOps(api, channel)) return;
      const shouldBeOpped = config.op_flags.some((f) => flags.includes(f));
      if (shouldBeOpped && enforceModes) {
        api.log(`Re-enforcing +o on ${target} in ${channel} (deopped by ${setter})`);
        const timer = setTimeout(() => {
          api.op(channel, target);
        }, config.enforce_delay_ms);
        state.enforcementTimers.push(timer);
      }
      // Punish whoever stripped ops from a recognized op
      if (protectOps && shouldBeOpped) {
        const isSetterNodesynch = config.nodesynch_nicks.some(
          (n) => api.ircLower(n) === api.ircLower(setter),
        );
        if (!isSetterNodesynch) {
          const setterFlags = getUserFlags(api, channel, setter);
          const setterHasAuthority =
            setterFlags && config.op_flags.some((f) => setterFlags.includes(f));
          if (!setterHasAuthority) {
            punishDeop(api, config, state, channel, setter);
          }
        }
      }
    } else if (modeStr === '-h') {
      if (!botCanHalfop(api, channel)) return;
      const shouldBeHalfopped =
        config.halfop_flags.length > 0 && config.halfop_flags.some((f) => flags.includes(f));
      if (shouldBeHalfopped) {
        api.log(`Re-enforcing +h on ${target} in ${channel} (dehalfopped by ${setter})`);
        const timer = setTimeout(() => {
          api.halfop(channel, target);
        }, config.enforce_delay_ms);
        state.enforcementTimers.push(timer);
      }
    } else if (modeStr === '-v') {
      if (!botHasOps(api, channel)) return;
      const shouldBeVoiced = config.voice_flags.some((f) => flags.includes(f));
      if (shouldBeVoiced) {
        api.log(`Re-enforcing +v on ${target} in ${channel} (devoiced by ${setter})`);
        const timer = setTimeout(() => {
          api.voice(channel, target);
        }, config.enforce_delay_ms);
        state.enforcementTimers.push(timer);
      }
    }
  });

  return () => {
    for (const timer of state.enforcementTimers) clearTimeout(timer);
    for (const timer of state.cycleTimers) clearTimeout(timer);
    state.enforcementTimers.length = 0;
    state.cycleTimers.length = 0;
    state.cycleScheduled.clear();
    state.intentionalModeChanges.clear();
    state.enforcementCooldown.clear();
  };
}

function punishDeop(
  api: PluginAPI,
  config: ChanmodConfig,
  state: SharedState,
  channel: string,
  setter: string,
): void {
  const punishKey = `punish:${api.ircLower(channel)}:${api.ircLower(setter)}`;
  const now = Date.now();
  const entry = state.enforcementCooldown.get(punishKey);
  if (entry && now < entry.expiresAt) {
    if (entry.count >= PUNISH_MAX) {
      api.warn(`Suppressing deop punishment for ${setter} in ${channel} — rate limit`);
      return;
    }
    entry.count++;
  } else {
    state.enforcementCooldown.set(punishKey, { count: 1, expiresAt: now + PUNISH_COOLDOWN_MS });
  }

  markIntentional(state, api, channel, setter);

  if (config.punish_action === 'kickban') {
    const hostmask = api.getUserHostmask(channel, setter);
    if (hostmask) {
      const full = hostmask.includes('!') ? hostmask : `${setter}!${hostmask}`;
      const mask = buildBanMask(full, 1);
      if (mask) {
        api.ban(channel, mask);
        storeBan(api, channel, mask, getBotNick(api), config.default_ban_duration);
      }
    }
  }
  api.kick(channel, setter, config.punish_kick_reason);
  api.log(`Punished ${setter} in ${channel} for unauthorized deop (${config.punish_action})`);
}
