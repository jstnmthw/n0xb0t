# Plan: Code Quality Refactors

## Summary

Addresses all findings from the March 2026 quality audit. No behavior changes — every item here
is a pure readability or maintainability improvement. Organized into three phases by priority.

- **Phase 1 (High):** Two structural refactors with the highest reader-impact.
- **Phase 2 (Medium):** Three targeted extractions that clean up the most complex methods.
- **Phase 3 (Low/Cosmetic):** Cross-cutting utility extraction, minor clarifications, and a
  safety improvement in plugin teardown.

Each phase is independently shippable.

---

## Feasibility

- **Alignment:** All changes are internal restructuring. No API surface changes, no config
  format changes, no plugin contract changes.
- **Blockers:** None.
- **Risk areas:**
  - `irc-bridge.ts` handler refactor: must preserve event field extraction exactly per handler —
    some fields differ (e.g. `kick` carries `kicked_nick`, `mode` carries `modes` array). A
    shared context builder must not over-generalize.
  - `src/core/dcc.ts` orchestration split: DCC state machine has strict ordering requirements
    (NickServ verify must complete before port allocation). Any extraction must preserve call
    order and not introduce async races.

---

## Phase 1 — High Priority

### 1.1 `src/irc-bridge.ts` — Extract repeated event handler skeleton

**Size:** M

**Problem:** 11 event handlers (`onPrivmsg`, `onAction`, `onJoin`, `onPart`, `onQuit`, `onKick`,
`onNick`, `onMode`, `onTopic`, `onInvite`, `onNotice`) each repeat the same structure:

1. Extract raw fields from the irc-framework event
2. Sanitize strings
3. Build a `HandlerContext`
4. Call `dispatcher.dispatch()`

Any change to context-building (e.g. adding a new shared field) currently requires editing all
11 handlers.

**Approach:**

1. Define a `RawIrcEvent` discriminated union or a plain `Record<string, string>` shape covering
   the fields each handler reads.
2. Write a `buildBaseContext(type, nick, host, channel?)` helper that populates the fields every
   handler shares (nick, host, target, ident, timestamp, accountName lookup).
3. Rewrite each handler as a thin wrapper:
   - Extract the event-specific fields (the parts that genuinely differ per event type).
   - Call `buildBaseContext()` for shared fields.
   - Merge and dispatch.

**Acceptance criteria:**

- All 11 handlers refactored.
- No change to the shape of `HandlerContext` objects dispatched.
- All existing tests pass unchanged.
- `irc-bridge.ts` line count reduced by ≥100 lines.

---

### 1.2 `src/plugin-loader.ts` — Break up `createPluginApi()` into sub-factories

**Size:** M

**Problem:** `createPluginApi()` (lines 358–635) is a 280-line flat function that builds the
entire scoped plugin API inline — `pluginDb`, `pluginPermissions`, `pluginServicesApi`, and the
main `api` object are all constructed in one contiguous block. Locating where a specific API
method is defined requires scrolling through the whole thing.

**Approach:**

1. Extract `createPluginDbApi(db, pluginName): PluginDbAPI` — the KV/log sub-object (currently
   lines ~405–435).
2. Extract `createPluginPermissionsApi(permissions, pluginName): PluginPermissionsAPI` — the
   user/flag sub-object (currently lines ~470–510).
3. Extract `createPluginServicesApi(services): PluginServicesAPI` — the NickServ/SASL sub-object
   (currently lines ~530–555).
4. `createPluginApi()` becomes an assembler of ~50 lines that calls these three helpers and
   composes the final `api` object.

**Acceptance criteria:**

- Three new private helper functions extracted.
- `createPluginApi()` body ≤ 60 lines.
- TypeScript types on each helper's return value match the existing `PluginAPI` sub-shapes.
- All plugin load/unload/reload tests pass unchanged.

---

## Phase 2 — Medium Priority

### 2.1 `plugins/flood/index.ts` — Flatten `init()` and deduplicate detector logic

**Size:** S

**Problem:**

- `init()` (lines 134–301) is 167 lines. It defines two nested async functions (`applyAction`,
  `recordOffence`) inline, then registers 4 bind handlers, all in one block. Hard to navigate.
- Three flood detectors (message, join, nick-change) at lines 220, 244, and 269 repeat the same
  sliding-window check pattern: prune old timestamps → push new → compare length to threshold.

**Approach:**

1. Lift `applyAction` and `recordOffence` out of `init()` as module-level functions taking
   `(api, cfg, nick, channel)` arguments.
2. Extract `isFloodTriggered(tracker, key, windowMs, threshold): boolean` as a pure helper
   (prune + push + check). Each detector call site becomes one line.
3. `init()` becomes ~40 lines of bind registrations only.

**Acceptance criteria:**

- `init()` ≤ 45 lines.
- `isFloodTriggered` covered by a unit test.
- Flood detection behavior unchanged (all existing flood tests pass).

---

### 2.2 `src/core/dcc.ts` — Split `onDccCtcp()` into guard + setup phases

**Size:** M

**Problem:** `onDccCtcp()` (lines 434–547) is 113 lines of sequential checks and async
operations. Guards (hostmask check, flag check, session limit, NickServ verify) are mixed
in-line with setup (port allocation, TCP server creation, connection timeout). A reader cannot
tell where validation ends and setup begins.

**Approach:**

1. Extract `validateDccRequest(nick, host, ctx): Promise<string | null>` — runs the four guard
   checks and returns a rejection reason string or `null` if all pass.
