# Plan: `chanmod` v2 — Refactor + Protection Features

## Summary

Two related changes in one plan:

1. **Refactor** the existing `plugins/chanmod/index.ts` (~820 lines, one monolithic `init()`
   function) into a multi-file plugin using a shared-state dependency-injection pattern. Each
   logical concern gets its own module file. The refactor must not change observable behavior.

2. **Add** Eggdrop-style protection features (rejoin on kick, revenge, bitch mode, protect ops,
   enforcebans, topic protection, stopnethack, nick recovery) as a new `protection.ts` module that
   slots cleanly into the refactored structure.

The protection features are merged into `chanmod` rather than a separate plugin because they share
significant state with the existing code (intentional-mode tracking, enforcement cooldowns, flag
lookups, `botHasOps` checks), and Eggdrop itself makes no architectural distinction between
moderation and protection — both are channel settings enforced by the same event handlers.

## Feasibility

- **Alignment**: Fits DESIGN.md. All IRC events needed (`kick`, `mode`, `raw`, `join`, `nick`,
  `time`) are already dispatched by `irc-bridge.ts`. All required API methods exist.
- **Blockers**: None. Refactor is pure internal restructuring; protect features use existing APIs.
- **Complexity**: M — refactor is mechanical but careful (no behavior change); protection features
  add new bind handlers on top of the clean structure.
- **Risk areas**:
  - Refactor must preserve all existing behavior exactly. Shared state passed by reference across
    modules; easy to introduce subtle initialization-order bugs.
  - Protection features interact with existing mode-enforcement handlers. Shared intentional-mode
    and cooldown state is the coordination mechanism — must be initialized once and passed to all
    modules that need it.
  - Bitch mode + ChanServ: `nodesynch_nicks` exemption must fire before bitch-mode deop or
    ChanServ-given ops get stripped.
  - Revenge timing: bot may not have ops immediately after rejoin (waiting for ChanServ).

## Proposed file structure

```
plugins/chanmod/
├── index.ts          # Plugin entry point — thin orchestrator, wires modules together
├── helpers.ts        # Shared pure utilities (botHasOps, buildBanMask, isBotNick, etc.)
├── state.ts          # SharedState interface + factory (intentionalModeChanges, cooldowns, etc.)
├── bans.ts           # Timed ban storage, auto-expire, liftExpiredBans
├── auto-op.ts        # Join handler: auto-op, auto-halfop, auto-voice, NickServ verification
├── mode-enforce.ts   # Mode handler: re-op enforcement, channel mode enforcement, bitch mode,
│                     #   protect ops (punish unauthorized deop), cycle-on-deop
├── protection.ts     # Adversarial: rejoin on kick, revenge, enforcebans, topic protect,
│                     #   stopnethack, nick recovery
├── commands.ts       # !op !deop !halfop !dehalfop !voice !devoice !kick !ban !unban !kickban !bans
└── config.json       # Extended with protection settings
```

## Module API pattern

Each module exports a single `setup*` function that registers its binds and returns a teardown:

```typescript
// example: auto-op.ts
export function setupAutoOp(api: PluginAPI, config: ChanmodConfig, state: SharedState): () => void {
  api.bind('join', '-', '*', async (ctx) => {
    /* ... */
  });
  return () => {
    /* clear any timers */
  };
}
```

`index.ts` creates `SharedState` once, calls each `setup*`, collects teardown functions:

```typescript
export function init(api: PluginAPI): void {
  const config = readConfig(api);
  const state = createState();
  teardowns = [
    setupBans(api, config, state),
    setupAutoOp(api, config, state),
    setupModeEnforce(api, config, state),
    setupProtection(api, config, state),
    setupCommands(api, config, state),
  ];
}

export function teardown(): void {
  for (const td of teardowns) td();
  teardowns = [];
}
```

## Phases

### Phase 0: Refactor (no behavior change)

**Goal:** Split the monolithic `init()` into focused module files. Tests must pass before and after.
All existing config keys, bind types, command names, and log messages must be preserved exactly.

- [ ] Create `plugins/chanmod/state.ts`:
  - Define `SharedState` interface: `intentionalModeChanges: Map<string, number>`,
    `enforcementCooldown: Map<string, {count: number; expiresAt: number}>`,
    `cycleTimers: ReturnType<typeof setTimeout>[]`, `cycleScheduled: Set<string>`,
    `enforcementTimers: ReturnType<typeof setTimeout>[]`, `startupTimer: ... | null`
  - Export `createState(): SharedState` factory

- [ ] Create `plugins/chanmod/helpers.ts`:
  - Move `getBotNick`, `isBotNick`, `botHasOps`, `botCanHalfop`, `isValidNick`,
    `markIntentional`, `wasIntentional`, `getUserFlags`, `parseModesSet`, `formatExpiry`
  - Functions that need `api` take it as a parameter (no module-level `api` variable)

