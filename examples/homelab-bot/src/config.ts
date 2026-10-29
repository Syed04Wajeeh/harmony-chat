import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

/** Everything the bot needs, validated once at start. Secrets only ever come from the environment. */
export interface Config {
  harmony: {
    url: string;
    token: string;
    guildId: string | undefined;
    dashboardChannel: string;
    opsChannel: string | undefined;
    /** Permission key a person needs to press control buttons and run control commands. */
    rolePermission: string;
    /** Optional key required for /status and /games (default: anyone who may run commands). */
    statusPermission: string | undefined;
    /** Where the last handled event number is kept; leave unset to start from zero. */
    seqFile: string | undefined;
  };
  docker: {
    proxyUrl: string | undefined;
    control: string[];
    status: string[];
  };
  pterodactyl: {
    url: string | undefined;
    apiKey: string | undefined;
    /** Slugs of servers that may be shown and controlled; empty means every server the key sees. */
    allow: string[];
  };
  kuma: { baseUrl: string; slug: string } | undefined;
  refreshSeconds: number;
  cooldownSeconds: number;
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;
type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const section = (raw: Raw, name: string): Raw => {
  const value = raw[name];
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new ConfigError(`"${name}" in the config file must be a mapping`);
  return value;
};

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

const list = (value: unknown, name: string): string[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new ConfigError(`"${name}" must be a list of strings`);
  }
  return (value as string[]).map((v) => v.trim()).filter((v) => v !== '');
};

const seconds = (value: unknown, fallback: number, name: string): number => {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1 || n > 86_400) throw new ConfigError(`${name} must be 1..86400`);
  return n;
};

const httpUrl = (value: string, name: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} is not a URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`${name} must be http or https`);
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
};

/**
 * `KUMA_STATUS_URL` is the public status page, such as `http://kuma:3001/status/home`. A bare
 * origin works too when the slug is given separately.
 */
export function parseKuma(value: string, slug: string | undefined): Config['kuma'] {
  const url = new URL(httpUrl(value, 'KUMA_STATUS_URL'));
  const match = /^(.*)\/status\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (match) return { baseUrl: url.origin + (match[1] ?? ''), slug: match[2] ?? '' };
  if (!slug) throw new ConfigError('KUMA_STATUS_URL needs /status/<slug> or KUMA_STATUS_SLUG');
  if (!/^[A-Za-z0-9_-]+$/.test(slug)) throw new ConfigError('Kuma slug has odd characters');
  return { baseUrl: url.origin + url.pathname.replace(/\/+$/, ''), slug };
}

export function readConfigFile(path: string | undefined): Raw {
  if (!path) return {};
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new ConfigError(`Config file ${path} does not exist`);
    throw new ConfigError(`Config file ${path} cannot be read (${String(code)})`);
  }
  // YAML is a superset of JSON, so one parser covers both.
  const parsed: unknown = parseYaml(source);
  if (parsed === null || parsed === undefined) return {};
  if (!isRecord(parsed)) throw new ConfigError('The config file must be a mapping');
  return parsed;
}

export function buildConfig(raw: Raw, env: Env): Config {
  const harmony = section(raw, 'harmony');
  const docker = section(raw, 'docker');
  const ptero = section(raw, 'pterodactyl');
  const kuma = section(raw, 'kuma');

  const token = text(env.HARMONY_BOT_TOKEN);
  if (!token) throw new ConfigError('Set HARMONY_BOT_TOKEN');
  if (!/^hb_[0-9]+_[A-Za-z0-9_-]+$/.test(token))
    throw new ConfigError('HARMONY_BOT_TOKEN is malformed');

  const dashboardChannel = text(env.DASHBOARD_CHANNEL) ?? text(harmony.dashboardChannel);
  if (!dashboardChannel) throw new ConfigError('Set DASHBOARD_CHANNEL (a channel id or name)');

  const proxy = text(env.DOCKER_PROXY_URL) ?? text(docker.proxyUrl);
  const control = list(docker.control, 'docker.control');
  const status = list(docker.status, 'docker.status');
  const overlap = control.filter((name) => status.includes(name));
  if (overlap.length > 0) {
    throw new ConfigError(`Listed in both control and status: ${overlap.join(', ')}`);
  }
  if (!proxy && (control.length > 0 || status.length > 0)) {
    throw new ConfigError('docker.control / docker.status need DOCKER_PROXY_URL');
  }

  const pteroUrl = text(env.PTERODACTYL_URL) ?? text(ptero.url);
  const pteroKey = text(env.PTERODACTYL_CLIENT_API_KEY);
  if (pteroUrl && !pteroKey)
    throw new ConfigError('PTERODACTYL_URL needs PTERODACTYL_CLIENT_API_KEY');

  const kumaUrl = text(env.KUMA_STATUS_URL) ?? text(kuma.statusUrl);
  const guildId = text(env.HARMONY_GUILD_ID) ?? text(harmony.guildId);

  return {
    harmony: {
      url: httpUrl(text(env.HARMONY_URL) ?? text(harmony.url) ?? '', 'HARMONY_URL'),
      token,
      guildId: guildId && /^\d+$/.test(guildId) ? guildId : undefined,
      dashboardChannel,
      opsChannel: text(env.OPS_CHANNEL) ?? text(harmony.opsChannel),
      rolePermission: text(env.ROLE_PERMISSION) ?? text(harmony.rolePermission) ?? 'manage_guild',
      statusPermission: text(env.STATUS_PERMISSION) ?? text(harmony.statusPermission),
      seqFile: text(env.HARMONY_SEQ_FILE) ?? text(harmony.seqFile),
    },
    docker: { proxyUrl: proxy ? httpUrl(proxy, 'DOCKER_PROXY_URL') : undefined, control, status },
    pterodactyl: {
      url: pteroUrl ? httpUrl(pteroUrl, 'PTERODACTYL_URL') : undefined,
      apiKey: pteroKey,
      allow: list(ptero.allow, 'pterodactyl.allow'),
    },
    kuma: kumaUrl ? parseKuma(kumaUrl, text(env.KUMA_STATUS_SLUG) ?? text(kuma.slug)) : undefined,
    refreshSeconds: seconds(env.REFRESH_SECONDS ?? raw.refreshSeconds, 30, 'refreshSeconds'),
    cooldownSeconds: seconds(env.COOLDOWN_SECONDS ?? raw.cooldownSeconds, 30, 'cooldownSeconds'),
  };
}

export function loadConfig(env: Env = process.env): Config {
  return buildConfig(readConfigFile(text(env.CONFIG_FILE) ?? './config.yml'), env);
}

/** The strings that must never appear in a log line or a message. */
export const secretsOf = (config: Config): string[] =>
  [config.harmony.token, config.pterodactyl.apiKey, config.docker.proxyUrl, config.pterodactyl.url]
    .filter((value): value is string => typeof value === 'string' && value.length >= 8)
    .flatMap((value) => {
      // The host part of a URL is as telling as the URL itself.
      try {
        const url = new URL(value);
        return [value, url.host];
      } catch {
        return [value];
      }
    });

export function redactor(secrets: readonly string[]): (input: string) => string {
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  return (input) => ordered.reduce((out, secret) => out.split(secret).join('[redacted]'), input);
}
