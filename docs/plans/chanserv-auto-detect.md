# Plan: ChanServ Auto-Detect & chanserv_op Merge

## Summary

The chanmod plugin has all the ChanServ recovery plumbing (Atheme/Anope backends, ProtectionChain, takeover escalation) but it's gated behind two settings that both default to off: `chanserv_access` (default `'none'`) and `chanserv_op` (default `false`). This means a freshly configured bot with ChanServ access won't auto-recover from deop, kick, or ban — it just logs "manual intervention required."

This plan implements:

1. **Option D (immediate):** Warn on join when takeover detection is on but no ChanServ access is configured
2. **Option C (main):** Auto-detect ChanServ access on join via FLAGS/ACCESS LIST probes, and merge `chanserv_op` into `chanserv_access` (if access >= op, auto-reop is implied)

## Feasibility

- **Alignment:** Fully compatible with DESIGN.md. The ProtectionBackend interface already has `verifyAccess()` / `handleFlagsResponse()` / `handleAccessResponse()` — they just need to be wired up. The `chanserv_op` merge is a simplification, not an architecture change.
- **Dependencies:** All existing — `atheme-backend.ts`, `anope-backend.ts`, `protection-backend.ts`, `auto-op.ts` (bot join handler), `mode-enforce.ts` (deop handler), `protection.ts` (kick handler). No new core modules needed.
- **Blockers:** The ChanServ notice handler is **completely unwired** — `handleFlagsResponse()` and `handleAccessResponse()` exist in the backends and are tested, but no chanmod notice bind calls them. This is the key gap beyond configuration defaults.
- **Complexity estimate:** M (day) — touching 6-7 files, mostly small surgical changes, plus a new notice handler module
- **Risk areas:**
  - ChanServ response format varies between Atheme versions (FLAGS output) — the parsers exist and are tested, so this is acceptable
  - Auto-detect must not override an explicit manual `.chanset chanserv_access` — we distinguish "auto-detected" from "manually set"
  - Timing: FLAGS probe is async (ChanServ responds via NOTICE) — the bot must handle being attacked before the probe response arrives
  - Removing `chanserv_op` immediately — existing configs with it set must not error, just log a warning

## Dependencies

- [x] Atheme backend with `verifyAccess()` and `handleFlagsResponse()` — exists
- [x] Anope backend with `verifyAccess()` and `handleAccessResponse()` — exists
- [x] ProtectionChain with `verifyAccess()` — exists
- [x] `auto-op.ts` bot-join handler — exists
- [x] `mode-enforce.ts` deop handler with `chanserv_op` check — exists
- [x] Dispatcher `notice` event type — exists in irc-bridge

## Phases

### Phase 1: Warning on incomplete config (Option D)

**Goal:** Immediately surface the misconfiguration so operators see it in logs on every bot join.

- [x] **`plugins/chanmod/auto-op.ts`** — In the bot-join handler (line 21-38), after `api.requestChannelModes(channel)`, add a check: if `takeover_detection` is enabled for this channel AND `chanserv_access` is `'none'` (not explicitly set), log a prominent warning:

  ```
  [plugin:chanmod] ⚠ Takeover detection enabled for #channel but chanserv_access is 'none' — bot cannot self-recover. Set via: .chanset #channel chanserv_access op
  ```

  Gate on `!api.channelSettings.isSet(channel, 'chanserv_access')` so the warning only fires when using the default, not when someone deliberately set it to 'none'.

- [x] **Verification:** Start the bot, confirm the warning appears for each channel where takeover_detection=true and chanserv_access is unset. Confirm it does NOT appear when chanserv_access has been explicitly set to any value.

### Phase 2: Wire ChanServ notice handler

**Goal:** Connect the existing `handleFlagsResponse()` / `handleAccessResponse()` backend methods to actual ChanServ NOTICE events so that `verifyAccess()` probes actually complete.

- [x] **Create `plugins/chanmod/chanserv-notice.ts`** — New module that binds a `notice` handler filtered to the ChanServ nick. It parses incoming notices and routes them to the appropriate backend method:
  - **Atheme FLAGS response:** Matches format `"FLAGS: <channel> <nick> <flags>"` or numbered format `"2 <nick> <flags>"` — calls `athemeBackend.handleFlagsResponse(channel, flags)`
  - **Anope ACCESS LIST response:** Matches format containing the bot's nick and a numeric level — calls `anopeBackend.handleAccessResponse(channel, level)`
  - Handler ignores notices that don't match expected patterns (ChanServ sends many notice types)
  - Must use `api.ircLower()` for all nick/channel comparisons
  - Log parsed results at debug level

