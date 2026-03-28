# topic plugin

Sets channel topics using pre-built IRC color theme borders. Ships with 22+ built-in themes.
Includes optional topic protection: lock the current topic and the bot will restore it if anyone
changes it without operator privileges.

## Commands

| Command                         | Flags | Description                                                  |
| ------------------------------- | ----- | ------------------------------------------------------------ |
| `!topic <theme> <text>`         | `o`   | Set the channel topic wrapped in the theme's color border    |
| `!topic lock`                   | `o`   | Lock the current topic — restores it on unauthorized changes |
| `!topic unlock`                 | `o`   | Disable topic protection                                     |
| `!topic preview <theme> <text>` | `o`   | Preview the themed topic as a channel message                |
| `!topics`                       | `-`   | List all available theme names                               |
| `!topics preview [text]`        | `-`   | PM all themes rendered with optional sample text             |

## Typical workflow

```
!topic rune Welcome to #hexbot | https://hexbot.net
!topic lock
```

Then if anyone changes the topic without `+o`, the bot immediately restores it.
To change the locked topic, set a new one and re-lock:

```
!topic rune Updated topic text
!topic lock
```

To stop protecting:

```
!topic unlock
```

The protection state is also readable and writable via the REPL:

```
.chaninfo #channel          — shows protect_topic and topic_text
.chanset #channel +protect_topic   — enable protection (does not set topic_text)
.chanset #channel -protect_topic   — disable protection
```

> **Note**: `!settopic` was removed in v2.1.0. Use `!topic <theme> <text>` followed by
> `!topic lock` instead.

## Requirements

The bot must have channel operator status (or the channel must have mode `-t`) to set topics.

## Theme list

amethyst, arctic, arrowhead, aurora, baroque, beacon, blaze, bloodrune, charcoal, crimson,
deepblue, dusk, ember, emerald, filigree, frost, fuchsia, grove, obsidian, orchid, prism, rune,
seafoam, silverscreen, spectral, sterling, sunset, tropical, whisper
