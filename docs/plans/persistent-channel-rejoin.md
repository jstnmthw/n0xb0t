# Plan: Persistent Channel Rejoin

## Summary

The bot has no mechanism to retry joining configured channels after a failed join attempt. If the bot is kicked and banned, it tries to rejoin once (via chanmod's `rejoin_on_kick`), fails silently when the server rejects the join, and never tries again. The same applies to any join failure: channel full (+l), invite only (+i), bad key (+k), need to register (+r). Eggdrop solves this with a periodic channel presence check — every ~30 seconds it scans configured channels, identifies any the bot is missing from, and attempts to rejoin. This is a core bot reliability feature, not a plugin concern.

## Current behavior

1. **On connect** (`connection-lifecycle.ts:166`): `joinConfiguredChannels()` sends JOIN for every configured channel. Works for the initial connection.

2. **On kick** (`plugins/chanmod/protection.ts:63-152`): If `rejoin_on_kick` is enabled, schedules a single rejoin after `rejoin_delay_ms` (default 5s). Rate-limited to `max_rejoin_attempts` (default 3) per window. If the rejoin fails (banned, +i, +k, +l), no further attempts are made.

3. **On join error** (`connection-lifecycle.ts:117-140`): Logs the error (`banned_from_channel`, `invite_only_channel`, `channel_is_full`, `bad_channel_key`, `477/need_to_register`). Takes no further action.

4. **On invite** (`connection-lifecycle.ts:147-163`): Rejoins the configured channel. This is the only existing recovery path for +i channels, and it requires an external user to send an INVITE.

5. **On reconnect**: `joinConfiguredChannels()` fires again on `registered`, so reconnects are fine. The gap is only mid-session join failures.

**Result:** If a rejoin fails for any reason, the bot permanently loses the channel until it reconnects to the server or an operator manually intervenes.

## Fix

Add a periodic channel presence check to `connection-lifecycle.ts` that runs on a configurable interval (default 30s). On each tick:

1. Get the set of configured channels from `configuredChannels`
2. Get the set of channels the bot is currently in from `channelState`
3. For any configured channel NOT in the current set, attempt to JOIN (with key if configured)
4. Log each retry attempt at debug level (not info — these will be noisy on persistent failures)
5. Log at warn level on the first failed attempt per channel, then suppress repeated warnings

This runs in the core, independent of chanmod. It handles every failure case uniformly without needing to know why the bot isn't in the channel.

## Feasibility

- **Alignment**: Core bot behavior — maintaining presence in configured channels is fundamental. Belongs in `connection-lifecycle.ts` alongside the existing join-on-connect and invite-on-join logic.
- **Dependencies**: Requires `channelState` to know which channels the bot is currently in. Already wired into `Bot`.
- **Blockers**: None.
- **Complexity**: **S** (hours) — straightforward timer + set difference.
- **Risk areas**:
  - **Flood**: Attempting to join many channels simultaneously on every tick could trigger server-side throttling. Stagger joins or respect the message queue.
  - **Noisy logs**: A persistently banned channel will generate a warning every 30s forever. Need log suppression after the first warning per channel.
  - **Interaction with chanmod**: chanmod's `rejoin_on_kick` provides fast immediate rejoin (5s). The core timer provides slow persistent retry (30s+). They complement each other — chanmod handles the fast path, the core timer is the safety net. No conflict, but the core timer should not reset chanmod's rejoin rate limiter.
  - **Channel keys**: Must pass the configured key on retry, or keyed channels will never succeed.

## Implementation

### Changes to `src/core/connection-lifecycle.ts`

- [ ] Add `startChannelPresenceCheck()` function:

  ```typescript
  function startChannelPresenceCheck(
    deps: ConnectionLifecycleDeps & {
      channelState: { getChannel(name: string): unknown | undefined };
    },
  ): ReturnType<typeof setInterval> {
    const intervalMs = deps.config.channel_rejoin_interval_ms ?? 30_000;
    const warnedChannels = new Set<string>();

    return setInterval(() => {
      for (const ch of deps.configuredChannels) {
        const inChannel = deps.channelState.getChannel(ch.name) !== undefined;
        if (inChannel) {
          warnedChannels.delete(ch.name); // reset warning suppression on success
          continue;
        }
        if (!warnedChannels.has(ch.name)) {
          deps.logger.warn(`Not in configured channel ${ch.name} — attempting rejoin`);
          warnedChannels.add(ch.name);
        } else {
          deps.logger.debug(`Retrying join for ${ch.name}`);
        }
        deps.client.join(ch.name, ch.key);
      }
    }, intervalMs);
  }
  ```

- [ ] Call `startChannelPresenceCheck()` inside the `registered` handler, after `joinConfiguredChannels()`
- [ ] Store the interval handle and clear it on shutdown (return it from `registerConnectionEvents` or add to deps)

### Changes to `src/bot.ts`

- [ ] Pass `channelState` into `registerConnectionEvents` deps (it's already available on the Bot instance)
- [ ] Store the interval handle returned from the presence check; clear it in `shutdown()`

### Changes to `src/types.ts`

- [ ] Add optional `channel_rejoin_interval_ms` to `BotConfig` (default 30000)

### Config

New optional field in `config/bot.json`:

```json
{
  "channel_rejoin_interval_ms": 30000
}
```

Default: 30000 (30 seconds). Set to 0 to disable.

## Interaction with takeover protection plan

The persistent rejoin timer and the takeover plan's ChanServ UNBAN serve different purposes:

| Scenario                                   | Persistent rejoin (this fix)                          | ChanServ UNBAN (takeover plan)              |
| ------------------------------------------ | ----------------------------------------------------- | ------------------------------------------- |
| Bot kicked + banned                        | Retries every 30s until unbanned                      | Immediately sends UNBAN, then rejoins       |
| Bot kicked, not banned                     | Rejoins on next tick (~30s worst case)                | N/A (chanmod's immediate rejoin handles it) |
| Channel +i set after bot removed           | Retries but fails until +i removed or INVITE received | Sends ChanServ INVITE                       |
| Channel +l full                            | Retries until space opens                             | N/A                                         |
| Manual unban by a human                    | Next tick succeeds                                    | N/A                                         |
| Bot never kicked, just failed initial join | Retries until success                                 | N/A                                         |

They're complementary: ChanServ UNBAN is the fast path (immediate, requires services access), persistent rejoin is the safety net (eventual, no requirements).

## Test plan

1. **Periodic rejoin** (`tests/core/channel-presence.test.ts`):
   - Bot not in configured channel → JOIN sent on next tick
   - Bot in all configured channels → no JOINs sent
   - Channel key passed correctly on retry
   - Interval configurable, 0 disables
   - Warn logged on first miss, debug on subsequent retries
   - Warning resets after successful rejoin + subsequent miss

2. **Integration with existing behavior**:
   - chanmod `rejoin_on_kick` still fires immediately (fast path)
   - Core timer fires independently on its own interval (safety net)
   - Both can coexist without conflict

## Open questions

None.