- [x] **`plugins/chanmod/index.ts`** — Import and call `setupChanServNotice(api, config, chain)` in `init()`. Pass the concrete backend instance (not just the chain) so the notice handler can call `handleFlagsResponse` / `handleAccessResponse` directly. Add its teardown to the teardowns array.

- [x] **Verification:** Unit test: mock a ChanServ notice with FLAGS response, verify `handleFlagsResponse` is called with correct args. Integration: start bot, check logs for "access verified" or "downgrading" messages after joining a channel with chanserv_access configured.

### Phase 3: Auto-detect ChanServ access on join

**Goal:** When the bot joins a channel, automatically probe ChanServ and set `chanserv_access` based on the response — eliminating the need for manual `.chanset` on every channel.

- [x] **`plugins/chanmod/atheme-backend.ts`** — Modify `handleFlagsResponse()` (line 144-160): When `configured === 'none'` and the probe finds real flags, **auto-set** the access level instead of silently returning. Add a boolean `autoDetected` field to the access map (or a parallel `Set<string>` tracking which channels were auto-detected vs manually set). Log:

  ```
  Atheme: auto-detected access for #channel — flags '+AOehiortv' (tier: 'op')
  ```

- [x] **`plugins/chanmod/anope-backend.ts`** — Same change to `handleAccessResponse()` (line 172-186): When `configured === 'none'`, auto-set based on the detected level instead of returning.

- [x] **`plugins/chanmod/protection-backend.ts`** — Add `isAutoDetected(channel: string): boolean` method to `ProtectionBackend` interface and both implementations. Add to `ProtectionChain` as well. This distinguishes auto-detected access from manual `.chanset` — important so that:
  - Manual `.chanset chanserv_access none` is respected (not overridden by auto-detect)
  - Auto-detected values can be refreshed on each join
  - The Phase 1 warning only fires for channels where access is genuinely unknown (not auto-detected, not manually set)

- [x] **`plugins/chanmod/auto-op.ts`** — Modify bot-join handler (line 25-37): Always call `chain.verifyAccess(channel)` on join, regardless of current access level. Currently it only probes when `access !== 'none'`, which means the auto-detect probe never fires for unconfigured channels. Remove the `if (access !== 'none')` guard around the verify call. Keep the `setAccess` call for manually-configured channels.

- [x] **`plugins/chanmod/chanserv-notice.ts`** — After the backend's `handleFlagsResponse` / `handleAccessResponse` updates the access level, sync it back to `channelSettings` so that `.chaninfo` shows the auto-detected value and other code that reads `chanserv_access` via channelSettings gets the right answer.

- [x] **Update Phase 1 warning** — Amend the warning condition: suppress it if the channel has been auto-detected (access probe is in-flight or completed). The warning should only fire after a timeout (e.g., 5s after join) if neither manual config nor auto-detect has set the access level. If no ChanServ response arrives within 10s, log at debug level: `"ChanServ access probe for #channel timed out — no services response (access remains 'none')"`. This is debug-level (not warn) because no-ChanServ networks are a valid configuration.

- [x] **Verification:** Unit test: mock the full flow — bot joins, FLAGS probe sent, ChanServ NOTICE arrives, access level auto-set, backend capabilities unlocked. Test that `chain.canOp()` returns true after auto-detect. Test that manual `.chanset chanserv_access none` is NOT overridden by auto-detect.

### Phase 4: Merge chanserv_op into chanserv_access

**Goal:** Eliminate the `chanserv_op` footgun. If `chanserv_access >= op`, the bot always requests re-op when deopped. The separate flag becomes unnecessary.

- [x] **`plugins/chanmod/mode-enforce.ts`** — In the bot self-deop handler (line 270-337), replace the `chanserv_op` flag check (line 277-278) with a check on the ProtectionChain's access level:

  ```typescript
  // Old: const chanservOp = api.channelSettings.getFlag(channel, 'chanserv_op');
  // New: derive from access level — if chain can op, always request re-op
  const chanservOp = chain?.canOp(channel) ?? false;
  ```

  This also removes the fallback direct ChanServ message (line 291-303), which was only needed because `chanserv_op` could be true while `chanserv_access` was 'none'. With auto-detect, the chain always knows whether it can OP.

- [x] **`plugins/chanmod/index.ts`** — Remove the `chanserv_op` channel setting registration entirely. If the setting key is encountered in existing DB rows it's harmless (unknown keys are ignored by channelSettings). Log a one-time deprecation notice on init if `chanserv_op` is present in the plugin's config JSON:

  ```
  [plugin:chanmod] chanserv_op config key is removed — ChanServ re-op is now automatic when chanserv_access >= op. You can delete this key from plugins.json.
  ```

