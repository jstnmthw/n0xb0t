# hexbot — Principal Engineer Review

### March 2026

This document is a structured principal-level review of the hexbot codebase, combining static analysis of the current implementation with external research into the current state of the IRC ecosystem (security advisories, IRCv3 protocol evolution, authentication standards, and Node.js library landscape) as of early 2026.

The audience is the development team. The goal is to surface gaps between current implementation and current best practices, produce actionable recommendations, and document the findings in enough detail that they can be acted on in future sessions without re-doing the research.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Codebase Assessment](#2-codebase-assessment)
3. [External Research: IRC Ecosystem 2024–2026](#3-external-research-irc-ecosystem-20242026)
4. [Gap Analysis](#4-gap-analysis)
5. [Prioritized Recommendations](#5-prioritized-recommendations)
6. [Appendix: Research Sources](#6-appendix-research-sources)

---

## 1. Executive Summary

**hexbot is architecturally sound and already implements most IRC bot security best practices correctly.** The Eggdrop-inspired bind system, scoped plugin API, hostmask-based identity, NickServ integration, input sanitization at the trust boundary, and message rate limiting are all well-designed and correctly implemented.

The codebase shows evidence of deliberate security thinking — `docs/SECURITY.md` is comprehensive, TLS is on by default, SASL is preferred, and the configuration world-readability check is a thoughtful operational detail rarely seen in open-source bots.

**Three areas require attention before deploying on a hostile public network:**

| Priority | Issue                                                                             | Impact                                                |
| -------- | --------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **P0**   | NickServ ACC race condition not enforced at dispatch time                         | Admin privilege escalation via nick squatting         |
| **P1**   | Message tags from IRCv3 treated as server-trusted without explicit classification | Trust boundary ambiguity                              |
| **P2**   | No SASL EXTERNAL / CertFP path                                                    | Bot credentials exist in config as plaintext password |

Additionally, several IRCv3 capabilities relevant to bot operations are not yet negotiated (`account-notify`, `extended-join`, `chghost`) — these would materially improve identity verification robustness.

---

## 2. Codebase Assessment

### 2.1 Architecture

The two-tier core/plugin separation is the project's strongest design decision. Core modules provide foundational services with direct access to primitives; plugins receive a frozen, scoped `PluginAPI` that enforces namespace isolation at the TypeScript type level. This is the correct approach.

The Eggdrop bind system is the right abstraction for IRC event routing. Its 30-year operational history on hostile networks validates the design. The dispatcher implementation correctly:

- Checks flags before calling handlers
- Wraps every handler in try/catch
- Enforces minimum timer intervals (10s floor prevents timer flooding)
- Distinguishes stackable from non-stackable bind types

The IRC bridge (`src/irc-bridge.ts`) correctly identifies itself as the trust boundary and applies `sanitize()` to all incoming fields. The split between bridge (event translation + sanitization) and dispatcher (routing + permission checking) is clean.

### 2.2 Security Posture

#### Correctly Implemented

| Practice                                                   | Status | Location                                                          |
| ---------------------------------------------------------- | ------ | ----------------------------------------------------------------- |
| Strip `\r\n` from all IRC input                            | ✅     | `src/utils/sanitize.ts`, applied in `irc-bridge.ts`               |
| TLS by default                                             | ✅     | Default `irc.tls: true`                                           |
| SASL preferred over PRIVMSG IDENTIFY                       | ✅     | Documented default                                                |
| Parameterized SQL queries                                  | ✅     | `better-sqlite3` prepared statements throughout `src/database.ts` |
| Flag check before every handler                            | ✅     | `dispatcher.dispatch()` gates on `checkFlags()`                   |
| Config world-readability check on startup                  | ✅     | `src/bot.ts` `loadConfig()`                                       |
| NickServ password omitted from `botConfig` sent to plugins | ✅     | Plugin API construction                                           |
| CTCP rate limiting (3 responses per nick per 10s)          | ✅     | `src/irc-bridge.ts`                                               |
| Plugin error containment (no crash propagation)            | ✅     | Dispatcher try/catch                                              |
| Message splitting at word boundaries                       | ✅     | `src/utils/split-message.ts`                                      |
| Outbound rate limiting (token bucket)                      | ✅     | `src/core/message-queue.ts`                                       |
| Hostmask `nick!*@*` warning                                | ✅     | Logged on `adduser`                                               |
| IRC control code stripping before command parse            | ✅     | `src/irc-bridge.ts`                                               |
| Plugin namespace DB isolation                              | ✅     | `Database` class enforces at runtime                              |
| DCC: 30-second port timeout, single-accept                 | ✅     | `src/core/dcc.ts`                                                 |
| Mod action logging with actor                              | ✅     | `mod_log` table                                                   |

#### Partial or Gap

**NickServ ACC race — P0**

`docs/SECURITY.md` correctly identifies the risk: a user can adopt an admin's nick before completing NickServ identification, and if the bot ops on join without waiting for the ACC response, the attacker receives ops.

The documentation says "the bot MUST wait for the ACC response." However, the `require_acc_for` config controls this per-flag-level, and the enforcement path relies on handlers being manually written to call `api.services.verifyUser()` before acting. The dispatcher does not enforce this automatically. A plugin author who forgets the `await verifyUser()` call will silently ship the race condition.

**Recommendation:** The dispatcher should enforce this. When a `HandlerContext` is created for a bind with flags that appear in `config.identity.require_acc_for`, the context should include a pre-fetched `accVerified: boolean` that handlers can trust without re-querying. Alternatively, the dispatcher could block handler execution for flagged binds until verification completes (with configurable timeout/fallback).

**Formatting stripping in security output — P2**

`docs/SECURITY.md` section 5.2 correctly warns that user input containing IRC color/formatting codes could mislead in security-relevant messages. The greeter plugin strips formatting from nick before display — but this is ad-hoc per-plugin. There is no `stripFormatting(text)` utility in `src/utils/`, so plugin authors must either know to do this themselves or skip it.

**Recommendation:** Add `src/utils/strip-formatting.ts` exporting `stripFormatting(text: string): string` and expose it in the `PluginAPI`. Document it in `docs/SECURITY.md` section 5.2 and `docs/PLUGIN_API.md`.

### 2.3 Plugin Ecosystem

The shipped plugins are well-implemented. Specific observations:

**chanmod** — correctly reads `ISUPPORT MODES` before batching mode changes. Timed-ban tracking via database is robust. The auto-op path is the primary area where the NickServ ACC race (above) could manifest in practice.

**flood** — per-user and per-channel rate tracking is correct. The join-spam detection uses a time window with a count threshold, which is the standard approach. Nick-change spam detection is present but does not currently de-privilege (voice/op removal) spammers — it only kicks. Consider whether this is the intended behavior.

**ctcp** — CTCP rate limiting at the bridge level (`src/irc-bridge.ts`) is the right layer. The plugin only handles responses; it doesn't need its own rate limiting. Correct architecture.

**greeter** — the custom greet feature correctly gates on NickServ verification (`verifyUser()`) before allowing users to set custom greets. Good pattern for other plugins to follow.

### 2.4 Code Quality

TypeScript strict mode throughout, no observed `any` escapes, ESM modules, async/await correctly used. The codebase is well above average for an IRC bot. Pre-commit hooks (ESLint + Prettier + Husky) enforce style consistency.

Test coverage is strong for core modules (dispatcher, permissions, services, database) and adequate for plugins. The `tests/helpers/mock-bot.ts` mock is well-structured.

One quality observation: `src/irc-bridge.ts` at ~500 lines is approaching the size where a split might be warranted. The CTCP handling, topic suppression, and action event handling are candidates for extraction into focused sub-handlers if the file continues to grow.

---

## 3. External Research: IRC Ecosystem 2024–2026

### 3.1 Security Vulnerabilities — Active CVEs and Advisories

#### CVE-2025-27146 — matrix-appservice-irc Command Injection (February 2025)

**This is the most directly relevant recent CVE for Node.js IRC bot developers.**

The Matrix IRC bridge failed to sanitize user-supplied input before constructing IRC command strings, allowing injection of arbitrary IRC commands via `\r\n` characters. Classification: CWE-77 (Command Injection). CVSS 3.1 base: 4.3 (NIST). Fixed in matrix-appservice-irc 3.0.4.

This is precisely the attack that hexbot's `sanitize()` utility and "use typed methods, not `raw()`" policy defend against. The CVE confirms that real-world Node.js IRC bridges ship with this gap when developers don't treat IRC output as a protocol injection surface.

**hexbot status:** Protected. Sanitize is applied at the trust boundary. `raw()` in the plugin API strips newlines before dispatch.

#### CVE-2022-2663 — Linux Kernel Netfilter IRC Helper

A 2022 Linux kernel vulnerability in the IRC connection tracking helper allowed remote attackers to manipulate unencrypted NAT'd IRC connections — including DCC handshakes — to bypass firewalls or cause DoS. This does not affect hexbot directly but reinforces the value of TLS (which hexbot defaults to) for all IRC traffic.

#### InspIRCd Security Advisory 2024-01 (July 2024)

The `spanningtree` module in InspIRCd v4.0.0 through v4.0.0a26/rc3 caused a null pointer dereference when the `chanhistory` module was also loaded. Any connected user with channel mode permissions could crash the server remotely. Fixed in v4.0.1 within 24 hours.

Relevant for hexbot deployments running against InspIRCd v4.0.0. If the target server is unpatched, the bot has no defense (this is a server-side bug). Ensure InspIRCd is at v4.0.1+.

#### CVE-2019-19010 — Limnoria (Supybot) Eval Injection

The Python IRC bot Limnoria's `calc` and `icalc` commands evaluated user-supplied math expressions via Python's `eval()`, allowing full code execution in the bot's context. CVSS 9.8.

Direct analogy for the hexbot plugin ecosystem: any plugin command that evaluates user-controlled input as code or as a templating expression is a critical vulnerability. The hexbot plugin API has no `eval`-adjacent surface, but plugin authors should be explicitly warned against it.

#### Historical CTCP Exploit Patterns

Across X-Chat, KVIrc, WeeChat, Quassel, and Irssi, the consistent CTCP vulnerability class is: insufficient sanitization of `\r`, `\n`, `\0`, and backslash sequences in CTCP parameter values that get embedded into IRC command construction. The rate limiter in `src/irc-bridge.ts` addresses CTCP flooding. The `sanitize()` function addresses injection. Both are correct.

#### SSHStalker Botnet (February 2026)

A newly discovered Linux botnet using IRC C2 infrastructure. It connects to an UnrealIRCd server, joins a control channel, and receives flood-attack commands via PRIVMSG. It combines SSH brute-forcing with 16 legacy Linux kernel CVEs.

Context: IRC C2 infrastructure remains actively used in malware operations as of early 2026. This means any publicly accessible hexbot deployment will periodically receive unsolicited JOIN/PRIVMSG traffic from bots probing for common bot command interfaces. The flood plugin's rate limiting and chanmod's mode enforcement are the primary defenses. Consider adding basic `!version` CTCP blocking or unusual-command rate limiting if deploying on a public network.

### 3.2 Authentication — Current Best Practices

#### SASL Authentication (IRCv3.1 / 3.2)

SASL is the current standard for bot authentication. IRCv3 SASL 3.2 specification (ratified) defines:

- SASL MUST be negotiated before `CAP END` — the authentication window is pre-registration.
- `DH-BLOWFISH` and `DH-AES` mechanisms are deprecated; they provided false security. PLAIN over TLS is cryptographically superior.
- Preferred mechanisms ranked by security: **EXTERNAL** (TLS client certificate) > **PLAIN over TLS** > anything else.

**SASL EXTERNAL (CertFP)** — the gold standard for bots: the bot authenticates using a TLS client certificate whose fingerprint is registered with NickServ. No password is stored in config or transmitted over the wire. This eliminates the password-in-config risk entirely.

hexbot currently supports SASL PLAIN (via `irc-framework`, which handles SASL at the library level). SASL EXTERNAL is not implemented as a config option. This is a gap.

#### NickServ Services Security

Atheme IRC Services recommends `crypto/pbkdf2v2` for password hashing (as of 2024). Anope 2024 downgraded MD5/SHA1/SHA256 modules to verify-only. Both confirm that services passwords should be treated as high-value secrets requiring strong hashing on the server side — reinforcing the argument for CertFP so the bot never transmits a password at all.

#### `account-notify` / `extended-join` — IRCv3 Identity Tracking

Two IRCv3 capabilities that materially improve bot identity verification:

- **`extended-join`**: On JOIN, the server appends the user's services account name to the event. The bot knows immediately on join whether the user is identified, without querying NickServ. Eliminates the ACC query round-trip and the race window.
- **`account-notify`**: The server sends a notification whenever a user's identification status changes (identifies, deidentifies, changes nick while identified). The bot can maintain a live account-nick mapping without polling.
- **`chghost`**: The server sends a notification when a user's displayed hostmask changes (e.g., after identifying). Without this, the bot may have a stale hostmask in its channel-state cache.

None of these capabilities are currently negotiated or used in hexbot. Implementing them would significantly reduce reliance on the NickServ ACC polling approach.

### 3.3 IRCv3 Protocol Evolution

The IRCv3 working group has ratified or drafted several specifications relevant to bot operations.

#### Message Tags — Trust Model

Message tags (ratified) have a critical trust distinction:

- **Server tags** (unprefixed, e.g., `time`, `account`, `msgid`): Set by the server. Bot code may treat these as server-verified.
- **Client-only tags** (prefixed `+`, e.g., `+draft/react`): Set by clients, relayed by the server as-is. **Must be treated as completely untrusted user input** — equivalent in trust level to message body text.

The hexbot codebase does not currently use message tags (irc-framework abstracts them). However, any future feature that reads tag values must apply this trust classification.

#### `labeled-response` + `batch` (Ratified)

These capabilities allow correlating sent commands to server responses using opaque 64-byte labels. For a bot that sends commands and needs to match responses (e.g., MODE queries, WHO requests), labeled-response prevents response-confusion attacks where the server's reply to one command is misinterpreted as a reply to another.

irc-framework does not currently expose labeled-response to library consumers. If hexbot ever implements complex multi-step flows (e.g., verifying channel state before applying modes), this is the correct mechanism.

#### `message-redaction` Draft (April 2024)

A draft specification allowing removal/hiding of chat history messages. Bots acting as history services need to handle redaction events. Not currently relevant to hexbot's feature set but will matter if the seen plugin or a future logging plugin stores message history.

#### `account-extban` (July 2024)

Standardizes account-based banning via ISUPPORT: `EXTBAN=$,accountname`. This allows mode strings like `+b $a:baduser` to ban by services account rather than hostmask. More robust than IP-based banning. chanmod's ban system could use this if the target server supports it.

#### `metadata-2` Draft (September 2024)

Arbitrary public metadata on users and channels. All metadata values must be treated as untrusted user input — same classification as message body.

### 3.4 Node.js IRC Library Landscape

#### irc-framework (kiwiirc/irc-framework)

- **Latest release:** v4.14.0 (September 23, 2024)
- **Security advisories:** 0 public advisories as of research date
- Actively maintained; powers Kiwi IRC (production web IRC client)
- Recent security-relevant changes:
  - SASL failure handling improved (v4.13.0, January 2024)
  - SASL v3.2 mechanism list honored (v4.13.0)
  - Certificate fingerprint retrieval fixed for InspIRCd v4 (v4.14.0) — directly relevant to any CertFP/SASL EXTERNAL implementation
  - Node.js v12 support dropped (v4.13.0) — hexbot already requires Node.js 24+

**Assessment:** irc-framework remains the correct library choice. It is the only actively maintained production-grade IRC client library for Node.js. Its typed methods (`say`, `notice`, `mode`, `join`) provide the layer of indirection that prevents the CRLF injection class of bugs at the transport level. CVE-2025-27146 happened in matrix-appservice-irc precisely because that project constructed raw IRC strings from user input — irc-framework's API design prevents this by default.

#### Alternatives

No viable alternatives exist for a TypeScript/Node.js IRC bot in 2026:

- `node-irc` (martynsmith): Last significant update years ago; has unpatched historical vulnerabilities. Not recommended.
- `coffea`: Inactive.
- `matrix-appservice-irc`: Actively developed but bridge-focused, not library-focused; just shipped CVE-2025-27146.

### 3.5 IRC Server Compatibility Notes

#### Ergo (ergochat/ergo) — Security Reference Implementation

Ergo v2.17.0 (December 2025) is the most security-forward modern ircd. Notable features relevant to bot developers:

- Requires TLS by default; no plaintext port in default config
- Native SASL, CertFP, LDAP integration
- bcrypt for all stored passwords
- Unified ban system targeting IPs, networks, masks, and registered accounts
- Full IRCv3 support including `extended-join`, `account-notify`, `chghost`, `labeled-response`

Testing hexbot against Ergo locally is recommended as a development environment because Ergo's strict IRCv3 compliance will expose capability negotiation gaps that lenient servers may hide.

#### InspIRCd v4

hexbot's CertFP-related code was updated in irc-framework v4.14.0 to fix fingerprint retrieval with InspIRCd v4's new format. Ensure the irc-framework version in use is ≥4.14.0 before deploying against InspIRCd v4.

#### UnrealIRCd

UnrealIRCd distinguishes "known" vs "unknown" users with tiered rate limits. A bot can be configured as a known user with elevated limits via security groups. For high-activity bots (flood protection, topic management), registering the bot's IP in UnrealIRCd's security group config prevents the bot from triggering server-side flood protection.

---

## 4. Gap Analysis

Mapping current hexbot state against the research findings above.

### 4.1 Security Gaps

| Gap                                                | Severity       | Research Context                                               | Recommended Fix                                         |
| -------------------------------------------------- | -------------- | -------------------------------------------------------------- | ------------------------------------------------------- |
| NickServ ACC race not enforced at dispatcher level | **High**       | Documented in `SECURITY.md` but relies on plugin author memory | Dispatcher-level ACC enforcement for flagged binds      |
| No SASL EXTERNAL / CertFP path                     | **Medium**     | Gold standard for bot auth; eliminates password-in-config      | Add `services.sasl_mechanism: "EXTERNAL"` config option |
| `account-notify` / `extended-join` not negotiated  | **Medium**     | Eliminates ACC polling race window entirely                    | Negotiate and integrate into identity verification      |
| `chghost` not negotiated                           | **Low-Medium** | Channel state cache may hold stale hostmasks                   | Negotiate and update channel-state on chghost           |
| No `stripFormatting()` utility in PluginAPI        | **Low**        | Ad-hoc per plugin; SECURITY.md recommends it                   | Add to `src/utils/`, expose in PluginAPI                |
| Message tag trust classification not documented    | **Low**        | IRCv3 message tag trust model is non-obvious                   | Document in SECURITY.md and PLUGIN_API.md               |
| Plugin eval() not explicitly forbidden in docs     | **Low**        | CVE-2019-19010 pattern; critical if any plugin adds this       | Add explicit prohibition to SECURITY.md section 4       |

### 4.2 Feature Gaps (IRCv3 Capabilities)

| Capability                   | IRCv3 Status      | Hexbot Status                      | Value                                  |
| ---------------------------- | ----------------- | ---------------------------------- | -------------------------------------- |
| `sasl`                       | Ratified          | ✅ Implemented (PLAIN)             | Authentication                         |
| `message-tags`               | Ratified          | irc-framework handles; not exposed | Tag trust model needs documentation    |
| `labeled-response` + `batch` | Ratified          | Not implemented                    | Command/response correlation           |
| `account-notify`             | Ratified          | ❌ Not negotiated                  | Real-time deidentification detection   |
| `extended-join`              | Ratified          | ❌ Not negotiated                  | Know account on join without ACC query |
| `chghost`                    | Ratified          | ❌ Not negotiated                  | Real-time hostmask change events       |
| `away-notify`                | Ratified          | Not negotiated                     | Away status tracking                   |
| `cap-notify`                 | Ratified          | irc-framework handles internally   | Capability change awareness            |
| `account-extban`             | Draft (July 2024) | ❌ Not used                        | Account-based banning in chanmod       |

### 4.3 Operational Gaps

| Gap                                                         | Recommendation                                                       |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| No guidance on testing against a strict IRCv3 server        | Add Ergo to recommended dev environment in README or DESIGN.md       |
| InspIRCd v4 CertFP fix requires irc-framework ≥4.14.0       | Document minimum irc-framework version in DESIGN.md tech stack table |
| No security group registration guidance for UnrealIRCd      | Add to deployment doc or `docs/plans/deployment.md`                  |
| `docs/SECURITY.md` does not mention message tag trust model | Add section on IRCv3 message tags                                    |

---

## 5. Prioritized Recommendations

### P0 — Enforce NickServ ACC at Dispatch Time

**Problem:** The ACC race condition is documented but not mechanically enforced. A plugin author who calls `api.bind('join', '+o', '*', handler)` without calling `api.services.verifyUser()` ships the race condition silently.

**Solution:** When the dispatcher resolves a handler for a flagged bind, and `config.identity.require_acc_for` includes that flag level, the dispatcher should:

1. Check if the IRC server has services available (`api.services.isAvailable()`).
2. If yes, call `verifyUser()` and gate handler execution on the result.
3. If `verifyUser()` times out, fall through to the configured fallback (deny or allow).

This makes the secure behavior the default and the insecure behavior opt-in, rather than the current inverse.

**Alternatively** (and preferably, long-term): negotiate `extended-join` and `account-notify` so that the bot maintains a live account→nick mapping. Dispatcher flag checks can then consult this map synchronously instead of making async network calls.

**Files:** `src/dispatcher.ts`, `src/core/services.ts`, `src/irc-bridge.ts`

### P1 — Add `extended-join`, `account-notify`, `chghost` Capability Negotiation

**Problem:** hexbot's identity verification relies on polling NickServ ACC on demand. This is inherently racy and requires a round-trip per event.

**Solution:** Request the `extended-join`, `account-notify`, and `chghost` capabilities during capability negotiation in `src/irc-bridge.ts`. Update `src/core/channel-state.ts` to:

- Store `accountName` on `ChannelUser` (populated from `extended-join`)
- Update `accountName` on `account-notify` events
- Update hostmask on `chghost` events

The dispatcher and services module can then consult the channel-state account mapping synchronously, eliminating the NickServ polling race entirely for join-triggered operations.

**Files:** `src/irc-bridge.ts`, `src/core/channel-state.ts`, `src/types.ts`

**Note:** These capabilities require the IRC server to support them. irc-framework handles capability negotiation; hexbot should request them and gracefully fall back to polling if not offered.

### P2 — Implement SASL EXTERNAL (CertFP)

**Problem:** Bot authentication with SASL PLAIN requires a plaintext password in `config/bot.json`. Even with the world-readability check, the password is present on disk. SASL EXTERNAL authenticates via TLS client certificate, eliminating the password entirely.

**Solution:** Add `services.sasl_mechanism: "EXTERNAL"` config option. Generate and register a client certificate. Pass the client certificate to irc-framework's TLS configuration. irc-framework v4.14.0 supports CertFP fingerprint retrieval — verify the cert generation and fingerprint registration flow works end-to-end.

This is a configuration and documentation change more than a code change; irc-framework handles the SASL exchange.

**Files:** `config/bot.example.json`, `src/bot.ts` (TLS cert loading), `docs/SECURITY.md`

### P3 — Add `stripFormatting()` to PluginAPI

**Problem:** `docs/SECURITY.md` section 5.2 recommends stripping IRC formatting from user input in security-relevant output. The greeter plugin does this ad-hoc. There is no shared utility.

**Solution:** Add `src/utils/strip-formatting.ts` that strips IRC control characters (bold `\x02`, color `\x03`, italic `\x1D`, underline `\x1F`, strikethrough `\x1E`, monospace `\x11`, reset `\x0F`) from a string. Expose as `api.stripFormatting(text)` in the PluginAPI. Update `docs/PLUGIN_API.md` and `docs/SECURITY.md`.

The regex pattern: `/[\x02\x03\x04\x0F\x11\x1D\x1E\x1F](\d{1,2}(,\d{1,2})?)?/g`

**Files:** `src/utils/strip-formatting.ts`, `src/types.ts`, `src/plugin-loader.ts`, `docs/PLUGIN_API.md`

### P4 — Document Message Tag Trust Model

**Problem:** IRCv3 message tags have a non-obvious trust model. Client-only tags (`+` prefix) are completely untrusted — they are user-supplied values relayed verbatim by the server. Any future feature reading tag values must apply this distinction. Currently there is no documentation of this.

**Solution:** Add a section to `docs/SECURITY.md` covering:

- Server tags vs client-only tags (`+` prefix)
- Server tags may be treated as server-verified
- Client-only tags must be treated as untrusted user input equivalent to message body
- List currently relevant server tags: `time`, `account`, `msgid`

**Files:** `docs/SECURITY.md`

### P5 — Add Development Environment Guidance (Ergo)

**Problem:** hexbot is currently tested against production IRC networks. Ergo is a strict IRCv3-compliant ircd that would expose capability negotiation gaps and authentication flows in a controlled environment.

**Solution:** Add a section to `docs/plans/deployment.md` (or a new `docs/DEVELOPMENT.md`) recommending Ergo for local development:

```bash
docker run --rm -it -p 6697:6697 ghcr.io/ergochat/ergo
```

Ergo defaults to TLS-only, full IRCv3, and strict capability negotiation — a better test surface than most production networks.

### P6 — Explicitly Prohibit `eval()` in Plugin Security Docs

CVE-2019-19010 (Limnoria) is a real-world example of an IRC bot plugin developer using `eval()` to process user input. The hexbot `docs/SECURITY.md` section 4 covers plugin isolation but does not explicitly call out `eval()` as prohibited. Add it explicitly given the severity (CVSS 9.8).

**Files:** `docs/SECURITY.md`

---

## 6. Appendix: Research Sources

| Source                                                                                                                                 | Relevance                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [CVE-2025-27146 — matrix-appservice-irc](https://github.com/matrix-org/matrix-appservice-irc/security/advisories/GHSA-5mvm-89c9-9gm5)  | Direct CRLF injection CVE in Node.js IRC bridge, February 2025 |
| [InspIRCd Security Advisory 2024-01](https://docs.inspircd.org/security/2024-01/)                                                      | Server-side crash via chanhistory + spanningtree modules       |
| [CVE-2019-19010 — Limnoria](https://vulert.com/vuln-db/pypi-limnoria-15662)                                                            | eval() injection in IRC bot plugin (CVSS 9.8)                  |
| [SSHStalker Botnet — The Hacker News](https://thehackernews.com/2026/02/sshstalker-botnet-uses-irc-c2-to.html)                         | Active IRC C2 botnet using UnrealIRCd, February 2026           |
| [IRCv3 2024 Specification Round-up](https://ircv3.net/2024/11/13/spec-round-up)                                                        | account-extban, message-redaction, metadata-2 drafts           |
| [IRCv3 Message Tags Specification](https://ircv3.net/specs/extensions/message-tags.html)                                               | Trust model for server vs client-only tags                     |
| [IRCv3 SASL 3.2 Specification](https://ircv3.net/specs/extensions/sasl-3.2)                                                            | Preferred mechanisms, reauthentication, timing requirements    |
| [IRCv3 Labeled Response Specification](https://ircv3.net/specs/extensions/labeled-response.html)                                       | Command/response correlation                                   |
| [irc-framework v4.14.0 release notes](https://github.com/kiwiirc/irc-framework/releases/tag/v4.14.0)                                   | CertFP fix for InspIRCd v4; current library version            |
| [irc-framework v4.13.0 release notes](https://github.com/kiwiirc/irc-framework/releases/tag/v4.13.0)                                   | SASL v3.2 mechanism list, failure handling                     |
| [Ergo v2.17.0](https://ergo.chat/about/)                                                                                               | Strict IRCv3-compliant ircd for development testing            |
| [IRC Technology News H2 2024 — Ilmari Lauhakangas](https://www.ilmarilauhakangas.fi/irc_technology_news_from_the_second_half_of_2024/) | IRCv3 ecosystem overview, server compatibility notes           |
| [UnrealIRCd Anti-Flood Settings](https://www.unrealircd.org/docs/Anti-flood_settings)                                                  | Security group configuration for trusted bot accounts          |
| [Anope News 2024](https://www.anope.org/news/2024/)                                                                                    | Password hashing algorithm changes in services software        |
| [Libera Chat SASL Guide](https://libera.chat/guides/sasl)                                                                              | Network-specific SASL EXTERNAL / CertFP registration process   |
| [OWASP CRLF Injection](https://owasp.org/www-community/vulnerabilities/CRLF_Injection)                                                 | Classification and mitigation patterns                         |
| [CVE-2022-2663 — Linux Netfilter IRC Helper](https://nvd.nist.gov/vuln/detail/CVE-2022-2663)                                           | Kernel-level IRC DCC traffic manipulation                      |

---

_Review conducted by Principal Engineer session, March 27, 2026. Next review recommended before first public network deployment or after any major architectural change to the dispatcher, irc-bridge, or authentication subsystem._
