# Plan: Topic Plugin Fixes + Command Redesign

## Summary

The topic plugin has three bugs and an awkward command surface. Bugs: (1) IRC color codes are
stripped from command arguments before plugins see them; (2) `!settopic` never actually enables
`protect_topic` despite saying "locked"; (3) the bot's own TOPIC echo re-triggers the protection
handler and can loop. Beyond the bug fixes, the command surface is being simplified: `!settopic`
is replaced by explicit `!topic lock` / `!topic unlock` subcommands so that setting a topic and
locking it are two intentional steps. This aligns with how ChanServ separates TOPIC from
TOPICLOCK and keeps the REPL / `.chanset` state readable via `.chaninfo`.

**Decided answers (from user Q&A)**

| Question                       | Decision                                                       |
| ------------------------------ | -------------------------------------------------------------- |
| How to unlock?                 | `!topic lock` / `!topic unlock` subcommands; drop `!settopic`  |
| `!topic` while locked?         | Ephemeral — lock stays, original `!settopic`-era text restores |
| 390-char warning in lock path? | Yes                                                            |

## Feasibility

- **Alignment**: Self-contained to `plugins/topic/index.ts` and `src/irc-bridge.ts`. The
  command surface change is additive + removes `!settopic` (considered an internal rename, not
  a breaking API change).
- **Dependencies**: All core modules exist.
- **Complexity estimate**: S–M (a few hours).
- **Risk areas**:
  - `ctx.args` fix in `irc-bridge.ts` touches the hot path for every pub command — change is a
    one-liner.
  - `!topic lock` reads the live channel topic from `api.getChannel()`. If the bot hasn't
    joined or `channel-state` hasn't populated yet, `topic` may be `''`. Guard for this.
  - The echo-loop fix (`ctx.text === enforced → return early`) must not silently swallow a
    legitimate authorized change that happens to match the stored text. It won't — if the topic
    is already correct there is nothing to do regardless of who set it.
  - Dropping `!settopic`: any existing operator muscle memory breaks. Document in plugin README.

## Dependencies

- [x] `src/irc-bridge.ts` — exists
- [x] `plugins/topic/index.ts` — exists
- [x] `plugins/topic/themes.ts` — exists
- [x] `tests/plugins/topic.test.ts` — exists
- [x] `src/core/channel-state.ts` — exists (needed for `api.getChannel()` in `!topic lock`)

---

## Phases

### Phase 1: Fix IRC color codes being stripped from `ctx.args`

**Goal**: `ctx.args` in every `pub` handler preserves `\x03` color codes and all other IRC
formatting characters that the user typed after the command word.

**Root cause** (`src/irc-bridge.ts:162–165`):

```typescript
const stripped = stripFormatting(message);
const spaceIdx = stripped.indexOf(' ');
const command = spaceIdx === -1 ? stripped : stripped.substring(0, spaceIdx);
const args = spaceIdx === -1 ? '' : stripped.substring(spaceIdx + 1).trim(); // ← BUG
```

`args` is sliced from `stripped`, so `\x03` and other control chars are gone before any plugin
sees them. When a user types `!settopic \x034red text`, the plugin receives `4red text`.

**Fix**: use the first space in the _original_ `message` to extract `args`; keep `stripped`
only for deriving the command word.

- [ ] In `src/irc-bridge.ts`, replace those four lines with:

  ```typescript
  const stripped = stripFormatting(message);
  const spaceIdx = stripped.indexOf(' ');
  const command = spaceIdx === -1 ? stripped : stripped.substring(0, spaceIdx);
  // Preserve IRC formatting in args — extract from original unstripped message
  const firstSpace = message.indexOf(' ');
  const args = firstSpace === -1 ? '' : message.substring(firstSpace + 1).trim();
  ```

- [ ] Add a test in `tests/irc-bridge.test.ts` (or `tests/plugins/topic.test.ts`) that
      simulates a privmsg of `!settopic \x034hello` and asserts `ctx.args === '\x034hello'`
      (color control char preserved).

**Verification**: `!topic rune \x034red` → `ctx.args` is `rune \x034red`; the theme replaces
`$text` with `\x034red` intact.

---

### Phase 2: Fix the protection echo loop

**Goal**: When the bot calls `api.topic()` to restore a protected topic, the IRC server echoes
a TOPIC event back with the bot as setter. The protection handler must not fire again or the bot
will loop.

**Root cause** (`plugins/topic/index.ts:170–187`): the `topic` bind fires on every TOPIC event
including the bot's own echo. If the bot lacks `+o` in the permissions DB, `api.topic()` is
called again → the server echoes again → infinite loop.

**Fix**: add an early-return guard — if the incoming topic already matches the enforced text
there is nothing to do.

- [ ] In `plugins/topic/index.ts` inside the `topic` bind, replace:

  ```typescript
  if (!enforced) return; // no authoritative topic set yet
  ```

  with:

  ```typescript
  if (!enforced) return; // no lock set
  if (ctx.text === enforced) return; // already correct (bot's own echo or matching change)
  ```

