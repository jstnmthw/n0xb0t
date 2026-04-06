# Security Audit: BotLink Hub — Auth Brute-Force Protection

**Date:** 2026-04-06
**Scope:** `src/core/botlink-hub.ts` connection handling and authentication, `src/core/botlink-protocol.ts` auth helpers
**Trigger:** Observed repeated auth failure probes from external scanners against production hub

## Summary

The botlink hub had **zero protection against brute-force authentication attempts**. Any host that could reach the hub's TCP port could make unlimited rapid connection attempts with no throttling, banning, or even IP-level logging. The password is hashed with scrypt (good), but online brute-force against the hub endpoint itself was completely unchecked.

The user's logs showed exactly this pattern — ~5 attempts/second from a scanner trying common botnet leaf names.

**Status:** All findings remediated. One documentation task remains (SECURITY.md §9).

**Findings:** 1 critical, 2 warning, 1 info

## Findings

### [CRITICAL] No brute-force protection on auth endpoint

**File:** `src/core/botlink-hub.ts:468-545` (`handleConnection`) and `src/core/botlink-hub.ts:549-637` (`handleHello`)
**Category:** DoS / Credential brute-force

**Description:** Every TCP connection was accepted unconditionally. On auth failure, the hub logged a warning and closed the socket — but kept no record of the source IP, attempt count, or timing. An attacker could:

1. Open connections at network speed (~hundreds/sec)
2. Send `HELLO` frames with different passwords
3. Each attempt costs the hub: socket accept → readline setup → JSON parse → string comparison against pre-hashed password → log write → close
4. The per-attempt CPU cost is low (string compare, not a fresh scrypt derivation), but the connection churn itself is the resource drain — file descriptors, readline allocations, timer setup

There was no:

- Per-IP connection rate limiting
- Temporary ban after N failures
- Escalating backoff
- Connection tracking of any kind

**The pre-fix code path:**

```
TCP connect → handleConnection() → wait for HELLO frame
  → handleHello() → password !== expectedHash
    → log warn (botname only, no IP) → send AUTH_FAILED → close
    → attacker immediately reconnects, repeat forever
```

**Post-fix code path:**

```
TCP connect → handleConnection()
  → ban check (banned? → destroy socket, no setup)
  → pending handshake limit (exceeded? → destroy socket)
  → protocol/readline setup → wait for HELLO frame
  → handleHello() → password !== expectedHash
    → log warn (botname + IP) → send AUTH_FAILED → close
    → recordAuthFailure() → ban after threshold → emit auth:ban
    → attacker reconnects → hits ban → immediately destroyed
```

**Remediation:** Implement a per-IP auth failure tracker with automatic temporary bans. Recommended approach:

```typescript
interface AuthTracker {
  failures: number;
  firstFailure: number;
  bannedUntil: number;
  banCount: number; // drives escalation doubling
}

// In BotLinkHub class:
private authTracker: Map<string, AuthTracker> = new Map();
```

In `handleConnection()`, before setting up the handshake:

1. Read `socket.remoteAddress`
2. If the IP is currently banned (`bannedUntil > Date.now()`), immediately destroy the socket — no handshake, no scrypt, no log spam
3. On auth failure in `handleHello()`, increment the failure counter for that IP
4. After `max_auth_failures` (default: 5) within `auth_window_ms` (default: 60000), ban the IP for `auth_ban_duration_ms` (default: 300000 / 5 min), escalating on repeat offenses
5. Periodically sweep stale entries from the map (e.g., on each new connection, prune entries older than the ban window)

Config additions to `BotlinkConfig`:

```typescript
max_auth_failures?: number;      // default 5
auth_window_ms?: number;         // default 60_000
auth_ban_duration_ms?: number;   // default 300_000
```

**Decisions:** Exact IP tracking (no prefix grouping). Ban duration doubles on each re-ban, capped at 24h to prevent integer overflow — tracker entry never resets, so a persistent scanner stays at the 24h ceiling indefinitely. Whitelisted CIDRs bypass the tracker entirely.

**Recommended phased solution:**

- [x] Add `AuthTracker` interface and `authTracker: Map<string, AuthTracker>` to `BotLinkHub`
- [x] Read `socket.remoteAddress` in `handleConnection()`; skip tracker for IPs matching `auth_ip_whitelist` CIDRs
- [x] If IP is currently banned (`bannedUntil > Date.now()`), immediately destroy socket — no handshake, no scrypt
- [x] On auth failure in `handleHello()`, increment per-IP failure counter; ban after `max_auth_failures` within `auth_window_ms`
- [x] Escalating ban duration: double on each re-ban, cap at 24h, no reset (5m → 10m → 20m → … → 24h ceiling)
- [x] Add config knobs to `BotlinkConfig`: `max_auth_failures`, `auth_window_ms`, `auth_ban_duration_ms`, `auth_ip_whitelist`
- [x] Emit `auth:ban` and `auth:unban` events on the EventBus (IP, failure count, ban duration)
- [x] Periodic stale-entry sweep (prune expired non-escalated entries on each new connection)
- [x] Add tests: failure counting, ban enforcement, ban expiry, escalation doubling, whitelist bypass, EventBus emission, config overrides

