# Plan: Per-Plugin Channel Scoping

## Summary

Implement the `channels` field in `plugins.json` so plugins can be restricted to specific IRC channels. When `channels` is set, the plugin's bind handlers only fire for events in those channels. When omitted, the plugin runs everywhere. This feature is already documented in DESIGN.md and the `PluginConfig.channels` type exists — only the filtering logic is missing.

## Feasibility

- **Alignment**: Fully aligned — DESIGN.md already promises this feature (section 2.11)
- **Dependencies**: None — all infrastructure exists (`PluginConfig.channels`, `BindEntry.pluginId`, `ircLower`)
- **Blockers**: None
- **Complexity**: S (small — ~20 lines of logic, one file for core change)
- **Risk areas**: IRC case folding (channel names must be compared case-insensitively using the network's CASEMAPPING)

## Semantics

- **`channels` omitted or undefined** → plugin runs in all channels
- **`channels: ["#lobby", "#games"]`** → plugin only fires for events in those channels
- **`channels: []`** → effectively disabled for all channel events
- **Non-channel events** (`ctx.channel === null`) → always fire regardless of scope. This includes: `msg`, `msgm`, `nick`, `quit`, `ctcp`, `time`. Rationale: timers need housekeeping, PMs are user-facing, nick/quit are network-level.
- **Channel events** (`ctx.channel` is set) → filtered against the scope. This includes: `pub`, `pubm`, `join`, `part`, `kick`, `mode`, `topic`, `notice`, `invite`.
- **Channel settings and help** → not filtered. If a plugin is loaded, its `.chanset` settings and `!help` entries remain visible globally. Scope only controls event dispatch.

## Phases

### Phase 1: Core implementation

**Goal:** Wire up channel filtering in the plugin loader's bind wrapper.

- [x] In `src/plugin-loader.ts` `load()`: extract `channels` from `pluginsConfig?.[pluginName]?.channels` and pass it to `createPluginApi()`
- [x] In `src/plugin-loader.ts` `createPluginApi()`: accept an optional `channelScope: string[] | undefined` parameter
- [x] When `channelScope` is defined and non-empty, build a `Set<string>` of lowercased channel names (using `ircLower` with the current casemapping)
- [x] Wrap the `bind()` method: if a channel scope exists, wrap the handler so it checks `ctx.channel` — if `ctx.channel` is `null`, pass through; if `ctx.channel` is set, only call the original handler when the channel is in the scope set
- [x] Log at plugin load time when a channel scope is active: `[plugin-loader] Plugin "greeter" scoped to channels: #lobby, #games`

**Verification:** Load a plugin with `"channels": ["#test"]` in plugins.json. Trigger a command in `#test` (should fire) and `#other` (should not fire). Trigger a PM command (should fire).

### Phase 2: Tests

**Goal:** Full test coverage for channel scoping behavior.

- [x] `tests/plugin-loader-channel-scope.test.ts` (or add to existing plugin-loader tests):
  - [x] Plugin with no `channels` field → handlers fire in all channels
  - [x] Plugin with `channels: ["#test"]` → handler fires in `#test`, skipped in `#other`
  - [x] Plugin with `channels: ["#test"]` → handler fires for PM (`ctx.channel = null`)
  - [x] Plugin with `channels: ["#test"]` → timer bind fires (`ctx.channel = null`)
  - [x] Plugin with `channels: []` → handler never fires for channel events
  - [x] Channel name comparison is case-insensitive (`#Test` matches `#test`)
  - [x] Multiple channels work (`channels: ["#a", "#b"]` → fires in both)

**Verification:** `pnpm test` passes, all new tests green.

### Phase 3: Documentation

**Goal:** Document the feature in all relevant places.

- [x] Update `docs/PLUGIN_API.md` — add a "Channel scoping" section explaining the `channels` field
- [x] Update `plugins/README.md` — mention channel scoping in the configuration section
- [x] Verify `DESIGN.md` section 2.11 still accurately describes the behavior (it already mentions channel restriction)
- [x] Add a commented example to `config/plugins.example.json` or mention in a doc that `channels` can be added to any plugin entry

**Verification:** Read the docs and confirm they match the implemented behavior.

## Config changes

No new config fields — `PluginConfig.channels` already exists in `src/types.ts`:

```typescript
export interface PluginConfig {
  enabled: boolean;
  channels?: string[]; // ← already defined, now wired up
  config?: Record<string, unknown>;
}
```

Usage in `plugins.json`:

```json
{
  "greeter": {
    "channels": ["#lobby", "#welcome"],
    "config": { "message": "Welcome to {channel}, {nick}!" }
  }
}
```

## Database changes

None.

## Test plan

See Phase 2 above. Key scenarios:

1. Scoped plugin skips channel events outside scope
2. Scoped plugin allows channel events inside scope
3. Scoped plugin always allows non-channel events (PM, timer, nick, quit)
4. Unscoped plugin (no `channels` field) runs everywhere
5. Empty `channels: []` blocks all channel events
6. Channel matching is IRC-case-insensitive
7. Plugin reload preserves channel scope from config

## Open questions

None — all design decisions resolved.
