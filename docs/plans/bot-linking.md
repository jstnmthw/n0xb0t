# Plan: Bot Linking (Hub/Leaf Botnet)

## Summary

This feature implements bot-to-bot linking, modeled after Eggdrop's botnet architecture: a TCP link protocol where multiple HexBot instances connect in a hub-and-leaf topology, sharing channel/user/permission state, relaying commands, bridging DCC party line chat across bots, supporting session relay (`.relay`), syncing channel ban lists, and providing the transport layer for coordinated channel protection (`BotnetBackend` in the channel-takeover-protection plan). This is entirely separate from the existing DCC CHAT console feature.

---

## 1. Naming Decision

The word "botnet" has been used in two distinct senses in Eggdrop's tradition and in this codebase, and the collision causes confusion:

### What to call each feature

| Feature                                           | Current name in code                            | Correct name              | Rationale                                                                                                       |
| ------------------------------------------------- | ----------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Human DCC CHAT admin sessions with shared console | "botnet" (in messages, comments, command names) | **console**               | A management-forward name that emphasises bot control over chat. The `.console` command lists connected admins. |
| Bot-to-bot TCP link protocol (this feature)       | not yet implemented                             | **bot link** / **botnet** | The bot-to-bot link network. Linked bots are "linked bots" or "bot links".                                      |

### Rename summary for existing code

The following strings in `src/core/dcc.ts` referred to the console incorrectly as "botnet" and have been renamed to "console":

- `*** Botnet: ${botnets}` → `*** Console: ${connected}` ✓
- `.botnet` command → `.console` (`.who` alias kept) ✓
- `Botnet (${list.length}):` → `Console (${list.length}):` ✓
- `has left the botnet` → `has left the console` ✓
- `has joined the botnet` → `has joined the console` ✓

`DESIGN.md`, `docs/DCC.md`, and `src/types.ts` have all been updated. **Phase 1 is complete.**

---

## Feasibility

- **Alignment**: Strong. DESIGN.md section 2.12 anticipates multiple transports feeding the same parser. The `CommandHandler` is transport-agnostic. Bot linking is listed as post-MVP scope.
- **Dependencies**: All present — `CommandHandler`, `Permissions`, `ChannelState`, `BotEventBus`, `DCCManager.announce()`, `sanitize()`, `net` module (Node built-in). No new npm dependencies.
- **Blockers**: None. The console rename in Phase 1 is cosmetic only and does not block Phase 2+.
- **Complexity**: XL — the original protocol/sync/relay core is L, but the additions (party line, channel sharing, session relay, protection frames) bring significant interaction surface.
- **Risk areas**:
  - Permission sync conflict if a leaf mutates its own DB independently — mitigated by hub-authoritative design.
  - `ChannelState` not designed for synthetic event injection — needs new public method.
  - Reconnect logic must avoid thundering-herd if many leaves reconnect simultaneously after hub restart.
  - SHA-256 password hashing is not replay-resistant — document that the link should be on a private network.
  - **Party line flood**: a compromised or misbehaving leaf could flood `PARTY_CHAT` frames to all bots. Mitigated by 5/sec rate limit per leaf on `PARTY_CHAT`.
  - **Relay session lifecycle**: if the hub or target bot crashes mid-relay, the origin bot must cleanly return the user to the local console. Unclean relay teardown could leave a DCC session in a dead state.
  - **Ban sync conflicts**: two bots simultaneously setting/unsetting the same ban on the same channel. Last-write-wins is acceptable; the ban state will converge after the next event.
  - **PROTECT\_\* trust boundary**: a compromised leaf sending `PROTECT_OP #chan attacker` — mitigated by requiring the target nick to exist in the permissions DB, but the permissions DB itself is synced from the hub, so a compromised hub is a total compromise. Document this trust model.

---

## Dependencies

- [x] `CommandHandler` — exists, transport-agnostic
- [x] `Permissions.addUser/removeUser/setGlobalFlags/addHostmask` — exist
- [x] `ChannelState` — exists (needs `injectEvent` public method added)
- [x] `BotEventBus` — exists (needs new event types)
- [x] `DCCManager.announce()` — exists
- [x] `sanitize()` — exists at `src/utils/sanitize.ts`
- [x] `net` module — Node built-in

---

## Phases

### Phase 1: Rename console references ✅ Complete

**Goal:** Clean up the "botnet" naming before adding the real botnet feature so there is no confusion.

- [x] `src/core/dcc.ts` — rename `.botnet` command to `.console`; update all user-visible strings from "botnet" to "console"
- [x] `src/types.ts` — update `DccConfig` JSDoc comment from "DCC CHAT / botnet settings" to "DCC CHAT / console settings"
- [x] `DESIGN.md` — replace all "botnet" in console context
- [x] `docs/DCC.md` — replace all "botnet" occurrences with "console"
- [x] `docs/plans/dcc-botnet.md` — update decision #3 to point to this plan
- [x] **Verify**: `pnpm exec tsc --noEmit` passes; existing DCC tests still pass.