---

### [WARNING] Auth failure logs omit source IP

**File:** `src/core/botlink-hub.ts:560` (was `:449`)
**Category:** Logging / Incident response

**Description:** The auth failure log line was:

```typescript
this.logger?.warn(`Auth failed for "${botname}"`);
```

The `botname` is attacker-controlled (it's from the HELLO frame). The actual source IP (`socket.remoteAddress`) was never logged. This meant:

- Admins couldn't correlate failures to a source without packet captures or external firewall logs
- The botname in the log was whatever the scanner chose to send — it could be misleading (e.g., matching a real leaf name)
- External fail2ban rules couldn't parse the IP from the log line

**Remediation:** Include the source IP in auth failure (and success) log lines. The implementation reads `socket.remoteAddress` directly in `handleConnection()` (before protocol creation for banned IPs):

```typescript
this.logger?.warn(`Auth failed for "${botname}" from ${ip}`);
this.logger?.info(`Leaf "${botname}" connected from ${ip}`);
```

**Recommended phased solution:**

- [x] Add `get remoteAddress()` getter to `BotLinkProtocol` exposing `this.socket.remoteAddress`
- [x] Include source IP in auth failure log: `Auth failed for "${botname}" from ${ip}`
- [x] Include source IP in auth success log: `Leaf "${botname}" connected from ${ip}`
- [x] Add tests verifying IP presence in log output

---

### [WARNING] Handshake timeout still costs resources during flood

**File:** `src/core/botlink-hub.ts:512-520` (was `:414-421`)
**Category:** DoS

**Description:** Each connection gets a configurable handshake timer (default 10s, was 30s). During a flood of connections that never send HELLO (slowloris-style), each connection holds a socket, a readline interface, and a timer for up to 10 seconds. With hundreds of concurrent connections, this consumes file descriptors and memory.

The brute-force protection from the CRITICAL finding would partially mitigate this (banned IPs get immediately dropped), but connections from unbanned IPs that never complete the handshake still linger.

**Remediation:**

- The per-IP ban from the critical fix is the primary mitigation
- Per-IP `max_pending_handshakes` limit (default: 3) — reject new connections from the same IP when limit reached
- Handshake timeout reduced to 10s (configurable via `handshake_timeout_ms`) — legitimate leaves HELLO within milliseconds

**Decisions:** Per-IP pending handshake cap (not global). Handshake timeout configurable via config.

**Recommended phased solution:**

- [x] (Covered by CRITICAL fix) Banned IPs dropped before handshake setup
- [x] Add per-IP `max_pending_handshakes` counter (default: 3) to `BotLinkHub`; reject new connections from the same IP when limit reached
- [x] Make handshake timeout configurable via `handshake_timeout_ms` in `BotlinkConfig`; reduce default to 10s
- [x] Add tests: per-IP pending handshake limit enforcement, timeout behavior, config override

---

### [INFO] No connection event logging for monitoring

**File:** `src/core/botlink-hub.ts:468` (was `:409`)
**Category:** Observability

**Description:** New TCP connections were not logged at all until authentication succeeded or failed. A connection that arrived and hung (no HELLO, no close) was invisible until the timeout fired. A debug-level log on connection accept (with IP) helps correlate network events.

**Remediation:**

```typescript
private handleConnection(socket: Socket): void {
  const ip = socket.remoteAddress ?? 'unknown';
  this.logger?.debug(`New connection from ${ip}`);
  // ... existing logic
}
```

**Recommended phased solution:**

- [x] Add `debug`-level log on connection accept: `New connection from ${ip}`
- [x] Add `debug`-level log on handshake timeout: `Handshake timeout from ${ip}` (logged at warn level)

## Passed checks

- **Password never sent in plaintext** — scrypt hash is used over the wire
- **Handshake timeout** configurable via `handshake_timeout_ms` (default 10s, was hardcoded 30s) — prevents connections from hanging forever
- **max_leaves** cap prevents unbounded authenticated leaf connections
- **Frame size limit** (64KB) prevents oversized frame attacks
- **Frame sanitization** strips injection characters from all string values
- **Rate limiting** on CMD/PARTY_CHAT/PROTECT frames after authentication

## Recommendations

1. ~~**Implement per-IP auth failure tracking with temp bans**~~ — Done. ~120 lines of hub logic plus config, types, events, and tests.

2. ~~**Expose source IP in BotLinkProtocol**~~ — Done. `get remoteAddress()` getter added; IP read directly from `socket.remoteAddress` in `handleConnection()` (before protocol creation for banned IPs).

3. ~~**Add config knobs**~~ — Done. `max_auth_failures`, `auth_window_ms`, `auth_ban_duration_ms`, `auth_ip_whitelist`, `handshake_timeout_ms`, `max_pending_handshakes` in `BotlinkConfig`.

4. ~~**`max_pending_handshakes`**~~ — Done. Per-IP limit (default 3), checked before protocol setup.

5. **Document in SECURITY.md §9** — add a subsection on auth brute-force protection and the recommended deployment practice of firewall rules in addition to the application-level protection.
   - [ ] Add SECURITY.md §9 subsection on auth brute-force protection
