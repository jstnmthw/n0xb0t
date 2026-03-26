// chanmod — timed ban storage, auto-expire, and periodic cleanup
import type { PluginAPI } from '../../src/types';
import { botHasOps } from './helpers';
import type { ChanmodConfig, SharedState } from './state';

export interface BanRecord {
  mask: string;
  channel: string;
  by: string;
  ts: number;
  expires: number; // 0 = permanent, otherwise unix timestamp ms
}

export function banDbKey(api: PluginAPI, channel: string, mask: string): string {
  return `ban:${api.ircLower(channel)}:${mask}`;
}

export function storeBan(
  api: PluginAPI,
  channel: string,
  mask: string,
  by: string,
  durationMinutes: number,
): void {
  const now = Date.now();
  const expires = durationMinutes === 0 ? 0 : now + durationMinutes * 60_000;
  const record: BanRecord = { mask, channel: api.ircLower(channel), by, ts: now, expires };
  api.db.set(banDbKey(api, channel, mask), JSON.stringify(record));
}

export function removeBanRecord(api: PluginAPI, channel: string, mask: string): void {
  api.db.del(banDbKey(api, channel, mask));
}

export function getAllBanRecords(api: PluginAPI): BanRecord[] {
  return api.db.list('ban:').map(({ value }) => JSON.parse(value) as BanRecord);
}

export function getChannelBanRecords(api: PluginAPI, channel: string): BanRecord[] {
  return api.db
    .list(`ban:${api.ircLower(channel)}:`)
    .map(({ value }) => JSON.parse(value) as BanRecord);
}

/** Lift expired bans in channels where the bot has ops. Returns count lifted. */
export function liftExpiredBans(api: PluginAPI): number {
  const now = Date.now();
  let lifted = 0;
  for (const record of getAllBanRecords(api)) {
    if (record.expires > 0 && record.expires <= now) {
      if (botHasOps(api, record.channel)) {
        api.mode(record.channel, '-b', record.mask);
        removeBanRecord(api, record.channel, record.mask);
        api.log(`Auto-lifted expired ban ${record.mask} from ${record.channel}`);
        lifted++;
      }
    }
  }
  return lifted;
}

export function setupBans(api: PluginAPI, _config: ChanmodConfig, state: SharedState): () => void {
  // Lift bans that expired during downtime (after a short delay to allow joining + getting ops)
  state.startupTimer = setTimeout(() => {
    state.startupTimer = null;
    const lifted = liftExpiredBans(api);
    if (lifted > 0) {
      api.log(`Lifted ${lifted} expired ban${lifted === 1 ? '' : 's'} after downtime`);
    }
  }, 5000);

  api.bind('time', '-', '60', () => {
    liftExpiredBans(api);
  });

  return () => {
    if (state.startupTimer !== null) {
      clearTimeout(state.startupTimer);
      state.startupTimer = null;
    }
  };
}
