// Core ban store — first-class channel ban persistence in the _bans namespace.
// Wraps AdminListStore<BanRecord> with IRC-aware key formatting and expiry logic.
import type { BotDatabase } from '../database.js';
import type { BanRecord, PluginDB } from '../types.js';
import { AdminListStore } from '../utils/admin-list-store.js';

export type { BanRecord } from '../types.js';

// ---------------------------------------------------------------------------
// BanStore
// ---------------------------------------------------------------------------

const NAMESPACE = '_bans';

export class BanStore {
  private readonly store: AdminListStore<BanRecord>;
  private readonly ircLower: (s: string) => string;

  constructor(db: BotDatabase, ircLower: (s: string) => string) {
    this.ircLower = ircLower;
    this.store = new AdminListStore<BanRecord>(db, {
      namespace: NAMESPACE,
      keyFn: (record) => this.makeKey(record.channel, record.mask),
    });
  }

  /** Store a ban with a duration in milliseconds (0 = permanent). */
  storeBan(channel: string, mask: string, by: string, durationMs: number): void {
    const now = Date.now();
    const expires = durationMs === 0 ? 0 : now + durationMs;
    const existing = this.getBan(channel, mask);
    const record: BanRecord = {
      mask,
      channel: this.ircLower(channel),
      by,
      ts: now,
      expires,
      sticky: existing?.sticky,
    };
    this.store.set(record);
  }

  /** Remove a ban record. */
  removeBan(channel: string, mask: string): void {
    this.store.del(this.makeKey(channel, mask));
  }

  /** Get a single ban record, or null if not found. */
  getBan(channel: string, mask: string): BanRecord | null {
    return this.store.get(this.makeKey(channel, mask));
  }

  /** Get all bans for a specific channel. */
  getChannelBans(channel: string): BanRecord[] {
    return this.store.list(`ban:${this.ircLower(channel)}:`);
  }

  /** Get all bans across all channels. */
  getAllBans(): BanRecord[] {
    return this.store.list('ban:');
  }

  /** Toggle sticky flag on an existing ban. Returns false if the ban doesn't exist. */
  setSticky(channel: string, mask: string, sticky: boolean): boolean {
    const record = this.getBan(channel, mask);
    if (!record) return false;
    record.sticky = sticky;
    this.store.set(record);
    return true;
  }

  /**
   * Lift expired bans in channels where the bot has ops.
   * @param hasOps - check if bot has ops in a channel
   * @param mode - send a MODE command to IRC
   * @returns count of bans lifted
   */
  liftExpiredBans(
    hasOps: (channel: string) => boolean,
    mode: (channel: string, modes: string, param: string) => void,
  ): number {
    const now = Date.now();
    let lifted = 0;
    for (const record of this.getAllBans()) {
      if (record.expires > 0 && record.expires <= now) {
        if (hasOps(record.channel)) {
          mode(record.channel, '-b', record.mask);
          this.removeBan(record.channel, record.mask);
          lifted++;
        }
      }
    }
    return lifted;
  }

  /**
   * Migrate ban records from a plugin's namespace to the core _bans namespace.
   * Safe to run multiple times (idempotent — skips if _bans already has the key).
   * @returns count of records migrated
   */
  migrateFromPluginNamespace(pluginDb: PluginDB): number {
    const oldRecords = pluginDb.list('ban:');
    let migrated = 0;
    for (const { key, value } of oldRecords) {
      // Only migrate if the key doesn't already exist in _bans
      if (!this.store.has(key)) {
        const record = JSON.parse(value) as BanRecord;
        this.store.set(record);
        migrated++;
      }
      // Delete from old namespace regardless (idempotent cleanup)
      pluginDb.del(key);
    }
    return migrated;
  }

  private makeKey(channel: string, mask: string): string {
    return `ban:${this.ircLower(channel)}:${mask}`;
  }
}