---

### Phase 2: Type system additions ✅ Complete

**Goal:** Extend the type system to support bot linking without breaking existing compilation.

- [x] `src/types.ts` — add `BotlinkConfig` interface (see Config Changes section)
- [x] `src/types.ts` — add `botlink?: BotlinkConfig` to `BotConfig`
- [x] `src/event-bus.ts` — add new event types: `botlink:connected`, `botlink:disconnected`, `botlink:syncComplete`, `user:removed`, `user:flagsChanged`, `user:hostmaskAdded`, `user:hostmaskRemoved`
- [x] `src/command-handler.ts` — add `'botlink'` to `CommandContext.source` union type
- [x] `config/bot.example.json` — add disabled `botlink` block (see Config Changes section)
- [x] **Verify**: `pnpm exec tsc --noEmit` passes clean.

---

### Phase 3: `src/core/botlink.ts` — protocol layer ✅ Complete

**Goal:** Frame serialization, connection management, handshake — no state sync yet.

Three classes in one file, following the `DCCManager`/`DCCSession` pattern from `src/core/dcc.ts`:

**`BotLinkProtocol`** (internal socket wrapper)

- [x] Wraps `net.Socket` with `readline` line framing
- [x] Serializes/deserializes JSON frames; enforces 64 KB max frame size
- [x] Strips `\r`/`\n` from all string fields via `sanitize()`
- [x] Emits typed events: `message`, `close`, `error`

**`BotLinkHub`** (hub role)

- [x] `listen(port, host)` — starts `net.Server`
- [x] Accepts connections, runs four-step handshake (see Protocol Design)
- [x] Authenticates password (`sha256:<hex>` format; never logged)
- [x] Maintains `Map<string, BotLinkLeafConnection>` keyed by botname
- [x] On auth success: broadcasts `BOTJOIN`, initiates state sync (Phase 4)
- [x] Fan-out: frame from one leaf forwarded to all other leaves
- [x] `close()` — tears down all leaf connections and server
- [x] Rate-limit `CMD` frames: max 10/sec per leaf
- [x] Rate-limit `PARTY_CHAT` frames: max 5/sec per leaf (anti-flood)
- [x] `PROTECT_*` frames are NOT rate-limited — they must arrive instantly during takeover response

**`BotLinkLeaf`** (leaf role)

- [x] Connects to hub; sends `HELLO`, waits for `WELCOME` or `ERROR`
- [x] Reconnect with exponential backoff (`reconnect_delay_ms` → `reconnect_max_delay_ms`)
- [x] Exposes `sendCommand(cmd, args, fromHandle, channel)` for command relay (Phase 5)
- [x] Exposes `sendProtect(type, channel, nick)` for protection requests (Phase 8)
- [x] `disconnect()` — closes socket, cancels reconnect timer

- [x] **Verify**: `tests/core/botlink.test.ts` — handshake success, auth failure, frame size limit, reconnect logic.

---

### Phase 4: `src/core/botlink-sync.ts` — state synchronization ✅ Complete

**Goal:** Channel state and permission sync frames.

- [x] `src/core/channel-state.ts` — add `injectEvent(event: string, data: Record<string, unknown>): void` public method (or typed `processJoin`, `processPart`, `processMode` methods)
- [x] `src/core/botlink-sync.ts` — `ChannelStateSyncer.buildSyncFrames(channelState)` → `LinkFrame[]`
- [x] `src/core/botlink-sync.ts` — `ChannelStateSyncer.applyFrame(frame, channelState)`
- [x] `src/core/botlink-sync.ts` — `PermissionSyncer.buildSyncFrames(permissions)` → `LinkFrame[]`
- [x] `src/core/botlink-sync.ts` — `PermissionSyncer.applyFrame(frame, permissions)`
- [x] `src/core/botlink.ts` — implement `SYNC_START`/`SYNC_END` sequence in hub and leaf
- [x] **Verify**: sync serialization roundtrip tests; permission sync tests; `pnpm exec tsc --noEmit` clean.

---

### Phase 5: Command relay ✅ Complete

**Goal:** Permission commands on a leaf are relayed to the hub for execution.

- [x] `src/command-handler.ts` — add `relayToHub?: boolean` to `CommandOptions`
- [x] `src/core/commands/permission-commands.ts` — mark `.adduser`, `.deluser`, `.flags`, `.addhost`, `.delhost` with `relayToHub: true`
- [x] `src/core/botlink.ts` — leaf: intercepts `relayToHub` commands, sends `CMD` frame, waits for `CMD_RESULT`, displays output to originating session
- [x] `src/core/botlink.ts` — hub: receives `CMD` frame, validates `fromHandle` flags against hub's own `Permissions`, executes via `CommandHandler`, sends `CMD_RESULT` back to originating leaf
- [x] `src/core/permissions.ts` — emit `BotEventBus` events (`user:added`, `user:removed`, `user:flagsChanged`, etc.) after each mutation
- [x] `src/core/botlink.ts` — hub: subscribe to `user:*` events on eventBus; broadcast `ADDUSER`/`DELUSER`/`SETFLAGS` frames to all leaves after successful permission command
- [x] **Verify**: leaf `.adduser` test — user appears in both hub and leaf `.users` after relay; permission denial test.

