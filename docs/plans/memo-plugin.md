# Plan: Memo / Notes System

## Summary

A core memo and notes system inspired by Eggdrop's `notes.mod` and IRC network MemoServ. Three layers:

1. **MemoServ relay** (primary use case) — When MemoServ sends the bot a notice (e.g. vhost approval, new memo), forward it to online owners/masters via NOTICE and DCC console. This is the driving need: the owner requests something on behalf of the bot (via REPL), the network responds via MemoServ, and the owner needs to see it.

2. **Internal notes** (Eggdrop-style) — `.note <handle> <message>` via DCC console or REPL. Owners and masters (`n`/`m` flags) can leave notes for each other. On DCC connect or join, the user gets "You have N unread note(s)."

3. **Public flag-gated commands** — `!memo <handle> <message>` and `!read <id>` in channel, requiring `m`/`n` flags. Replies via NOTICE (private). Gives admins a way to send/read notes without needing a DCC session.

**Who can use it:** Only users with `n` (owner) or `m` (master) flags. This is an admin tool, not a public messaging platform.

## Feasibility

- **Alignment**: Core module is appropriate — needs DCC console integration (`CommandHandler`), direct access to `Permissions` for flag checking and handle resolution. The public commands register through the same `CommandHandler` that DCC/REPL/IRC share.
- **Dependencies**: All required infrastructure exists — `CommandHandler` (DCC/REPL/IRC), `Permissions`, `BotDatabase`, `notice` dispatcher type for MemoServ relay, `DCCManager` for console delivery.
- **Blockers**: None.
- **Complexity estimate**: M (a day) — core module with DCC integration is slightly more involved than a standalone plugin.
- **Risk areas**:
  - **DCC delivery timing**: User may connect to DCC after MemoServ notice arrives. Need to queue MemoServ messages and deliver on next DCC connect, not just relay in real-time.
  - **Handle resolution**: Public `!memo` command needs to resolve a nick to a bot handle. If the target nick isn't in any channel, we can still accept the handle directly.
  - **MemoServ nick varies**: Different networks use different service nicks. Must be configurable.

## Dependencies

- [x] `CommandHandler` — shared command router for REPL/DCC/IRC
- [x] `Permissions` — flag checking, handle lookup, `findByHostmask()`
- [x] `BotDatabase` — `_memo` namespace for note storage
- [x] `DCCManager` — deliver notes on DCC console connect
- [x] `notice` bind type in dispatcher — intercept MemoServ notices
- [x] `join` bind type — trigger delivery notification on channel join
- [x] `ChannelState` — find online n/m users across channels for relay

## Phases

### Phase 1: MemoServ relay

**Goal:** Forward MemoServ notices to online owners/masters. This is the primary use case.

- [ ] Create `src/core/memo.ts` with `MemoManager` class
- [ ] Wire in `bot.ts` — create after IRC connect, pass `client`, `permissions`, `channelState`, `db`, `dccManager`, `logger`
- [ ] Register `notice` bind via dispatcher (or direct IRC client listener like `Services` does):
  - Only process private notices (`ctx.channel === null`)
  - Match sender nick against configurable `memoserv_nick` (default `"MemoServ"`)
  - On match: forward to all online `n`/`m` users via NOTICE
  - Also push to all connected DCC console sessions
  - Store the MemoServ message in DB (`_memo` namespace) as a note from `"MemoServ"` so it persists if no admin is online
- [ ] Config in `bot.json` (new optional top-level key):
  ```json
  "memo": {
    "memoserv_relay": true,
    "memoserv_nick": "MemoServ",
    "max_notes_per_user": 50,
    "max_note_length": 400,
    "max_age_days": 90,
    "delivery_cooldown_seconds": 60
  }
  ```
- [ ] **Verify:** Connect to a network with MemoServ, send the bot a memo, confirm owner gets a NOTICE and DCC console message

### Phase 2: Internal notes via DCC/REPL

**Goal:** Eggdrop-style `.note` command on the partyline. Owners/masters can leave notes for each other.

