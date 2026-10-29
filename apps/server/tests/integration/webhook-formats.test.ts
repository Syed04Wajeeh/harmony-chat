import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Message } from '@harmony/shared';
import {
  api,
  createChannel,
  createGuild,
  createInfra,
  type Infra,
  type TestApp,
} from './support/harness.js';
import { bare } from './support/bots.js';
import { hmacHex } from '../../src/webhooks/signature.js';
import * as p from '../support/webhook-payloads.js';

const uid = () => randomUUID().slice(0, 8);

describe('webhook formats, presets and templates', () => {
  let infra: Infra;
  let target: TestApp;

  beforeAll(async () => {
    infra = createInfra();
    target = await infra.startApp({ WEBHOOK_RATE_MAX: '100', LOG_LEVEL: 'error' });
  });
  afterAll(() => infra.stop());

  async function setup(config: Record<string, unknown> = {}) {
    const owner = `owner-${uid()}@example.com`;
    const member = `member-${uid()}@example.com`;
    const guildId = await createGuild(infra.db, owner, [member]);
    const channelId = await createChannel(infra.db, [owner], { guildId, createdBy: owner });
    const created = await api(target, owner)(`/api/channels/${channelId}/webhooks`, {
      method: 'POST',
      body: { name: 'Hook', ...config },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const hook = created.body as { id: string; url: string; format: string; hasSecret: boolean };
    return { owner, member, channelId, hook, url: hook.url };
  }

  const post = async (url: string, body: string, headers: Record<string, string>) => {
    const res = await fetch(`${target.url}${url}?wait=true`, { method: 'POST', body, headers });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null };
  };
  const json = { 'content-type': 'application/json' };

  it('defaults to the Discord format and reports its settings without the secret', async () => {
    const w = await setup();
    expect(w.hook).toMatchObject({ format: 'discord', hasSecret: false });
    const listed = await api(target, w.owner)(`/api/channels/${w.channelId}/webhooks`);
    expect(listed.body).toMatchObject({
      webhooks: [{ format: 'discord', template: null, hasSecret: false }],
    });
  });

  it('converts a Forgejo push through the endpoint', async () => {
    const w = await setup({ format: 'forgejo' });
    const res = await post(w.url, JSON.stringify(p.forgePush), {
      ...json,
      'x-forgejo-event': 'push',
    });
    expect(res.status).toBe(200);
    const message = res.body as Message;
    expect(message.embeds?.[0]?.title).toBe('[lab/harmony:main] 2 new commits');
    expect(message.author.isBot).toBe(true);
  });

  it('converts a GitHub pull request, and answers 204 for an ignored event', async () => {
    const w = await setup({ format: 'github' });
    const res = await post(w.url, JSON.stringify(p.forgePullRequestMerged), {
      ...json,
      'x-github-event': 'pull_request',
    });
    expect((res.body as Message).embeds?.[0]?.title).toContain('Pull request merged');
    const ignored = await post(w.url, JSON.stringify(p.forgePush), {
      ...json,
      'x-github-event': 'check_run',
    });
    expect(ignored.status).toBe(204);
  });

  it('converts Alertmanager, Grafana, Watchtower (JSON and text) and generic bodies', async () => {
    const alerts = await setup({ format: 'alertmanager' });
    const am = await post(alerts.url, JSON.stringify(p.alertmanagerFiring), json);
    expect((am.body as Message).embeds?.[0]?.title).toBe('[FIRING:2] HighLatency');

    const gf = await setup({ format: 'grafana' });
    const g = await post(gf.url, JSON.stringify(p.grafanaUnified), json);
    expect((g.body as Message).embeds?.[0]?.title).toBe('[FIRING:1] DiskFull (prod)');

    const wt = await setup({ format: 'watchtower' });
    const viaJson = await post(wt.url, JSON.stringify(p.watchtowerJson), json);
    expect((viaJson.body as Message).embeds?.[0]?.description).toContain('Found new');
    const viaText = await post(wt.url, p.watchtowerText, { 'content-type': 'text/plain' });
    expect((viaText.body as Message).embeds?.[0]?.description).toContain('Stopping /jellyfin');

    const gen = await setup({ format: 'generic' });
    const ha = await post(gen.url, JSON.stringify(p.homeAssistant), json);
    expect((ha.body as Message).embeds?.[0]?.title).toBe('door_opened');
  });

  it('accepts a GitHub form-encoded delivery', async () => {
    const w = await setup({ format: 'github' });
    const form = new URLSearchParams({ payload: JSON.stringify(p.forgeIssueOpened) }).toString();
    const res = await post(w.url, form, {
      'content-type': 'application/x-www-form-urlencoded',
      'x-github-event': 'issues',
    });
    expect((res.body as Message).embeds?.[0]?.title).toContain('Issue opened');
  });

  it('renders a template webhook, with mass mentions disarmed', async () => {
    const w = await setup({
      format: 'template',
      template: {
        content: 'Backup {{status | upper}} {{who}}',
        embed: {
          title: '{{name}}',
          color: '#2ecc71',
          fields: [{ name: 'Host', value: '{{host.name | default:"unknown"}}', inline: true }],
        },
      },
    });
    const res = await post(
      w.url,
      JSON.stringify({ name: 'Nightly', status: 'ok', who: '@everyone', host: {} }),
      json,
    );
    expect(res.status).toBe(200);
    const message = res.body as Message;
    expect(message.content).not.toMatch(/@everyone/);
    expect(message.content).toContain('Backup OK');
    expect(message.embeds?.[0]).toMatchObject({
      title: 'Nightly',
      color: 0x2ecc71,
      fields: [{ name: 'Host', value: 'unknown', inline: true }],
    });
  });

  it('answers 204 when a template renders nothing', async () => {
    const w = await setup({ format: 'template', template: { content: '{{nothing}}' } });
    expect((await post(w.url, '{}', json)).status).toBe(204);
  });

  it('rejects invalid configuration at save time', async () => {
    const owner = `owner-${uid()}@example.com`;
    const guildId = await createGuild(infra.db, owner, []);
    const channelId = await createChannel(infra.db, [owner], { guildId, createdBy: owner });
    const create = (body: unknown) =>
      api(target, owner)(`/api/channels/${channelId}/webhooks`, { method: 'POST', body });
    expect((await create({ name: 'a', format: 'template' })).status).toBe(400);
    expect((await create({ name: 'a', format: 'template', template: {} })).status).toBe(400);
    expect(
      (await create({ name: 'a', format: 'template', template: { content: '{{x | eval}}' } }))
        .status,
    ).toBe(400);
    expect(
      (await create({ name: 'a', format: 'template', template: { content: '{{__proto__}}' } }))
        .status,
    ).toBe(400);
    expect((await create({ name: 'a', format: 'nope' })).status).toBe(400);
    expect((await create({ name: 'a', format: 'generic', secret: 'longenough' })).status).toBe(400);
    expect((await create({ name: 'a', format: 'github', secret: 'short' })).status).toBe(400);
  });

  it('updates a webhook, switching format and managing the secret', async () => {
    const w = await setup();
    const as = api(target, w.owner);
    const toGithub = await as(`/api/webhooks/${w.hook.id}`, {
      method: 'PATCH',
      body: { format: 'github', secret: 'a-long-shared-secret' },
    });
    expect(toGithub.status).toBe(200);
    expect(toGithub.body).toMatchObject({ format: 'github', hasSecret: true });
    expect(JSON.stringify(toGithub.body)).not.toContain('a-long-shared-secret');
    // Moving to a format that cannot sign drops the secret.
    const toGeneric = await as(`/api/webhooks/${w.hook.id}`, {
      method: 'PATCH',
      body: { format: 'generic' },
    });
    expect(toGeneric.body).toMatchObject({ format: 'generic', hasSecret: false });
    const row = await infra.db
      .selectFrom('webhooks')
      .select('signature_secret')
      .where('id', '=', w.hook.id)
      .executeTakeFirstOrThrow();
    expect(row.signature_secret).toBeNull();
    const bad = await as(`/api/webhooks/${w.hook.id}`, {
      method: 'PATCH',
      body: { secret: 'a-long-shared-secret' },
    });
    expect(bad.status).toBe(400);
    expect(
      (
        await api(target, w.member)(`/api/webhooks/${w.hook.id}`, {
          method: 'PATCH',
          body: { format: 'discord' },
        })
      ).status,
    ).toBe(403);
  });

  describe('signatures', () => {
    const secret = 'a-long-shared-secret';
    const payload = JSON.stringify(p.forgePush);

    it('requires a valid GitHub signature once a secret is set', async () => {
      const w = await setup({ format: 'github', secret });
      const headers = { ...json, 'x-github-event': 'push' };
      const good = await post(w.url, payload, {
        ...headers,
        'x-hub-signature-256': `sha256=${hmacHex(secret, Buffer.from(payload))}`,
      });
      expect(good.status).toBe(200);
      const bad = await post(w.url, payload, {
        ...headers,
        'x-hub-signature-256': `sha256=${hmacHex('wrong-secret', Buffer.from(payload))}`,
      });
      expect(bad.status).toBe(401);
      expect(bad.body).toMatchObject({ code: 'invalid_signature' });
      const missing = await post(w.url, payload, headers);
      expect(missing.status).toBe(401);
      // A signature for a different body does not carry over.
      const tampered = await post(w.url, payload.replace('main', 'evil'), {
        ...headers,
        'x-hub-signature-256': `sha256=${hmacHex(secret, Buffer.from(payload))}`,
      });
      expect(tampered.status).toBe(401);
    });

    it('accepts Forgejo and Gitea signature headers', async () => {
      const w = await setup({ format: 'forgejo', secret });
      const sig = hmacHex(secret, Buffer.from(payload));
      for (const name of ['x-forgejo-signature', 'x-gitea-signature']) {
        const res = await post(w.url, payload, {
          ...json,
          'x-forgejo-event': 'push',
          [name]: sig,
        });
        expect(res.status, name).toBe(200);
      }
      expect((await post(w.url, payload, { ...json, 'x-forgejo-event': 'push' })).status).toBe(401);
    });

    it('checks the token before the signature, and signs form deliveries over the raw bytes', async () => {
      const w = await setup({ format: 'github', secret });
      const wrongToken = await post(`/api/webhooks/${w.hook.id}/${'A'.repeat(43)}`, payload, json);
      expect(wrongToken.body).toMatchObject({ code: 'invalid_token' });
      const form = new URLSearchParams({ payload }).toString();
      const res = await post(w.url, form, {
        'content-type': 'application/x-www-form-urlencoded',
        'x-github-event': 'push',
        'x-hub-signature-256': `sha256=${hmacHex(secret, Buffer.from(form))}`,
      });
      expect(res.status).toBe(200);
    });
  });

  describe('preview', () => {
    it('renders a sample with the saved template without posting', async () => {
      const w = await setup({
        format: 'template',
        template: { embed: { title: 'Hello {{who}}' } },
      });
      const res = await api(target, w.owner)(`/api/webhooks/${w.hook.id}/preview`, {
        method: 'POST',
        body: { body: { who: 'world' } },
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ message: { embeds: [{ title: 'Hello world' }] } });
      const history = await api(target, w.owner)(`/api/channels/${w.channelId}/messages`);
      expect((history.body as { messages: Message[] }).messages).toHaveLength(0);
    });

    it('previews an unsaved template or preset, and null when nothing would post', async () => {
      const w = await setup();
      const as = api(target, w.owner);
      const draft = await as(`/api/webhooks/${w.hook.id}/preview`, {
        method: 'POST',
        body: { body: { n: 3 }, format: 'template', template: { content: 'n={{n}}' } },
      });
      expect(draft.body).toMatchObject({ message: { content: 'n=3' } });
      const preset = await as(`/api/webhooks/${w.hook.id}/preview`, {
        method: 'POST',
        body: { body: p.forgePush, format: 'forgejo', headers: { 'X-Forgejo-Event': 'push' } },
      });
      expect(preset.body).toMatchObject({
        message: { embeds: [{ title: '[lab/harmony:main] 2 new commits' }] },
      });
      const none = await as(`/api/webhooks/${w.hook.id}/preview`, {
        method: 'POST',
        body: { body: {}, format: 'template', template: { content: '{{x}}' } },
      });
      expect(none.body).toEqual({ message: null });
      const invalid = await as(`/api/webhooks/${w.hook.id}/preview`, {
        method: 'POST',
        body: { body: {}, template: { content: '{{x | eval}}' } },
      });
      expect(invalid.status).toBe(400);
    });

    it('needs manage permission, and is not reachable without a signed-in user', async () => {
      const w = await setup({ format: 'generic' });
      const member = await api(target, w.member)(`/api/webhooks/${w.hook.id}/preview`, {
        method: 'POST',
        body: { body: {} },
      });
      expect(member.status).toBe(403);
      // Without a signed-in user the call is refused, never rendered.
      const anonymous = await bare(target, `/api/webhooks/${w.hook.id}/preview`, { body: {} });
      expect([401, 403]).toContain(anonymous.status);
    });
  });

  it('keeps the Discord format strict and unchanged', async () => {
    const w = await setup();
    expect((await post(w.url, JSON.stringify({ title: 'no content' }), json)).status).toBe(400);
    expect((await post(w.url, 'not json', json)).status).toBe(400);
    expect((await post(w.url, 'plain', { 'content-type': 'text/plain' })).status).toBe(400);
    expect((await post(w.url, JSON.stringify({ content: 'ok' }), json)).status).toBe(200);
  });
});
