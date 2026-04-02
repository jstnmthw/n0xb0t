# Security Audit: Default Bind Configuration

**Date:** 2026-04-02
**Scope:** All 39 registered binds from the running bot, focusing on flag assignments and abuse potential of flagless (`-`) binds.

## Summary

The bind configuration is generally sound. Channel moderation commands (`!op`, `!kick`, `!ban`, etc.) correctly require `+o`. The flagless binds are mostly low-risk public commands or passive event handlers. Three findings warrant attention: a TOCTOU race in DCC session tracking, `!seen` leaking cross-channel activity, and `!greet` leaking registration status.

**Findings:** 0 critical, 3 warning, 3 info

## Findings

### [WARNING] `!seen` exposes cross-channel activity

**Bind:** `pub - "!seen" → seen`
**File:** `plugins/seen/index.ts:42`
**Category:** Information disclosure

**Description:** The `!seen` command is flagless and returns the last channel a user was seen in, along with what they said and when. Since the `pubm` tracker records activity across all channels the bot is in, a user in `#public` can query `!seen secretnick` and learn that `secretnick` was active in `#private` along with a snippet of their message. This leaks cross-channel presence and message content to anyone.

**Remediation:** Restrict `!seen` results to the current channel — only return a match when `record.channel` equals `ctx.channel`. Alternatively, omit the channel name and message text from the response when the querier is not in the recorded channel (which requires checking channel state).

### [WARNING] `!greet` leaks user registration status

**Bind:** `pub - "!greet" → greeter`
**File:** `plugins/greeter/index.ts:102`
**Category:** Information disclosure / user enumeration

**Description:** When invoked with no arguments, `!greet` calls `api.permissions.findByHostmask()` against the caller's hostmask and replies either "No custom greet set." (if no record) or shows the greet. The `set` and `del` subcommands also give different responses for registered vs. unregistered users ("You must be a registered user"). This allows anyone to probe whether their hostmask (or, through social engineering, another person's hostmask) is in the user database. Knowing which hostmasks are registered gives an attacker a starting point for impersonation or privilege escalation.

**Remediation:** Return the same "No custom greet set." message regardless of whether the user is registered. The `set`/`del` paths can keep their distinct error since those already reveal registration status by design (users need to know why `set` fails), but the bare `!greet` path should not distinguish registered-with-no-greet from unregistered.

### [WARNING] DCC session TOCTOU race — duplicate pending connections

**Bind:** `ctcp - "DCC" → core:dcc`
**File:** `src/core/dcc.ts:677` (duplicate check), `src/core/dcc.ts:790` (session write)
**Category:** DoS / resource leak

**Description:** The "already connected" guard at line 677 checks `this.sessions.has()` but not `this.pending`. Sessions are only written to `this.sessions` at line 790 inside `openSession()`, which fires from a TCP `server.once('connection')` callback — well after the guard has passed. Two rapid DCC CHAT requests from the same nick can both pass the duplicate check (neither is in `sessions` yet, both are only in `pending`), both allocate ports, and both open TCP servers. When both TCP connections arrive, the second `sessions.set()` at line 790 overwrites the first session entry without closing the first session's socket. This orphans the first `DCCSession` object and its TCP socket, leaking resources.

The permission gates in `rejectIfInvalid()` (hostmask lookup, flag check, NickServ verify, session limit) are all correct and a null return does properly short-circuit before `acceptDccConnection` is reached. The bind being flagless is a valid pattern since CTCP has no channel context for dispatcher-level checks. The issue is specifically the gap between the duplicate check and the session write.

**Remediation:** Also check `this.pending` for the nick before proceeding. For example, add a `pendingByNick` set or scan `this.pending` values for a matching nick at the top of `rejectIfInvalid()`:

```typescript
// 4. Already connected or pending?
if (this.sessions.has(ircLower(nick, this.casemapping))) {
  this.client.notice(nick, 'DCC CHAT: you already have an active session.');
  return null;
}
for (const p of this.pending.values()) {
  if (ircLower(p.nick, this.casemapping) === ircLower(nick, this.casemapping)) {
    this.client.notice(nick, 'DCC CHAT: a connection is already pending.');
    return null;
  }
}
```

Alternatively, defensively close any existing session in `openSession()` before writing the new one.

### [INFO] CTCP VERSION reveals package name and version

**Bind:** `ctcp - "VERSION" → ctcp`
**File:** `plugins/ctcp/index.ts:25`
**Category:** Information disclosure

**Description:** The VERSION reply includes the bot's package name and version from `package.json`. This is standard IRC behavior (virtually all clients respond to CTCP VERSION), but it does fingerprint the bot software. An attacker targeting hexbot-specific vulnerabilities could use this to confirm the target.

No action needed unless you want to obscure the version. Most bots respond to VERSION and hiding it would be unusual.

### [INFO] Duplicate `invite` binds for core

**Binds:** Two `invite - "*" → core` entries
**Category:** Configuration

**Description:** The bind list shows two identical `invite - "*" → core` entries. This likely means the core invite handler fires twice on each INVITE event. Functionally harmless (the handler checks if it's already in the channel and skips), but it's wasted work and a sign of a double-registration bug.

**Remediation:** Check whether `setupConnectionLifecycle()` or equivalent is called twice, or if there are two separate invite bind registrations in the core module. Remove the duplicate.

## Passed checks

- **Channel moderation commands** (`!op`, `!deop`, `!voice`, `!devoice`, `!halfop`, `!dehalfop`, `!kick`, `!ban`, `!unban`, `!kickban`, `!bans`, `!topic`) — all correctly require `+o`
- **Flood detection** (`pubm`, `join`, `nick` handlers) — flagless but purely defensive; monitors for abuse rather than being abusable
- **Timer binds** (`time "60"`, `time "3600"`) — internal housekeeping with no user-facing attack surface
- **Chanmod passive handlers** (`join`, `mode`, `kick`, `nick`, `quit`) — event tracking with internal flag checks before taking action (auto-op, etc.)
- **Chanmod invite** — flagless at dispatcher level but checks for `n`/`m`/`o` flags internally before joining; correct pattern since INVITE has no channel context for dispatcher-level checks
- **`!help`** — has a per-user cooldown (30s), permission-filters the command list, and sends via privmsg; low risk
- **`!8ball`** — stateless random response; no side effects
- **`!topics`** — read-only theme listing with preview cooldown (60s)
- **`msg "!help"`** — private-message help query; same cooldown and filtering as public

## Recommendations

1. **Fix DCC TOCTOU race** — Check `this.pending` for the nick alongside `this.sessions` in `rejectIfInvalid()`, or defensively close any existing session in `openSession()` before writing the new entry.
2. **Fix `!seen` cross-channel leak** — A one-line check (`if (record.channel !== ctx.channel)`) would restrict results to same-channel activity, which matches user expectations.
3. **Normalize `!greet` responses** — Low effort, prevents user enumeration through the bare `!greet` command.
4. **Investigate duplicate core invite bind** — Quick cleanup, prevents double handler execution.