- [x] **`plugins/chanmod/state.ts`** — Remove `chanserv_op` from `ChanmodConfig` interface and `readConfig()`. Remove `chanserv_op_delay_ms` as well (the delay is folded into the existing `chanserv_op_delay_ms` config field on the ProtectionChain path, which remains as `enforce_delay_ms` or can be kept as a renamed timing config if needed). Actually, keep `chanserv_op_delay_ms` — it controls the delay before requesting OP and is still used in mode-enforce.ts. Only remove `chanserv_op: boolean`.

- [x] **`plugins/chanmod/protection.ts`** — In the kick handler (line 95-96), `chanserv_unban_on_kick` is already gated on `chain.canUnban()`. Verify this still works correctly with auto-detect — it should, since `canUnban()` checks access level, not `chanserv_op`. No change needed here, just verification.

- [x] **Verification:** Test that deopping the bot triggers a ChanServ OP request when `chanserv_access >= op`, without needing `chanserv_op`. Test that existing configs with `chanserv_op: true` in plugins.json log the deprecation notice but don't error.

### Phase 5: End-to-end takeover recovery test

**Goal:** Verify the full attack scenario from the bug report works correctly.

- [x] **`tests/plugins/chanmod-auto-detect.test.ts`** — New test file covering:
  1. Bot joins channel → FLAGS probe sent → ChanServ responds → access auto-detected as 'op'
  2. Bot is deopped → ChanServ OP request sent automatically (no chanserv_op flag needed)
  3. Bot is kicked → UNBAN + rejoin + OP request sent
  4. Bot is banned → threat escalates → UNBAN sent at level 2, RECOVER sent at level 3 (if founder access)
  5. Manual `.chanset chanserv_access none` → auto-detect does NOT override → no recovery attempted

- [x] **`tests/plugins/chanmod-chanserv-notice.test.ts`** — Unit tests for the notice parser:
  1. Atheme FLAGS format parsing (various flag strings)
  2. Anope ACCESS LIST format parsing (various levels)
  3. Ignoring non-ChanServ notices
  4. Ignoring malformed ChanServ notices
  5. Case-insensitive nick matching

## Config changes

No new config fields. Changes to existing:

```jsonc
// plugins.json — chanmod section
{
  // REMOVED (behavior now implicit from chanserv_access):
  // "chanserv_op": false,  ← removed, ignored if still present (logs notice)
  // UNCHANGED but now auto-detected on join:
  // "chanserv_services_type": "atheme",  ← still needed to select backend
  // "chanserv_nick": "ChanServ",         ← still needed for notice matching
}
```

Per-channel `.chanset` changes:

- `chanserv_access` — Still works as before for manual override. New behavior: if not set, auto-detected from ChanServ on join.
- `chanserv_op` — Removed. No longer registered as a channel setting. Existing DB entries are harmless (ignored by channelSettings).

## Database changes

None.

## Test plan

| Test file                          | What it verifies                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `chanmod-auto-detect.test.ts`      | **New.** Full auto-detect flow, deop/kick/ban recovery with auto-detected access, manual override respected, deprecated config accepted |
| `chanmod-chanserv-notice.test.ts`  | **New.** Notice parser for Atheme FLAGS and Anope ACCESS LIST responses, timeout behavior, edge cases                                   |
| `chanmod-atheme-backend.test.ts`   | **Extended.** Auto-set from 'none' on FLAGS response, `isAutoDetected()`                                                                |
| `chanmod-anope-backend.test.ts`    | **Extended.** Auto-set from 'none' on ACCESS response, `isAutoDetected()`                                                               |
| `chanmod-protection-chain.test.ts` | **Updated.** `verifyAccess` now probes all backends, `isAutoDetected` on mock                                                           |
| `chanmod-takeover.test.ts`         | **Updated.** Mock backend includes `isAutoDetected`, removed `chanserv_op` from config                                                  |
| `chanmod-speed-opt.test.ts`        | **Updated.** Removed `chanserv_op` setting, tests use `chanserv_access` only                                                            |
| `chanmod.test.ts`                  | **Updated.** Re-op tests rewritten for `chanserv_access`-based behavior, verify-on-join test reflects always-probe                      |

## Decisions

1. **`chanserv_op` removal:** Remove immediately. The flag is ignored starting now. Existing configs with it set get a one-time log notice but no error.

2. **No-ChanServ networks:** 10s timeout on unanswered probe, debug-level log. Access stays 'none' — correct for networks without services.

3. **Re-probe frequency:** Probe on every bot join (including rejoins after kick). ChanServ access can change between joins. Cost is 1 PRIVMSG + 1 NOTICE per channel per join. On reconnect with many channels (e.g., 50), probes queue up and drain at the configured message queue rate (default 2/sec) alongside other outgoing traffic — no special staggering needed.
