import { beforeEach, describe, expect, it } from 'vitest';
import { PanelView } from '@harmony/shared';
import { buttonId } from '../../src/targets.ts';
import {
  action,
  command,
  DASH,
  harness,
  PROXY,
  PTERO,
  PTERO_KEY,
  TOKEN,
  type Harness,
} from './helpers.ts';

const containerCalls = (h: Harness) =>
  h.docker.fetchImpl.calls.filter((c) => c.method === 'POST').map((c) => new URL(c.url).pathname);

describe('button presses', () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness();
    await h.bot.prepare();
    await h.bot.refresh();
  });

  it('restarts an allowlisted container, answers later, and writes to the ops log', async () => {
    const { responses } = await h.ask(action('rs-jellyfin'));
    expect(responses).toEqual([{ type: 'deferred' }]);
    expect(containerCalls(h)).toEqual(['/containers/jellyfin/restart']);
    expect(h.followups[0]?.content).toMatch(/^jellyfin: restarted \(now running\)/);
    expect(h.followups[0]?.ephemeral).toBe(true);
    expect(h.messages).toEqual([{ channel: '30', content: 'Ada restarted `jellyfin`' }]);
  });

  it('ignores an id that was never produced for a controllable target', async () => {
    for (const id of [
      'rs-vaultwarden',
      'rs-etc-passwd',
      'rs-',
      'rs-jellyfin-x',
      'xx-jellyfin',
      'rs-g-nothing',
    ]) {
      const { responses } = await h.ask(action(id));
      expect(responses).toEqual([{ type: 'deferred' }]);
    }
    expect(containerCalls(h)).toEqual([]);
    expect(h.followups.every((f) => /no longer valid|not valid any more/.test(f.content))).toBe(
      true,
    );
    expect(h.logs.some((l) => l.includes('forged'))).toBe(true);
  });

  it('never controls a status-only container, even when it is a real target', async () => {
    const target = h.bot.getRegistry().resolve('vaultwarden');
    expect(target.control).toBe(false);
    const ctx = (await h.ask(command('restart', { target: 'vaultwarden' }))).ctx;
    expect(ctx.isAnswered).toBe(true);
    expect(containerCalls(h)).toEqual([]);
    expect(h.followups.at(-1)?.content).toMatch(/information only/);
  });

  it('refuses a person without the permission, and says so in the ops log', async () => {
    const response = await h.ask(
      action('rs-jellyfin', { user: { id: '11', login: 'bob@example.com', displayName: 'Bob' } }),
    );
    expect(response.responses).toEqual([{ type: 'deferred' }]);
    expect(containerCalls(h)).toEqual([]);
    expect(h.followups[0]?.content).toContain('manage_guild');
    expect(h.messages[0]?.content).toContain('Bob was refused');
  });

  it('refuses people who are not members at all', async () => {
    await h.ask(action('rs-jellyfin', { user: { id: '404', login: 'x', displayName: 'X' } }));
    expect(containerCalls(h)).toEqual([]);
  });

  it('refuses a second press of the same target within the cooldown, then allows it later', async () => {
    await h.ask(action('rs-jellyfin'));
    await h.ask(action('rs-jellyfin'));
    expect(containerCalls(h)).toHaveLength(1);
    expect(h.followups[1]?.content).toMatch(/try again in 30 s/);
    // Another target is not blocked.
    await h.ask(action('st-n8n'));
    expect(containerCalls(h)).toHaveLength(2);
    h.clock.now += 31_000;
    await h.ask(action('rs-jellyfin'));
    expect(containerCalls(h)).toHaveLength(3);
  });

  it('reports a failure ephemerally with a reason and does not keep the target locked', async () => {
    h.docker.containers['jellyfin'] = { state: 'running' };
    delete h.docker.containers['jellyfin'];
    await h.ask(action('rs-jellyfin'));
    expect(h.followups[0]?.content).toMatch(
      /Could not restart jellyfin: Container jellyfin does not exist/,
    );
    expect(h.messages[0]?.content).toMatch(/tried to restart `jellyfin` but it failed/);
    h.docker.containers['jellyfin'] = { state: 'running' };
    await h.ask(action('rs-jellyfin'));
    expect(h.followups[1]?.content).toMatch(/restarted/);
  });

  it('says when a start or stop changed nothing', async () => {
    await h.ask(action('st-jellyfin'));
    expect(h.followups[0]?.content).toBe('jellyfin: was already running.');
    await h.ask(action('sp-n8n'));
    expect(h.followups[1]?.content).toBe('n8n: was already stopped.');
  });

  it('ignores interactions from another server', async () => {
    const { responses } = await h.ask(action('rs-jellyfin', { guildId: '999' }));
    expect(responses[0]).toMatchObject({ type: 'message', ephemeral: true });
    expect(containerCalls(h)).toEqual([]);
  });

  it('controls a game server through Pterodactyl with the same checks', async () => {
    await h.bot.refresh();
    const target = h.bot.getRegistry().resolve('core_keeper');
    await h.ask(action(buttonId('restart', target)));
    expect(h.powerCalls).toEqual([{ id: 'abcd1234', signal: 'restart' }]);
    expect(h.messages.at(-1)?.content).toBe('Ada asked to restart game server `Core Keeper`');
    // A person without the permission gets nothing sent.
    await h.ask(
      action(buttonId('stop', target), { user: { id: '11', login: 'b', displayName: 'Bob' } }),
    );
    expect(h.powerCalls).toHaveLength(1);
  });
});

