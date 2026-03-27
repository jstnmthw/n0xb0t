// topic — IRC topic creator with color-coded themes + topic protection
// Sets channel topics using pre-built color theme borders.
// Also provides protect_topic/topic_text settings and !settopic command.
import type { HandlerContext, PluginAPI } from '../../src/types';
import { themeNames, themes } from './themes';

export const name = 'topic';
export const version = '2.0.0';
export const description =
  'Set channel topics with color-coded theme borders; optional topic protection';

const PREVIEW_COOLDOWN_MS = 60_000;
let previewCooldown: Map<string, number>;

export function init(api: PluginAPI): void {
  previewCooldown = new Map();

  // Register per-channel settings for topic protection
  api.channelSettings.register([
    {
      key: 'protect_topic',
      type: 'flag',
      default: false,
      description: 'Restore topic if changed by a user without +o flag',
    },
    {
      key: 'topic_text',
      type: 'string',
      default: '',
      description: 'The enforced topic text (set by !settopic or an authorized topic change)',
    },
  ]);

  api.registerHelp([
    {
      command: '!topic',
      flags: 'o',
      usage: '!topic <theme> <text>',
      description: 'Set the channel topic with a color-coded theme',
      detail: ['Use !topic preview <theme> <text> to preview without setting'],
      category: 'topic',
    },
    {
      command: '!topics',
      flags: '-',
      usage: '!topics [preview [text]]',
      description: 'List available topic themes; preview renders all themes',
      category: 'topic',
    },
    {
      command: '!settopic',
      flags: 'o',
      usage: '!settopic <text>',
      description: 'Set and lock the channel topic',
      category: 'topic',
    },
  ]);

  // !topic <theme> <text>  — set the channel topic (requires o flag)
  // !topic preview <theme> <text>  — preview the themed text in channel
  api.bind('pub', '+o', '!topic', (ctx: HandlerContext) => {
    if (!ctx.channel) return;

    const args = ctx.args.trim();
    if (!args) {
      ctx.reply('Usage: !topic <theme> <text> | !topic preview <theme> <text>');
      return;
    }

    const parts = args.split(/\s+/);
    const firstArg = parts[0].toLowerCase();

    // Handle preview subcommand
    if (firstArg === 'preview') {
      if (parts.length < 3) {
        ctx.reply('Usage: !topic preview <theme> <text>');
        return;
      }
      const themeName = parts[1].toLowerCase();
      const text = parts.slice(2).join(' ');

      const template = themes[themeName];
      if (!template) {
        ctx.reply(`Unknown theme "${parts[1]}". Use !topics to see available themes.`);
        return;
      }

      const formatted = template.replace('$text', () => text);
      api.say(ctx.channel, formatted);
      return;
    }

    // Normal topic set: !topic <theme> <text>
    const themeName = firstArg;
    if (parts.length < 2) {
      ctx.reply('Usage: !topic <theme> <text>');
      return;
    }
    const text = parts.slice(1).join(' ');

    const template = themes[themeName];
    if (!template) {
      ctx.reply(`Unknown theme "${parts[0]}". Use !topics to see available themes.`);
      return;
    }

    const formatted = template.replace('$text', () => text);

    // Warn if the formatted topic is very long (typical IRC limit ~390 chars)
    if (formatted.length > 390) {
      ctx.reply(
        `Warning: topic is ${formatted.length} chars (typical limit is ~390). It may be truncated by the server.`,
      );
    }

    api.topic(ctx.channel, formatted);
    ctx.reply(`Topic set using theme "${themeName}".`);
  });

  // !topics — list available themes (anyone can use)
  // !topics preview [text] — PM all themes rendered with sample text
  api.bind('pub', '-', '!topics', (ctx: HandlerContext) => {
    const args = ctx.args.trim();
    const parts = args.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase();

    if (subcommand === 'preview') {
      const cooldownKey = ctx.nick.toLowerCase();
      const cooldownExpires = previewCooldown.get(cooldownKey) ?? 0;
      if (Date.now() < cooldownExpires) {
        const secsLeft = Math.ceil((cooldownExpires - Date.now()) / 1000);
        ctx.reply(`Preview cooldown active — try again in ${secsLeft}s.`);
        return;
      }
      previewCooldown.set(cooldownKey, Date.now() + PREVIEW_COOLDOWN_MS);

      const sampleText = parts.length > 1 ? parts.slice(1).join(' ') : 'Sample Topic Text';
      const nick = ctx.nick;
      ctx.reply(`Sending ${themeNames.length} theme previews to your PM...`);
      api.say(nick, `Theme previews using: "${sampleText}"`);
      for (const themeName of themeNames) {
        const formatted = themes[themeName].replace('$text', sampleText);
        api.say(nick, `${themeName}: ${formatted}`);
      }
      api.say(nick, `${themeNames.length} themes total. Use !topic <theme> <text> to set.`);
      return;
    }

    ctx.reply(
      `Available themes: ${themeNames.join(', ')} — Use "!topics preview [text]" to preview all via PM.`,
    );
  });

  // !settopic <text> — set and lock the channel topic (requires o flag)
  api.bind('pub', '+o', '!settopic', (ctx: HandlerContext) => {
    if (!ctx.channel) return;

    const text = ctx.args.trim();
    if (!text) {
      ctx.reply('Usage: !settopic <text>');
      return;
    }

    api.channelSettings.set(ctx.channel, 'topic_text', text);
    api.topic(ctx.channel, text);
    ctx.reply(`Topic set and locked.`);
  });

  // topic bind — enforce topic protection on unauthorized changes
  api.bind('topic', '-', '*', (ctx: HandlerContext) => {
    if (!ctx.channel) return;

    const protect = api.channelSettings.get(ctx.channel, 'protect_topic') as boolean;
    if (!protect) return;

    const enforced = api.channelSettings.get(ctx.channel, 'topic_text') as string;
    if (!enforced) return; // no authoritative topic set yet

    const isAuthorized = api.permissions.checkFlags('o', ctx);
    if (isAuthorized) {
      // Authorized change — update the stored topic
      api.channelSettings.set(ctx.channel, 'topic_text', ctx.text);
    } else {
      // Restore the enforced topic
      api.topic(ctx.channel, enforced);
    }
  });
}

export function teardown(): void {
  previewCooldown.clear();
}
