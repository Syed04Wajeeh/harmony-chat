import { z } from 'zod';
import { MAX_REACTIONS_PER_MESSAGE, ReactionParams, isValidEmoji } from '@harmony/shared';
import { AppError } from '../../errors.js';
import { forbidden, notFound } from '../../messages/service.js';
import { defineModule } from '../types.js';

const Config = z.object({
  REACTION_RATE_MAX: z.coerce.number().int().min(1).default(30),
  REACTION_RATE_WINDOW_SECONDS: z.coerce.number().int().min(1).default(10),
});

/**
 * Emoji reactions. The `message_reactions` table and the `reactions` field of a message are
 * core (history, search and bots read them); this module owns writing them.
 */
export const reactions = defineModule({
  id: 'reactions',
  name: 'Reactions',
  description: 'React to messages with emoji.',
  optional: true,
  config: Config,
  coreFrames: ['reaction.added', 'reaction.removed'],

  register(ctx) {
    const limiter = ctx.limiter(
      'add',
      ctx.config.REACTION_RATE_MAX,
      ctx.config.REACTION_RATE_WINDOW_SECONDS,
    );
    ctx.permissions.define('react', 'Add and remove reactions');

    async function target(userId: string, messageId: string, emoji: string) {
      if (!isValidEmoji(emoji)) throw new AppError(400, 'invalid_emoji', 'Not a valid emoji');
      const found = await ctx.messages.find(messageId, userId);
      if (!found.isMember) throw forbidden();
      if (found.deleted_at) throw notFound();
      await ctx.requireEnabled(found.guild_id);
      if (!(await limiter.consume(userId))) {
        throw new AppError(429, 'rate_limited', 'You are reacting too quickly');
      }
      return found;
    }

    ctx.routes((app) => {
      app.put(
        '/messages/:id/reactions/:emoji',
        { config: { scope: 'reactions.write' }, schema: { params: ReactionParams } },
        async (request, reply) => {
          const { id, emoji } = request.params;
          const found = await target(request.user.id, id, emoji);
          const event = {
            guildId: found.guild_id,
            channelId: found.channel_id,
            messageId: id,
            emoji,
            userId: request.user.id,
          };
          const added = await ctx.db.transaction().execute(async (trx) => {
            // Serializes reactions on one message so the distinct-emoji cap cannot be raced past.
            await trx
              .selectFrom('messages')
              .select('id')
              .where('id', '=', id)
              .forUpdate()
              .executeTakeFirstOrThrow();
            const distinct = await trx
              .selectFrom('message_reactions')
              .select('emoji')
              .where('message_id', '=', id)
              .groupBy('emoji')
              .execute();
            const known = distinct.some((row) => row.emoji === emoji);
            if (!known && distinct.length >= MAX_REACTIONS_PER_MESSAGE) {
              throw new AppError(
                400,
                'reaction_limit',
                'This message has too many different reactions',
              );
            }
            const row = await trx
              .insertInto('message_reactions')
              .values({ message_id: id, user_id: request.user.id, emoji })
              .onConflict((oc) => oc.doNothing())
              .returning('user_id')
              .executeTakeFirst();
            if (row && found.guild_id) {
              await ctx.outbox.enqueue(trx, {
                guildId: found.guild_id,
                channelId: found.channel_id,
                type: 'reaction.added',
                data: {
                  channelId: found.channel_id,
                  messageId: id,
                  emoji,
                  userId: request.user.id,
                },
              });
            }
            return row !== undefined;
          });
          if (added) {
            await ctx.publish.channel(found.channel_id, {
              type: 'reaction.added',
              channelId: found.channel_id,
              messageId: id,
              emoji,
              userId: request.user.id,
            });
            ctx.events.emit('reaction.added', event);
          }
          return reply.code(204).send();
        },
      );

      app.delete(
        '/messages/:id/reactions/:emoji',
        { config: { scope: 'reactions.write' }, schema: { params: ReactionParams } },
        async (request, reply) => {
          const { id, emoji } = request.params;
          const found = await target(request.user.id, id, emoji);
          const removed = await ctx.db.transaction().execute(async (trx) => {
            const row = await trx
              .deleteFrom('message_reactions')
              .where('message_id', '=', id)
              .where('user_id', '=', request.user.id)
              .where('emoji', '=', emoji)
              .returning('user_id')
              .executeTakeFirst();
            if (row && found.guild_id) {
              await ctx.outbox.enqueue(trx, {
                guildId: found.guild_id,
                channelId: found.channel_id,
                type: 'reaction.removed',
                data: {
                  channelId: found.channel_id,
                  messageId: id,
                  emoji,
                  userId: request.user.id,
                },
              });
            }
            return row !== undefined;
          });
          if (removed) {
            await ctx.publish.channel(found.channel_id, {
              type: 'reaction.removed',
              channelId: found.channel_id,
              messageId: id,
              emoji,
              userId: request.user.id,
            });
            ctx.events.emit('reaction.removed', {
              guildId: found.guild_id,
              channelId: found.channel_id,
              messageId: id,
              emoji,
              userId: request.user.id,
            });
          }
          return reply.code(204).send();
        },
      );
    });
  },
});
