# Plan: DI Interface Extraction

## Summary

Extract narrow interfaces for the 4 concrete classes that account for ~31 of the 56 remaining `as unknown as` casts in tests: `EventDispatcher`, `Permissions`, `Services`, and `CommandHandler`. Two of these (`Permissions`, `Services`) already have suitable interfaces in `src/types.ts` — we just need to wire them up. The other two need new 2-3 method interfaces. This brings the internal wiring in line with the IRC/plugin boundaries that are already cleanly interface-driven.

## Feasibility

- **Alignment**: Extends the existing interface pattern (DCCIRCClient, PluginPermissions, PermissionsProvider, ChannelStateClient, etc.). DESIGN.md encourages plugin isolation via interfaces — this applies the same principle internally.
- **Dependencies**: None. All source classes and tests already exist.
- **Blockers**: None.
- **Complexity**: M (one focused session)
- **Risk**: Low. Every change is a type annotation swap — no behavioral changes. If the wrong interface is extracted, the compiler catches it immediately.

## Current State

### Interfaces that already exist (reuse)

| Interface           | Location           | Methods                            | Matches consumer   |
| ------------------- | ------------------ | ---------------------------------- | ------------------ |
| `PluginPermissions` | `src/types.ts:118` | `findByHostmask()`, `checkFlags()` | DCCManager exactly |
| `PluginServices`    | `src/types.ts:132` | `verifyUser()`, `isAvailable()`    | DCCManager exactly |

### Interfaces that need extraction

| Proposed name     | Methods needed                                     | Consumers                                     |
| ----------------- | -------------------------------------------------- | --------------------------------------------- |
| `BindRegistrar`   | `bind()`, `unbind()`, `unbindAll()`                | DCCManager, PluginLoader, ConnectionLifecycle |
| `CommandExecutor` | `execute()`                                        | DCCSession, BotREPL, Bot (relay dispatch)     |
| `CommandRelay`    | `execute()`, `getCommand()`, `setPreExecuteHook()` | BotLinkHub, BotLinkLeaf                       |

### Cast elimination forecast

| Phase                    | Casts eliminated | Source                                                             |
| ------------------------ | ---------------- | ------------------------------------------------------------------ |
| Phase 1 (reuse existing) | ~14              | DCCManager tests: Permissions + Services mocks                     |
| Phase 2 (new interfaces) | ~12              | DCCManager + BotLink tests: EventDispatcher + CommandHandler mocks |
| Phase 3 (BotLink deps)   | ~5               | BotLink tests: Permissions + CommandHandler mocks                  |
| **Total**                | **~31**          | **56 → ~25 remaining**                                             |

The remaining ~25 casts are DCCSession partial mocks (class with private members) and the centralized mock helpers (mock-logger.ts, mock-socket.ts) — acceptable.

## Phases

### Phase 1: Reuse existing interfaces for DCCManager

**Goal:** Swap DCCManager's `Permissions` and `Services` deps to the narrow interfaces that already exist. Zero new code — just type annotation changes.

- [ ] `src/core/dcc.ts` — Change `DCCManagerDeps.permissions` type from `Permissions` to `PluginPermissions` (from `src/types.ts`)
- [ ] `src/core/dcc.ts` — Change `DCCManagerDeps.services` type from `Services` to `PluginServices` (from `src/types.ts`)
- [ ] `src/core/dcc.ts` — Remove `import type { Permissions }` and `import type { Services }` if no longer needed
- [ ] `src/bot.ts` — Verify the `new DCCManager({...})` call still compiles (Permissions/Services implement the interfaces structurally)
- [ ] `tests/core/dcc.test.ts` — Change `makePermissions()` return type to `PluginPermissions` and `makeServices()` to `PluginServices`. The `as unknown as` cast should become unnecessary since the mock objects now satisfy the interface directly
- [ ] Verification: `pnpm tsc --noEmit && pnpm test`

### Phase 2: Extract BindRegistrar and CommandExecutor

**Goal:** Create two narrow interfaces for the dispatch and command execution seams.

#### 2a. BindRegistrar

- [ ] `src/dispatcher.ts` — Export a `BindRegistrar` interface:
  ```typescript
  export interface BindRegistrar {
    bind(type: BindType, flags: string, mask: string, handler: BindHandler, pluginId: string): void;
    unbind(type: BindType, mask: string, handler: BindHandler): void;
    unbindAll(pluginId: string): void;
  }
  ```
- [ ] `src/core/dcc.ts` — Change `DCCManagerDeps.dispatcher` from `EventDispatcher` to `BindRegistrar`
- [ ] `tests/core/dcc.test.ts` — Update `makeDispatcher()` to return `BindRegistrar`. The `{ bind: vi.fn(), unbindAll: vi.fn() }` mock satisfies the interface — remove `as unknown as` cast
- [ ] Verification: `pnpm tsc --noEmit && pnpm test`

#### 2b. CommandExecutor

