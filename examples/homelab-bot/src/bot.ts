import type { PanelView } from '@harmony/shared';
import type { Config } from './config.ts';
import { isRunning, VERBS, type ContainerInfo, type DockerClient, type Verb } from './docker.ts';
import { BotError, clean, describeError, safeName } from './errors.ts';
import { Gateway, type HarmonyApi, type InteractionContext, type Log } from './harmony.ts';
import { fetchMonitors, type Monitor } from './kuma.ts';
import { containerPanels, formatDuration, gameItem, gamesPanel, monitorsPanel } from './panels.ts';
import type { PermissionChecker } from './permissions.ts';
import type { GameResources, PterodactylClient } from './pterodactyl.ts';
import { Cooldown, Registry, targetKey, type Target } from './targets.ts';

export interface Deps {
  config: Config;
  api: HarmonyApi;
  docker: DockerClient | undefined;
  pterodactyl: PterodactylClient | undefined;
  permissions: Pick<PermissionChecker, 'has'>;
  log: Log;
  now?: () => Date;
  cooldown?: Cooldown;
  monitors?: () => Promise<Monitor[]>;
}

const PAST: Record<Verb, string> = { start: 'started', stop: 'stopped', restart: 'restarted' };

export const COMMANDS = [
  ...VERBS.map((verb) => ({
    name: verb,
    description: `${verb[0]?.toUpperCase() ?? ''}${verb.slice(1)} a container or game server`,
    options: [
      {
        name: 'target',
        description: 'Container name or game server (see /status)',
        type: 'string',
        required: true,
      },
    ],
  })),
  {
    name: 'status',
    description: 'Summary of containers, game servers and monitors (only you see it)',
    options: [],
  },
  { name: 'games', description: 'Game servers and their state (only you see it)', options: [] },
];

interface Snapshot {
  containers: Map<string, ContainerInfo> | undefined;
  games:
    | { target: Extract<Target, { kind: 'game' }>; resources: GameResources | undefined }[]
    | undefined;
  monitors: Monitor[] | undefined;
}

export class HomelabBot {
  private registry: Registry;
  private readonly cooldown: Cooldown;
  private guildId = '';
  private dashboardId = '';
  private opsId: string | undefined;
  private readonly published = new Map<string, string>();
  private lastGames: { id: string; name: string; suspended: boolean }[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private refreshing: Promise<void> | undefined;
  private stopped = false;
  private gateway: Gateway | undefined;

  private readonly deps: Deps;

  constructor(deps: Deps) {
    this.deps = deps;
    this.cooldown = deps.cooldown ?? new Cooldown(deps.config.cooldownSeconds * 1000);
    this.registry = this.buildRegistry([]);
  }

  private buildRegistry(games: { id: string; name: string; suspended: boolean }[]): Registry {
    const { config } = this.deps;
    return new Registry(
      { control: config.docker.control, status: config.docker.status },
      games,
      config.pterodactyl.allow,
    );
  }

  /** What the bot may currently touch. */
  getRegistry(): Registry {
    return this.registry;
  }

  /* ---- start up ---- */

  /** Finds the server and channels and registers the commands; no connection is opened yet. */
  async prepare(): Promise<void> {
    const { api, config, log } = this.deps;
    this.guildId = config.harmony.guildId ?? (await this.onlyGuild());
    const channels = await api.channels(this.guildId);
    const find = (wanted: string, kind?: string): string => {
      const byId = channels.find((c) => c.id === wanted);
      const byName = channels.find(
        (c) =>
          c.name?.toLowerCase() === wanted.toLowerCase().replace(/^#/, '') &&
          (!kind || c.kind === kind),
      );
      const found = byId ?? byName;
      if (!found) throw new Error(`Channel "${wanted}" is not visible to the bot in that server`);
      return found.id;
    };
    this.dashboardId = find(config.harmony.dashboardChannel, 'dashboard');
    this.opsId = config.harmony.opsChannel ? find(config.harmony.opsChannel) : undefined;

    await api.putCommands(this.guildId, COMMANDS);
    log(`registered ${String(COMMANDS.length)} commands`);
    await this.loadGames();
  }

  async start(): Promise<void> {
    const { api, config } = this.deps;
    await this.prepare();
    this.gateway = new Gateway({
      url: api.baseUrl,
      token: config.harmony.token,
      seqFile: config.harmony.seqFile,
      log: this.deps.log,
      api,
      onInteraction: (context) => this.handle(context),
    });
    this.gateway.start();
    await this.refresh();
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.gateway?.stop();
  }

  private async onlyGuild(): Promise<string> {
    const guilds = await this.deps.api.guilds();
    if (guilds.length !== 1 || !guilds[0]) {
      throw new Error('The bot is in several servers (or none): set HARMONY_GUILD_ID');
    }
    return guilds[0].id;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.refresh().finally(() => this.schedule());
    }, this.deps.config.refreshSeconds * 1000);
  }