describe('slash commands', () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness();
    await h.bot.prepare();
  });

  it('/restart resolves a game server by its slug and a container by its name', async () => {
    await h.ask(command('restart', { target: 'core_keeper' }));
    await h.ask(command('restart', { target: 'Core-Keeper' }));
    await h.ask(command('restart', { target: 'JELLYFIN' }));
    expect(h.powerCalls).toHaveLength(1); // the second game press is inside the cooldown
    expect(containerCalls(h)).toEqual(['/containers/jellyfin/restart']);
  });

  it('/restart with an unknown target lists nothing it should not know and does nothing', async () => {
    await h.ask(command('restart', { target: 'portainer' }));
    await h.ask(command('stop', { target: '../../etc' }));
    await h.ask(command('start', { target: '' }));
    expect(containerCalls(h)).toEqual([]);
    expect(h.followups.every((f) => /is not a target/.test(f.content))).toBe(true);
  });

  it('refuses control commands to people without the permission', async () => {
    await h.ask(
      command(
        'stop',
        { target: 'jellyfin' },
        { user: { id: '11', login: 'b', displayName: 'Bob' } },
      ),
    );
    expect(containerCalls(h)).toEqual([]);
    expect(h.followups[0]?.content).toContain('manage_guild');
  });

  it('/status and /games answer ephemerally and mention only configured things', async () => {
    const status = await h.ask(command('status'));
    expect(status.responses).toEqual([{ type: 'deferred' }]);
    const text = h.followups[0]?.content ?? '';
    expect(text).toContain('**Containers:** 2/3 fine');
    expect(text).toContain('- n8n: exited');
    expect(text).toContain('**Game servers:** 1/1 running');
    expect(text).toContain('`core_keeper`');
    expect(text).not.toContain('vaultwarden`'); // status-only containers are not offered as targets
    await h.ask(command('games'));
    expect(h.followups[1]?.content).toContain('**Core Keeper** (`core_keeper`): running, up 1h 0m');
    expect(h.followups.every((f) => f.ephemeral !== false)).toBe(true);
  });

  it('only the four read/control calls ever reach the Docker proxy', async () => {
    await h.bot.refresh();
    await h.ask(command('restart', { target: 'n8n' }));
    await h.ask(command('stop', { target: 'jellyfin' }));
    await h.ask(command('status'));
    const seen = new Set(
      h.docker.fetchImpl.calls.map(
        (c) =>
          `${c.method} ${new URL(c.url).pathname.replace(/^\/containers\/(?!json$)[^/]+/, '/containers/<name>')}`,
      ),
    );
    for (const call of seen) {
      expect(call).toMatch(
        /^(GET \/containers\/json|GET \/containers\/<name>\/json|POST \/containers\/<name>\/(start|stop|restart))$/,
      );
    }
  });
});