---

### Phase 6: Bot.ts wiring and botlink commands ✅ Complete

**Goal:** Wire botlink into the bot lifecycle; register admin commands.

- [x] `src/bot.ts` — `private _botLinkHub: BotLinkHub | null = null` and `private _botLinkLeaf: BotLinkLeaf | null = null` with public getters
- [x] `src/bot.ts` — in `start()`, after `dccManager` setup: instantiate and start the appropriate role based on `config.botlink.role`
- [x] `src/bot.ts` — in `shutdown()`: call `hub.close()` or `leaf.disconnect()` before bridge detach
- [x] `src/core/commands/botlink-commands.ts` — implement commands (see table below)
- [x] `src/bot.ts` — register `BotlinkCommands` alongside other command modules
- [x] **Verify**: bot starts with `botlink.enabled: false` — no behaviour change. Hub starts and accepts leaf connection in integration smoke test.

**Botlink commands:**

| Command                                 | Flags | Source   | Description                                                       |
| --------------------------------------- | ----- | -------- | ----------------------------------------------------------------- |
| `.botlink status`                       | `m`   | DCC/REPL | Show hub/leaf connection status and linked bot list               |
| `.botlink disconnect <botname>`         | `n`   | DCC/REPL | (Hub only) Disconnect a specific leaf                             |
| `.botlink reconnect`                    | `m`   | DCC/REPL | (Leaf only) Force reconnect to hub                                |
| `.bots`                                 | `m`   | DCC/REPL | List all linked bots (name, role, IRC nick, connected channels)   |
| `.bottree`                              | `m`   | DCC/REPL | Show botnet topology as a visual tree                             |
| `.whom [channel]`                       | `-`   | DCC      | Show all console users across all linked bots (handle, bot, idle) |
| `.relay <botname>`                      | `m`   | DCC      | Transfer DCC session to a remote bot (Phase 9)                    |
| `.bot <botname> <command>`              | `m`   | DCC/REPL | Execute a command on a remote bot, return output                  |
| `.bsay <botname\|*> <target> <message>` | `m`   | DCC/REPL | Send a message via another (or all) linked bots                   |
| `.bannounce <message>`                  | `m`   | DCC/REPL | Broadcast to all console sessions across all linked bots          |

---

### Phase 7: Party line chat across bots ✅ Complete

**Goal:** DCC users connected to different bots can chat with each other in real time, just like Eggdrop's party line. This extends the existing local `broadcast()` in `dcc.ts` across the botnet.

Currently, `DCCManager.broadcast()` sends chat to local sessions only. This phase makes the party line span all linked bots.

- [x] `src/core/dcc.ts` — when a DCC user sends non-command text, in addition to calling `broadcast()` locally, emit a `PARTY_CHAT` frame to the botlink layer
- [x] `src/core/dcc.ts` — on DCC session connect/disconnect, emit `PARTY_JOIN` / `PARTY_PART` frames
- [x] `src/core/botlink.ts` — hub: receive `PARTY_CHAT` from a leaf, fan out to all other leaves, and deliver to the hub's own `DCCManager.announce()` with `<handle@botname>` prefix
- [x] `src/core/botlink.ts` — leaf: receive `PARTY_CHAT` from hub, deliver to local `DCCManager.announce()` with `<handle@botname>` prefix
- [x] `src/core/botlink.ts` — hub: receive `PARTY_JOIN`/`PARTY_PART`, fan out to all leaves. Each bot's `DCCManager` shows `*** handle has joined the console (on botname)` / `*** handle has left the console (on botname)`
- [x] `.whom` command — sends `PARTY_WHOM` request to hub, hub collects local sessions + all leaf sessions, returns `PARTY_WHOM_REPLY`. Output shows all users across all bots:
  ```
  Console (5 users across 3 bots):
    admin (admin!myident@my.vps.com) on hub — connected 2h ago
    oper1 (oper1!oper@shell.net) on leaf1 — connected 45m ago
    oper2 (oper2!op@host.com) on leaf2 — connected 12m ago (idle 5m)
  ```
- [x] Remote chat display format: `<handle@botname> message` (distinguishes local `<handle>` from remote `<handle@botname>`, matching Eggdrop convention)
- [x] Rate-limit `PARTY_CHAT` at 5/sec per leaf to prevent flood
- [x] **Verification**: Two mock bots linked — DCC user on bot A sends chat, DCC user on bot B receives it with `@botA` prefix. `.whom` shows users on both bots. Join/part notifications propagate.

---

### Phase 8: Channel-specific sharing ✅ Complete

**Goal:** Per-channel ban, exempt, and invite list synchronization across linked bots. When one bot bans a hostile user, all bots sharing that channel learn about it and can enforce it. This is Eggdrop's `+shared` channel flag equivalent.

