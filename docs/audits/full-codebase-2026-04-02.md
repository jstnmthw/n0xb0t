# Security Audit: Full Codebase

**Date:** 2026-04-02
**Scope:** All `.ts` files in `src/` and `plugins/` — every core module, utility, command handler, and plugin
**Prior audit:** `botlink-enforce-2026-04-01.md` — 10 findings, all resolved

## Summary

The codebase is in strong security shape. The previous bot-link audit remediated the most critical issues (PROTECT\_\* permission guards, mask validation, identity spoofing, rate limiting). This full-codebase audit found **0 critical, 8 warning, 8 info** findings. The warnings are defense-in-depth improvements and resource leak fixes; no remotely exploitable vulnerabilities were identified.

**Findings:** 0 critical, 8 warning, 8 info

## Findings

### [WARNING-1] `.adduser` / `.flags` commands do not prevent privilege escalation by +m users

**File:** `src/core/commands/permission-commands.ts:14-35, 59-109`
**Category:** Permissions / Privilege escalation

**Description:** The `.adduser` command requires `+n` (owner), which is correct. However, `.flags` requires `+n|+m` — meaning a master (+m) user can run `.flags <handle> +n` to grant owner flags to any handle, including their own. A +m user can escalate to +n.

The flag hierarchy intends `n > m > o > v`, but there's no guard preventing a +m user from setting flags higher than their own level.

**Mitigating factor:** +m is intended as a "user management" flag and is only given to trusted users. The current behavior may be intentional — some bot frameworks allow masters to grant any flag. However, it violates the principle of least privilege.

**Remediation:** Add a guard in `.flags` that prevents setting flags higher than the caller's own level. A +m user should only be able to grant +m, +o, or +v — not +n:

```typescript
// In .flags handler, before setting:
if (ctx.source !== 'repl') {
  const callerRecord = permissions.findByHostmask(`${ctx.nick}!${ctx.ident}@${ctx.hostname}`);
  if (callerRecord && !callerRecord.global.includes('n')) {
    if (flagsArg.includes('n')) {
      ctx.reply('Only owners can grant the +n flag.');
      return;
    }
  }
}
```

---

### [WARNING-2] `.bsay` and `.bannounce` don't sanitize messages for IRC protocol injection

**File:** `src/core/commands/botlink-commands.ts:369-421, 423-456`
**Category:** Input validation

**Description:** The `.bsay` command sends a message via a linked bot using `ircSay(target, message)` where `message` comes directly from user input without `sanitize()`. While `client.say()` in irc-framework handles framing, the message is also sent as a `BSAY` frame to remote bots. On the receiving end (`bot.ts`), the leaf calls `this.client.say(String(frame.target ?? ''), String(frame.message ?? ''))` — also without sanitize.

Similarly, `.bannounce` passes user input through DCC `announce()` and ANNOUNCE frames without sanitization.

The `sanitizeFrame()` in botlink.ts strips `\r\n\0` from all string fields in frames, which mitigates the injection vector. However, the local `ircSay` call in `.bsay` (line 383: `ircSay(target, message)`) bypasses frame sanitization since it goes directly to the IRC client.

**Mitigating factor:** `client.say()` in irc-framework splits on `\r\n` internally, preventing raw protocol injection. The risk is limited to crafting messages with control characters that could confuse IRC clients visually.

**Remediation:** Apply `sanitize()` to the message in the `.bsay` local send path:

```typescript
const sendLocal = () => {
  if (ircSay) ircSay(target, sanitize(message));
  ...
};
```

---

### [WARNING-3] `stripFormatting()` regex strips digits after non-color control characters

**File:** `src/utils/strip-formatting.ts:12`
**Category:** Input validation / Correctness

**Description:** The regex `/[\x02\x03\x04\x0F\x11\x16\x1D\x1E\x1F](\d{1,2}(,\d{1,2})?)?/g` captures the optional `(\d{1,2}(,\d{1,2})?)` digit group after ANY control character, not just `\x03` (color) and `\x04` (hex color). This means `\x02` (bold) followed by digits will eat up to 2 digits. For example, `\x0212 users online` would strip `\x0212` producing ` users online` — removing the actual text "12".

The irc-bridge has a separate inline `stripFormatting()` (`irc-bridge.ts:51-59`) with a different regex that only captures digits after `\x03`. Having two divergent implementations is also a maintenance risk.

**Remediation:** Restructure the regex to only capture digit parameters after `\x03` and `\x04`:

```typescript
const IRC_FORMAT_RE =
  /\x03(\d{1,2}(,\d{1,2})?)?\x04([0-9a-fA-F]{6})?|[\x02\x0F\x11\x16\x1D\x1E\x1F]/g;
```

Also, replace the inline version in `irc-bridge.ts` with an import of the shared utility.

---

### [WARNING-4] Hub does not clean up `activeRelays`, `cmdRoutes`, or `protectRequests` on leaf disconnect

**File:** `src/core/botlink.ts:845-861, 590-600`
**Category:** DoS / Resource exhaustion

**Description:** When a leaf disconnects (`onLeafClose` or `disconnectLeaf`), the hub cleans up `remotePartyUsers` but does NOT clean up three other maps:

- `activeRelays` — relay sessions involving the disconnected leaf remain forever
- `cmdRoutes` — pending CMD responses routed through the disconnected leaf remain forever
- `protectRequests` — pending PROTECT_ACK responses from the disconnected leaf remain forever

A malfunctioning or malicious leaf could accumulate entries by sending many PROTECT frames with unique refs and then disconnecting. The other side of active relays is also never notified.

**Remediation:** In `onLeafClose` and `disconnectLeaf`, iterate and clean up entries referencing the disconnected botname from all three maps. For `activeRelays`, send `RELAY_END` to the other side.

---

### [WARNING-5] `channel-state` `onPart` uses non-null assertion that can crash

**File:** `src/core/channel-state.ts:208-210`
**Category:** Robustness

**Description:** Line 209 uses `this.channels.get(...)!.users.delete(...)` with a non-null assertion. If a PART event arrives for a channel not in the Map (race condition or delayed event), this throws a TypeError. The `onKick` handler at line 231 correctly uses a null check: `const ch = this.channels.get(...); if (ch) ch.users.delete(...)`.

**Remediation:** Apply the same safe pattern: `const ch = this.channels.get(...); if (ch) ch.users.delete(...)`.

---

### [WARNING-6] REPL broadcasts all commands to DCC sessions including sensitive operations

**File:** `src/repl.ts:125`
**Category:** Information leakage

**Description:** Line 125 broadcasts every REPL command verbatim to all DCC sessions: `this.bot.dccManager?.announce('*** REPL: ${trimmed}')`. If the operator types `.say NickServ IDENTIFY password` or any command containing sensitive data, it's sent to all connected DCC users who may have lower privilege levels (e.g., `+m` but not `+n`).

**Mitigating factor:** The REPL user has physical access (highest trust). DCC users must have at least the configured `require_flags`. In practice, operators rarely type credentials at the REPL.

**Remediation:** Either suppress broadcast for commands containing known sensitive patterns (IDENTIFY, GHOST, password keywords), or only broadcast to `+n` sessions.

---

### [WARNING-7] BSAY frame lacks authorization check on the hub

**File:** `src/core/botlink.ts:509-523`
**Category:** Permissions

**Description:** The `.bsay` command requires `+m` flags, but that check happens at the command layer on the originating bot. The hub's `handleBsay()` accepts BSAY frames from any authenticated leaf without re-checking flags. A compromised leaf can bypass the command-layer check by sending raw BSAY frames to make any bot in the network say anything on any channel.

**Mitigating factor:** BSAY is in the `HUB_ONLY_FRAMES` set, so leaves can't fan it out to other leaves — only the hub processes BSAY locally. The attack requires a compromised leaf, not just a regular user.

**Remediation:** Add a `fromHandle` field to BSAY frames and verify the handle has `+m` flags on the hub before executing. Alternatively, verify the BSAY originated from a CMD relay that already passed flag checks.

---

### [WARNING-8] Nick recovery sends NickServ password via `api.say()` instead of services module

**File:** `plugins/chanmod/protection.ts:170`
**Category:** Credentials

**Description:** The nick recovery feature sends `api.say('NickServ', 'GHOST ${desiredNick} ${config.nick_recovery_password}')` through the plugin API rather than through the services module. The password is also stored in `plugins.json` rather than `bot.json`, violating SECURITY.md §6: "Plugin configs should not contain secrets."

**Mitigating factor:** DCC session mirroring only captures incoming messages, not outgoing `say()` calls. The actual credential exposure risk is limited to log files if debug logging captures outgoing messages.

**Remediation:** Move `nick_recovery_password` to `bot.json` under a chanmod section. Route the GHOST command through the services module.

---

### [INFO-1] INVITE auto-join handler has no rate limiting

**File:** `src/core/connection-lifecycle.ts:199-215`
**Category:** DoS

