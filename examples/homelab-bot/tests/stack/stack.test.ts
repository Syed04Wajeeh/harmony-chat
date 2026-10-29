import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { containerState, startedAt } from '../integration/docker-helpers.ts';
import { startStack, until, type Person, type Stack } from './harness.ts';

/**
 * The bot against a real Harmony dev server in gateway mode, real containers behind the real socket
 * proxy and a mock game panel. Needs a running dev stack: see "Tests" in the example's README.
 */
describe('homelab bot on a Harmony dev stack', () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack();
  }, 120_000);
  afterAll(() => s?.cleanup());

  interface Block {
    type: string;
    buttons?: { id: string; label: string; requiredPermission?: string; confirm?: unknown }[];
  }
  const panels = async () =>
    (
      await s.admin.call<{ panels: { id: string; key: string; view: { blocks: Block[] } }[] }>(
        'GET',
        `/api/channels/${s.dashboardId}/panels`,
      )
    ).panels;
  const buttonLabelled = async (key: string, label: string) => {
    const panel = (await panels()).find((p) => p.key === key);
    const button = panel?.view.blocks
      .flatMap((b) => b.buttons ?? [])
      .find((b) => b.label === label);
    if (!panel || !button) throw new Error(`no "${label}" button on ${key}`);
    return { panelId: panel.id, button };
  };
  const press = (who: Person, panelId: string, actionId: string) =>
    who.call('POST', '/api/interactions/actions', { source: { panelId }, actionId });
  const run = (who: Person, name: string, options: Record<string, string> = {}) =>
    who.call('POST', `/api/channels/${s.opsId}/commands`, { name, options });
  const opsLines = async () =>
    (
      await s.admin.call<{ messages: { content: string }[] }>(
        'GET',
        `/api/channels/${s.opsId}/messages`,
      )
    ).messages.map((m) => m.content);

  it('registers its slash commands in the server', async () => {
    const { commands } = await s.admin.call<{ commands: { name: string; botId: string }[] }>(
      'GET',
      `/api/guilds/${s.guildId}/commands`,
    );
    const mine = commands
      .filter((c) => c.botId === s.botId)
      .map((c) => c.name)
      .sort();
    expect(mine).toEqual(['games', 'restart', 'start', 'status', 'stop']);
  });

  it('publishes the containers and game panels with confirm dialogs and the required permission', async () => {
    const all = await panels();
    expect(all.map((p) => p.key).sort()).toEqual(['containers', 'games']);
    const { button } = await buttonLabelled('containers', `Restart ${s.throwaway.control}`);
    expect(button.requiredPermission).toBe('manage_guild');
    expect(button.confirm).toBeDefined();
    const text = JSON.stringify(all);
    expect(text).toContain(s.throwaway.statusOnly);
    expect(text).not.toContain(s.throwaway.other); // not allowlisted: invisible
    expect(text).not.toContain(`Restart ${s.throwaway.statusOnly}`); // status only: no buttons
  });

  it('a person with the permission restarts a container; it is logged, and a double press is held back', async () => {
    const { panelId, button } = await buttonLabelled(
      'containers',
      `Restart ${s.throwaway.control}`,
    );
    const before = startedAt(s.throwaway.control);
    await press(s.admin, panelId, button.id);
    await until('the container to restart', () =>
      Promise.resolve(startedAt(s.throwaway.control) !== before),
    );
    const lines = await until('the ops log line', async () => {
      const found = (await opsLines()).find((l) =>
        l.includes(`restarted \`${s.throwaway.control}\``),
      );
      return found ? [found] : undefined;
    });
    expect(lines[0]).toMatch(/^.+ restarted `hb-test-/);
    // A second press inside the cooldown does nothing.
    const afterFirst = startedAt(s.throwaway.control);
    await press(s.admin, panelId, button.id);
    await new Promise((r) => setTimeout(r, 1000));
    expect(startedAt(s.throwaway.control)).toBe(afterFirst);
    expect(containerState(s.throwaway.control)).toBe('running');
  });

  it('Harmony itself refuses a button to someone without the permission', async () => {
    const { panelId, button } = await buttonLabelled(
      'containers',
      `Restart ${s.throwaway.control}`,
    );
    await expect(press(s.member, panelId, button.id)).rejects.toThrow(/403/);
  });

  it('a button id that is not on the panel never reaches Docker', async () => {
    const { panelId } = await buttonLabelled('containers', `Restart ${s.throwaway.control}`);
    await expect(press(s.admin, panelId, 'rs-vaultwarden')).rejects.toThrow(/404/);
    await expect(press(s.admin, panelId, `rs-${s.throwaway.other}`)).rejects.toThrow(/404/);
  });

  it('the bot refuses a slash command from a member without the permission, and logs it', async () => {
    const before = startedAt(s.throwaway.control);
    await run(s.member, 'stop', { target: s.throwaway.control });
    await until('the refusal in the ops log', async () =>
      (await opsLines()).some((l) => l.includes('was refused: stop')),
    );
    expect(startedAt(s.throwaway.control)).toBe(before);
    expect(containerState(s.throwaway.control)).toBe('running');
  });

  it('slash commands cannot reach containers outside the lists', async () => {
    await run(s.admin, 'stop', { target: s.throwaway.other });
    await run(s.admin, 'stop', { target: s.throwaway.statusOnly });
    await new Promise((r) => setTimeout(r, 1500));
    expect(containerState(s.throwaway.other)).toBe('running');
    expect(containerState(s.throwaway.statusOnly)).toBe('running');
  });

  it('controls the game server through the panel API by slug and by button', async () => {
    await run(s.admin, 'restart', { target: 'mock_keeper' });
    await until('the power call', () =>
      Promise.resolve(s.game.powerCalls.some((c) => c.signal === 'restart')),
    );
    await new Promise((r) => setTimeout(r, 2500)); // the per-target cooldown is 2 s in this test
    const { panelId, button } = await buttonLabelled('games', 'Stop Mock Keeper');
    await press(s.admin, panelId, button.id);
    await until('the stop call', () =>
      Promise.resolve(s.game.powerCalls.some((c) => c.signal === 'stop')),
    );
    await until('the panel to offer Start', async () => {
      const { button: start } = await buttonLabelled('games', 'Start Mock Keeper');
      return start;
    });
    await until('the game log lines', async () => {
      const lines = await opsLines();
      return (
        lines.some((l) => l.includes('asked to restart game server `Mock Keeper`')) &&
        lines.some((l) => l.includes('asked to stop game server'))
      );
    });
  });

  it('keeps the token out of its own output', () => {
    expect(s.botOutput()).toContain('connected to the gateway');
    expect(s.botOutput()).not.toMatch(/hb_\d+_/);
    expect(s.botOutput()).not.toContain('ptlc_mock_key_for_tests');
  });
});
