import { createHash, randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Attachment, ListMessagesResponse, Message } from '@harmony/shared';
import { UploadCleaner } from '../../src/modules/uploads/cleaner.js';
import { LocalDiskStorage } from '../../src/uploads/storage.js';
import {
  PROXY_SECRET,
  PUBLIC_ORIGIN,
  api,
  createChannel,
  createInfra,
  type Infra,
  type TestApp,
} from './support/harness.js';

const unique = (name: string) => `${name}-${Math.random().toString(36).slice(2, 8)}@example.com`;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from('<html><script>alert(1)</script></html>');

describe('uploads and attachments', () => {
  let infra: Infra;
  let target: TestApp;

  const headers = (login: string) => ({
    'x-harmony-proxy-secret': PROXY_SECRET,
    'tailscale-user-login': login,
    'tailscale-user-name': login.split('@')[0] ?? login,
    origin: PUBLIC_ORIGIN,
  });
  const upload = async (
    login: string,
    bytes: Buffer,
    filename = 'file.bin',
    claimedType = 'application/octet-stream',
    app = target,
  ) => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type: claimedType }), filename);
    const res = await fetch(`${app.url}/api/uploads`, {
      method: 'POST',
      headers: headers(login),
      body: form,
    });
    return { status: res.status, body: (await res.json()) as Attachment & { code?: string } };
  };
  const download = (login: string, url: string) =>
    fetch(`${target.url}${url}`, { headers: headers(login) });
  const send = (login: string, channelId: string, body: object) =>
    api(target, login)(`/api/channels/${channelId}/messages`, { method: 'POST', body });

  beforeAll(async () => {
    infra = createInfra();
    target = await infra.startApp({ MESSAGE_RATE_MAX: '1000', RATE_LIMIT_MAX: '10000' });
  });

  afterAll(() => infra.stop());

  describe('storing', () => {
    it('detects the real type from magic bytes, ignoring the client-declared one and name', async () => {
      const user = unique('up');
      const { status, body } = await upload(user, PNG, '../../etc/<evil>.html', 'text/html');
      expect(status).toBe(201);
      expect(body).toMatchObject({
        contentType: 'image/png',
        sizeBytes: PNG.length,
        width: 1,
        height: 1,
        filename: '_evil_.html',
      });
      const row = await infra.db
        .selectFrom('attachments')
        .selectAll()
        .where('id', '=', body.id)
        .executeTakeFirstOrThrow();
      expect(row.sha256).toBe(createHash('sha256').update(PNG).digest('hex'));
      expect(row.message_id).toBeNull();

      const html = await upload(user, HTML, 'page.png', 'image/png');
      expect(html.body.contentType).toBe('application/octet-stream');
      const svg = await upload(user, SVG, 'image.svg', 'image/svg+xml');
      expect(svg.body).toMatchObject({ contentType: 'application/octet-stream', width: null });
    });

    it('stores the bytes unchanged', async () => {
      const user = unique('up');
      const bytes = randomBytes(300_000);
      const { body } = await upload(user, bytes, 'blob.bin');
      const res = await download(user, body.url);
      expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
    });

    it('rejects files over UPLOAD_MAX_BYTES with 413 and leaves nothing behind', async () => {
      const small = await infra.startApp({ UPLOAD_MAX_BYTES: '2048' });
      const user = unique('big');
      const ok = await upload(
        user,
        randomBytes(2048),
        'fits.bin',
        'application/octet-stream',
        small,
      );
      expect(ok.status).toBe(201);
      const filesBefore = await readdir(small.config.UPLOAD_DIR);

      const res = await upload(
        user,
        randomBytes(5000),
        'big.bin',
        'application/octet-stream',
        small,
      );
      expect(res.status).toBe(413);
      expect(res.body.code).toBe('file_too_large');
      expect(await readdir(small.config.UPLOAD_DIR)).toEqual(filesBefore);
      const rows = await infra.db
        .selectFrom('attachments')
        .select('id')
        .where('filename', '=', 'big.bin')
        .execute();
      expect(rows).toHaveLength(0);
    });

    it('rejects empty uploads, missing files and non-multipart requests', async () => {
      const user = unique('bad');
      expect((await upload(user, Buffer.alloc(0))).status).toBe(400);
      const plain = await api(target, user)('/api/uploads', { method: 'POST', body: { a: 1 } });
      expect(plain.status).toBe(400);
      const noFile = new FormData();
      noFile.append('field', 'value');
      const res = await fetch(`${target.url}/api/uploads`, {
        method: 'POST',
        headers: headers(user),
        body: noFile,
      });
      expect(res.status).toBe(400);
    });

    it('requires the Origin header like every other write', async () => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(PNG)]), 'x.png');
      const noOrigin = Object.fromEntries(
        Object.entries(headers(unique('csrf'))).filter(([name]) => name !== 'origin'),
      );
      const res = await fetch(`${target.url}/api/uploads`, {
        method: 'POST',
        headers: noOrigin,
        body: form,
      });
      expect(res.status).toBe(403);
    });

    it('rate limits uploads per user', async () => {
      const limited = await infra.startApp({ UPLOAD_RATE_MAX: '2' });
      const user = unique('rate');
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        statuses.push((await upload(user, PNG, 'p.png', 'image/png', limited)).status);
      }
      expect(statuses).toEqual([201, 201, 429, 429]);
    });
  });

  describe('downloading', () => {
    it('serves raster images inline with hardened headers', async () => {
      const user = unique('img');
      const { body } = await upload(user, PNG, 'pixel.png', 'image/png');
      const res = await download(user, body.url);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('content-length')).toBe(String(PNG.length));
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-disposition')).toMatch(/^inline;/);
      expect(res.headers.get('content-disposition')).toContain('pixel.png');
      expect(res.headers.get('content-security-policy')).toContain('sandbox');
      expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    });

    it('forces everything else, including SVG and HTML, to download', async () => {
      const user = unique('dangerous');
      for (const [bytes, name] of [
        [SVG, 'a.svg'],
        [HTML, 'a.html'],
        [Buffer.from('hello'), 'a.txt'],
      ] as const) {
        const { body } = await upload(user, bytes, name, 'image/png');
        const res = await download(user, body.url);
        expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
        expect(res.headers.get('content-type')).toBe('application/octet-stream');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('content-security-policy')).toContain('sandbox');
      }
    });

    it('limits an unattached upload to its uploader and an attached one to channel members', async () => {
      const [author, member, outsider] = [unique('author'), unique('member'), unique('outsider')];
      const channelId = await createChannel(infra.db, [author, member]);
      const { body } = await upload(author, PNG, 'p.png');

      expect((await download(author, body.url)).status).toBe(200);
      expect((await download(member, body.url)).status).toBe(403);

      const message = (await send(author, channelId, { content: '', attachmentIds: [body.id] }))
        .body as Message;
      expect(message.attachments).toEqual([body]);
      expect((await download(member, body.url)).status).toBe(200);
      expect((await download(outsider, body.url)).status).toBe(403);
      expect((await download(author, `/api/attachments/${crypto.randomUUID()}/x.png`)).status).toBe(
        404,
      );
      expect((await download(author, '/api/attachments/not-a-uuid/x.png')).status).toBe(400);

      await api(target, author)(`/api/messages/${message.id}`, { method: 'DELETE' });
      expect((await download(member, body.url)).status).toBe(404);
    });
  });

  describe('attaching to messages', () => {
    it('sends attachment-only messages and hides attachments of deleted ones', async () => {
      const user = unique('sender');
      const channelId = await createChannel(infra.db, [user]);
      const [one, two] = [
        await upload(user, PNG, 'one.png'),
        await upload(user, Buffer.from('two'), 'two.txt'),
      ];

      const res = await send(user, channelId, {
        content: '',
        attachmentIds: [one.body.id, two.body.id, one.body.id],
      });
      expect(res.status).toBe(201);
      const message = res.body as Message;
      expect(message.content).toBe('');
      expect(message.attachments.map((a) => a.id)).toEqual([one.body.id, two.body.id]);

      const history = (await api(target, user)(`/api/channels/${channelId}/messages`))
        .body as ListMessagesResponse;
      expect(history.messages[0]?.attachments).toHaveLength(2);
      await api(target, user)(`/api/messages/${message.id}`, { method: 'DELETE' });
      const after = (await api(target, user)(`/api/channels/${channelId}/messages`))
        .body as ListMessagesResponse;
      expect(after.messages[0]?.attachments).toEqual([]);
    });

    it('requires content or attachments', async () => {
      const user = unique('empty');
      const channelId = await createChannel(infra.db, [user]);
      expect((await send(user, channelId, { content: '' })).status).toBe(400);
      expect((await send(user, channelId, { content: ' ', attachmentIds: [] })).status).toBe(400);
    });

    it('rejects attachments that are someone elses, already attached, unknown or too many', async () => {
      const [owner, thief] = [unique('owner'), unique('thief')];
      const channelId = await createChannel(infra.db, [owner, thief]);
      const { body } = await upload(owner, PNG, 'mine.png');

      const stolen = await send(thief, channelId, {
        content: 'mine now',
        attachmentIds: [body.id],
      });
      expect(stolen.status).toBe(400);
      expect(stolen.body).toMatchObject({ code: 'invalid_attachments' });
      expect(
        (await send(owner, channelId, { content: 'ok', attachmentIds: [body.id] })).status,
      ).toBe(201);
      expect(
        (await send(owner, channelId, { content: 'again', attachmentIds: [body.id] })).status,
      ).toBe(400);
      expect(
        (await send(owner, channelId, { content: 'x', attachmentIds: [crypto.randomUUID()] }))
          .status,
      ).toBe(400);
      const many = Array.from({ length: 11 }, () => crypto.randomUUID());
      expect((await send(owner, channelId, { content: 'x', attachmentIds: many })).status).toBe(
        400,
      );
      expect((await send(owner, channelId, { content: 'x', attachmentIds: ['nope'] })).status).toBe(
        400,
      );
    });

    it('does not consume attachments when the send fails', async () => {
      const user = unique('atomic');
      const channelId = await createChannel(infra.db, [user]);
      const { body } = await upload(user, PNG, 'keep.png');
      const bad = await send(user, channelId, {
        content: 'x',
        attachmentIds: [body.id],
        replyToId: '999999999',
      });
      expect(bad.status).toBe(400);
      expect((await send(user, channelId, { content: 'x', attachmentIds: [body.id] })).status).toBe(
        201,
      );
    });
  });

  describe('orphan cleanup', () => {
    const cleaner = (instanceId: string) =>
      new UploadCleaner(
        infra.db,
        infra.redis,
        new LocalDiskStorage(target.config.UPLOAD_DIR),
        { orphanTtlMs: 24 * 60 * 60 * 1000, intervalMs: 60_000, instanceId },
        { warn: () => undefined },
      );
    const age = (id: string, hours: number) =>
      sql`update attachments set created_at = now() - ${hours} * interval '1 hour' where id = ${id}`.execute(
        infra.db,
      );

    it('deletes unattached uploads older than 24 hours, keeping fresh and attached ones', async () => {
      const user = unique('orphan');
      const channelId = await createChannel(infra.db, [user]);
      const [stale, fresh, attached] = await Promise.all([
        upload(user, randomBytes(64), 'stale.bin'),
        upload(user, randomBytes(64), 'fresh.bin'),
        upload(user, randomBytes(64), 'attached.bin'),
      ]);
      await send(user, channelId, { content: 'x', attachmentIds: [attached.body.id] });
      await Promise.all([
        age(stale.body.id, 25),
        age(fresh.body.id, 23),
        age(attached.body.id, 48),
      ]);
      const key = async (id: string) =>
        (
          await infra.db
            .selectFrom('attachments')
            .select('storage_key')
            .where('id', '=', id)
            .executeTakeFirstOrThrow()
        ).storage_key;
      const [staleKey, freshKey, attachedKey] = await Promise.all([
        key(stale.body.id),
        key(fresh.body.id),
        key(attached.body.id),
      ]);

      const deleted = await cleaner('cleaner-a').runOnce();
      expect(deleted).toBeGreaterThanOrEqual(1);

      const remaining = new Set(
        (await infra.db.selectFrom('attachments').select('id').execute()).map((r) => r.id),
      );
      expect(remaining.has(stale.body.id)).toBe(false);
      expect(remaining.has(fresh.body.id)).toBe(true);
      expect(remaining.has(attached.body.id)).toBe(true);
      const files = new Set(await readdir(target.config.UPLOAD_DIR));
      expect(files.has(staleKey)).toBe(false);
      expect(files.has(freshKey)).toBe(true);
      expect(files.has(attachedKey)).toBe(true);
    });

    it('lets only one instance run at a time via the Redis lock', async () => {
      await infra.redis.del('harmony:lock:upload-cleanup');
      const results = await Promise.all([
        cleaner('one').runOnce(),
        cleaner('two').runOnce(),
        cleaner('three').runOnce(),
      ]);
      expect(results.filter((r) => r === null)).toHaveLength(2);
      expect(results.filter((r) => r !== null)).toHaveLength(1);
      await infra.redis.del('harmony:lock:upload-cleanup');
    });
  });
});
