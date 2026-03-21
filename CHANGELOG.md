# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Phase 0 — Scaffolding**: project structure, `package.json`, `tsconfig.json`, ESLint config, Vitest setup
- **Phase 1 — Database and dispatcher**:
  - SQLite database wrapper (`src/database.ts`) with namespaced key-value store and mod_log table
  - Event dispatcher (`src/dispatcher.ts`) with Eggdrop-style `bind(type, flags, mask, handler)` system
  - All 13 bind types: `pub`, `pubm`, `msg`, `msgm`, `join`, `part`, `kick`, `nick`, `mode`, `raw`, `time`, `ctcp`, `notice`
  - Non-stackable (`pub`, `msg`) and stackable bind type support
  - Timer binds via `setInterval` with automatic cleanup
  - Wildcard pattern matching utility (`src/utils/wildcard.ts`) supporting `*` and `?`
- **Phase 2 — Permissions and commands**:
  - Permissions system (`src/core/permissions.ts`) with `n/m/o/v` flags, hostmask matching, and per-channel overrides
  - Owner flag (`n`) implies all other flags
  - Flag syntax supports OR with `|` (e.g. `+n|+m`)
  - Security warnings for insecure `nick!*@*` hostmask patterns on privileged users
  - Command handler (`src/command-handler.ts`) — transport-agnostic command router with `.help` built-in
  - Permission commands: `.adduser`, `.deluser`, `.flags`, `.users`
  - Dispatcher commands: `.binds`
  - Shared type definitions (`src/types.ts`) for HandlerContext, PluginAPI, UserRecord, config shapes
- **Phase 3 — Bot core and IRC**:
  - Bot orchestrator (`src/bot.ts`) — wires all modules together, manages lifecycle
  - IRC bridge (`src/irc-bridge.ts`) — translates irc-framework events to dispatcher events with input sanitization
  - IRC protocol injection prevention: `\r\n` stripping on all incoming fields
  - IRC formatting character stripping before command parsing
  - Internal event bus (`src/event-bus.ts`) — typed EventEmitter for bot-level events
  - Interactive REPL (`src/repl.ts`) with implicit owner privileges
  - Entry point (`src/index.ts`) with CLI args (`--repl`, `--config`), signal handlers, graceful shutdown
  - IRC admin commands: `.say`, `.join`, `.part`, `.status`
  - Auto-reconnect support via irc-framework
  - SASL authentication support
  - Owner bootstrapping from config on first start
- **Phase 4 — Plugin loader and MVP plugins**:
  - Plugin loader (`src/plugin-loader.ts`) — discover, load, unload, hot-reload via ESM cache-busting
  - Scoped PluginAPI with frozen objects, namespace-isolated database, and auto-tagged binds
  - Plugin config merging (plugin `config.json` defaults + `plugins.json` overrides)
  - Plugin validation: safe name check, required exports, duplicate detection
  - Plugin management commands: `.plugins`, `.load`, `.unload`, `.reload`
  - `8ball` plugin — Magic 8-Ball with 20 classic responses
  - `greeter` plugin — configurable join greetings with `{channel}` and `{nick}` template variables
  - `seen` plugin — last-seen tracking via `!seen <nick>` with relative time formatting
- **Phase 5 — Core modules and auto-op**:
  - Channel state tracking (`src/core/channel-state.ts`) — users, modes, hostmasks per channel, updated in real time
  - IRC commands module (`src/core/irc-commands.ts`) — `op`, `deop`, `voice`, `devoice`, `kick`, `ban`, `unban`, `mode`, `topic`, `quiet` with mod action logging and mode batching
  - Services module (`src/core/services.ts`) — NickServ IDENTIFY fallback, ACC/STATUS verification with timeout, Atheme/Anope/DALnet adapter support
  - `auto-op` plugin — auto-op/voice on join based on permission flags with optional NickServ verification
  - PluginAPI extended with `op`, `deop`, `voice`, `devoice`, `kick`, `ban`, `mode`, `getUserHostmask`, `permissions`, `services`, `botConfig`
- Config examples: `config/bot.example.json`, `config/plugins.example.json`
- Security guide: `docs/SECURITY.md`
- Design document: `DESIGN.md`
- Phase planning docs in `docs/mvp/`

### Changed

- Seen plugin updated to v1.1.0 with TTL cleanup — records older than `max_age_days` (default 365) are automatically purged on query

### Fixed

- **Security audit** (all findings from `docs/audits/all-2026-03-21.md`):
  - CommandHandler enforces permission flags for IRC sources, preventing privilege escalation
  - `botConfig` deep-frozen with NickServ password omitted from plugin API
  - Plugin `.load` command validates name against `SAFE_NAME_RE` to prevent path traversal
  - Plugin `raw()` strips `\r\n` to prevent accidental IRC protocol injection
  - REPL commands logged to console for audit trail
  - `ensureOwner` adds config hostmask if missing from existing DB record
  - IRC replies split at ~400 bytes, capped at 4 lines with `...` truncation (`src/utils/split-message.ts`)
  - RFC 2812 `ircLower()` case mapping used in wildcard matching, channel-state lookups, and dispatcher mask comparisons
  - Timer binds enforce 10-second minimum interval to prevent resource exhaustion
