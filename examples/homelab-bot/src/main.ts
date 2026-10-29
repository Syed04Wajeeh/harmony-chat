import { HomelabBot } from './bot.ts';
import { ConfigError, loadConfig, redactor, secretsOf } from './config.ts';
import { DockerClient } from './docker.ts';
import { HarmonyApi } from './harmony.ts';
import { PermissionChecker } from './permissions.ts';
import { PterodactylClient } from './pterodactyl.ts';

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(
    error instanceof ConfigError ? error.message : 'The configuration could not be loaded.',
  );
  process.exit(1);
}

// Every line goes through the redactor, so a key or address that slips into an error is masked.
const redact = redactor(secretsOf(config));
const log = (message: string) => console.log(`${new Date().toISOString()} ${redact(message)}`);

const api = new HarmonyApi(config.harmony.url, config.harmony.token);
const docker = config.docker.proxyUrl
  ? new DockerClient(config.docker.proxyUrl, config.docker)
  : undefined;
const pterodactyl =
  config.pterodactyl.url && config.pterodactyl.apiKey
    ? new PterodactylClient(config.pterodactyl.url, config.pterodactyl.apiKey)
    : undefined;

const guildReady = async (): Promise<string> => {
  if (config.harmony.guildId) return config.harmony.guildId;
  const guilds = await api.guilds();
  if (guilds.length !== 1 || !guilds[0])
    throw new Error('Set HARMONY_GUILD_ID: the bot is in zero or several servers');
  return guilds[0].id;
};

let bot: HomelabBot | undefined;
for (let delay = 2000; !bot; delay = Math.min(delay * 2, 60_000)) {
  try {
    const guildId = await guildReady();
    const candidate = new HomelabBot({
      config,
      api,
      docker,
      pterodactyl,
      permissions: new PermissionChecker(api, guildId),
      log,
    });
    await candidate.start();
    bot = candidate;
  } catch (error) {
    log(
      `start failed: ${error instanceof Error ? error.message : 'unknown error'}; retrying in ${String(delay / 1000)} s`,
    );
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
log('homelab bot is running');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    bot?.stop();
    process.exit(0);
  });
}
