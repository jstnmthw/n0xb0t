// chanmod — shared state types and config interface
import type { PluginAPI } from '../../src/types';

// ---------------------------------------------------------------------------
// Shared mutable state (created fresh on each init, passed to all modules)
// ---------------------------------------------------------------------------

export interface SharedState {
  intentionalModeChanges: Map<string, number>;
  enforcementCooldown: Map<string, { count: number; expiresAt: number }>;
  cycleTimers: ReturnType<typeof setTimeout>[];
  cycleScheduled: Set<string>;
  enforcementTimers: ReturnType<typeof setTimeout>[];
  startupTimer: ReturnType<typeof setTimeout> | null;
}

export const INTENTIONAL_TTL_MS = 5000;
export const COOLDOWN_WINDOW_MS = 10_000;
export const MAX_ENFORCEMENTS = 3;

export function createState(): SharedState {
  return {
    intentionalModeChanges: new Map(),
    enforcementCooldown: new Map(),
    cycleTimers: [],
    cycleScheduled: new Set(),
    enforcementTimers: [],
    startupTimer: null,
  };
}

// ---------------------------------------------------------------------------
// Plugin config (read once in init, passed to all modules)
// ---------------------------------------------------------------------------

export interface ChanmodConfig {
  // Auto-op
  auto_op: boolean;
  op_flags: string[];
  halfop_flags: string[];
  voice_flags: string[];
  notify_on_fail: boolean;
  // Mode enforcement
  enforce_modes: boolean;
  enforce_delay_ms: number;
  nodesynch_nicks: string[];
  enforce_channel_modes: string;
  // Cycle
  cycle_on_deop: boolean;
  cycle_delay_ms: number;
  // Bans / kick
  default_kick_reason: string;
  default_ban_duration: number;
  default_ban_type: number;
  // Protection
  rejoin_on_kick: boolean;
  rejoin_delay_ms: number;
  max_rejoin_attempts: number;
  rejoin_attempt_window_ms: number;
  revenge_on_kick: boolean;
  revenge_action: 'deop' | 'kick' | 'kickban';
  revenge_delay_ms: number;
  revenge_kick_reason: string;
  revenge_exempt_flags: string;
  bitch: boolean;
  punish_deop: boolean;
  punish_action: 'kick' | 'kickban';
  punish_kick_reason: string;
  enforcebans: boolean;
  topic_protect: boolean;
  nick_recovery: boolean;
  nick_recovery_ghost: boolean;
  stopnethack_mode: number;
  split_timeout_ms: number;
}

export function readConfig(api: PluginAPI): ChanmodConfig {
  const c = api.config;
  return {
    auto_op: (c.auto_op as boolean | undefined) ?? true,
    op_flags: (c.op_flags as string[] | undefined) ?? ['n', 'm', 'o'],
    halfop_flags: (c.halfop_flags as string[] | undefined) ?? [],
    voice_flags: (c.voice_flags as string[] | undefined) ?? ['v'],
    notify_on_fail: (c.notify_on_fail as boolean | undefined) ?? false,
    enforce_modes: (c.enforce_modes as boolean | undefined) ?? false,
    enforce_delay_ms: (c.enforce_delay_ms as number | undefined) ?? 500,
    nodesynch_nicks: (c.nodesynch_nicks as string[] | undefined) ?? ['ChanServ'],
    enforce_channel_modes: (c.enforce_channel_modes as string | undefined) ?? '',
    cycle_on_deop: (c.cycle_on_deop as boolean | undefined) ?? false,
    cycle_delay_ms: (c.cycle_delay_ms as number | undefined) ?? 5000,
    default_kick_reason: (c.default_kick_reason as string | undefined) ?? 'Requested',
    default_ban_duration: (c.default_ban_duration as number | undefined) ?? 120,
    default_ban_type: (c.default_ban_type as number | undefined) ?? 3,
    rejoin_on_kick: (c.rejoin_on_kick as boolean | undefined) ?? true,
    rejoin_delay_ms: (c.rejoin_delay_ms as number | undefined) ?? 5000,
    max_rejoin_attempts: (c.max_rejoin_attempts as number | undefined) ?? 3,
    rejoin_attempt_window_ms: (c.rejoin_attempt_window_ms as number | undefined) ?? 300_000,
    revenge_on_kick: (c.revenge_on_kick as boolean | undefined) ?? false,
    revenge_action: (c.revenge_action as 'deop' | 'kick' | 'kickban' | undefined) ?? 'deop',
    revenge_delay_ms: (c.revenge_delay_ms as number | undefined) ?? 3000,
    revenge_kick_reason: (c.revenge_kick_reason as string | undefined) ?? "Don't kick me.",
    revenge_exempt_flags: (c.revenge_exempt_flags as string | undefined) ?? 'nm',
    bitch: (c.bitch as boolean | undefined) ?? false,
    punish_deop: (c.punish_deop as boolean | undefined) ?? false,
    punish_action: (c.punish_action as 'kick' | 'kickban' | undefined) ?? 'kick',
    punish_kick_reason: (c.punish_kick_reason as string | undefined) ?? "Don't deop my friends.",
    enforcebans: (c.enforcebans as boolean | undefined) ?? false,
    topic_protect: (c.topic_protect as boolean | undefined) ?? false,
    nick_recovery: (c.nick_recovery as boolean | undefined) ?? true,
    nick_recovery_ghost: (c.nick_recovery_ghost as boolean | undefined) ?? false,
    stopnethack_mode: (c.stopnethack_mode as number | undefined) ?? 0,
    split_timeout_ms: (c.split_timeout_ms as number | undefined) ?? 300_000,
  };
}
