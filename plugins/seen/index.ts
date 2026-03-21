// seen — Last-seen tracking plugin
// Tracks when users were last active in a channel and responds to !seen queries.

import type { PluginAPI, HandlerContext } from '../../src/types.js';

export const name = 'seen';
export const version = '1.0.0';
export const description = 'Tracks and reports when users were last seen';

export function init(api: PluginAPI): void {
  // Track every channel message (pubm is stackable, won't interfere with others)
  api.bind('pubm', '-', '*', (ctx: HandlerContext) => {
    if (!ctx.channel) return;

    const record = JSON.stringify({
      nick: ctx.nick,
      channel: ctx.channel,
      text: ctx.text,
      time: Date.now(),
    });

    api.db.set(`seen:${ctx.nick.toLowerCase()}`, record);
  });

  // Respond to !seen queries
  api.bind('pub', '-', '!seen', (ctx: HandlerContext) => {
    const targetNick = ctx.args.trim().split(/\s+/)[0];
    if (!targetNick) {
      ctx.reply('Usage: !seen <nick>');
      return;
    }

    const raw = api.db.get(`seen:${targetNick.toLowerCase()}`);
    if (!raw) {
      ctx.reply(`I haven't seen ${targetNick}.`);
      return;
    }

    try {
      const record = JSON.parse(raw) as { nick: string; channel: string; text: string; time: number };
      const ago = formatRelativeTime(Date.now() - record.time);
      ctx.reply(`${record.nick} was last seen ${ago} in ${record.channel} saying: ${record.text}`);
    } catch {
      ctx.reply(`I haven't seen ${targetNick}.`);
    }
  });

  api.log('Loaded');
}

export function teardown(): void {
  // No cleanup needed
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}