**Description:** The core INVITE handler in `bindCoreInviteHandler()` auto-joins configured channels on invite with no rate limiting. An attacker who can send INVITE messages (requires channel ops or appropriate ircd config) could repeatedly kick the bot and invite it back, causing a join/part loop.

**Mitigating factor:** The bot only joins channels that are in its configured channel list. The channel presence check timer (30s default) already handles missed channels. IRC servers also rate-limit JOIN commands.

**Remediation:** Add a per-channel cooldown (e.g., 30s) to the invite handler to prevent rapid rejoin loops. Low priority since IRC server-side rate limiting already provides some protection.

---

### [INFO-2] `findByNick()` matches on nick portion only — weaker than hostmask matching

**File:** `src/core/permissions.ts:211-227`
**Category:** Permissions

**Description:** `findByNick()` only matches the nick portion of stored hostmask patterns. This is used by `botlink-protect.ts` for the PROTECT_OP/DEOP/KICK permission guards. If a user has hostmask `*!*@trusted.host`, `findByNick("anyone")` would NOT match (correct). But if they have `someuser!*@*`, `findByNick("someuser")` would match regardless of actual host (also correct for the threat model — the guard is "is this nick in the permissions DB at all").

**Mitigating factor:** The PROTECT\_\* guards use `findByNick()` as a "is this a known user" check, not as an authorization check. The ops check (`hasOps`) and the permissions DB entry check work together. A nick collision (attacker using a registered nick) is mitigated by NickServ verification in the auto-op path.

**Remediation:** Document that `findByNick()` is a weak lookup suitable only for "known user" checks, not for granting privileges. Consider adding a comment to the method.

---

### [INFO-3] `botUser!.modes` assertion in flood plugin could throw on stale state

**File:** `plugins/flood/index.ts:84`
**Category:** DoS / Robustness

**Description:** `botHasOps()` in the flood plugin uses `botUser!.modes.includes('o')` with a non-null assertion. If the bot's own user entry is somehow missing from the channel user list (e.g., during a desync or race between quit/rejoin), this would throw and crash the handler.

**Mitigating factor:** The dispatcher wraps all handler calls in try/catch, so this would log an error rather than crash the bot. The chanmod plugin's `botHasOps()` helper correctly uses optional chaining: `botUser?.modes.includes('o') ?? false`.

**Remediation:** Change to safe access: `return botUser?.modes.includes('o') ?? false;`

---

### [INFO-4] DCC party line chat is not sanitized for IRC formatting injection

**File:** `src/core/dcc.ts:377`
**Category:** Output safety

**Description:** When a DCC user sends party line chat, it's broadcast to other sessions as `<${this.handle}> ${trimmed}` without stripping IRC formatting codes from the message content. A local DCC user could send bold/color codes to confuse other DCC users' terminal displays.

**Mitigating factor:** DCC users are authenticated (hostmask + flag check + optional NickServ). This is a trusted channel between known users. The risk is cosmetic annoyance, not security. Remote party line messages (from botlink) are already stripped via `stripFormatting()` in `bot.ts`.

**Remediation:** Low priority. If desired, apply `stripFormatting()` to the message in `DCCSession.onLine()` before broadcasting. Not recommended as DCC users may intentionally use formatting.

---

### [INFO-5] `seen` plugin stores user-controlled text in DB without length validation beyond truncation

**File:** `plugins/seen/index.ts:28-39`
**Category:** DoS / Storage

**Description:** The seen plugin stores the last message for every nick that speaks in any channel. While text is truncated to 200 chars, there's no limit on the number of unique nicks tracked. An attacker could join with many different nicks and speak once each, growing the DB unboundedly.

**Mitigating factor:** The hourly cleanup (`cleanupStale`) removes entries older than `max_age_days` (default 365). SQLite handles large tables gracefully. The `db.list('seen:')` call in cleanup iterates all entries, which scales linearly but is acceptable for typical IRC usage.

**Remediation:** Consider adding a max-entries limit or more aggressive cleanup for nicks not in the permissions DB. Low priority — this is a theoretical concern for extreme abuse scenarios.

### [INFO-6] `irc-bridge.ts` has its own `stripFormatting()` divergent from the shared utility

**File:** `src/irc-bridge.ts:51-59`
**Category:** Code quality / Maintenance

**Description:** The IRC bridge maintains a separate inline `stripFormatting()` implementation with a different regex than the shared utility at `src/utils/strip-formatting.ts`. The bridge version uses `String.fromCharCode()` and does not include `\x04` (hex color) or `\x11` (monospace). Having two implementations that strip different character sets creates inconsistency.

