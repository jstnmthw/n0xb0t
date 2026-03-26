// chanmod — Channel operator tools: auto-op/halfop/voice, mode enforcement, timed bans,
//           kick/ban commands, and Eggdrop-style channel protection.
import type { PluginAPI } from '../../src/types';
import { setupAutoOp } from './auto-op';
import { setupBans } from './bans';
import { setupCommands } from './commands';
import { setupModeEnforce } from './mode-enforce';
import { setupProtection } from './protection';
import { createState, readConfig } from './state';

export const name = 'chanmod';
export const version = '2.1.0';
export const description =
  'Channel operator tools: auto-op/halfop/voice, mode enforcement, timed bans, kick/ban, cycle';

let teardowns: Array<() => void> = [];

export function init(api: PluginAPI): void {
  const config = readConfig(api);
  const state = createState();

  teardowns = [
    setupBans(api, config, state),
    setupAutoOp(api, config, state),
    setupModeEnforce(api, config, state),
    setupProtection(api, config, state),
    setupCommands(api, config, state),
  ];

  api.log('Loaded');
}

export function teardown(): void {
  for (const td of teardowns) td();
  teardowns = [];
}