  /* ---- reading state ---- */

  private async loadGames(): Promise<void> {
    const { pterodactyl, log } = this.deps;
    if (!pterodactyl) return;
    try {
      this.lastGames = await pterodactyl.listServers();
      this.registry = this.buildRegistry(this.lastGames);
    } catch (error) {
      log(`could not list game servers: ${describeError(error)}`);
    }
  }

  async snapshot(): Promise<Snapshot> {
    const { docker, pterodactyl, config, log } = this.deps;
    const out: Snapshot = { containers: undefined, games: undefined, monitors: undefined };
    const settle = async <T>(what: string, run: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await run();
      } catch (error) {
        log(`${what}: ${describeError(error)}`);
        return undefined;
      }
    };
    await Promise.all([
      docker &&
        settle('docker', async () => {
          out.containers = new Map((await docker.list()).map((c) => [c.name, c]));
        }),
      pterodactyl &&
        settle('pterodactyl', async () => {
          await this.loadGames();
          const client = pterodactyl;
          out.games = await Promise.all(
            this.registry.games.map(async (target) => ({
              target,
              resources: await settle(`game ${target.slug}`, () => client.resources(target.id)),
            })),
          );
        }),
      config.kuma &&
        settle('kuma', async () => {
          out.monitors = await (
            this.deps.monitors ?? (() => fetchMonitors(config.kuma as NonNullable<Config['kuma']>))
          )();
        }),
    ]);
    return out;
  }

  /* ---- panels ---- */

  private async publish(key: string, view: PanelView): Promise<void> {
    const body = JSON.stringify(view);
    if (this.published.get(key) === body) return;
    await this.deps.api.putPanel(this.dashboardId, key, view);
    this.published.set(key, body);
  }

  panels(snap: Snapshot): Record<string, PanelView> {
    const { config, docker } = this.deps;
    const now = (this.deps.now ?? (() => new Date()))();
    const down = (title: string, why: string): PanelView => ({
      title,
      blocks: [
        { type: 'markdown', text: `**${title} unavailable.** ${why}` },
        { type: 'markdown', text: `Updated ${now.toISOString().slice(11, 16)} UTC` },
      ],
    });
    const out: Record<string, PanelView> = {};
    if (docker) {
      if (snap.containers) {
        Object.assign(
          out,
          containerPanels({
            control: this.registry.targets.filter((t) => t.kind === 'docker' && t.control),
            status: this.registry.targets.filter((t) => t.kind === 'docker' && !t.control),
            infos: snap.containers,
            permission: config.harmony.rolePermission,
            now,
          }),
        );
      } else out['containers'] = down('Containers', 'The Docker proxy did not answer.');
    }
    if (this.deps.pterodactyl) {
      out['games'] = snap.games
        ? gamesPanel({ servers: snap.games, permission: config.harmony.rolePermission, now })
        : down('Game servers', 'The game panel did not answer.');
    }
    if (config.kuma) {
      out['monitors'] = snap.monitors
        ? monitorsPanel(snap.monitors, now)
        : down('Monitors', 'Uptime Kuma did not answer.');
    }
    return out;
  }

  /** Reads everything and pushes the panels that changed. Calls overlap safely: one run at a time. */
  refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const { api, log } = this.deps;
    try {
      const panels = this.panels(await this.snapshot());
      for (const [key, view] of Object.entries(panels)) await this.publish(key, view);
      // Overflow panels (containers-2 ...) that are no longer needed.
      const mine = await api.listPanels(this.dashboardId);
      for (const panel of mine) {
        if (panel.botId === api.botId() && !(panel.key in panels)) {
          await api.deletePanel(this.dashboardId, panel.key);
          this.published.delete(panel.key);
        }
      }
    } catch (error) {
      log(
        `panel refresh failed: ${error instanceof Error ? clean(error.message, 160) : 'unknown'}`,
      );
    }
  }

  /* ---- interactions ---- */

  async handle(ctx: InteractionContext): Promise<void> {
    const { interaction } = ctx;
    const { log } = this.deps;
    if (interaction.guildId !== this.guildId) {
      return ctx.say('This bot only works in its own server.');
    }
    if (interaction.type === 'action') {
      ctx.defer();
      const found = this.registry.fromButton(interaction.action.id);
      if (!found) {
        log(
          `ignored unknown or forged button ${clean(interaction.action.id, 40)} from ${interaction.user.id}`,
        );
        return ctx.say('That button is not valid any more. The dashboard will refresh shortly.');
      }
      return this.control(ctx, found.verb, found.target);
    }

    const { name, options } = interaction.command;
    if ((VERBS as readonly string[]).includes(name)) {
      ctx.defer();
      try {
        const target = this.registry.resolve(String(options.target ?? ''));
        return await this.control(ctx, name as Verb, target);
      } catch (error) {
        return ctx.say(describeError(error));
      }
    }
    ctx.defer();
    if (!(await this.mayView(ctx))) return;
    if (name === 'status') return ctx.say(await this.statusText());
    if (name === 'games') return ctx.say(await this.gamesText());
    return ctx.say('Unknown command.');
  }

  private async mayView(ctx: InteractionContext): Promise<boolean> {
    const need = this.deps.config.harmony.statusPermission;
    if (!need || (await this.deps.permissions.has(ctx.interaction.user.id, need))) return true;
    await ctx.say(`You need the ${need} permission for that.`);
    return false;
  }

  /** The single path every start, stop and restart takes, whether it came from a button or a command. */
  async control(ctx: InteractionContext, verb: Verb, target: Target): Promise<void> {
    const { config, docker, pterodactyl } = this.deps;
    const { user } = ctx.interaction;
    const who = safeName(user.displayName);

    // Allowlist, re-checked here against the live registry (never against the button's text).
    const known = this.registry.targets.find((t) => targetKey(t) === targetKey(target));
    if (!known?.control) {
      return ctx.say(
        `${clean(target.name, 40)} is shown for information only; this bot cannot ${verb} it.`,
      );
    }
    const need = config.harmony.rolePermission;
    if (!(await this.deps.permissions.has(user.id, need))) {
      await this.audit(`${who} was refused: ${verb} ${known.name} (needs ${need})`);
      return ctx.say(`You need the ${need} permission to ${verb} things here.`);
    }

    const key = targetKey(known);
    try {
      this.cooldown.claim(key);
    } catch (error) {
      return ctx.say(describeError(error));
    }
    try {
      let outcome = '';
      if (known.kind === 'docker') {
        if (!docker) throw new BotError('failed', 'Docker is not configured.');
        const result = await docker.act(verb, known.name);
        const now = await docker.inspect(known.name).catch(() => undefined);
        const state = now ? ` (now ${now.state}${now.health ? `, ${now.health}` : ''})` : '';
        outcome =
          result === 'unchanged'
            ? `was already ${verb === 'start' ? 'running' : 'stopped'}`
            : `${PAST[verb]}${state}`;
        await this.audit(
          result === 'unchanged'
            ? `${who} asked to ${verb} \`${known.name}\`, which ${outcome}`
            : `${who} ${PAST[verb]} \`${known.name}\``,
        );
      } else {
        if (!pterodactyl) throw new BotError('failed', 'The game panel is not configured.');
        await pterodactyl.power(known.id, verb);
        outcome = `asked to ${verb}`;
        await this.audit(`${who} asked to ${verb} game server \`${known.name}\``);
      }
      await ctx.say(`${known.name}: ${outcome}.`);
      setTimeout(() => void this.refresh(), 3000).unref();
    } catch (error) {
      this.cooldown.release(key);
      await this.audit(
        `${who} tried to ${verb} \`${known.name}\` but it failed: ${describeError(error)}`,
      );
      await ctx.say(`Could not ${verb} ${known.name}: ${describeError(error)}`);
    }
  }

  /** One line in the ops channel; never throws and never contains a secret. */
  async audit(line: string): Promise<void> {
    if (!this.opsId) return;
    try {
      await this.deps.api.sendMessage(this.opsId, line.slice(0, 500));
    } catch (error) {
      this.deps.log(
        `ops log failed: ${error instanceof Error ? clean(error.message, 120) : 'unknown'}`,
      );
    }
  }

  /* ---- text answers ---- */

  async statusText(): Promise<string> {
    const snap = await this.snapshot();
    const lines: string[] = [];
    if (this.deps.docker) {
      if (!snap.containers) lines.push('**Containers:** the Docker proxy did not answer.');
      else {
        const all = [...snap.containers.values()];
        const bad = all.filter(
          (c) => !isRunning(c) || c.health === 'unhealthy' || c.state === 'restarting',
        );
        lines.push(`**Containers:** ${String(all.length - bad.length)}/${String(all.length)} fine`);
        for (const c of bad.slice(0, 12))
          lines.push(`- ${c.name}: ${c.state}${c.health ? `, ${c.health}` : ''}`);
      }
    }
    if (this.deps.pterodactyl) {
      if (!snap.games) lines.push('**Game servers:** the game panel did not answer.');
      else {
        lines.push(
          `**Game servers:** ${String(snap.games.filter((g) => g.resources?.state === 'running').length)}/${String(snap.games.length)} running`,
        );
        for (const g of snap.games)
          lines.push(`- ${gameItem(g.target.name, g.resources).detail ?? ''} (${g.target.name})`);
      }
    }
    if (this.deps.config.kuma) {
      if (!snap.monitors) lines.push('**Monitors:** Uptime Kuma did not answer.');
      else {
        const down = snap.monitors.filter((m) => m.status === 0);
        lines.push(
          `**Monitors:** ${String(snap.monitors.length - down.length)}/${String(snap.monitors.length)} up`,
        );
        for (const m of down.slice(0, 10)) lines.push(`- down: ${m.name}`);
      }
    }
    if (lines.length === 0) lines.push('Nothing is configured.');
    lines.push(
      `\nTargets for /start, /stop and /restart: ${
        this.registry
          .names()
          .map((n) => `\`${n}\``)
          .join(', ') || 'none'
      }`,
    );
    return lines.join('\n');
  }

  async gamesText(): Promise<string> {
    const snap = await this.snapshot();
    if (!this.deps.pterodactyl) return 'Game servers are not configured.';
    if (!snap.games) return 'The game panel did not answer.';
    if (snap.games.length === 0) return 'No game servers are visible to this bot.';
    return snap.games
      .map((g) => {
        const r = g.resources;
        const up = r && r.uptimeMs > 0 ? `, up ${formatDuration(r.uptimeMs)}` : '';
        return `- **${g.target.name}** (\`${g.target.slug}\`): ${r?.state ?? 'unknown'}${up}`;
      })
      .join('\n');
  }
}
