// Unit tests for plugins/chanmod/bans.ts
// Tests liftExpiredBans, storeBan, getAllBanRecords, getChannelBanRecords directly.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getAllBanRecords,
  getChannelBanRecords,
  liftExpiredBans,
  removeBanRecord,
  storeBan,
} from '../../plugins/chanmod/bans';
import { BotDatabase } from '../../src/database';
import { createLogger } from '../../src/logger';
import type { PluginAPI, PluginDB } from '../../src/types';

/** Wrap a BotDatabase with a namespace to create a PluginDB (as plugin-loader does). */
function makePluginDb(db: BotDatabase, ns: string): PluginDB {
  return {
    get: (key) => db.get(ns, key) ?? undefined,
    set: (key, value) => db.set(ns, key, value),
    del: (key) => db.del(ns, key),
    list: (prefix) => db.list(ns, prefix),
  };
}

function makeApi(botHasOps = true): { api: PluginAPI; modeSpy: ReturnType<typeof vi.fn> } {
  const rawDb = new BotDatabase(':memory:', createLogger('error'));
  rawDb.open();
  const pluginDb = makePluginDb(rawDb, 'chanmod');

  const botNick = 'hexbot';
  const users = new Map<string, { modes: string[] }>();
  if (botHasOps) users.set(botNick, { modes: ['o'] });

  const modeSpy = vi.fn();

  const api = {
    db: pluginDb,
    casemapping: 'rfc1459' as const,
    botConfig: { irc: { nick: botNick } },
    getChannel: vi.fn().mockReturnValue({ users }),
    mode: modeSpy,
    log: vi.fn(),
    ircLower: (s: string) => s.toLowerCase(),
  } as unknown as PluginAPI;

  return { api, modeSpy };
}

describe('chanmod bans — storeBan / getAllBanRecords / getChannelBanRecords', () => {
  let api: PluginAPI;

  beforeEach(() => {
    ({ api } = makeApi());
  });

  it('storeBan stores a permanent ban (durationMinutes=0)', () => {
    storeBan(api, '#test', '*!*@bad.host', 'Admin', 0);
    const records = getAllBanRecords(api);
    expect(records.length).toBe(1);
    expect(records[0].expires).toBe(0);
    expect(records[0].mask).toBe('*!*@bad.host');
  });

  it('storeBan stores a timed ban with future expiry', () => {
    const before = Date.now();
    storeBan(api, '#test', '*!*@bad.host', 'Admin', 60);
    const records = getAllBanRecords(api);
    expect(records.length).toBe(1);
    expect(records[0].expires).toBeGreaterThan(before);
  });

  it('getChannelBanRecords returns only bans for a specific channel', () => {
    storeBan(api, '#test', '*!*@a.host', 'Admin', 0);
    storeBan(api, '#other', '*!*@b.host', 'Admin', 0);
    const testBans = getChannelBanRecords(api, '#test');
    expect(testBans.length).toBe(1);
    expect(testBans[0].mask).toBe('*!*@a.host');
  });

  it('removeBanRecord deletes the ban entry', () => {
    storeBan(api, '#test', '*!*@gone.host', 'Admin', 0);
    removeBanRecord(api, '#test', '*!*@gone.host');
    expect(getAllBanRecords(api).length).toBe(0);
  });
});

describe('chanmod bans — liftExpiredBans', () => {
  it('does not lift permanent bans (expires=0)', () => {
    const { api, modeSpy } = makeApi();
    storeBan(api, '#test', '*!*@perm.host', 'Admin', 0);
    const lifted = liftExpiredBans(api);
    expect(lifted).toBe(0);
    expect(modeSpy).not.toHaveBeenCalled();
  });

  it('does not lift bans that have not expired yet', () => {
    const { api, modeSpy } = makeApi();
    storeBan(api, '#test', '*!*@future.host', 'Admin', 60); // 60 minutes in future
    const lifted = liftExpiredBans(api);
    expect(lifted).toBe(0);
    expect(modeSpy).not.toHaveBeenCalled();
  });

  it('lifts expired bans when bot has ops', () => {
    const { api, modeSpy } = makeApi(true); // bot has ops
    // Manually store a ban that expires in the past
    const expiredRecord = {
      mask: '*!*@expired.host',
      channel: '#test',
      by: 'Admin',
      ts: Date.now() - 120_000,
      expires: Date.now() - 60_000, // expired 1 minute ago
    };
    api.db.set('ban:#test:*!*@expired.host', JSON.stringify(expiredRecord));

    const lifted = liftExpiredBans(api);
    expect(lifted).toBe(1);
    expect(modeSpy).toHaveBeenCalledWith('#test', '-b', '*!*@expired.host');
    expect(getAllBanRecords(api).length).toBe(0);
  });

  it('does not lift expired ban when bot has no ops', () => {
    const { api, modeSpy } = makeApi(false); // bot has no ops
    const expiredRecord = {
      mask: '*!*@expired.host',
      channel: '#test',
      by: 'Admin',
      ts: Date.now() - 120_000,
      expires: Date.now() - 60_000,
    };
    api.db.set('ban:#test:*!*@expired.host', JSON.stringify(expiredRecord));

    const lifted = liftExpiredBans(api);
    expect(lifted).toBe(0);
    expect(modeSpy).not.toHaveBeenCalled();
  });

  it('lifts multiple expired bans in one pass', () => {
    const { api, modeSpy } = makeApi(true);
    const now = Date.now();
    ['*!*@a.host', '*!*@b.host', '*!*@c.host'].forEach((mask) => {
      api.db.set(
        `ban:#test:${mask}`,
        JSON.stringify({
          mask,
          channel: '#test',
          by: 'Admin',
          ts: now - 120_000,
          expires: now - 60_000,
        }),
      );
    });

    const lifted = liftExpiredBans(api);
    expect(lifted).toBe(3);
    expect(modeSpy).toHaveBeenCalledTimes(3);
  });
});