describe('what the bot publishes and says', () => {
  it('never contains the token, the API key or the internal addresses', async () => {
    const h = harness();
    await h.bot.prepare();
    await h.bot.refresh();
    await h.ask(action('rs-jellyfin'));
    await h.ask(command('status'));
    await h.ask(command('restart', { target: 'nope' }));
    const everything = JSON.stringify([[...h.panels.values()], h.messages, h.followups, h.logs]);
    for (const secret of [TOKEN, PTERO_KEY, PROXY, PTERO, 'secret-host']) {
      expect(everything).not.toContain(secret);
    }
  });

  it('keeps every published panel inside the API limits and with working button ids', async () => {
    const h = harness({
      control: Array.from(
        { length: 30 },
        (_, i) => `service-with-a-rather-long-name-number-${String(i)}`,
      ),
      status: Array.from({ length: 12 }, (_, i) => `db-${String(i)}`),
      containers: Object.fromEntries(
        [
          ...Array.from(
            { length: 30 },
            (_, i) => `service-with-a-rather-long-name-number-${String(i)}`,
          ),
          ...Array.from({ length: 12 }, (_, i) => `db-${String(i)}`),
        ].map((n, i) => [n, { state: i % 4 === 0 ? 'exited' : 'running' }]),
      ),
    });
    await h.bot.prepare();
    await h.bot.refresh();
    expect(h.panels.size).toBeGreaterThanOrEqual(2);
    for (const [key, view] of h.panels) {
      const parsed = PanelView.safeParse(view);
      expect(parsed.success, `${key}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
    // Every button on every panel resolves back to exactly one allowlisted action.
    const registry = h.bot.getRegistry();
    const buttons = [...h.panels.values()].flatMap((v) =>
      (
        v as {
          blocks: {
            type: string;
            buttons?: { id: string; requiredPermission?: string; confirm?: unknown }[];
          }[];
        }
      ).blocks.flatMap((b) => b.buttons ?? []),
    );
    expect(buttons.length).toBeGreaterThan(30);
    for (const b of buttons) {
      expect(registry.fromButton(b.id), b.id).toBeDefined();
      expect(b.requiredPermission).toBe('manage_guild');
      expect(b.confirm).toBeDefined();
    }
  });

  it('does not rewrite a panel that has not changed, and removes overflow panels that are no longer needed', async () => {
    const h = harness();
    await h.bot.prepare();
    await h.bot.refresh();
    const puts = () =>
      h.harmony.calls.filter((c) => c.method === 'PUT' && c.url.includes('/panels/')).length;
    const first = puts();
    expect(first).toBe(2); // containers + games
    await h.bot.refresh();
    expect(puts()).toBe(first);
    h.docker.containers['n8n'] = { state: 'running' };
    await h.bot.refresh();
    expect(puts()).toBe(first + 1);
    expect(DASH).toBe('20');
  });

  it('lists configured containers the daemon does not know as not found', async () => {
    const h = harness();
    await h.bot.prepare();
    for (const name of Object.keys(h.docker.containers)) delete h.docker.containers[name];
    h.docker.containers['x'] = { state: 'running' };
    await h.bot.refresh();
    // Names missing from the daemon are listed as "not found" rather than dropped silently.
    expect(JSON.stringify(h.panels.get('containers'))).toContain('not found');
  });
});
