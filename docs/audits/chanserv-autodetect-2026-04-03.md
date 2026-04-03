# Security Audit: ChanServ Auto-Detect & chanserv_op Merge

**Date:** 2026-04-03
**Scope:** All files changed in the ChanServ auto-detect feature + message queue integer budget fix

Files audited:

- `plugins/chanmod/chanserv-notice.ts` (new)
- `plugins/chanmod/auto-op.ts` (modified)
- `plugins/chanmod/atheme-backend.ts` (modified)
- `plugins/chanmod/anope-backend.ts` (modified)
- `plugins/chanmod/protection-backend.ts` (modified)
- `plugins/chanmod/mode-enforce.ts` (modified)
- `plugins/chanmod/index.ts` (modified)
- `plugins/chanmod/state.ts` (modified)
- `src/core/message-queue.ts` (modified)

## Summary

The changes are well-structured with good security properties. The notice handler correctly validates the sender identity and uses `api.ircLower()` for all comparisons. The auto-detect flow is conservative — it only grants capabilities the bot actually has, never upgrades beyond what ChanServ reports, and manual overrides are respected. One warning-level finding around ChanServ identity spoofing on non-standard networks.

**Findings:** 0 critical, 1 warning, 2 info

## Findings

### [WARNING] ChanServ notice handler trusts nick-based identity

**File:** `plugins/chanmod/chanserv-notice.ts:90`
**Category:** Identity / IRC-specific

**Description:** The notice handler identifies ChanServ by comparing `ctx.nick` against the configured `chanserv_nick` (default `"ChanServ"`). On standard networks with services, ChanServ's nick is protected and cannot be impersonated. However, on networks without services protection, or where ChanServ uses a non-standard nick that isn't HOLD-protected, an attacker could set their nick to "ChanServ" and send a crafted NOTICE to trick the bot into believing it has founder-level access.

The impact is privilege escalation within the chanmod plugin — the bot would believe it can OP/UNBAN/RECOVER via ChanServ when it actually can't, causing failed commands but no security breach to the channel. The auto-detected access level would be wrong, but the bot can't actually _do_ anything harmful with a false positive — ChanServ would just ignore the commands.

On networks where ChanServ's nick _is_ spoofable, the attacker would also need to win a race against the real ChanServ (if present) since the handler consumes probes FIFO.

**Remediation:** This is acceptable for the current design. The existing `verifyAccess()` pattern (pre-existing, not new) has the same trust model. For defense-in-depth, consider also checking `ctx.hostname` against a configured services hostname pattern (e.g., `services.libera.chat`) in a future hardening pass. This is not urgent because:

1. Networks with services always protect the ChanServ nick
2. The worst case is the bot sends commands ChanServ ignores
3. No channel operations are performed without ChanServ actually executing them

### [INFO] Probe timer list grows unboundedly

**File:** `plugins/chanmod/chanserv-notice.ts:134`
**Category:** DoS / resource

**Description:** `probeState.probeTimers` accumulates timeout timer references. Each `markProbePending()` call pushes a timer. Timers are cleared on teardown, but the array itself grows by one entry per channel per join for the lifetime of the plugin. For a bot in 50 channels that reconnects frequently, this list grows but entries are never removed after they fire.

After the 10s timeout fires, the timer reference in the array is a dead `setTimeout` handle — harmless (no memory leak from the timer itself since Node GCs it), but the array slot persists.

**Remediation:** Low priority. Could filter out fired timers periodically, or use a Set with self-removal in the timeout callback. Not a practical concern unless the bot runs for months with hundreds of reconnects.

### [INFO] syncAccessToSettings may trigger onChange loop

**File:** `plugins/chanmod/chanserv-notice.ts:153-159` and `plugins/chanmod/index.ts:167-177`
**Category:** Logic / correctness

**Description:** `syncAccessToSettings()` writes to `channelSettings` via `api.channelSettings.set()`. The `onChange` handler in `index.ts:167` listens for `chanserv_access` changes and calls `b.setAccess()` on all backends. `setAccess()` clears the `autoDetectedChannels` flag. So the sequence is: auto-detect sets access → sync writes to channelSettings → onChange fires → `setAccess()` clears auto-detected flag.

This means `isAutoDetected()` will return `false` after the sync completes, even though the access was auto-detected. The auto-detected flag is only briefly `true` between the backend's `handleFlagsResponse` setting it and the `syncAccessToSettings` → `onChange` → `setAccess` clearing it.

This doesn't cause a security issue (the access level itself is correct), but the `isAutoDetected()` query may not return the expected value for downstream callers checking it after the sync.

**Remediation:** Either skip the `autoDetectedChannels.delete()` in `setAccess()` when the value matches the current auto-detected value, or set a flag in the sync path to suppress the onChange callback. Low priority since no current code depends on `isAutoDetected()` being true after sync — it's only checked in `syncAccessToSettings` itself which runs before the onChange fires.

## Passed checks

- **Input validation:** All notice text is parsed via regexes with explicit patterns. No user input is interpolated into IRC commands — channel names and nicks come from the bot's own state or regex captures that are validated against `getBotNick()`.
- **Protocol injection:** No `raw()` calls. All ChanServ commands use `api.say()` which goes through the message queue and irc-framework's safe methods.
- **Permissions:** No permission changes in this code. The auto-detect only affects the bot's own ChanServ access tier, not user permissions.
- **Plugin isolation:** All new code is within the chanmod plugin. No cross-plugin imports. Uses only the scoped `PluginAPI`.
- **Credentials:** No secrets handled. ChanServ commands don't include passwords.
- **DoS (message queue):** The integer budget fix in `message-queue.ts` is correct and eliminates the float drift. `Date.now()` returns integer milliseconds, all arithmetic is integer addition/subtraction/comparison. The `Math.min` cap prevents budget overflow. The `Math.max(costMs, burst * costMs)` ensures capacity is always at least one message.
- **IRC-specific:** Case-insensitive comparisons via `api.ircLower()` throughout. Channel names properly lowered for map keys. ChanServ nick comparison is case-insensitive.
- **Error containment:** The notice handler is a bound handler — errors are caught by the dispatcher's try/catch wrapper. Timeout callbacks are lightweight (map delete + debug log).

## Recommendations

1. Consider adding a `services_hostname` config option for stricter ChanServ identity verification in a future hardening pass (addresses the WARNING finding).
2. The probe timer array could self-clean, but this is cosmetic — not worth the complexity now.
3. The `isAutoDetected()` flag behavior after sync should be documented if any future code depends on it.
