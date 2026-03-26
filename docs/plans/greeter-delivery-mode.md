# Plan: Greeter Delivery Mode + Private Join Notice

## Summary

Two orthogonal features added to the greeter plugin:

**1. `delivery` — controls the public channel greeting (visible to everyone):**

| `delivery`         | IRC call           | How clients show it               |
| ------------------ | ------------------ | --------------------------------- |
| `"say"` (default)  | `PRIVMSG #channel` | `<Bot> Welcome, nick!`            |
| `"channel_notice"` | `NOTICE #channel`  | `-Bot- [#channel] Welcome, nick!` |

**2. `join_notice` — an independent private NOTICE sent to the joining user:**

- Informational, not social — nobody else sees it
- Typical use: "Welcome! Type `!help` to see available commands."
- Fires in addition to (not instead of) the public greeting
- Disabled by default (`join_notice: ""`)

Both can be active simultaneously. A channel might publicly say "Welcome, alice!" while
privately noticing alice with command info — the same pattern seen on many IRC networks.

## Feasibility

- **Alignment**: Pure plugin-level change. No core modifications needed — `api.say()`,
  `api.notice()`, and `ctx.reply()` already exist on `PluginAPI`.
- **Dependencies**: Greeter plugin (exists and fully implemented at v2.0.0).
- **Blockers**: None.
- **Complexity**: XS (< 1 hour).
- **Risk areas**:
  - `join_notice` strings must have `\r\n` stripped (same as custom greet sanitization).
  - `{channel}` / `{nick}` substitution should apply to `join_notice` too for consistency.

## Dependencies

- [x] Greeter plugin (`plugins/greeter/index.ts` — v2.0.0)
- [x] `api.notice()` on `PluginAPI`

## Phases

### Phase 1: `delivery` — public greeting routing

**Goal:** Drop the `"notice"` delivery mode (private notice is now `join_notice`'s job)
and keep `delivery` scoped to public-facing greeting style.

- [ ] Add `"delivery": "say"` to `plugins/greeter/config.json`.
- [ ] In `init()`, read `delivery` and update the join handler:

  ```typescript
  const delivery = (api.config.delivery as string) ?? 'say';

  // inside join handler, after building `text`:
  if (delivery === 'channel_notice' && ctx.channel) {
    api.notice(ctx.channel, text);
  } else {
    ctx.reply(text); // 'say' — PRIVMSG to channel (default)
  }
  ```

- [ ] Verification: existing tests still pass; `delivery: "channel_notice"` fires
      `api.notice` to the channel name.

### Phase 2: `join_notice` — private notice to joining user

**Goal:** Optionally NOTICE the joining user directly with a separate informational message.

- [ ] Add `"join_notice": ""` to `plugins/greeter/config.json` (empty string = disabled).
- [ ] In `init()`, read and apply after the public greeting:

  ```typescript
  const joinNotice = (api.config.join_notice as string) ?? '';

  // inside join handler, after public greeting:
  if (joinNotice) {
    const noticeText = joinNotice
      .replace(/[\r\n]/g, '')
      .replace(/\{channel\}/g, ctx.channel ?? '')
      .replace(/\{nick\}/g, stripFormatting(ctx.nick));
    api.notice(ctx.nick, noticeText);
  }
  ```

- [ ] Verification: with `join_notice` set, join event fires `api.notice(nick, ...)` in
      addition to the public greeting; with it empty, no notice is sent.

### Phase 3: Tests + docs

**Goal:** Full test coverage for both features; README updated.

- [ ] Add to `tests/plugins/greeter.test.ts`:
  - **delivery modes**:
    - `delivery: "say"` (default) → `ctx.reply` called; `api.notice` not called
    - `delivery: "channel_notice"` → `api.notice('#channel', ...)` called for public greeting
  - **join_notice**:
    - `join_notice: ""` (default) → no notice sent to nick
    - `join_notice: "Welcome! Try !help."` → `api.notice(nick, ...)` called
    - `join_notice` with `{channel}` / `{nick}` → substitutions applied
    - `join_notice` with embedded `\r\n` → stripped before sending
    - Both `delivery: "channel_notice"` and `join_notice` active simultaneously → both fire
- [ ] Update `plugins/greeter/README.md` with a delivery modes table and a `join_notice`
      section explaining its purpose vs the public greeting.
- [ ] Verification: `pnpm test` passes with no regressions.

## Config changes

`plugins/greeter/config.json` (updated defaults):

```json
{
  "message": "Welcome to {channel}, {nick}!",
  "delivery": "say",
  "join_notice": "",
  "allow_custom": false,
  "min_flag": "v"
}
```

`plugins.json` example — public channel notice + private info notice:

```json
{
  "greeter": {
    "enabled": true,
    "config": {
      "message": "Welcome to {channel}, {nick}!",
      "delivery": "channel_notice",
      "join_notice": "Hi {nick}! Type !help to see available commands."
    }
  }
}
```

Result when alice joins `#lobby`:

```
-Bot- [#lobby] Welcome to #lobby, alice!        ← visible to whole channel
-Bot- Hi alice! Type !help to see available commands.   ← private to alice only
```

## Database changes

None.

## Open questions

None — fully specified.