- [ ] Register `.note <handle> <message>` command in `CommandHandler` (flags `m`):
  - Validate target handle exists in permissions DB
  - Validate target has `n` or `m` flags (can't note random +o users)
  - Store note in DB: key `note:<recipient_handle>:<id>`, value `{ from, to, message, timestamp, read }`
  - Auto-increment sequence via `note_seq` key
  - Confirm: `"Note sent to <handle>."`
- [ ] Register `.notes` command (flags `m`) — list unread notes for the calling user
  - Show ID, sender, timestamp, preview (first ~80 chars)
- [ ] Register `.readnote <id>` command (flags `m`) — display full note, mark as read
- [ ] Register `.delnote <id|all>` command (flags `m`) — delete note(s)
- [ ] Register `.notes-purge [handle]` command (flags `n`) — owner-only: purge notes for a handle or all
- [ ] On DCC connect: check for unread notes, show `"You have N unread note(s). Type .notes to read."`
- [ ] Register help entries for all commands
- [ ] **Verify:** DCC in, `.note` yourself, disconnect, reconnect, see the notification, `.notes`, `.readnote`, `.delnote`

### Phase 3: Public flag-gated IRC commands

**Goal:** Admins can send/read notes from a channel without needing DCC.

- [ ] Register `!memo <handle> <message>` command via dispatcher bind (`pub`, flags `m`):
  - Resolve nick → handle if a nick is given (via channel state + `findByHostmask()`)
  - Same validation as `.note` — target must be n/m handle
  - Store note, confirm via NOTICE to sender
- [ ] Register `!memos` command (`pub`, flags `m`) — list unread notes via NOTICE
- [ ] Register `!read <id>` command (`pub`, flags `m`) — read note via NOTICE, mark as read
- [ ] Register `!delmemo <id|all>` command (`pub`, flags `m`) — delete via NOTICE confirmation
- [ ] Auto-delivery on join: bind `join` handler, resolve joiner → handle, check for unread notes:
  - If joiner has `n`/`m` flags and unread notes: NOTICE `"You have N unread note(s). Use !memos to read."`
  - Per-user cooldown (configurable, default 60s) to prevent spam on multi-channel joins
- [ ] Cooldown tracking: in-memory `Map<handle, lastNotifiedTimestamp>` (cleared on restart — re-notifying is fine)
- [ ] **Verify:** In channel, `!memo admin Check the vhost status`, join on alt, see notification, `!memos`, `!read`

### Phase 4: Cleanup and expiry

**Goal:** Prevent note accumulation, handle edge cases.

- [ ] Hourly timer: expire notes older than `max_age_days`
- [ ] Enforce `max_notes_per_user` on write — reject with "mailbox full" message
- [ ] `teardown()` / shutdown cleanup — clear cooldown map and any timers
- [ ] **Verify:** Set `max_age_days` to 0, confirm stale notes are cleaned up

## Config changes

New optional key in `config/bot.json`:

```json
"memo": {
  "memoserv_relay": true,
  "memoserv_nick": "MemoServ",
  "max_notes_per_user": 50,
  "max_note_length": 400,
  "max_age_days": 90,
  "delivery_cooldown_seconds": 60
}
```

Requires adding `MemoConfigSchema` to `src/config.ts` and `MemoConfig` interface to `src/types.ts`.

## Database changes

Uses existing `kv` table with reserved `_memo` namespace (core module convention).

**Keys:**

| Key pattern          | Value                                        | Purpose                  |
| -------------------- | -------------------------------------------- | ------------------------ |
| `note:<handle>:<id>` | `{ from, to, message, timestamp, read }`     | Individual note          |
| `note_seq`           | `"<number>"`                                 | Auto-increment counter   |
| `memoserv:<id>`      | `{ message, timestamp, read, relayed_to[] }` | Stored MemoServ messages |

## Test plan

- **Unit tests** (`tests/core/memo.test.ts`):
  - MemoServ relay: notice from configured nick → stored + forwarded to n/m users
  - MemoServ relay: notice from other nick → ignored
  - `.note` stores note with correct fields, rejects non-n/m targets
  - `.notes` lists only unread notes for the calling handle
  - `.readnote` marks note as read
  - `.delnote` removes note, `.delnote all` removes all for user
  - `max_notes_per_user` enforced — reject when full
  - `max_note_length` enforced — reject when too long
  - Join delivery: n/m user with unread notes gets NOTICE
  - Join delivery: cooldown prevents re-notification within window
  - Join delivery: non-n/m user gets no notification even if notes exist
  - Expiry timer removes notes older than `max_age_days`
  - `.notes-purge` (owner only) clears notes for a handle

## Resolved decisions

1. **Architecture**: Core module (`src/core/memo.ts`), not a plugin. Needs DCC console access and direct CommandHandler integration.
2. **Who can use it**: Only `n` (owner) and `m` (master) flagged users. This is an admin tool.
3. **Access layers**: DCC/REPL (`.note`, `.notes`, `.readnote`, `.delnote`), IRC channel (`!memo`, `!memos`, `!read`, `!delmemo`) — both require m/n flags.
4. **Recipient resolution**: Handle-first with nick fallback for public commands. DCC commands use handles directly.
5. **Cross-channel delivery**: Once per 60s cooldown window, regardless of channel.
6. **MemoServ relay**: Stored persistently so notes survive if no admin is online when MemoServ sends.
