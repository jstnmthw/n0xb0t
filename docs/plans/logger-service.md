# Plan: Logger Service (chalk + log levels)

## Summary

Replace all 60 `console.log/error/warn` calls across 14 source files with a centralized `Logger` service in `src/logger.ts`. The logger supports configurable log levels (debug/info/warn/error) read from `config.logging.level`, uses Chalk for colored console output, and provides child loggers with source prefixes (e.g. `[bot]`, `[dispatcher]`, `[plugin:seen]`). The plugin API's `log()`/`error()` methods delegate to the logger so plugins get the same formatting and level filtering.

## Feasibility

- **Alignment**: DESIGN.md section 2.14 already specifies `logging.level` in config and structured console output with `[source]` prefixes. The `LoggingConfig` type already exists with `level: 'debug' | 'info' | 'warn' | 'error'`. This plan fulfills a designed-but-unimplemented feature.
- **Dependencies**: Chalk must be added as a production dependency. Chalk v5+ is ESM-only which matches our setup.
- **Blockers**: None.
- **Complexity**: **M** (day) — the logger itself is simple, but touching 14 files with 60 call sites requires care.
- **Risk areas**:
  - Early startup errors (config file not found, parse errors) happen before the logger is initialized. These must remain as raw `console.error` + `process.exit(1)` calls — the logger can't be used before config is loaded.
  - Test output: tests shouldn't produce noisy colored output. The logger needs to be suppressible/mockable in tests.
  - Chalk auto-detects color support. In CI or piped output, colors are auto-disabled — no special handling needed.

## Dependencies

- [ ] `chalk` npm package (v5+, ESM-only) — must be installed

## Phases

### Phase 1: Create the Logger service

**Goal:** A standalone `src/logger.ts` module with no dependencies on other n0xb0t modules.

- [ ] Install chalk: `pnpm add chalk`
- [ ] Create `src/logger.ts` with this API:
  ```typescript
  type LogLevel = 'debug' | 'info' | 'warn' | 'error';

  class Logger {
    constructor(options: { level: LogLevel });
    setLevel(level: LogLevel): void;
    child(prefix: string): Logger;  // returns a new Logger that prepends [prefix]
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  }
  ```
- [ ] Color scheme (chalk):
  - Timestamp: `chalk.gray` (e.g. `12:34:56`)
  - Prefix/source: `chalk.cyan` (e.g. `[bot]`, `[dispatcher]`)
  - DEBUG level label: `chalk.gray('DBG')`
  - INFO level label: `chalk.blue('INF')`
  - WARN level label: `chalk.yellow('WRN')`
  - ERROR level label: `chalk.red('ERR')`
  - Message text: default (no color)
- [ ] Output format: `HH:MM:SS INF [source] message`
- [ ] Level filtering: numeric comparison (debug=0, info=1, warn=2, error=3). Messages below the configured level are silently dropped.
- [ ] `child(prefix)` creates a new Logger instance sharing the same level but prepending `[prefix]` to every message
- [ ] Export a factory: `createLogger(options)` that returns a Logger instance
- [ ] **Verify:** Write a quick smoke test — create logger, call all levels, verify output and filtering

### Phase 2: Wire logger into Bot and pass to modules

**Goal:** The Bot creates the logger from config and passes it to all modules.

