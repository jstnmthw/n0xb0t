# greeter

Greets users when they join a channel with a customizable message.

## Usage

Automatic — fires on every JOIN event. No commands.

## Config

In `config/plugins.json`:

```json
{
  "greeter": {
    "enabled": true,
    "config": {
      "message": "Welcome to {channel}, {nick}!",
      "botNick": "n0xb0t"
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `message` | `Welcome to {channel}, {nick}!` | Greeting template. `{channel}` and `{nick}` are replaced. |
| `botNick` | `""` | The bot's nick — won't greet itself. |