- [ ] Add a test: after setting `topic_text = 'locked text'` and `protect_topic = true`,
      fire a synthetic `topic` IRC event with the bot's nick and text `'locked text'` → confirm
      zero additional `TOPIC` raw commands are emitted.

**Verification**: Bot restores topic exactly once per unauthorized change; the echo from its own
restore does not trigger a second restore.

---

### Phase 3: Replace `!settopic` with `!topic lock` / `!topic unlock`

**Goal**: Eliminate `!settopic`. Locking and unlocking become explicit subcommands of `!topic`
so the mental model is: _set the topic first, then decide whether to lock it_. The new flow is:

```
!topic rune Welcome to #hexbot
!topic lock           ← locks whatever the live topic is right now
!topic unlock         ← disables protection
```

Internal state is unchanged (`protect_topic` flag + `topic_text` string in channel settings),
so `.chanset` and `.chaninfo` continue to reflect the protection state in the REPL.

**Changes to `plugins/topic/index.ts`**:

- [ ] Remove the `!settopic` bind entirely.

- [ ] Remove `!settopic` from `registerHelp`.

- [ ] Extend the `!topic` bind to handle two new subcommands before reaching the existing
      theme-set path:

  **`!topic lock`** — reads the current live topic from `api.getChannel(ctx.channel)?.topic`,
  stores it as `topic_text`, sets `protect_topic = true`, confirms to the channel.

  ```typescript
  if (firstArg === 'lock') {
    const live = api.getChannel(ctx.channel)?.topic ?? '';
    if (!live) {
      ctx.reply('Cannot lock: no topic is currently set.');
      return;
    }
    if (live.length > 390) {
      ctx.reply(`Warning: topic is ${live.length} chars (typical limit ~390).`);
    }
    api.channelSettings.set(ctx.channel, 'topic_text', live);
    api.channelSettings.set(ctx.channel, 'protect_topic', true);
    ctx.reply('Topic locked.');
    return;
  }
  ```

  **`!topic unlock`** — clears `topic_text`, sets `protect_topic = false`.

  ```typescript
  if (firstArg === 'unlock') {
    api.channelSettings.set(ctx.channel, 'protect_topic', false);
    api.channelSettings.set(ctx.channel, 'topic_text', '');
    ctx.reply('Topic protection disabled.');
    return;
  }
  ```

- [ ] Update the existing `!topic <theme> <text>` path to warn if the formatted topic exceeds
      390 chars (it already does — verify the warning is in place and keep it).

- [ ] Update `registerHelp` for `!topic`:
  - Add `!topic lock` entry: flags `o`, usage `!topic lock`, description `Lock the current channel topic`
  - Add `!topic unlock` entry: flags `o`, usage `!topic unlock`, description `Disable topic protection`
  - Update `!topic` detail array to mention lock/unlock.

- [ ] Update `plugins/topic/README.md` to document the new flow and note that `!settopic` has
      been removed.

**Tests to add** (`tests/plugins/topic.test.ts`):

- [ ] `!topic lock` with a live topic set → `protect_topic = true`, `topic_text = live topic`,
      reply contains "locked"
- [ ] `!topic lock` when no topic is set → error reply, no state change
- [ ] `!topic lock` with a topic > 390 chars → warning reply AND still locks
- [ ] `!topic unlock` → `protect_topic` reverts to default, `topic_text` cleared, reply confirms
- [ ] After `!topic lock`, a non-op changes topic → bot restores it (integration of Phase 2 fix)
- [ ] After `!topic unlock`, a non-op changes topic → bot does NOT restore it

**Verification**: Flow `!topic rune Welcome` → `!topic lock` → user changes topic to `E` →
bot restores to the rune-themed topic. Then `!topic unlock` → user changes to `E` → no restore.

---

## Config changes

None. `protect_topic` and `topic_text` are already registered channel settings. State is
visible in `.chaninfo #chan` and writable in the REPL via `.chanset #chan +protect_topic` /
`.chanset #chan -protect_topic`.

## Database changes

None.

## Test plan

| Test                                                | File                          | Phase |
| --------------------------------------------------- | ----------------------------- | ----- |
| `ctx.args` preserves `\x03` color codes             | `tests/irc-bridge.test.ts`    | 1     |
| Bot TOPIC echo does not re-trigger restore          | `tests/plugins/topic.test.ts` | 2     |
| `!topic lock` sets `protect_topic` and `topic_text` | `tests/plugins/topic.test.ts` | 3     |
| `!topic lock` with no live topic → error            | `tests/plugins/topic.test.ts` | 3     |
| `!topic lock` with topic > 390 chars → warns        | `tests/plugins/topic.test.ts` | 3     |
| `!topic unlock` clears protection                   | `tests/plugins/topic.test.ts` | 3     |
| Non-op change after lock → topic restored           | `tests/plugins/topic.test.ts` | 3     |
| Non-op change after unlock → not restored           | `tests/plugins/topic.test.ts` | 3     |

## Open questions

None — all three from the original Q&A have been resolved.