- [ ] Create `plugins/chanmod/bans.ts`:
  - Move `banDbKey`, `storeBan`, `removeBanRecord`, `getAllBanRecords`, `getChannelBanRecords`,
    `liftExpiredBans`, `buildBanMask`
  - Export `setupBans(api, config, state): () => void` — registers the `time` bind (60s cleanup)
    and the startup timer that lifts bans expired during downtime

- [ ] Create `plugins/chanmod/auto-op.ts`:
  - Move the `join` bind handler (auto-op, auto-halfop, auto-voice, bot-join mode check)
  - Export `setupAutoOp(api, config, state): () => void`

- [ ] Create `plugins/chanmod/mode-enforce.ts`:
  - Move the `mode` bind handler (channel mode enforcement, user re-op enforcement, cycle-on-deop)
  - Export `setupModeEnforce(api, config, state): () => void`

- [ ] Create `plugins/chanmod/commands.ts`:
  - Move all `pub` bind handlers: `!op`, `!deop`, `!halfop`, `!dehalfop`, `!voice`, `!devoice`,
    `!kick`, `!ban`, `!unban`, `!kickban`, `!bans`
  - Export `setupCommands(api, config, state): () => void`

- [ ] Define `ChanmodConfig` interface in `index.ts` (or a `config-types.ts`) to type the config
      object passed to each module — eliminates the repeated `as X | undefined` casts throughout

- [ ] Rewrite `plugins/chanmod/index.ts` as the thin orchestrator

- [ ] Verify: `pnpm test` passes. Manually reload the plugin in a running bot; behavior identical.

### Phase 1: Rejoin on kick + revenge

**Goal:** Bot rejoins after being kicked. Optionally deops/kicks/bans the kicker afterward.

- [ ] Confirm `kick` bind ctx field layout by reading `src/irc-bridge.ts` kick handler (which
      field is the kickee vs. the kicker?)

- [ ] Create `plugins/chanmod/protection.ts`, export `setupProtection(api, config, state): () => void`

- [ ] Implement rejoin-on-kick:
  - Bind `kick` (`*`): if kickee field matches bot nick, record `{channel, kickerNick, kickerHostmask}`
  - Rate-limit via `api.db` key `rejoin_attempts:<channel>` — skip if `max_rejoin_attempts`
    exceeded within `rejoin_attempt_window_ms`
  - `setTimeout(() => api.join(channel), rejoin_delay_ms)`

- [ ] Implement revenge:
  - If `revenge_on_kick` enabled, schedule second timer at `rejoin_delay_ms + revenge_delay_ms`
  - Skip if kicker no longer in channel, or no `botHasOps`, or kicker has `revenge_exempt_flags`
  - `"deop"` → `api.deop()`; `"kick"` → `api.kick()`; `"kickban"` → `api.ban()` + `api.kick()`
  - Call `markIntentional(channel, kickerNick)` before acting so `mode-enforce.ts` doesn't react

- [ ] Wire `setupProtection` into `index.ts`; add timer cleanup to returned teardown

- [ ] Verification: kick the bot → rejoins; with `revenge_on_kick: true` → deops the kicker

### Phase 2: Bitch mode + protect ops + enforcebans + topic protection

**Goal:** Strict op control, punishment for unauthorized deops, ban enforcement, topic restoration.

**Bitch mode** (add to `mode-enforce.ts`):

- [ ] Extend the `mode` bind to also handle `+o`/`+h`:
  - Only when `bitch: true`; skip `nodesynch_nicks`; skip if setter is the bot
  - If newly-opped user lacks the required flags → `markIntentional` then `api.deop()`/`api.dehalfop()`

**Protect ops — punish unauthorized deop** (add to `mode-enforce.ts`):

- [ ] Extend the existing `-o`/`-h`/`-v` handler after its re-op logic:
  - When `punish_deop: true` and setter lacks `o`+ flags but target had them → punish setter
  - Reuse `SharedState.enforcementCooldown`; max 2 punishments per setter per 30s
  - `"kick"` → `markIntentional` then `api.kick()`; `"kickban"` → ban+kick

**Enforcebans** (add to `mode-enforce.ts`):

- [ ] Extend `mode` bind to detect `+b`:
  - Only when `enforcebans: true`
  - Test all channel users against the new ban mask via `src/utils/wildcard.ts`
  - Kick matching users; mark kicks as intentional

**Topic protection** (add to `protection.ts`):

- [ ] `raw` bind for `332` (RPL_TOPIC) → store initial topic in `api.db` as `topic:<channel>`
- [ ] `raw` bind for `TOPIC` lines → parse setter; if unauthorized, restore via `api.topic()`;
      if authorized, update stored topic; if bot-originated, mark intentional and update

- [ ] Verification: bitch mode deops unrecognized ops; unauthorized deop triggers punishment;
      ban set kicks matching users; unauthorized topic change is restored.

### Phase 3: Nick recovery + stopnethack (optional)

**Nick recovery** (add to `protection.ts`):

