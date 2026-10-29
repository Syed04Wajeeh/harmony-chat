export interface Config {
  url: string;
  token: string;
  defaultChannel: string | undefined;
  /** Sends (messages, questions) allowed per rolling minute from this process. */
  maxSendsPerMinute: number;
  allowMassMentions: boolean;
  /** Channel for runs and approvals when a call names none (HARMONY_AGENT_CHANNEL). */
  agentChannel: string | undefined;
  /** Permission a person needs to decide an approval or cancel a run. */
  approvalPermission: string;
  /** At most one panel write per run in this many milliseconds. */
  panelMinIntervalMs: number;
}

export class ConfigError extends Error {}

/** Reads the environment. Error messages never contain the token. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const token = env.HARMONY_BOT_TOKEN?.trim();
  if (!token) {
    throw new ConfigError(
      'Set HARMONY_BOT_TOKEN to a Harmony bot token (Settings > Bots > create a bot; shown once).',
    );
  }
  if (!/^hb_\d+_\S+$/.test(token)) {
    throw new ConfigError(
      'HARMONY_BOT_TOKEN does not look like a bot token (hb_<botId>_<secret>).',
    );
  }
  const url = (env.HARMONY_URL?.trim() || 'http://127.0.0.1:8471').replace(/\/+$/, '');
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
  } catch {
    throw new ConfigError('HARMONY_URL must be an http(s) URL such as http://127.0.0.1:8471.');
  }
  const rawLimit = env.HARMONY_MAX_SENDS_PER_MINUTE?.trim();
  const maxSendsPerMinute = rawLimit ? Number(rawLimit) : 20;
  if (!Number.isInteger(maxSendsPerMinute) || maxSendsPerMinute < 1) {
    throw new ConfigError('HARMONY_MAX_SENDS_PER_MINUTE must be a positive integer.');
  }
  const approvalPermission = env.HARMONY_APPROVAL_PERMISSION?.trim() || 'manage_messages';
  if (!/^[a-z][a-z0-9_.]{0,63}$/.test(approvalPermission)) {
    throw new ConfigError(
      'HARMONY_APPROVAL_PERMISSION must be a permission key such as manage_messages.',
    );
  }
  const rawInterval = env.HARMONY_PANEL_MIN_INTERVAL_MS?.trim();
  const panelMinIntervalMs = rawInterval ? Number(rawInterval) : 1000;
  if (!Number.isInteger(panelMinIntervalMs) || panelMinIntervalMs < 0) {
    throw new ConfigError('HARMONY_PANEL_MIN_INTERVAL_MS must be a non-negative integer.');
  }
  return {
    url,
    token,
    defaultChannel: env.HARMONY_DEFAULT_CHANNEL?.trim() || undefined,
    maxSendsPerMinute,
    allowMassMentions: env.HARMONY_ALLOW_MASS_MENTIONS === '1',
    agentChannel: env.HARMONY_AGENT_CHANNEL?.trim() || undefined,
    approvalPermission,
    panelMinIntervalMs,
  };
}
