import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_CUSTOM_THEMES,
  type CustomTheme,
  type Guild,
  type GuildSummary,
  type Invite,
  type InvitePreview,
  type Me,
  type UserSettings,
} from '@harmony/shared';
import {
  PROXY_SECRET,
  PUBLIC_ORIGIN,
  TestSocket,
  api,
  createInfra,
  type Infra,
  type TestApp,
} from './support/harness.js';

const unique = (name: string) => `${name}-${Math.random().toString(36).slice(2, 8)}@example.com`;

const THEME = {
  name: 'Dusk',
  base: 'dark',
  tokens: { 'color-bg-canvas': '#101418', 'color-accent': '#8fb4ff', 'radius-card': '8px' },
};

describe('user settings and themes', () => {
  let infra: Infra;
  let target: TestApp;
  const sockets: TestSocket[] = [];

  const connect = async (login: string) => {
    const socket = await TestSocket.connect(target, login);
    sockets.push(socket);
    await socket.waitFor('hello');
    return socket;
  };
  const get = async (login: string) =>
    (await api(target, login)('/api/me/settings')).body as UserSettings;

  beforeAll(async () => {
    infra = createInfra();
    target = await infra.startApp({ RATE_LIMIT_MAX: '10000', PERKS_DEFAULT: 'none' });
  });

  afterAll(async () => {
    await Promise.all(sockets.map((s) => s.close()));
    await infra.stop();
  });

  describe('settings', () => {
    it('serves defaults at version 0 before anything is saved', async () => {
      const settings = await get(unique('fresh'));
      expect(settings.version).toBe(0);
      expect(settings.appearance).toMatchObject({
        mode: 'system',
        themeId: 'harmony-dark',
        density: 'cozy',
      });
      expect(settings.behavior.sendOnEnter).toBe(true);
    });

    it('saves a patch, bumps the version and keeps untouched fields', async () => {
      const login = unique('saver');
      const call = api(target, login);
      const first = await call('/api/me/settings', {
        method: 'PATCH',
        body: { version: 0, appearance: { density: 'compact', fontScale: 1.125 } },
      });
      expect(first.status).toBe(200);
      const saved = first.body as UserSettings;
      expect(saved.version).toBe(1);
      expect(saved.appearance).toMatchObject({
        density: 'compact',
        fontScale: 1.125,
        panels: 'floating',
      });

      const second = await call('/api/me/settings', {
        method: 'PATCH',
        body: { version: 1, behavior: { timeFormat: '24h' } },
      });
      expect((second.body as UserSettings).version).toBe(2);
      expect(await get(login)).toMatchObject({
        version: 2,
        appearance: { density: 'compact' },
        behavior: { timeFormat: '24h' },
      });
    });

    it('answers 409 to a stale version and applies nothing', async () => {
      const login = unique('stale');
      const call = api(target, login);
      await call('/api/me/settings', {
        method: 'PATCH',
        body: { version: 0, appearance: { panels: 'flat' } },
      });
      const stale = await call('/api/me/settings', {
        method: 'PATCH',
        body: { version: 0, appearance: { density: 'compact' } },
      });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ code: 'version_conflict' });
      expect((await get(login)).appearance.density).toBe('cozy');
    });

    it('lets exactly one of two concurrent writers win', async () => {
      const login = unique('race');
      const call = api(target, login);
      await call('/api/me/settings', {
        method: 'PATCH',
        body: { version: 0, appearance: { panels: 'flat' } },
      });
      const results = await Promise.all(
        ['compact', 'comfortable'].map((density) =>
          call('/api/me/settings', {
            method: 'PATCH',
            body: { version: 1, appearance: { density } },
          }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    });

    it('rejects invalid values and unknown themes', async () => {
      const call = api(target, unique('invalid'));
      const bad = (appearance: object) =>
        call('/api/me/settings', { method: 'PATCH', body: { version: 0, appearance } });
      expect((await bad({ fontScale: 3 })).status).toBe(400);
      expect((await bad({ messageFont: 'wingdings' })).status).toBe(400);
      expect((await bad({ themeId: 'nope' })).status).toBe(400);
      expect((await bad({ themeId: crypto.randomUUID() })).status).toBe(400);
      expect((await bad({ themeId: 'midnight' })).status).toBe(200);
    });

    it('sanitizes custom CSS on save and stores the clean text', async () => {
      const login = unique('css');
      const dirty =
        '@import url(https://evil.example/a.css);\n[data-harmony="message"] { background: u\\rl(http://evil.example/x) red; color: #123 }';
      const res = await api(target, login)('/api/me/settings', {
        method: 'PATCH',
        body: { version: 0, appearance: { customCssEnabled: true, customCss: dirty } },
      });
      expect(res.status).toBe(200);
      const css = (res.body as UserSettings).appearance.customCss;
      expect(css).not.toContain('evil.example');
      expect(css).not.toContain('@import');
      expect(css).toContain('color: #123');
      expect((await get(login)).appearance.customCss).toBe(css);
      const stored = await infra.db
        .selectFrom('user_settings')
        .innerJoin('users', 'users.id', 'user_settings.user_id')
        .select('user_settings.appearance')
        .where('users.login', '=', login)
        .executeTakeFirstOrThrow();
      expect(JSON.stringify(stored.appearance)).not.toContain('evil.example');
    });

    it('rejects custom CSS over 20 KB', async () => {
      const res = await api(target, unique('big'))('/api/me/settings', {
        method: 'PATCH',
        body: { version: 0, appearance: { customCss: `a{color:red}${' '.repeat(21 * 1024)}` } },
      });
      expect(res.status).toBe(400);
    });

    it("publishes settings.updated to the user's other sessions only", async () => {
      const login = unique('live');
      const first = await connect(login);
      const second = await connect(login);
      const stranger = await connect(unique('other'));
      await api(target, login)('/api/me/settings', {
        method: 'PATCH',
        body: { version: 0, appearance: { themeId: 'rose', mode: 'light' } },
      });
      const [frame] = await second.waitFor('settings.updated');
      expect(frame?.settings.appearance).toMatchObject({ themeId: 'rose', mode: 'light' });
      expect(frame?.settings.version).toBe(1);
      expect((await first.waitFor('settings.updated'))[0]?.settings.version).toBe(1);
      expect(stranger.of('settings.updated')).toHaveLength(0);
    });

    it('keeps settings private to their owner', async () => {
      const a = unique('a');
      await api(target, a)('/api/me/settings', {
        method: 'PATCH',
        body: { version: 0, appearance: { density: 'compact' } },
      });
      expect((await get(unique('b'))).appearance.density).toBe('cozy');
    });
  });

  describe('themes', () => {
    const create = (login: string, body: object = THEME) =>
      api(target, login)('/api/me/themes', { method: 'POST', body });

    it('creates, lists, updates and deletes', async () => {
      const login = unique('themer');
      const call = api(target, login);
      const created = await create(login);
      expect(created.status).toBe(201);
      const theme = created.body as CustomTheme;
      expect(theme).toMatchObject(THEME);

      const listed = (await call('/api/me/themes')).body as { themes: CustomTheme[] };
      expect(listed.themes.map((t) => t.id)).toEqual([theme.id]);

      const updated = await call(`/api/me/themes/${theme.id}`, {
        method: 'PUT',
        body: { ...THEME, name: 'Dusk 2', tokens: { 'color-accent': '#aabbcc' } },
      });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({ name: 'Dusk 2', tokens: { 'color-accent': '#aabbcc' } });

      expect((await call(`/api/me/themes/${theme.id}`, { method: 'DELETE' })).status).toBe(204);
      expect(((await call('/api/me/themes')).body as { themes: unknown[] }).themes).toEqual([]);
      expect((await call(`/api/me/themes/${theme.id}`, { method: 'DELETE' })).status).toBe(404);
    });

    it('enforces the per-user limit', async () => {
      const login = unique('hoarder');
      const results = await Promise.all(
        Array.from({ length: MAX_CUSTOM_THEMES + 3 }, () => create(login)),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(MAX_CUSTOM_THEMES);
      expect(results.filter((r) => r.status === 400)).toHaveLength(3);
      expect(results.find((r) => r.status === 400)?.body).toMatchObject({ code: 'theme_limit' });
      expect((await create(unique('fresh'))).status).toBe(201);
    });

    it.each([
      ['injection', { 'color-text': 'red;}body{display:none' }],
      ['url', { 'color-text': 'url(http://evil.example/x)' }],
      ['var', { 'color-text': 'var(--color-accent)' }],
      ['unknown token', { 'font-ui': 'serif' }],
      ['bad length', { 'radius-card': '99px' }],
    ])('rejects %s', async (_name, tokens) => {
      expect((await create(unique('hostile'), { ...THEME, tokens })).status).toBe(400);
    });

    it("does not let one user read, change or select another's theme", async () => {
      const owner = unique('owner');
      const intruder = unique('intruder');
      const theme = (await create(owner)).body as CustomTheme;
      const other = api(target, intruder);
      expect(
        (await other(`/api/me/themes/${theme.id}`, { method: 'PUT', body: THEME })).status,
      ).toBe(404);
      expect((await other(`/api/me/themes/${theme.id}`, { method: 'DELETE' })).status).toBe(404);
      expect(((await other('/api/me/themes')).body as { themes: unknown[] }).themes).toEqual([]);
      const select = await other('/api/me/settings', {
        method: 'PATCH',
        body: { version: 0, appearance: { themeId: theme.id } },
      });
      expect(select.status).toBe(400);
    });

    it('selects a custom theme, and falls back to the default when it is deleted', async () => {
      const login = unique('select');
      const call = api(target, login);
      const theme = (await create(login)).body as CustomTheme;
      const socket = await connect(login);
      const set = await call('/api/me/settings', {
        method: 'PATCH',
        body: { version: 0, appearance: { themeId: theme.id } },
      });
      expect((set.body as UserSettings).appearance.themeId).toBe(theme.id);
      await call(`/api/me/themes/${theme.id}`, { method: 'DELETE' });
      expect((await get(login)).appearance.themeId).toBe('harmony-dark');
      const frames = await socket.waitFor('themes.updated');
      expect(frames.at(-1)?.themes).toEqual([]);
    });
  });

  describe('guild branding', () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const upload = async (login: string) => {
      const form = new FormData();
      form.append('file', new Blob([png], { type: 'image/png' }), 'banner.png');
      const res = await fetch(`${target.url}/api/uploads`, {
        method: 'POST',
        headers: {
          'x-harmony-proxy-secret': PROXY_SECRET,
          'tailscale-user-login': login,
          origin: PUBLIC_ORIGIN,
        },
        body: form,
      });
      return ((await res.json()) as { id: string }).id;
    };

    it('needs manage_guild to change branding, and shows it in every payload', async () => {
      const owner = unique('owner');
      const member = unique('member');
      const outsider = unique('outsider');
      const guild = (
        await api(target, owner)('/api/guilds', { method: 'POST', body: { name: 'Club' } })
      ).body as GuildSummary;
      const invite = (
        await api(target, owner)(`/api/guilds/${guild.id}/invites`, { method: 'POST', body: {} })
      ).body as Invite;
      await api(target, member)(`/api/invites/${invite.code}/accept`, { method: 'POST' });
      const branding = { accentColor: 0x3b9ec7, description: 'Tea, books and bad puns.' };

      const denied = await api(target, member)(`/api/guilds/${guild.id}`, {
        method: 'PATCH',
        body: branding,
      });
      expect(denied.status).toBe(403);

      const memberId = ((await api(target, member)('/api/me')).body as Me).id;
      const role = (
        await api(target, owner)(`/api/guilds/${guild.id}/roles`, {
          method: 'POST',
          body: { name: 'Curators', permissions: ['manage_guild'] },
        })
      ).body as { id: string };
      await api(target, owner)(`/api/guilds/${guild.id}/members/${memberId}/roles/${role.id}`, {
        method: 'PUT',
      });

      const watcher = await TestSocket.connect(target, owner);
      sockets.push(watcher);
      const bannerId = await upload(member);
      const saved = await api(target, member)(`/api/guilds/${guild.id}`, {
        method: 'PATCH',
        body: { ...branding, bannerAttachmentId: bannerId },
      });
      expect(saved.status).toBe(200);
      const updated = saved.body as Guild;
      expect(updated).toMatchObject(branding);
      expect(updated.bannerUrl).toContain(bannerId);

      const [frame] = await watcher.waitFor('guild.updated');
      expect(frame?.guild).toMatchObject({ ...branding, id: guild.id });

      const listed = (await api(target, owner)('/api/guilds')).body as { guilds: GuildSummary[] };
      expect(listed.guilds.find((g) => g.id === guild.id)).toMatchObject(branding);

      const preview = (await api(target, outsider)(`/api/invites/${invite.code}`))
        .body as InvitePreview;
      expect(preview.guild).toMatchObject({ ...branding, bannerUrl: updated.bannerUrl });
      const banner = await fetch(`${target.url}${updated.bannerUrl ?? ''}`, {
        headers: { 'x-harmony-proxy-secret': PROXY_SECRET, 'tailscale-user-login': outsider },
      });
      expect(banner.status).toBe(200);

      const cleared = await api(target, owner)(`/api/guilds/${guild.id}`, {
        method: 'PATCH',
        body: { accentColor: null, description: '', bannerAttachmentId: null },
      });
      expect(cleared.body).toMatchObject({ accentColor: null, description: null, bannerUrl: null });
    });

    it('validates accent, description length and banner ownership', async () => {
      const owner = unique('owner');
      const guild = (
        await api(target, owner)('/api/guilds', { method: 'POST', body: { name: 'Club' } })
      ).body as GuildSummary;
      const patch = (body: object) =>
        api(target, owner)(`/api/guilds/${guild.id}`, { method: 'PATCH', body });
      expect((await patch({ accentColor: 0x1000000 })).status).toBe(400);
      expect((await patch({ accentColor: -1 })).status).toBe(400);
      expect((await patch({ description: 'x'.repeat(301) })).status).toBe(400);
      expect((await patch({ description: 'x'.repeat(300) })).status).toBe(200);
      const theirs = await upload(unique('someone-else'));
      expect((await patch({ bannerAttachmentId: theirs })).status).toBe(400);
      expect((await patch({ bannerAttachmentId: crypto.randomUUID() })).status).toBe(400);
    });
  });
});
