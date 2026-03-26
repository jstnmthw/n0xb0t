// chanmod — auto-op/halfop/voice on join, with optional NickServ verification
import type { HandlerContext, PluginAPI } from '../../src/types';
import { botCanHalfop, botHasOps, isBotNick, parseModesSet } from './helpers';
import type { ChanmodConfig, SharedState } from './state';

export function setupAutoOp(api: PluginAPI, config: ChanmodConfig, state: SharedState): () => void {
  const enforceChannelModeSet = parseModesSet(config.enforce_channel_modes);

  api.bind('join', '-', '*', async (ctx: HandlerContext) => {
    const { nick, channel } = ctx;
    if (!channel) return;

    // Bot joined — check if channel needs enforce_channel_modes applied
    if (isBotNick(api, nick)) {
      if (enforceChannelModeSet.size > 0) {
        const timer = setTimeout(() => {
          if (!botHasOps(api, channel)) return;
          const ch = api.getChannel(channel);
          if (!ch) return;
          const missing = [...enforceChannelModeSet].filter((m) => !ch.modes.includes(m));
          if (missing.length > 0) {
            const modeString = '+' + missing.join('');
            api.mode(channel, modeString);
            api.log(`Set channel modes ${modeString} on ${channel} (enforce_channel_modes)`);
          }
        }, config.enforce_delay_ms);
        state.enforcementTimers.push(timer);
      }
      return;
    }

    if (!config.auto_op) return;

    const { ident, hostname } = ctx;
    const fullHostmask = `${nick}!${ident}@${hostname}`;
    const user = api.permissions.findByHostmask(fullHostmask);
    if (!user) return;

    const globalFlags = user.global;
    const channelFlags = user.channels[channel] ?? '';
    const allFlags = globalFlags + channelFlags;

    const shouldOp = config.op_flags.some((f) => allFlags.includes(f));
    const shouldHalfop =
      !shouldOp &&
      config.halfop_flags.length > 0 &&
      config.halfop_flags.some((f) => allFlags.includes(f));
    const shouldVoice =
      !shouldOp && !shouldHalfop && config.voice_flags.some((f) => allFlags.includes(f));

    if (!shouldOp && !shouldHalfop && !shouldVoice) return;

    // NickServ verification if required
    const identityConfig = api.botConfig.identity as Record<string, unknown> | undefined;
    const requireAccFor = (identityConfig?.require_acc_for as string[] | undefined) ?? [];
    const flagToApply = shouldOp ? '+o' : shouldHalfop ? '+h' : '+v';
    const needsVerification = requireAccFor.includes(flagToApply) && api.services.isAvailable();

    if (needsVerification) {
      api.log(`Verifying ${nick} via NickServ before applying ${flagToApply} in ${channel}`);
      const result = await api.services.verifyUser(nick);
      if (!result.verified) {
        api.log(`Verification failed for ${nick} in ${channel} — not applying ${flagToApply}`);
        if (config.notify_on_fail) {
          api.notice(nick, 'Auto-op: NickServ verification failed. Please identify and rejoin.');
        }
        return;
      }
      api.log(
        `Verified ${nick} (account: ${result.account}) — applying ${flagToApply} in ${channel}`,
      );
    }

    if (shouldOp) {
      if (!botHasOps(api, channel)) {
        api.log(`Cannot auto-op ${nick} in ${channel} — I am not opped`);
        return;
      }
      api.op(channel, nick);
      api.log(`Auto-opped ${nick} in ${channel}`);
    } else if (shouldHalfop) {
      if (!botCanHalfop(api, channel)) {
        api.log(`Cannot auto-halfop ${nick} in ${channel} — I do not have +h or +o`);
        return;
      }
      api.halfop(channel, nick);
      api.log(`Auto-halfopped ${nick} in ${channel}`);
    } else if (shouldVoice) {
      if (!botHasOps(api, channel)) {
        api.log(`Cannot auto-voice ${nick} in ${channel} — I am not opped`);
        return;
      }
      api.voice(channel, nick);
      api.log(`Auto-voiced ${nick} in ${channel}`);
    }
  });

  return () => {};
}
