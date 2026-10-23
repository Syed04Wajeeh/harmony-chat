import { crc32, deflateSync } from 'node:zlib';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Attachment, GuildEmoji, Message, UserProfileResponse } from '@harmony/shared';
import { LocalDiskStorage } from '../../src/uploads/storage.js';
import { UploadCleaner } from '../../src/modules/uploads/cleaner.js';
import {
  PROXY_SECRET,
  PUBLIC_ORIGIN,
  TestSocket,
  api,
  createChannel,
  createGuild,
  createInfra,
  ensureUser,
  settle,
  type Infra,
  type TestApp,
} from './support/harness.js';

const unique = (name: string) => `${name}-${Math.random().toString(36).slice(2, 8)}@example.com`;

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

function png(width: number, height: number): Buffer {
  const rows = Buffer.alloc((width * 3 + 1) * height, 0x80);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A 1x1 GIF with two frames. */
const frame = Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x02, 0x02, 0x4c, 0x01, 0x00]);
const GIF = Buffer.concat([
  Buffer.from('GIF89a', 'ascii'),
  Buffer.from([1, 0, 1, 0, 0, 0, 0]),
  frame,
  frame,
  Buffer.from([0x3b]),
]);

describe('profiles, custom emoji and perks', () => {
  let infra: Infra;
  let target: TestApp;
  let other: TestApp;
  const admin = unique('admin');

  const upload = async (login: string, bytes: Buffer, filename = 'file.png', app = target) => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)]), filename);
    const res = await fetch(`${app.url}/api/uploads`, {
      method: 'POST',
      headers: {
        'x-harmony-proxy-secret': PROXY_SECRET,
        'tailscale-user-login': login,
        origin: PUBLIC_ORIGIN,
      },
      body: form,
    });
    return { status: res.status, body: (await res.json()) as Attachment };
  };
  const call = (login: string, app = target) => api(app, login);
  const PIC = 'https://pics.example.com/p.png';
  const withPic = (init: object = {}) => ({
    headers: { 'tailscale-user-profile-pic': PIC },
    ...init,
  });
  const grant = (userId: string, perk: string) =>
    call(admin)(`/api/admin/users/${userId}/perks`, { method: 'PUT', body: { perk } });
  const addEmoji = async (login: string, guildId: string, name: string, bytes = png(32, 32)) => {
    const file = await upload(login, bytes);
    return call(login)(`/api/guilds/${guildId}/emoji`, {
      method: 'POST',
      body: { name, attachmentId: file.body.id },
    });
  };

  beforeAll(async () => {
    infra = createInfra();
    await ensureUser(infra.db, admin, { admin: true });
    const env = {
      PERKS_DEFAULT: 'none',
      MESSAGE_RATE_MAX: '1000',
      RATE_LIMIT_MAX: '10000',
      UPLOAD_MAX_BYTES: '4000',
      UPLOAD_MAX_BYTES_PERK: '40000',
      EMOJI_MAX_PER_GUILD: '3',
      LOG_LEVEL: 'error',
    };
    target = await infra.startApp(env);
    other = await infra.startApp(env);
  });
  afterAll(() => infra.stop());

  describe('profiles', () => {
    it('shows a profile only to people who share a guild or a DM', async () => {
      const [a, b, c] = [unique('a'), unique('b'), unique('c')];
      await createGuild(infra.db, a, [b]);
      const idA = await ensureUser(infra.db, a);
      await ensureUser(infra.db, c);
      expect((await call(b)(`/api/users/${idA}/profile`)).status).toBe(200);
      expect((await call(c)(`/api/users/${idA}/profile`)).status).toBe(404);

      const idC = await ensureUser(infra.db, c);
      const dm = await infra.db
        .insertInto('channels')
        .values({
          guild_id: null,
          kind: 'dm',
          is_private: true,
          name: null,
          topic: null,
          dm_key: `${idA}:${idC}`,
          created_by: idA,
          archived_at: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      for (const userId of [idA, idC]) {
        await infra.db
          .insertInto('channel_members')
          .values({ channel_id: dm.id, user_id: userId, last_read_message_id: null })
          .execute();
      }
      expect((await call(c)(`/api/users/${idA}/profile`)).status).toBe(200);
    });

    it('stores profile fields and reports guild membership details', async () => {
      const [a, b] = [unique('pa'), unique('pb')];
      const guildId = await createGuild(infra.db, a, [b]);
      const idA = await ensureUser(infra.db, a);
      const patch = await call(a)('/api/me/profile', {
        method: 'PATCH',
        body: {
          bio: 'Hello **there**',
          pronouns: 'they/them',
          accentColor: 0x336699,
          bannerColor: 0x112233,
        },
      });
      expect(patch.status).toBe(204);
      const res = await call(b)(`/api/users/${idA}/profile?guildId=${guildId}`);
      const body = res.body as UserProfileResponse;
      expect(body.profile).toMatchObject({
        bio: 'Hello **there**',
        pronouns: 'they/them',
        accentColor: 0x336699,
      });
      expect(body.member?.joinedAt).toBeTruthy();
      expect(
        (await call(a)('/api/me/profile', { method: 'PATCH', body: { bio: 'x'.repeat(191) } }))
          .status,
      ).toBe(400);
    });

    it('sends user.updated to people who share a guild, and not to others', async () => {
      const [a, b, c] = [unique('fa'), unique('fb'), unique('fc')];
      await createGuild(infra.db, a, [b]);
      await ensureUser(infra.db, c);
      const sockB = await TestSocket.connect(target, b);
      const sockC = await TestSocket.connect(target, c);
      await call(a)('/api/me/profile', {
        method: 'PATCH',
        body: { status: { emoji: '🎧', text: 'listening', duration: '1h' } },
      });
      const [frame] = await sockB.waitFor('user.updated');
      expect(frame?.profile).toMatchObject({ statusEmoji: '🎧', statusText: 'listening' });
      await settle(300);
      expect(sockC.frames.some((f) => f.type === 'user.updated')).toBe(false);
      await sockB.close();
      await sockC.close();
    });

    it('clears an expired status on read and via the sweep', async () => {
      const [a, b] = [unique('ea'), unique('eb')];
      await createGuild(infra.db, a, [b]);
      const idA = await ensureUser(infra.db, a);
      await call(a)('/api/me/profile', {
        method: 'PATCH',
        body: { status: { text: 'brb', duration: '30m' } },
      });
      await infra.db
        .updateTable('user_profiles')
        .set({ status_expires_at: new Date(Date.now() - 1000) })
        .where('user_id', '=', idA)
        .execute();
      const users = (await call(b)('/api/users')).body as { profiles: Record<string, unknown> };
      expect(users.profiles[idA]).toBeUndefined();
      await settle(200);
      const row = await infra.db
        .selectFrom('user_profiles')
        .select('status_text')
        .where('user_id', '=', idA)
        .executeTakeFirstOrThrow();
      expect(row.status_text).toBeNull();
    });
  });

  describe('perks', () => {
    it('keeps the perks admin API for instance admins only', async () => {
      const user = unique('pu');
      const id = await ensureUser(infra.db, user);
      expect((await call(user)('/api/admin/perks')).status).toBe(403);
      expect(
        (
          await call(user)(`/api/admin/users/${id}/perks`, {
            method: 'PUT',
            body: { perk: 'animated_avatar' },
          })
        ).status,
      ).toBe(403);
      const overview = (await call(admin)('/api/admin/perks')).body as {
        defaults: string[];
        users: { id: string; grants: { perk: string; grantedBy: string }[] }[];
      };
      expect(overview.defaults).toEqual([]);
      expect((await grant(id, 'animated_avatar')).status).toBe(204);
      const after = (await call(admin)('/api/admin/perks')).body as typeof overview;
      expect(after.users.find((u) => u.id === id)?.grants[0]).toMatchObject({
        perk: 'animated_avatar',
      });
      expect((await call(user)('/api/me/perks')).body).toMatchObject({
        explicit: ['animated_avatar'],
      });
    });

    it('enforces animated avatars, banner images, larger uploads, extra themes and status emoji', async () => {
      const user = unique('enf');
      const id = await ensureUser(infra.db, user);
      const gif = await upload(user, GIF, 'a.gif');
      const still = await upload(user, png(8, 8), 's.png');
      const set = (body: object) => call(user)('/api/me/profile', { method: 'PATCH', body });

      expect((await set({ avatarAttachmentId: still.body.id })).status).toBe(204);
      const refused = await set({ avatarAttachmentId: gif.body.id });
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: 'perk_required' });
      expect((await set({ bannerAttachmentId: still.body.id })).status).toBe(403);
      expect((await upload(user, Buffer.alloc(5000, 1), 'big.bin')).status).toBe(413);

      const theme = () =>
        call(user)('/api/me/themes', {
          method: 'POST',
          body: { name: 'T', base: 'dark', tokens: {} },
        });
      for (let i = 0; i < 20; i++) expect((await theme()).status).toBe(201);
      expect((await theme()).status).toBe(400);

      for (const perk of [
        'animated_avatar',
        'profile_banner_image',
        'larger_uploads',
        'extra_themes',
      ]) {
        await grant(id, perk);
      }
      expect((await set({ avatarAttachmentId: gif.body.id })).status).toBe(204);
      expect((await set({ bannerAttachmentId: still.body.id })).status).toBe(204);
      expect((await upload(user, Buffer.alloc(5000, 1), 'big.bin')).status).toBe(201);
      expect((await theme()).status).toBe(201);

      const reset = await set({ avatarAttachmentId: null });
      expect(reset.status).toBe(204);
    });

    it('uploaded avatars replace the Tailscale picture until reset', async () => {
      const user = unique('av');
      const id = await ensureUser(infra.db, user);
      const me = (path: string, init: { method?: string; body?: unknown } = {}) =>
        call(user)(path, { ...init, ...withPic() });
      const profileOf = async () =>
        ((await me(`/api/users/${id}/profile`)).body as UserProfileResponse).profile;
      await me('/api/me');
      const file = await upload(user, png(16, 16));
      await me('/api/me/profile', { method: 'PATCH', body: { avatarAttachmentId: file.body.id } });
      expect(await profileOf()).toMatchObject({ avatarUrl: file.body.url, avatarOverridden: true });
      await me('/api/me');
      expect((await profileOf()).avatarUrl).toBe(file.body.url);
      await me('/api/me/profile', { method: 'PATCH', body: { avatarAttachmentId: null } });
      expect((await profileOf()).avatarUrl).toBe(PIC);
    });
  });

  describe('custom emoji', () => {
    it('lets only members with manage_emoji manage emoji, and enforces limits', async () => {
      const [owner, member] = [unique('own'), unique('mem')];
      const guildId = await createGuild(infra.db, owner, [member]);
      const ok = await addEmoji(owner, guildId, 'blob');
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({ name: 'blob', animated: false });
      expect((await addEmoji(member, guildId, 'nope')).status).toBe(403);
      expect((await addEmoji(owner, guildId, 'blob')).status).toBe(409);
      expect((await addEmoji(owner, guildId, 'Bad Name')).status).toBe(400);
      expect((await addEmoji(owner, guildId, 'wide', png(129, 10))).status).toBe(400);
      const animated = await addEmoji(owner, guildId, 'spin');
      expect(animated.status).toBe(201);
      const gifUpload = await upload(owner, GIF, 'g.gif');
      const gifEmoji = await call(owner)(`/api/guilds/${guildId}/emoji`, {
        method: 'POST',
        body: { name: 'flick', attachmentId: gifUpload.body.id },
      });
      expect(gifEmoji.body).toMatchObject({ animated: true });
      expect((await addEmoji(owner, guildId, 'fourth')).body).toMatchObject({
        code: 'emoji_limit',
      });

      const id = (ok.body as GuildEmoji).id;
      const renamed = await call(owner)(`/api/guilds/${guildId}/emoji/${id}`, {
        method: 'PATCH',
        body: { name: 'blob2' },
      });
      expect(renamed.body).toMatchObject({ name: 'blob2' });
      const list = (await call(member)(`/api/guilds/${guildId}/emoji`)).body as {
        emoji: GuildEmoji[];
      };
      expect(list.emoji.map((e) => e.name).sort()).toEqual(['blob2', 'flick', 'spin']);
      const image = await fetch(`${target.url}${list.emoji[0]?.url ?? ''}`, {
        headers: {
          'x-harmony-proxy-secret': PROXY_SECRET,
          'tailscale-user-login': member,
          origin: PUBLIC_ORIGIN,
        },
      });
      expect(image.status).toBe(200);
      expect(image.headers.get('x-content-type-options')).toBe('nosniff');
      expect(
        (await call(member)(`/api/guilds/${guildId}/emoji/${id}`, { method: 'DELETE' })).status,
      ).toBe(403);
      expect(
        (await call(owner)(`/api/guilds/${guildId}/emoji/${id}`, { method: 'DELETE' })).status,
      ).toBe(204);
    });

    it('turns tokens the sender cannot use into text and keeps usable ones', async () => {
      const [owner, user] = [unique('so'), unique('su')];
      const home = await createGuild(infra.db, owner, [user]);
      const away = await createGuild(infra.db, owner, [user]);
      const homeChannel = await createChannel(infra.db, [owner, user], { guildId: home });
      const awayChannel = await createChannel(infra.db, [owner, user], { guildId: away });
      const emoji = (await addEmoji(owner, home, 'wave')).body as GuildEmoji;
      const token = `<:wave:${emoji.id}>`;
      const post = async (channelId: string, content: string) =>
        (
          await call(user)(`/api/channels/${channelId}/messages`, {
            method: 'POST',
            body: { content },
          })
        ).body as Message;

      expect((await post(homeChannel, `hi ${token}`)).content).toBe(`hi ${token}`);
      expect((await post(homeChannel, `<:wrong:${emoji.id}>`)).content).toBe(token);
      expect((await post(awayChannel, `hi ${token}`)).content).toBe('hi :wave:');
      expect((await post(homeChannel, '<:ghost:999999>')).content).toBe(':ghost:');

      await grant(await ensureUser(infra.db, user), 'cross_server_emoji');
      expect((await post(awayChannel, `hi ${token}`)).content).toBe(`hi ${token}`);
    });

    it('accepts custom emoji reactions under the same rules, and old unicode ones', async () => {
      const [owner, user] = [unique('ro'), unique('ru')];
      const home = await createGuild(infra.db, owner, [user]);
      const away = await createGuild(infra.db, owner, [user]);
      const homeChannel = await createChannel(infra.db, [owner, user], { guildId: home });
      const awayChannel = await createChannel(infra.db, [owner, user], { guildId: away });
      const emoji = (await addEmoji(owner, home, 'cheer')).body as GuildEmoji;
      const token = encodeURIComponent(`<:cheer:${emoji.id}>`);
      const react = async (login: string, channelId: string, emojiParam: string) => {
        const sent = (
          await call(login)(`/api/channels/${channelId}/messages`, {
            method: 'POST',
            body: { content: 'x' },
          })
        ).body as Message;
        return call(login)(`/api/messages/${sent.id}/reactions/${emojiParam}`, { method: 'PUT' });
      };
      expect((await react(user, homeChannel, token)).status).toBe(204);
      expect((await react(user, awayChannel, token)).status).toBe(400);
      expect((await react(user, awayChannel, encodeURIComponent('👍'))).status).toBe(204);
      expect((await react(user, homeChannel, encodeURIComponent(':old_style:'))).status).toBe(204);
    });

    it('is usable on another instance immediately after it is added', async () => {
      const [owner, user] = [unique('xo'), unique('xu')];
      const guildId = await createGuild(infra.db, owner, [user]);
      const channelId = await createChannel(infra.db, [owner, user], { guildId });
      const send = (content: string) =>
        call(user, other)(`/api/channels/${channelId}/messages`, {
          method: 'POST',
          body: { content },
        });
      // Warm B's cache with the guild's (empty) emoji map first.
      await send('<:late:1>');
      const emoji = (await addEmoji(owner, guildId, 'late')).body as GuildEmoji;
      await settle(100);
      const res = await send(`<:late:${emoji.id}>`);
      expect((res.body as Message).content).toBe(`<:late:${emoji.id}>`);
    });

    it('keeps files used as avatars, banners and emoji out of the orphan sweep', async () => {
      const owner = unique('co');
      const guildId = await createGuild(infra.db, owner);
      const ownerId = await ensureUser(infra.db, owner);
      await grant(ownerId, 'profile_banner_image');
      const emoji = (await addEmoji(owner, guildId, 'keep')).body as GuildEmoji;
      const avatar = await upload(owner, png(10, 10));
      const banner = await upload(owner, png(12, 12));
      const loose = await upload(owner, png(14, 14));
      await call(owner)('/api/me/profile', {
        method: 'PATCH',
        body: { avatarAttachmentId: avatar.body.id, bannerAttachmentId: banner.body.id },
      });
      await sql`update attachments set created_at = to_timestamp(0) where uploader_id = ${ownerId}`.execute(
        infra.db,
      );
      const cleaner = new UploadCleaner(
        infra.db,
        infra.redis,
        new LocalDiskStorage(target.config.UPLOAD_DIR),
        { orphanTtlMs: 1, intervalMs: 60_000, instanceId: 'test' },
        { warn: () => undefined },
      );
      await cleaner.runOnce();
      const left = await infra.db
        .selectFrom('attachments')
        .select('id')
        .where('uploader_id', '=', ownerId)
        .execute();
      const ids = left.map((row) => row.id);
      expect(ids).toContain(avatar.body.id);
      expect(ids).toContain(banner.body.id);
      expect(ids).not.toContain(loose.body.id);
      expect(ids).toHaveLength(3);
      expect(emoji.name).toBe('keep');
    });
  });
});