- [ ] `src/command-handler.ts` — Export a `CommandExecutor` interface:
  ```typescript
  export interface CommandExecutor {
    execute(commandString: string, ctx: CommandContext): Promise<void>;
  }
  ```
- [ ] `src/core/dcc.ts` — Change `DCCManagerDeps.commandHandler` from `CommandHandler` to `CommandExecutor`
- [ ] `src/core/dcc.ts` — Change `DCCSession` constructor's `commandHandler` param from `CommandHandler` to `CommandExecutor`
- [ ] `tests/core/dcc.test.ts` — Update `makeCommandHandler()` to return `CommandExecutor`. Remove `as unknown as` cast
- [ ] Verification: `pnpm tsc --noEmit && pnpm test`

### Phase 3: BotLink deps

**Goal:** Apply the same pattern to BotLinkHub and BotLinkLeaf, which also take concrete `Permissions` and `CommandHandler`.

- [ ] Read `src/core/botlink.ts` — identify which `Permissions` and `CommandHandler` methods BotLink actually uses
- [ ] BotLink uses `permissions.getUser()`, `permissions.checkFlagsByHandle()`, `permissions.findByHostmask()` — this is broader than `PluginPermissions`. Extract a `LinkPermissions` interface in `src/core/botlink.ts`:
  ```typescript
  export interface LinkPermissions {
    getUser(handle: string): UserRecord | null;
    findByHostmask(fullHostmask: string): UserRecord | null;
    checkFlagsByHandle(requiredFlags: string, handle: string, channel: string | null): boolean;
  }
  ```
- [ ] BotLink uses `commandHandler.execute()`, `commandHandler.getCommand()`, `commandHandler.setPreExecuteHook()` — extract a `CommandRelay` interface in `src/core/botlink.ts`:
  ```typescript
  export interface CommandRelay {
    execute(commandString: string, ctx: CommandContext): Promise<void>;
    getCommand(name: string): CommandEntry | undefined;
    setPreExecuteHook(hook: PreExecuteHook | null): void;
  }
  ```
- [ ] Update `BotLinkHub` and `BotLinkLeaf` to accept the interfaces instead of concrete classes
- [ ] `tests/core/commands/botlink-commands.test.ts` — update mocks to use the new interfaces
- [ ] Verification: `pnpm tsc --noEmit && pnpm test`

### Phase 4: Remaining consumers (optional, lower value)

**Goal:** Apply BindRegistrar to PluginLoader and ConnectionLifecycle if the cast count justifies it.

- [ ] `src/plugin-loader.ts` — Change `PluginLoaderDeps.dispatcher` from `EventDispatcher` to `BindRegistrar`
- [ ] `src/core/connection-lifecycle.ts` — Check if `ConnectionLifecycleDeps.dispatcher` can use `BindRegistrar` (it only calls `bind()`)
- [ ] Note: PluginLoader tests use mock-bot (not direct mocking), so cast savings may be minimal. Evaluate before proceeding.
- [ ] Verification: `pnpm tsc --noEmit && pnpm test`

### Phase 5: Logger (skip unless painful)

**Goal:** Evaluate whether a `LoggerLike` interface is worth extracting.

Logger is mocked in 4 test files but all mocks are centralized in `tests/helpers/mock-logger.ts` (single cast site). Extracting an interface would eliminate 2 casts in that helper. The cost/benefit is marginal.

- [ ] Decision: skip unless a future feature adds more Logger consumers that need mocking
- [ ] If proceeding: extract `LoggerLike` with `info()`, `debug()`, `warn()`, `error()`, `child()` — update all `Logger | null` annotations to `LoggerLike | null`

## Config changes

None.

## Database changes

None.

## Test plan

Each phase is verified by:

1. `pnpm tsc --noEmit` — zero errors (the compiler is the primary safety net)
2. `pnpm test` — all 1522 tests pass
3. Count `as unknown as` casts before and after each phase

After all phases:

- Grep for remaining `as unknown as` casts
- Verify remaining casts are justified (DCCSession partials, centralized mock helpers)
- Update the chaos detector findings if running `/testability` post-refactor

## Open questions

1. **PluginLoader dispatcher type** — PluginLoader takes `EventDispatcher` but only uses `bind()`, `unbind()`, `unbindAll()`. However, PluginLoader tests use mock-bot (not direct mocking), so switching to `BindRegistrar` has near-zero cast savings. Worth the churn?

2. **BotREPL** — Takes `Bot` (the god class) directly. Extracting an interface would be expensive (BotREPL accesses many Bot members). Low priority since REPL tests are minimal. Skip?

3. **`PluginPermissions` naming** — DCCManager is not a plugin. Using the name `PluginPermissions` for a core module dep is semantically misleading. Options:
   - Rename to `ReadOnlyPermissions` and have `PluginPermissions` become a type alias
   - Keep `PluginPermissions` as-is (it's structurally correct even if the name is plugin-centric)
   - Create a separate `PermissionsReader` and have both be type aliases of the same shape