- [x] Add `shared` per-channel setting (default: `false`) — controls whether this channel's ban/exempt/invite lists are synced to linked bots
- [x] `src/core/botlink-sync.ts` — `BanListSyncer`:
  - On link establish: send `CHAN_BAN_SYNC` and `CHAN_EXEMPT_SYNC` for each shared channel (full list)
  - On local ban add (chanmod sets a ban): send `CHAN_BAN_ADD` with `enforce: true` if `enforcebans` is set on the channel
  - On local ban remove: send `CHAN_BAN_DEL`
  - On receive `CHAN_BAN_ADD`: store in local ban tracking; if `enforce: true` and bot has ops, kick matching users (same logic as chanmod's enforcebans)
  - On receive `CHAN_BAN_DEL`: remove from local ban tracking; optionally unban if the ban is currently set on IRC
  - Same pattern for exempts
- [x] Hub fans out `CHAN_BAN_*` / `CHAN_EXEMPT_*` frames to all other leaves (not back to sender)
- [x] Only sync for channels that have `shared: true` on both the sending and receiving bot — a leaf that doesn't operate in `#channel` ignores ban frames for it
- [x] `src/core/botlink.ts` — on `SYNC_START`/`SYNC_END`, include `CHAN_BAN_SYNC` frames for shared channels
- [x] **Verification**: Bot A sets ban in shared channel → Bot B receives `CHAN_BAN_ADD` → if Bot B has ops and `enforcebans`, kicks matching users. Bans for non-shared channels are NOT synced.

---

### Phase 9: Session relay (`.relay`) ✅ Complete

**Goal:** Transfer a DCC session to a remote bot so the operator interacts with it directly, as if they DCC'd into that bot. Eggdrop's `.relay <botname>` equivalent.

The session is proxied, not transferred — the TCP connection stays with the origin bot. Input is forwarded to the target bot via `RELAY_INPUT` frames, and output comes back via `RELAY_OUTPUT` frames. The user sees a seamless experience.

- [x] `.relay <botname>` command — initiates relay:
  1. Origin bot sends `RELAY_REQUEST` to hub, which forwards to target bot
  2. Target bot creates a virtual DCC session (no TCP socket, just a logical session) and responds with `RELAY_ACCEPT`
  3. Origin bot switches the DCC session into relay mode: all user input is forwarded as `RELAY_INPUT` frames instead of being processed locally
  4. Target bot feeds `RELAY_INPUT` into its virtual session's command handler; output is sent back as `RELAY_OUTPUT`
  5. Origin bot writes `RELAY_OUTPUT` lines to the user's DCC session
- [x] `.relay end` or `.quit` from the relayed session terminates the relay:
  - `RELAY_END` frame sent, both sides clean up
  - User returns to their original bot's console
- [x] Virtual session on the target bot:
  - Appears in the target bot's `.console` / `.whom` output (marked as `(relayed from botname)`)
  - Has the same handle and flags as on the origin bot (looked up from synced permissions)
  - Can run any command the user has flags for on the target bot
- [x] Display on relay start: `*** Relaying to <botname>. Type .relay end to return.`
- [x] Display on relay end: `*** Relay ended. Back on <originbot>.`
- [x] Relay broken if the botlink drops — user sees `*** Relay to <botname> lost (link disconnected).` and returns to local console
- [x] **Verification**: User DCC'd to bot A runs `.relay leaf1` → sees leaf1's prompt → runs `.status` (sees leaf1's status) → `.relay end` → back on bot A. Relay survives normal chat. Relay cleanly ends if link drops.

---

### Phase 10: Protection request frames ✅ Complete

**Goal:** Add the `PROTECT_*` frame types that the `BotnetBackend` (from channel-takeover-protection plan) needs to ask peer bots to act on its behalf during takeover recovery.

These frames are the bridge between the bot-linking transport layer and the `ProtectionBackend` interface. They must be implemented before the channel-takeover-protection plan's `BotnetBackend` can be built.

- [x] `src/core/botlink.ts` — handle incoming `PROTECT_*` frames on both hub and leaf:
  - `PROTECT_OP`: if this bot has ops in the channel, `api.op(channel, nick)`. Respond `PROTECT_ACK` with success/failure.
  - `PROTECT_DEOP`: if this bot has ops, `api.deop(channel, nick)`. Respond `PROTECT_ACK`.
  - `PROTECT_UNBAN`: if this bot has ops, find bans matching the requesting bot's hostmask and remove them. Respond `PROTECT_ACK`.
  - `PROTECT_INVITE`: if this bot is in the channel, `api.invite(channel, nick)`. Respond `PROTECT_ACK`.
  - `PROTECT_KICK`: if this bot has ops, `api.kick(channel, nick, reason)`. Respond `PROTECT_ACK`.
- [x] Hub routing: `PROTECT_*` frames are broadcast to all leaves in the target channel (any opped peer can respond). First `PROTECT_ACK` with `success: true` is considered authoritative; subsequent ACKs for the same ref are ignored by the requester.
- [x] `PROTECT_*` frames bypass the `CMD` rate limit — they must arrive instantly during takeover response
- [x] Guard: a bot only acts on `PROTECT_*` if it has ops in the named channel AND the requesting bot is a known linked bot (not a spoofed frame)
- [x] Guard: `PROTECT_OP` only ops nicks that are recognized users in the permissions DB (prevents a compromised leaf from opping arbitrary nicks)
- [x] `src/core/botlink.ts` — expose `sendProtect(type, channel, nick): Promise<boolean>` for the `BotnetBackend` to call. Returns true if any peer ACKed with success within a timeout (default 5s).
- [x] **Verification**: Bot A has ops, Bot B doesn't. Bot B sends `PROTECT_OP #chan BotB` → Hub forwards to Bot A → Bot A ops Bot B → `PROTECT_ACK` success. Test with no opped peers → timeout → ACK failure. Test that PROTECT_OP refuses to op nicks not in the permissions DB.

---

### Phase 11: Passive/aggressive sharing _(deferred)_

> **Deferred** — the hub-authoritative model with `sync_permissions: true/false` covers the primary use case. This phase adds Eggdrop-style per-bot granularity for larger networks.

**Goal:** Per-bot control over sharing direction, matching Eggdrop's passive (`+p`) and aggressive (`+a`) sharing flags.

- [ ] Add per-bot share mode to `BotlinkConfig`: `share_mode: 'none' | 'passive' | 'aggressive'` (default: `'aggressive'` for hub, `'passive'` for leaf)
  - `passive`: bot receives permission/ban updates from hub but does NOT push local changes upstream. Local changes are local-only and will be overwritten on next full sync.
  - `aggressive`: bot both sends and receives changes. Local `.adduser` / `.flags` changes propagate to hub and then to all other bots.
  - `none`: no sharing (bot keeps its own independent user DB)
- [ ] Hub tracks each leaf's share mode and only sends update frames to bots that accept them
- [ ] Conflict resolution: hub's version wins on full sync. With multiple aggressive bots, last-write-wins (same as Eggdrop).

---

### Phase 12: Party line channels _(deferred)_

> **Deferred** — the single party line (channel 0) is sufficient for initial release. Named channels add complexity with minimal immediate value.

**Goal:** Numbered/named party line channels that span linked bots, matching Eggdrop's assoc module.

- [ ] Party line channels numbered 0–99 (0 = default, where all users land)
- [ ] `.chat <number|name>` — switch to a party line channel
- [ ] `.chat off` — leave the party line (invisible, receive no chat)
- [ ] Named channels via `.assoc <number> <name>` — associations broadcast across botnet
- [ ] Each `PARTY_CHAT` / `PARTY_JOIN` / `PARTY_PART` frame includes a `channel: number` field
- [ ] `.whom <channel>` — show users on a specific party line channel

---

### Phase 13: Documentation ✅ Complete

- [x] `docs/BOTLINK.md` — user-facing guide: prerequisites, hub setup, leaf setup, firewall rules, admin commands, troubleshooting
- [x] `DESIGN.md` — add section 2.16 (Bot Linking): topology, protocol, sync strategy, command relay rules
- [x] `docs/plans/dcc-botnet.md` — update decision #3 to link here
- [x] `CHANGELOG.md` — entry under `### Added`

---

## Protocol Design

### Transport

Plain TCP, line-oriented (`\r\n` terminators), JSON-framed. Maximum frame size: 64 KB. Frames exceeding this are treated as protocol errors and the link is dropped.

### Handshake

```
Hub listens on TCP port (e.g. 5051)
Leaf connects

Leaf → Hub:  {"type":"HELLO","botname":"leaf1","password":"sha256:<hex>","version":"0.1.0"}
Hub  → Leaf: {"type":"WELCOME","botname":"hub","version":"0.1.0"}   (success)
          or {"type":"ERROR","code":"AUTH_FAILED","message":"bad password"}

Hub  → Leaf: {"type":"SYNC_START"}
Hub  → Leaf: [CHAN frames, ADDUSER frames, ...]
Hub  → Leaf: {"type":"SYNC_END"}

Link enters steady state: bidirectional event and command relay
```

Password is transmitted as `sha256:<hex-of-shared-secret>`. The `password` field is **never logged** — mask as `[REDACTED]` in any debug output.

Handshake timeout: 30 seconds. If `HELLO` is not received within 30 seconds, close the socket.

### Message Types (steady state)

```typescript
// Heartbeat
{ type: 'PING', seq: number }
{ type: 'PONG', seq: number }

// Channel state
{ type: 'CHAN', channel: string, topic: string, modes: string, users: UserSyncRecord[] }
{ type: 'JOIN', channel: string, nick: string, ident: string, hostname: string }
{ type: 'PART', channel: string, nick: string, reason: string }
{ type: 'QUIT', nick: string, reason: string }
{ type: 'NICK', oldNick: string, newNick: string }
{ type: 'MODE', channel: string, modes: string, params: string[] }
{ type: 'KICK', channel: string, nick: string, by: string, reason: string }
{ type: 'TOPIC', channel: string, topic: string, by: string }

// Ban list
{ type: 'BAN', channel: string, mask: string, setBy: string, setAt: number }
{ type: 'UNBAN', channel: string, mask: string }

// Permissions
{ type: 'ADDUSER', handle: string, hostmasks: string[], globalFlags: string, channelFlags: Record<string,string> }
{ type: 'DELUSER', handle: string }
{ type: 'SETFLAGS', handle: string, globalFlags: string, channelFlags: Record<string,string> }

// Command relay
{ type: 'CMD', command: string, args: string, fromHandle: string, fromBot: string, channel: string | null }
{ type: 'CMD_RESULT', ref: string, output: string[] }

// Bot presence
{ type: 'BOTJOIN', botname: string }
{ type: 'BOTPART', botname: string, reason: string }

// Party line — real-time chat relay across bots (mirrors local DCC broadcast())
{ type: 'PARTY_CHAT', handle: string, fromBot: string, message: string }
{ type: 'PARTY_JOIN', handle: string, fromBot: string }
{ type: 'PARTY_PART', handle: string, fromBot: string, reason: string }
{ type: 'PARTY_WHOM', ref: string } // request: hub responds with PARTY_WHOM_REPLY
{ type: 'PARTY_WHOM_REPLY', ref: string, users: PartyLineUser[] }

// System announcements (non-chat: IRC mirror, system messages)
{ type: 'ANNOUNCE', message: string, fromBot: string }

// Session relay — transfer a DCC session to a remote bot (.relay command)
{ type: 'RELAY_REQUEST', handle: string, fromBot: string }
{ type: 'RELAY_ACCEPT', handle: string, toBot: string }
{ type: 'RELAY_INPUT', handle: string, line: string }   // proxied keystrokes from origin bot
{ type: 'RELAY_OUTPUT', handle: string, line: string }  // proxied output from target bot
{ type: 'RELAY_END', handle: string, reason: string }   // either side terminates

// Channel-specific sharing (per-channel ban/exempt/invite sync)
{ type: 'CHAN_BAN_SYNC', channel: string, bans: { mask: string, setBy: string, setAt: number }[] }
{ type: 'CHAN_BAN_ADD', channel: string, mask: string, setBy: string, setAt: number, enforce: boolean }
{ type: 'CHAN_BAN_DEL', channel: string, mask: string }
{ type: 'CHAN_EXEMPT_SYNC', channel: string, exempts: { mask: string, setBy: string, setAt: number }[] }
{ type: 'CHAN_EXEMPT_ADD', channel: string, mask: string, setBy: string, setAt: number }
{ type: 'CHAN_EXEMPT_DEL', channel: string, mask: string }

// Protection requests (used by BotnetBackend from channel-takeover-protection plan)
{ type: 'PROTECT_OP', channel: string, nick: string, requestedBy: string }
{ type: 'PROTECT_DEOP', channel: string, nick: string, requestedBy: string }
{ type: 'PROTECT_UNBAN', channel: string, nick: string, requestedBy: string }
{ type: 'PROTECT_INVITE', channel: string, nick: string, requestedBy: string }
{ type: 'PROTECT_KICK', channel: string, nick: string, reason: string, requestedBy: string }
{ type: 'PROTECT_ACK', ref: string, success: boolean, message?: string }

// Error
{ type: 'ERROR', code: string, message: string }
```

**`PartyLineUser` record** (used in `PARTY_WHOM_REPLY`):

```typescript
interface PartyLineUser {
  handle: string;
  nick: string; // IRC nick of the DCC user
  botname: string; // which bot they're connected to
  connectedAt: number; // epoch ms
  idle: number; // seconds since last input
}
```

---

## Config Changes

New optional section in `config/bot.json`:

```json
"botlink": {
  "enabled": false,
  "role": "leaf",
  "botname": "leaf1",
  "hub": {
    "host": "192.168.1.10",
    "port": 5051
  },
  "listen": {
    "host": "0.0.0.0",
    "port": 5051
  },
  "password": "changeme-shared-secret",
  "reconnect_delay_ms": 5000,
  "reconnect_max_delay_ms": 60000,
  "max_leaves": 10,
  "sync_permissions": true,
  "sync_channel_state": true,
  "sync_bans": true,
  "ping_interval_ms": 30000,
  "link_timeout_ms": 90000
}
```

| Key                      | Type                | Role | Description                                                   |
| ------------------------ | ------------------- | ---- | ------------------------------------------------------------- |
| `enabled`                | boolean             | both | Enable bot linking. Default: `false`                          |
| `role`                   | `"hub"` \| `"leaf"` | both | This bot's role in the network                                |
| `botname`                | string              | both | Unique name for this bot on the link network (not IRC nick)   |
| `hub.host`               | string              | leaf | Hub's hostname/IP to connect to                               |
| `hub.port`               | number              | leaf | Hub's TCP port                                                |
| `listen.host`            | string              | hub  | Interface to listen on                                        |
| `listen.port`            | number              | hub  | Port to listen on                                             |
| `password`               | string              | both | Shared secret for link auth (same value on all bots)          |
| `reconnect_delay_ms`     | number              | leaf | Initial reconnect delay. Default: 5000                        |
| `reconnect_max_delay_ms` | number              | leaf | Max reconnect delay (exponential backoff cap). Default: 60000 |
| `max_leaves`             | number              | hub  | Maximum concurrent leaf connections. Default: 10              |
| `sync_permissions`       | boolean             | both | Sync user permissions over the link. Default: true            |
| `sync_channel_state`     | boolean             | both | Sync channel user lists over the link. Default: true          |
| `sync_bans`              | boolean             | both | Sync ban/exempt lists for shared channels. Default: true      |
| `ping_interval_ms`       | number              | both | Heartbeat interval. Default: 30000                            |
| `link_timeout_ms`        | number              | both | Drop link if no message received in this time. Default: 90000 |

New `BotlinkConfig` interface in `src/types.ts`:

```typescript
interface BotlinkConfig {
  enabled: boolean;
  role: 'hub' | 'leaf';
  botname: string;
  hub?: { host: string; port: number };
  listen?: { host: string; port: number };
  password: string;
  reconnect_delay_ms?: number;
  reconnect_max_delay_ms?: number;
  max_leaves?: number;
  sync_permissions?: boolean;
  sync_channel_state?: boolean;
  sync_bans?: boolean;
  ping_interval_ms?: number;
  link_timeout_ms?: number;
}
```

---

## Database Changes

None. Bot link sessions and topology are ephemeral (in-memory only). Permission changes that arrive via link sync are persisted to the local bot's existing SQLite DB via the normal `Permissions` API — no schema changes needed.

---

## Security Considerations

1. **Password never logged** — the `HELLO` frame's `password` field must be masked as `[REDACTED]` in all debug output.
2. **Input validation from link** — all string fields from link frames must be sanitized with `sanitize()` before use; nick/ident/hostname validated against IRC character sets before injecting into `ChannelState`.
3. **Hub re-checks permissions** — `CMD` relay uses `fromHandle` to look up flags in the hub's own database; a compromised leaf cannot spoof elevated permissions.
4. **DoS mitigations** — 64 KB frame limit; 30s handshake timeout; 10 CMD/sec rate limit per leaf; `max_leaves` cap.
5. **TLS future** — initial implementation is plaintext TCP; document that the link should be on a private network or VPN. A future `botlink.tls: true` option can use `tls.connect()`/`tls.createServer()`.
6. **SHA-256 password** — not replay-resistant; document. A future improvement is HMAC challenge-response.
7. **File permissions** — `config/bot.json` must be `chmod 600`; the existing world-readable check in `bot.ts` already warns on this.

---

## Test Plan

**Unit tests** (`tests/core/botlink.test.ts`):

- [x] `BotLinkProtocol`: frame serialization roundtrip, oversized frame rejected, `\r\n` stripped from string fields
- [x] Handshake: valid password accepted, wrong password → `ERROR` frame, handshake timeout fires at 30s
- [x] Hub fan-out: frame from leaf1 forwarded to leaf2 and leaf3 but not back to leaf1
- [x] Leaf reconnect: failure triggers retry after delay; succeeds on second attempt
- [x] `ChannelStateSyncer`: `buildSyncFrames` → `applyFrame` roundtrip without data loss
- [x] `PermissionSyncer`: `buildSyncFrames` → `applyFrame` roundtrip; `SETFLAGS` overrides; `DELUSER` removes user

**Party line tests** (`tests/core/botlink-party.test.ts`):

- [x] `PARTY_CHAT` from leaf1 arrives at leaf2 and hub's local DCC sessions with `<handle@leaf1>` prefix
- [x] `PARTY_CHAT` does NOT echo back to the sending leaf
- [x] `PARTY_JOIN` / `PARTY_PART` notifications propagate to all bots
- [x] `.whom` returns users from all linked bots, including idle times
- [x] `PARTY_CHAT` rate limit: 6th message within 1 second is dropped with warning

**Channel sharing tests** (`tests/core/botlink-sharing.test.ts`):

- [x] `CHAN_BAN_ADD` with `enforce: true` → receiving bot kicks matching users if it has ops
- [x] `CHAN_BAN_ADD` for non-shared channel is ignored
- [x] `CHAN_BAN_SYNC` on link establish includes all bans for shared channels only
- [x] `CHAN_BAN_DEL` removes ban from local tracking
- [x] `CHAN_EXEMPT_*` frames follow the same pattern

**Session relay tests** (`tests/core/botlink-relay.test.ts`):

- [x] `.relay botname` → `RELAY_REQUEST` → `RELAY_ACCEPT` → session enters relay mode
- [x] Input in relay mode forwarded as `RELAY_INPUT`, output returned as `RELAY_OUTPUT`
- [x] `.relay end` sends `RELAY_END`, user returns to local console
- [x] Link drop during relay → clean teardown, user back on local console with error message
- [x] Relayed session appears in target bot's `.whom` output as `(relayed from botname)`
- [x] Relayed session can execute commands gated on the user's flags

**Protection frame tests** (`tests/core/botlink-protect.test.ts`):

- [x] `PROTECT_OP` from leaf → hub forwards to all peers in channel → opped peer acts, sends `PROTECT_ACK`
- [x] `PROTECT_OP` refused for nicks not in permissions DB
- [x] `PROTECT_*` not rate-limited (unlike CMD frames)
- [x] No opped peers → `sendProtect()` times out → returns false
- [x] `PROTECT_UNBAN` → peer finds and removes matching bans

**Integration tests** (mock TCP sockets):

- [x] Full handshake between mock hub and mock leaf over loopback
- [x] Sync complete: hub sends `CHAN` + `ADDUSER` + `CHAN_BAN_SYNC` frames, leaf's `ChannelState`, `Permissions`, and ban lists populated
- [x] Command relay: leaf sends `.adduser`, hub executes, both have the user after `CMD_RESULT`
- [x] Party line end-to-end: user on bot A chats → user on bot B sees it → `.whom` shows both
- [x] Session relay end-to-end: `.relay leaf1` → run command on leaf1 → `.relay end` → back on hub
- [x] Protection end-to-end: bot B deopped → sends `PROTECT_OP` → bot A (has ops) re-ops bot B → `PROTECT_ACK`
- [x] Idle timeout: no ping → link dropped after `link_timeout_ms`

---

## Open Questions

1. **Hub chaining**: Should the hub also be able to connect to another hub (forming a chain of hubs)? Deferred for now — hub-and-leaf covers the primary use case.

---

## Decisions

1. **Hub-and-leaf only, no mesh** — avoids cycle-detection complexity. Future improvement can add hub chaining.
2. **JSON framing over custom binary** — development simplicity and debuggability over marginal performance improvement.
3. **Hub is authoritative for permissions** — prevents split-brain. Leaves relay permission commands to hub; hub executes and rebroadcasts.
4. **Channel-specific ban sharing with enforcement** — ban lists sync for channels with `shared: true` on both sides. When `enforce: true`, receiving bots kick matching users (same as Eggdrop's channel sharing with enforcebans). This bridges the link layer and chanmod.
5. **Plaintext TCP initially, TLS later** — avoids certificate management complexity. Document: use on private network or VPN.
6. **No leaf-to-leaf direct connections** — all traffic routes through hub. Simpler topology.
7. **Full party line relay, not just announcements** — `PARTY_CHAT` frames carry real-time DCC user chat across linked bots, matching Eggdrop's party line experience. `ANNOUNCE` frames remain for system messages (IRC mirrors, etc.). Users see `<handle@botname>` for remote chat.
8. **`.botnet` → `.console` rename** — completed in Phase 1 before any bot-link code lands, so the two features are never confused in the codebase.
9. **Session relay is proxied, not transferred** — `.relay` keeps the TCP connection on the origin bot and forwards I/O via `RELAY_INPUT`/`RELAY_OUTPUT` frames. This avoids the complexity of transferring a raw socket across bots and works even when bots have different public IPs. Matches Eggdrop's relay behavior.
10. **PROTECT\_\* frames are first-class, not CMD relay** — protection requests bypass the CMD rate limit and have dedicated frame types. During a takeover, latency matters more than protocol elegance. The `BotnetBackend` from the channel-takeover-protection plan calls `sendProtect()` which maps directly to these frames.
11. **PROTECT_OP validates nicks against permissions DB** — a peer bot will not op an arbitrary nick just because a linked bot asked. The target nick must be a known user. This prevents a compromised leaf from weaponizing the botnet to op attackers.
12. **PROTECT\_\* peer selection: first responder wins** — when multiple peers have ops, any opped peer acts immediately on a `PROTECT_*` frame. Race conditions are accepted; duplicate MODEs are harmless (server ignores redundant +o). This matches Eggdrop's approach and gives the fastest response time.
13. **All-channel sync scope** — leaves receive channel state sync frames for ALL channels the hub knows about, not just channels the leaf is in. This enables global ban enforcement, complete `.whom` output, and protection decisions based on full network awareness. HexBot botnets are typically small enough that the overhead is negligible.
14. **Link auth is sufficient for relayed commands** — no NickServ ACC verification for relayed commands. The shared-secret link password authenticates the bot; the bot authenticated the DCC user via hostmask. Adding ACC would add latency without meaningful security benefit — if the link is compromised, ACC won't help.
15. **Relay auth uses synced permissions DB** — when a user relays to a remote bot, the target bot looks up the handle in its local (hub-synced) permissions DB. If the handle isn't found (sync incomplete), the relay is rejected with an error. This avoids trusting origin-bot assertions while using the existing sync infrastructure.