**Remediation:** Import and use the shared `stripFormatting` from `src/utils/strip-formatting.ts`.

---

### [INFO-7] Help and topic plugin cooldown maps use wrong case function

**File:** `plugins/help/index.ts:93`, `plugins/topic/index.ts:167`
**Category:** IRC-specific / DoS bypass

**Description:** The help plugin's cooldown uses `ctx.nick` as the Map key without IRC case normalization. The topic plugin uses `ctx.nick.toLowerCase()` instead of `api.ircLower(ctx.nick)`. On IRC networks using RFC 1459 casemapping, `[user]` and `{user}` are the same nick but produce different keys, allowing cooldown bypass.

**Remediation:** Use `api.ircLower(ctx.nick)` for cooldown keys in both plugins.

---

### [INFO-8] `SlidingWindowCounter` has no cleanup of stale keys

**File:** `src/utils/sliding-window.ts:6-18`
**Category:** DoS / Memory

**Description:** The `SlidingWindowCounter` stores timestamps per key. The `filter()` call prunes old timestamps within a key on access, but keys that are never accessed again (users who left) remain in the Map forever. In high-traffic scenarios with many unique hostmasks, this Map grows without bound.

**Mitigating factor:** Each key stores only timestamp arrays that are pruned on access. The practical growth rate is slow for typical IRC usage. The flood plugin's `SlidingWindowCounter` instances are reset on plugin teardown/reload.

**Remediation:** Add a periodic sweep method that removes keys with empty timestamp arrays, or cap the total number of keys.

---

## Passed checks

### Input validation

- **IRC bridge**: All fields (`nick`, `ident`, `hostname`, `target`, `message`) are sanitized via `sanitize()` before entering the dispatcher (`irc-bridge.ts:145-149`)
- **IRC commands**: All `raw()` calls use `sanitize()` on every interpolated value (`irc-commands.ts:62-177`)
- **Admin commands**: `.say`, `.msg` validate targets with regex; `.invite` checks for `\r\n` before processing (`irc-commands-admin.ts:49, 116, 135-136`)
- **DCC input**: `sanitize()` applied to nick/message mirrored from IRC notices/privmsgs (`dcc.ts:479, 487`)
- **Greeter**: Custom greets stripped of `\r\n`; nick stripped via `stripFormatting()` before display (`greeter/index.ts:84, 96, 134`)
- **Seen**: Output uses `stripFormatting()` on stored nick, channel, and text (`seen/index.ts:72-74`)
- **Bot link frames**: `sanitizeFrame()` strips `\r\n\0` from all string fields before processing (`botlink.ts`)

### Protocol injection

- **No eval/Function usage anywhere in the codebase** — confirmed via codebase-wide grep
- **No string-concatenated SQL** — all database operations use prepared statements (`database.ts:80-94`)
- **No user input in `raw()` without sanitize()** — all 11 `raw()` call sites verified

### Permissions

- **Dispatcher flag check**: Always runs before handlers, including ACC verification gate (`dispatcher.ts:282-296`)
- **Owner flag implies all**: Correctly implemented in `userHasFlag()` (`permissions.ts:337-338`)
- **DCC flag check**: Runs before port allocation, not after (`dcc.ts:634-641`)
- **Chanmod commands**: All `!op/!deop/!kick/!ban` require `+o` flag (`chanmod/commands.ts:104-366`)
- **Admin commands**: `.say/.join/.part` require `+o`; `.adduser/.deluser` require `+n` (`irc-commands-admin.ts`, `permission-commands.ts`)
- **Bot link commands**: `.botlink/.bots/.bot` require `+m`; `.whom` is `-` (no security data exposed) (`botlink-commands.ts`)

### Plugin isolation

- **Scoped API frozen**: `Object.freeze(api)` applied to all plugin API objects (`plugin-loader.ts:437`)
- **DB namespace enforcement**: Plugin DB access scoped to `pluginId` at the API layer (`plugin-loader.ts:631-643`)
- **Password never exposed**: Plugin-facing `botConfig.services` omits password field (`plugin-loader.ts:393`)
- **Channel keys hidden**: Plugin sees only channel names, not keys (`plugin-loader.ts:385`)
- **Error containment**: Dispatcher wraps all handlers in try/catch (`dispatcher.ts:298-304`)
- **Teardown called**: Plugin unload calls teardown and unbinds all (`plugin-loader.ts:292-336`)