- [ ] In `src/bot.ts`:
  - Create the logger in the constructor: `this.logger = createLogger({ level: config.logging.level })`
  - Expose `readonly logger: Logger` on the Bot class
  - Replace all `console.log('[bot]', ...)` with `this.logger.info(...)` (the bot's logger uses prefix `'bot'`)
  - Replace `console.error('[bot]', ...)` with `this.logger.error(...)`
  - **Exception**: Keep `console.error` + `process.exit(1)` in `loadConfig()` — this runs before the logger exists
- [ ] Update module constructors/options to accept a `Logger` instance:
  - `EventDispatcher` — add logger param
  - `IRCBridge` — add logger to `IRCBridgeOptions`
  - `Permissions` — add logger param
  - `CommandHandler` — add logger param (if it logs)
  - `PluginLoader` — add logger to options
  - `ChannelState` — add logger param
  - `Services` — add logger param
  - `IRCCommands` — add logger param
  - `BotDatabase` — add logger param
  - `REPL (startRepl)` — add logger param
- [ ] Each module calls `logger.child('module-name')` to get its own prefixed child logger
- [ ] **Verify:** `pnpm exec tsc --noEmit` compiles clean

### Phase 3: Replace console.* calls in all modules

**Goal:** Every `console.log/error/warn` in `src/` (except pre-config fatal errors) uses the logger.

Files to update (with approximate call counts):

- [ ] `src/database.ts` (2 calls) — `logger.info`
- [ ] `src/dispatcher.ts` (5 calls) — `logger.error`, `logger.warn`
- [ ] `src/irc-bridge.ts` (3 calls) — `logger.info`, `logger.error`
- [ ] `src/core/permissions.ts` (10 calls) — `logger.info`, `logger.error`, `logger.warn`
- [ ] `src/core/channel-state.ts` (2 calls) — `logger.info`
- [ ] `src/core/services.ts` (4 calls) — `logger.info`
- [ ] `src/core/irc-commands.ts` (1 call) — `logger.error`
- [ ] `src/plugin-loader.ts` (10 calls) — `logger.info`, `logger.error`, `logger.warn`
- [ ] `src/repl.ts` (5 calls) — `logger.info`
- [ ] `src/index.ts` (4 calls) — Keep `console.error` for uncaught/unhandled (these are process-level). Replace `console.log` for signal handling.
- [ ] `src/bot.ts` (15 calls) — most replaced in Phase 2

Mapping of existing patterns:
- `console.log('[module] ...')` → `logger.info('...')`  (prefix comes from the child logger)
- `console.error('[module] ...')` → `logger.error('...')`
- `console.warn('[module] ...')` → `logger.warn('...')`

- [ ] Remove the hardcoded `[module]` prefix strings from log messages — the child logger adds them automatically
- [ ] **Verify:** `grep -rn 'console\.' src/ --include='*.ts'` shows only the intentional exceptions (pre-config fatals, uncaught exception handler)

### Phase 4: Update plugin API logging

**Goal:** Plugins use the logger through their API, getting the same formatting and level filtering.

- [ ] In `src/plugin-loader.ts`, update the `buildAPI()` method:
  - Create a child logger for each plugin: `const pluginLogger = this.logger.child('plugin:' + pluginId)`
  - Wire `api.log()` → `pluginLogger.info()`
  - Wire `api.error()` → `pluginLogger.error()`
- [ ] Add `warn(...args)` and `debug(...args)` to the `PluginAPI` interface in `src/types.ts`
- [ ] Wire `api.warn()` → `pluginLogger.warn()` and `api.debug()` → `pluginLogger.debug()`
- [ ] **Verify:** Load a plugin, check its log output has the correct format and colors

### Phase 5: Tests

**Goal:** Logger unit tests and updated module tests.

- [ ] Create `tests/logger.test.ts`:
  - Level filtering: debug messages suppressed at info level, etc.
  - `child()` produces prefixed output
  - All four levels produce output when level is `debug`
  - `error` level only produces error output
- [ ] Update existing tests that mock/check console output:
  - Check `tests/` for any `vi.spyOn(console, ...)` — these need to spy on the logger instead, or the modules need to accept a logger in tests
  - The mock-bot helper (`tests/helpers/mock-bot.ts`) may need a mock/silent logger
- [ ] **Verify:** `pnpm test` passes with no unexpected console noise

## Config changes

None — `config.logging.level` already exists in the config schema and type definitions. We're just now actually using it.

```json
{
  "logging": {
    "level": "info",
    "mod_actions": true
  }
}
```

## Database changes

None.

## Test plan

1. **Unit tests** for `Logger`: level filtering, child loggers, format output
2. **Integration**: Boot the bot with `level: "debug"` — see all messages. Boot with `level: "warn"` — see only warnings and errors.
3. **Plugin test**: Load a plugin, call `api.log()`, `api.warn()`, `api.debug()` — verify formatting and filtering.
4. **Existing tests**: All existing tests must continue to pass.

## Open questions

1. **Timestamp format**: Plan uses `HH:MM:SS` (time only, no date). The date is usually visible from the terminal/log aggregator. Want full ISO timestamps instead?
2. **Log to file?** Currently this plan is console-only. Want a file transport too, or is console sufficient? (stdout can be redirected with `> bot.log 2>&1` if needed.)
3. **Plugin log level override?** Should plugins be able to set their own log level (e.g. debug one noisy plugin while keeping others at info)? Or is the global level sufficient for now?
4. **REPL output**: The REPL's command results (e.g. `.plugins` output, `.help` text) should probably NOT go through the logger — they're user-facing responses, not log messages. Only the REPL's own status messages (`Shutting down...`, `Interactive mode`) should use the logger. Agree?
