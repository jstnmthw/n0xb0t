# ctcp

Replies to CTCP VERSION, PING, and TIME requests.

## How it works

The plugin registers `ctcp` binds for `VERSION`, `PING`, and `TIME`. Responses are automatic — no user interaction required.

| Request   | Response                                       |
| --------- | ---------------------------------------------- |
| `VERSION` | `hexbot v<version>` (read from `package.json`) |
| `PING`    | Echo of the PING payload (standard CTCP PING)  |
| `TIME`    | Current local time as a human-readable string  |

Responses are rate-limited by the core CTCP rate limiter (shared with any other CTCP handler).

## Config

No configurable options. Enable or disable the plugin in `config/plugins.json`:

```json
{
  "ctcp": {
    "enabled": true
  }
}
```
