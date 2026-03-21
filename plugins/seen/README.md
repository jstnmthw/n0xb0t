# seen

Tracks when users were last seen talking in a channel.

## Usage

```
!seen <nick>
```

Reports when the user was last active, in which channel, and what they said.

## How it works

The plugin silently records every channel message via a `pubm` bind (stackable, doesn't interfere with other plugins). Data is stored in the bot's database, namespaced to this plugin. Records persist across plugin reloads and bot restarts.

## Config

No configuration needed.
