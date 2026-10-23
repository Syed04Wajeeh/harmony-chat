import { z } from 'zod';
import {
  CreateEmojiBody,
  EmojiParams,
  GuildEmoji as GuildEmojiSchema,
  Id,
  ListEmojiResponse,
  MAX_EMOJI_BYTES,
  MAX_EMOJI_DIMENSION,
  RenameEmojiBody,
  type GuildEmoji,
} from '@harmony/shared';
import { AppError } from '../../errors.js';
import { isAnimatedImage } from '../../uploads/animated.js';
import { readUpTo } from '../../uploads/read.js';
import { defineModule } from '../types.js';

const Config = z.object({
  EMOJI_MAX_PER_GUILD: z.coerce.number().int().min(1).default(50),
});

const EMOJI_TYPES = new Set(['image/png', 'image/gif', 'image/webp']);
const GuildParam = z.object({ id: Id });

/**
 * Custom emoji for a guild: upload, rename and delete. The `guild_emoji` table and the token
 * rules (`EmojiService`, used by message sending and reactions) are core, so existing messages
 * keep rendering and validating when a guild switches the module off; only managing is gated.
 */
export const customEmoji = defineModule({
  id: 'custom-emoji',
  name: 'Custom emoji',
  description: 'Upload emoji for this server and use them in messages and reactions.',
  optional: true,
  config: Config,
  coreFrames: ['guild.emoji_updated'],

  register(ctx) {
    async function announce(guildId: string): Promise<GuildEmoji[]> {
      await ctx.emoji.changed(guildId);
      const emoji = await ctx.emoji.list(guildId);
      const members = await ctx.db
        .selectFrom('guild_members')
        .select('user_id')
        .where('guild_id', '=', guildId)
        .execute();
      await Promise.all(
        members.map((member) =>
          ctx.publish.user(member.user_id, { type: 'guild.emoji_updated', guildId, emoji }),
        ),
      );
      return emoji;
    }

    async function one(guildId: string, emojiId: string): Promise<GuildEmoji> {
      const found = (await ctx.emoji.list(guildId)).find((emoji) => emoji.id === emojiId);
      if (!found) throw new AppError(404, 'emoji_not_found', 'Emoji not found');
      return found;
    }

    ctx.routes((app) => {
      const gated = { module: 'custom-emoji', moduleScope: 'guild' } as const;

      app.get(
        '/guilds/:id/emoji',
        {
          config: { ...gated, scope: 'channels.read' },
          schema: { params: GuildParam, response: { 200: ListEmojiResponse } },
        },
        async (request) => {
          const member = await ctx.db
            .selectFrom('guild_members')
            .select('user_id')
            .where('guild_id', '=', request.params.id)
            .where('user_id', '=', request.user.id)
            .executeTakeFirst();
          if (!member) throw new AppError(403, 'forbidden', 'You are not a member of this server');
          return { emoji: await ctx.emoji.list(request.params.id) };
        },
      );

      app.post(
        '/guilds/:id/emoji',
        {
          config: { ...gated, humanOnly: true },
          schema: {
            params: GuildParam,
            body: CreateEmojiBody,
            response: { 201: GuildEmojiSchema },
          },
        },
        async (request, reply) => {
          const guildId = request.params.id;
          await ctx.permissions.require(request.user, guildId, 'manage_emoji');
          const { name, attachmentId } = request.body;

          const file = await ctx.db
            .selectFrom('attachments')
            .selectAll()
            .where('id', '=', attachmentId)
            .where('uploader_id', '=', request.user.id)
            .where('message_id', 'is', null)
            .executeTakeFirst();
          if (!file || !EMOJI_TYPES.has(file.content_type)) {
            throw new AppError(
              400,
              'invalid_emoji_image',
              'Emoji must be a PNG, GIF or WebP you uploaded',
            );
          }
          if (Number(file.size_bytes) > MAX_EMOJI_BYTES) {
            throw new AppError(400, 'emoji_too_large', 'Emoji must be 256 KB or smaller');
          }
          if (
            !file.width ||
            !file.height ||
            file.width > MAX_EMOJI_DIMENSION ||
            file.height > MAX_EMOJI_DIMENSION
          ) {
            throw new AppError(
              400,
              'emoji_dimensions',
              `Emoji must be at most ${String(MAX_EMOJI_DIMENSION)}x${String(MAX_EMOJI_DIMENSION)} pixels`,
            );
          }
          const bytes = await readUpTo(await ctx.storage.get(file.storage_key), MAX_EMOJI_BYTES);
          const animated = bytes !== null && isAnimatedImage(bytes, file.content_type);

          const created = await ctx.db.transaction().execute(async (trx) => {
            // Serializes uploads per guild so the cap cannot be raced past.
            await trx
              .selectFrom('guilds')
              .select('id')
              .where('id', '=', guildId)
              .forUpdate()
              .executeTakeFirstOrThrow();
            const { count } = await trx
              .selectFrom('guild_emoji')
              .select((eb) => eb.fn.countAll<string>().as('count'))
              .where('guild_id', '=', guildId)
              .executeTakeFirstOrThrow();
            if (Number(count) >= ctx.config.EMOJI_MAX_PER_GUILD) {
              throw new AppError(
                409,
                'emoji_limit',
                `This server can have up to ${String(ctx.config.EMOJI_MAX_PER_GUILD)} emoji`,
              );
            }
            const taken = await trx
              .selectFrom('guild_emoji')
              .select('id')
              .where('guild_id', '=', guildId)
              .where('name', '=', name)
              .executeTakeFirst();
            if (taken) throw new AppError(409, 'emoji_name_taken', 'That emoji name is taken');
            return trx
              .insertInto('guild_emoji')
              .values({
                guild_id: guildId,
                name,
                attachment_id: attachmentId,
                animated,
                created_by: request.user.id,
              })
              .returning('id')
              .executeTakeFirstOrThrow();
          });
          await announce(guildId);
          return reply.code(201).send(await one(guildId, created.id));
        },
      );

      app.patch(
        '/guilds/:id/emoji/:emojiId',
        {
          config: { ...gated, humanOnly: true },
          schema: {
            params: EmojiParams,
            body: RenameEmojiBody,
            response: { 200: GuildEmojiSchema },
          },
        },
        async (request) => {
          const { id: guildId, emojiId } = request.params;
          await ctx.permissions.require(request.user, guildId, 'manage_emoji');
          await one(guildId, emojiId);
          try {
            await ctx.db
              .updateTable('guild_emoji')
              .set({ name: request.body.name })
              .where('id', '=', emojiId)
              .where('guild_id', '=', guildId)
              .execute();
          } catch (error) {
            if ((error as { code?: string }).code === '23505') {
              throw new AppError(409, 'emoji_name_taken', 'That emoji name is taken');
            }
            throw error;
          }
          await announce(guildId);
          return one(guildId, emojiId);
        },
      );

      app.delete(
        '/guilds/:id/emoji/:emojiId',
        { config: { ...gated, humanOnly: true }, schema: { params: EmojiParams } },
        async (request, reply) => {
          const { id: guildId, emojiId } = request.params;
          await ctx.permissions.require(request.user, guildId, 'manage_emoji');
          await one(guildId, emojiId);
          await ctx.db
            .deleteFrom('guild_emoji')
            .where('id', '=', emojiId)
            .where('guild_id', '=', guildId)
            .execute();
          await announce(guildId);
          return reply.code(204).send();
        },
      );
    });
  },
});