2. Extract `acceptDccConnection(nick, port, payload): Promise<void>` — handles port allocation,
   TCP server setup, and the connection-accept timeout. This is the async state machine portion.
3. `onDccCtcp()` becomes a clear two-step: call `validateDccRequest`, bail if rejected, call
   `acceptDccConnection`.

**Note:** Preserve exact call order. NickServ verification (async) must complete before port
allocation. Do not parallelize the guard checks.

**Acceptance criteria:**

- `onDccCtcp()` ≤ 20 lines.
- Extracted functions have explicit TypeScript parameter and return types.
- All DCC tests pass. Manual test: passive DCC handshake still works end-to-end.

---

### 2.3 `src/bot.ts` — Split `connect()` into config builder + event registrar

**Size:** S

**Problem:** `connect()` (lines 317–424) is 107 lines mixing SASL config parsing, proxy setup,
capability negotiation config, and `irc.on(...)` event-listener registration. A reader trying to
understand connection startup has to parse all four concerns at once.

**Approach:**

1. Extract `buildClientOptions(): IrcClientOptions` — pure function, returns the irc-framework
   options object (SASL, proxy, capabilities, server/port/nick). No side effects.
2. Extract `registerConnectionEvents(): void` — registers all `irc.on(...)` listeners (connect,
   registered, close, error).
3. `connect()` calls `buildClientOptions()`, passes the result to `new IRC.Client()`, calls
   `registerConnectionEvents()`, then `this.client.connect()`.

**Acceptance criteria:**

- `connect()` ≤ 15 lines.
- `buildClientOptions()` is a pure function (no `this` side effects, just reads config).
- Existing connection and reconnection behavior unchanged.

---

## Phase 3 — Low Priority / Cosmetic

### 3.1 Cross-cutting: Extract `SlidingWindowCounter` utility

**Size:** S

**Problem:** The sliding-window throttle pattern (prune old timestamps → push new → compare
count to threshold) appears independently in:

- `src/core/dcc.ts` lines 136–145 (CTCP rate limiter)
- `plugins/flood/index.ts` lines 220, 244, 269 (three detectors)

Any bug in the window logic must be fixed in all three places.

**Approach:**

Create `src/utils/sliding-window.ts`:

```typescript
export class SlidingWindowCounter {
  private windows = new Map<string, number[]>();

  /** Returns true if adding this event now would exceed `limit` events in `windowMs`. */
  check(key: string, windowMs: number, limit: number): boolean {
    const now = Date.now();
    const timestamps = (this.windows.get(key) ?? []).filter((t) => now - t < windowMs);
    timestamps.push(now);
    this.windows.set(key, timestamps);
    return timestamps.length > limit;
  }

  clear(key: string): void {
    this.windows.delete(key);
  }
}
```

Replace all three use sites with `SlidingWindowCounter` instances.

**Acceptance criteria:**

- `src/utils/sliding-window.ts` exists with unit tests.
- All three use sites migrated.
- No behavior change.

---

### 3.2 `src/plugin-loader.ts` — Improve teardown failure handling

**Size:** S

**Problem:** If a plugin's `teardown()` throws (lines 300–301), the error is logged but the
plugin is still removed from `loaded` and all binds are unregistered (line 305). Timers, sockets,
or other resources the plugin held may not be released. The current log message just says
teardown threw — it doesn't warn that the process state may be dirty.

**Approach:**

1. Change the catch block message from a generic error log to: `"[plugin-loader] WARNING:
teardown() for <name> threw — some resources may not have been released. Recommend restarting
the bot if behavior is unstable."`
2. Track teardown result: add a `teardownFailed: boolean` flag to the loaded plugin record. Log a
   summary at startup if any flagged plugins are present in the list (shouldn't persist across
   restarts, but useful for debugging).

No code structure changes needed — this is a targeted improvement to observability.

**Acceptance criteria:**

- Warning message improved with specific actionable text.
- `teardownFailed` flag present in plugin record type.

---

### 3.3 Minor clarifications (opportunistic)

Address these in whatever PR touches the relevant file:

- `src/core/services.ts` lines 200–223 — Add a comment explaining _why_ the ACC→STATUS method
  retry exists (some IRC networks don't support ACC; STATUS is the fallback).
- `plugins/flood/index.ts` lines 10, 37–40 — Add a comment on module-level mutable state
  explaining it's intentional (plugin is single-instance per process; state lives at module scope
  for performance).
- `src/dispatcher.ts` lines 103–139 — Consider extracting the timer-bind setup branch into a
  private `registerTimer()` method for navigability. Low value; only worth doing if touching this
  file for another reason.

---

## Dependencies between phases

```
Phase 1.1 (irc-bridge)    ─── independent
Phase 1.2 (plugin-loader) ─── independent
Phase 2.1 (flood)         ─── independent; 3.1 (SlidingWindow) can land first or after
Phase 2.2 (dcc)           ─── independent
Phase 2.3 (bot.ts)        ─── independent
Phase 3.1 (SlidingWindow) ─── can precede 2.1 to make migration trivial
Phase 3.2 (teardown)      ─── independent
Phase 3.3 (comments)      ─── opportunistic, no dependency
```

No phase has a hard prerequisite on another. Each item can be a standalone PR.

---

## What this plan does NOT change

- Plugin API surface (`PluginAPI`, `HandlerContext`, `PluginDB`, etc.) — no breaking changes.
- Dispatcher bind semantics — no changes.
- Any observable bot behavior.
- Test structure — tests should pass without modification after each refactor.
