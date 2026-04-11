import { beforeEach, describe, expect, it } from 'vitest';

import { STSStore, enforceSTS, parseSTSDirective } from '../../src/core/sts';
import { BotDatabase } from '../../src/database';

// ---------------------------------------------------------------------------
// parseSTSDirective
// ---------------------------------------------------------------------------

describe('parseSTSDirective', () => {
  it('parses a plaintext-form directive with port and duration', () => {
    const d = parseSTSDirective('port=6697,duration=2592000');
    expect(d).toEqual({ port: 6697, duration: 2592000 });
  });

  it('parses a TLS-form directive with only duration', () => {
    const d = parseSTSDirective('duration=86400');
    expect(d).toEqual({ duration: 86400 });
  });

  it('accepts duration=0 as a policy-clear directive (IRCv3 spec)', () => {
    const d = parseSTSDirective('duration=0');
    expect(d).toEqual({ duration: 0 });
  });

  it('ignores unknown keys for forward compatibility', () => {
    const d = parseSTSDirective('duration=60,preload=yes,future=whatever');
    expect(d).toEqual({ duration: 60 });
  });

  it('returns null when duration is missing entirely', () => {
    expect(parseSTSDirective('port=6697')).toBeNull();
  });

  it('returns null on an empty value', () => {
    expect(parseSTSDirective('')).toBeNull();
    expect(parseSTSDirective(undefined)).toBeNull();
  });

  it('rejects negative durations', () => {
    expect(parseSTSDirective('duration=-1')).toBeNull();
  });

  it('rejects out-of-range port values', () => {
    const d = parseSTSDirective('duration=60,port=99999');
    expect(d).toEqual({ duration: 60 }); // port dropped, directive still valid
  });
});

// ---------------------------------------------------------------------------
// STSStore — SQLite persistence
// ---------------------------------------------------------------------------

describe('STSStore', () => {
  let db: BotDatabase;
  let store: STSStore;

  beforeEach(() => {
    db = new BotDatabase(':memory:');
    db.open();
    store = new STSStore(db);
  });

  it('persists a policy with the recorded expiry', () => {
    const now = 1_700_000_000_000;
    store.put('irc.example.net', { duration: 600, port: 6697 }, now);
    const record = store.get('irc.example.net', now);
    expect(record?.host).toBe('irc.example.net');
    expect(record?.port).toBe(6697);
    expect(record?.expiresAt).toBe(now + 600_000);
  });

  it('lowercases the host key so `IRC.EXAMPLE.NET` and `irc.example.net` match', () => {
    const now = 1_700_000_000_000;
    store.put('IRC.EXAMPLE.NET', { duration: 60 }, now);
    expect(store.get('irc.example.net', now)).not.toBeNull();
  });

  it('returns null for an expired policy and prunes it from disk', () => {
    const planted = 1_700_000_000_000;
    store.put('irc.example.net', { duration: 1 }, planted);
    const later = planted + 5_000; // 5s later; policy lasted 1s
    expect(store.get('irc.example.net', later)).toBeNull();
    // Pruned — a second call at the planted timestamp still returns null
    expect(store.get('irc.example.net', planted)).toBeNull();
  });

  it('deletes the policy when duration=0 (IRCv3 clear directive)', () => {
    store.put('irc.example.net', { duration: 600, port: 6697 });
    store.put('irc.example.net', { duration: 0 });
    expect(store.get('irc.example.net')).toBeNull();
  });

  it('delete() removes an existing record', () => {
    store.put('irc.example.net', { duration: 600 });
    store.delete('irc.example.net');
    expect(store.get('irc.example.net')).toBeNull();
  });

  it('returns null on malformed stored JSON', () => {
    db.set('_sts', 'bad.example.net', 'not-json');
    expect(store.get('bad.example.net')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// enforceSTS — connect-time policy check
// ---------------------------------------------------------------------------

describe('enforceSTS', () => {
  let db: BotDatabase;
  let store: STSStore;

  beforeEach(() => {
    db = new BotDatabase(':memory:');
    db.open();
    store = new STSStore(db);
  });

  it('allows when no policy exists', () => {
    expect(enforceSTS(store, 'irc.example.net', false, 6667)).toEqual({ kind: 'allow' });
  });

  it('allows when the config already uses TLS', () => {
    const now = 1_700_000_000_000;
    store.put('irc.example.net', { duration: 600, port: 6697 }, now);
    const outcome = enforceSTS(store, 'irc.example.net', true, 6697, now);
    expect(outcome.kind).toBe('allow');
  });

  it('upgrades plaintext to TLS using the recorded port', () => {
    const now = 1_700_000_000_000;
    store.put('irc.example.net', { duration: 600, port: 6697 }, now);
    const outcome = enforceSTS(store, 'irc.example.net', false, 6667, now);
    expect(outcome).toEqual({
      kind: 'upgrade',
      tls: true,
      port: 6697,
      expiresAt: now + 600_000,
    });
  });

  it('refuses when policy exists but no port was recorded (cannot downgrade-safe upgrade)', () => {
    const now = 1_700_000_000_000;
    store.put('irc.example.net', { duration: 600 }, now);
    const outcome = enforceSTS(store, 'irc.example.net', false, 6667, now);
    expect(outcome.kind).toBe('refuse');
    if (outcome.kind === 'refuse') {
      expect(outcome.reason).toContain('no port');
    }
  });

  it('allows once the policy has expired', () => {
    const planted = 1_700_000_000_000;
    store.put('irc.example.net', { duration: 1, port: 6697 }, planted);
    const later = planted + 5_000;
    expect(enforceSTS(store, 'irc.example.net', false, 6667, later)).toEqual({ kind: 'allow' });
  });
});