### Credentials

- **No passwords in logs**: NickServ password never logged (verified `services.ts:98` — only logs "Sent IDENTIFY")
- **SASL credentials**: Handled by irc-framework internally, never touched by HexBot code
- **Config file**: `bot.json` is in `.gitignore`; example configs contain only placeholders

### DoS resistance

- **Flood protection**: Per-user sliding window with owner bypass (`dispatcher.ts:162-192`)
- **CTCP rate limiting**: Max 3 responses per nick per 10s (`irc-bridge.ts:134-138`)
- **Bot link rate limiting**: CMD at 10/sec, PARTY*CHAT at 5/sec, PROTECT*\* at 20/sec per leaf (`botlink.ts`)
- **Frame size cap**: 64KB max frame size with immediate disconnect on oversized frames (`botlink.ts`)
- **Max leaves**: Configurable limit on simultaneous leaf connections (`botlink.ts`)
- **Timer minimum**: 10-second floor for timer binds prevents tight loops (`dispatcher.ts:212-221`)
- **Message splitting**: Long replies split at 440-char boundaries (`split-message.ts`)
- **Mode batching**: MODES limit respected from ISUPPORT (`irc-commands.ts:139-155`)
- **DCC session limit**: Configurable max_sessions cap (`dcc.ts:644-646`)
- **DCC idle timeout**: Sessions auto-close after configurable idle period (`dcc.ts:381-386`)
- **Rejoin rate limiting**: Per-channel attempt window prevents kick/rejoin loops (`chanmod/protection.ts:73-94`)

### IRC-specific

- **NickServ race**: Dispatcher enforces `require_acc_for` at dispatch time via verification gate (`dispatcher.ts:288-295`)
- **Auto-op ACC**: Chanmod auto-op explicitly awaits NickServ verification before granting modes (`chanmod/auto-op.ts:43-59`)
- **Case-insensitive**: `ircLower()` used consistently for nick/channel comparisons throughout
- **Insecure hostmask warning**: `nick!*@*` patterns for privileged users trigger `[security]` log warnings (`permissions.ts:371-387`)
- **Topic protection**: Authorized changes update the stored topic; unauthorized changes are reverted (`topic/index.ts:193-211`)
- **Stopnethack**: Split-op detection with configurable modes (isoptest/wasoptest) (`chanmod/protection.ts:198-262`)

### Bot link (verified from prior audit)

- **Frame sanitization**: All string fields stripped of `\r\n\0` via `sanitizeFrame()`
- **Password hashing**: SHA-256 hash comparison, never plaintext
- **Identity enforcement**: Hub overwrites `frame.fromBot` with authenticated botname
- **CMD session verification**: Hub verifies `fromHandle` has active party line session
- **PROTECT\_\* guards**: DEOP/KICK refuse to act on recognized users
- **Ban mask validation**: Masks must contain `!` and `@`, rejects `*!*@*`
- **Party line stripping**: IRC formatting stripped from handle, botname, and message fields

## Recommendations

**Priority fixes (code changes):**

1. **[WARNING-1]** Add privilege escalation guard to `.flags` — prevent +m from granting +n. Most impactful finding.
2. **[WARNING-3]** Fix `stripFormatting()` regex — digit stripping after non-color control chars is a correctness bug.
3. **[WARNING-4]** Add map cleanup on leaf disconnect — `activeRelays`, `cmdRoutes`, `protectRequests` leak entries.
4. **[WARNING-5]** Fix `onPart` non-null assertion in channel-state — trivial one-line fix.
5. **[WARNING-2]** Add `sanitize()` to `.bsay` local send path — one-line defense-in-depth fix.
6. **[INFO-3]** Fix `!` assertion in flood plugin's `botHasOps()` — trivial defensive fix.
7. **[INFO-6]** Replace irc-bridge's inline `stripFormatting` with import of shared utility.
8. **[INFO-7]** Use `api.ircLower()` for cooldown keys in help and topic plugins.

**Consider (design decisions):**

9. **[WARNING-6]** Decide whether REPL broadcast to DCC should be filtered for sensitive commands.
10. **[WARNING-7]** Decide whether BSAY should require flag verification on the hub (tradeoff: hub trust model).
11. **[WARNING-8]** Move `nick_recovery_password` from plugin config to `bot.json` per SECURITY.md §6.

**Overall assessment:** The codebase consistently applies defense-in-depth: sanitize at boundaries, validate before acting, fail closed. No remotely exploitable vulnerabilities were found. The security model is well-implemented and well-documented.