- [ ] `raw` bind for `433` (ERR_NICKNAMEINUSE) — note desired nick is taken
- [ ] `nick` bind — when a user changes away from the desired nick, attempt `api.raw('NICK <desired>')`
- [ ] `raw` bind for QUIT — when desired nick's holder quits, attempt reclaim
- [ ] Backoff: max one attempt per 30s
- [ ] If `nick_recovery_ghost: true` and services available, send NickServ GHOST (use
      `botConfig.services.password`; never log it)

**Stopnethack** (add to `protection.ts`):

- [ ] `stopnethack_mode: 0` = off, `1` = isoptest (deop unless in permissions db with `o`+ flags),
      `2` = wasoptest (deop unless had ops before split)
- [ ] `raw` bind — detect netsplit (3+ QUITs with `*.net *.split` message within 5s); snapshot
      current ops per channel; set `split_timeout_ms` expiry
- [ ] `mode`/`join` bind — on server-granted `+o` during/after split, apply configured check
- [ ] Default: `stopnethack_mode: 0`; document heuristic edge cases in README

## Config changes

Extended `plugins/chanmod/config.json` — all existing keys unchanged, new keys appended:

```json
{
  "rejoin_on_kick": true,
  "rejoin_delay_ms": 5000,
  "max_rejoin_attempts": 3,
  "rejoin_attempt_window_ms": 300000,

  "revenge_on_kick": false,
  "revenge_action": "deop",
  "revenge_delay_ms": 3000,
  "revenge_kick_reason": "Don't kick me.",
  "revenge_exempt_flags": "nm",

  "bitch": false,

  "punish_deop": false,
  "punish_action": "kick",
  "punish_kick_reason": "Don't deop my friends.",

  "enforcebans": false,

  "topic_protect": false,

  "nick_recovery": true,
  "nick_recovery_ghost": false,

  "stopnethack_mode": 0,
  "split_timeout_ms": 300000
}
```

**Eggdrop comparison** (for chanmod README):

| Eggdrop setting        | chanmod equivalent                                 | Default        |
| ---------------------- | -------------------------------------------------- | -------------- |
| `+protectops` (re-op)  | `enforce_modes`                                    | false          |
| `+protectops` (punish) | `punish_deop`                                      | false          |
| `+bitch`               | `bitch`                                            | false          |
| `+enforcebans`         | `enforcebans`                                      | false          |
| `+cycle`               | `cycle_on_deop`                                    | false          |
| bot kick → rejoin      | `rejoin_on_kick`                                   | true           |
| `+revengebot` + mode 0 | `revenge_on_kick: true, revenge_action: "deop"`    | —              |
| `+revengebot` + mode 2 | `revenge_on_kick: true, revenge_action: "kick"`    | —              |
| `+revengebot` + mode 3 | `revenge_on_kick: true, revenge_action: "kickban"` | —              |
| topic lock (Tcl)       | `topic_protect`                                    | false          |
| `stopnethack-mode N`   | `stopnethack_mode`                                 | 0              |
| `+nodesynch`           | `nodesynch_nicks` list                             | `["ChanServ"]` |

## Database changes

No new tables. Extended `api.db` (namespaced KV) usage:

- `ban:<channel>:<mask>` — existing; unchanged
- `rejoin_attempts:<channel>` — JSON `{count, windowStart}` for rejoin rate-limiting
- `topic:<channel>` — last known authorized topic for topic-protect restoration

## Test plan

All existing `chanmod` tests must pass unchanged after Phase 0 (refactor regression gate).

New tests per phase:

**Phase 1:**

- Bot kicked → `join()` called after `rejoin_delay_ms`
- Rejoin suppressed after `max_rejoin_attempts` in window
- `revenge_action: "deop"` → `deop()` called on kicker after delay
- `revenge_action: "kick"` / `"kickban"` variants
- Revenge skipped: kicker has `revenge_exempt_flags`
- Revenge skipped: bot has no ops after rejoin

**Phase 2:**

- Bitch: user opped without flags → deopped immediately
- Bitch: user opped with `o` flag → not deopped
- Bitch: setter in `nodesynch_nicks` → not deopped
- Punish deop: non-op deops flagged user → setter kicked
- Punish deop: op deops someone → no punishment
- Punish deop: rate-limit suppresses after 2 per 30s
- Enforcebans: `+b` set → matching in-channel user kicked
- Topic: non-op changes topic → bot restores saved topic
- Topic: op changes topic → saved, not restored

## Open questions

1. **Kick ctx fields**: confirm kickee vs. kicker field mapping in `src/irc-bridge.ts` before
   Phase 1 — do not guess.

2. **Revenge window**: should revenge only fire if the kicker is still in the channel within 60s
   of the bot rejoining? (Suggested: yes.)

3. **Punish deop + enforce modes simultaneously**: chanmod will re-op the victim AND kick the
   offender at the same time. Eggdrop does exactly this. Confirmed as desired?

4. **Topic protect bot-echo**: some IRCd implementations echo back the setter's own TOPIC to them.
   Verify on target network before Phase 2; use intentional-topic flag if needed.

5. **Nick recovery password**: uses `botConfig.services.password`; must never appear in logs.
   Acceptable, or prefer a separate `nick_recovery_password` field in config?
