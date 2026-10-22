import {
  ChannelParams,
  Message,
  MessageParams,
  PinsResponse,
  type DirectoryUser,
} from '@harmony/shared';
import { forbidden, notFound } from '../../messages/service.js';
import { defineModule } from '../types.js';

const MAX_PINS = 50;

/** Pinned messages. `pinned_at`/`pinned_by` stay on the message row, so history shows them. */
export const pins = defineModule({
  id: 'pins',
  name: 'Pins',
  description: 'Pin important messages to the top of a channel.',
  optional: true,

  register(ctx) {
    ctx.permissions.define('pin', 'Pin and unpin messages');

    async function setPinned(user: DirectoryUser, messageId: string, pinned: boolean) {
      const userId = user.id;
      const target = await ctx.messages.find(messageId, userId);
      if (!target.isMember) throw forbidden();
      if (target.deleted_at) throw notFound();
      // Moderators always can; `pins.pin` lets a guild open pinning to everyone, as it was.
      if (
        !(await ctx.permissions.has(user, target.guild_id, 'manage_messages', target.channel_id))
      ) {
        await ctx.permissions.require(user, target.guild_id, 'pin', target.channel_id);
      }
      const { message } = await ctx.messages.update(target, async (trx) => {
        const changed = await trx
          .updateTable('messages')
          .set(
            pinned
              ? { pinned_at: new Date(), pinned_by: userId }
              : { pinned_at: null, pinned_by: null },
          )
          .where('id', '=', messageId)
          .where('pinned_at', pinned ? 'is' : 'is not', null)
          .returning('id')
          .executeTakeFirst();
        return changed !== undefined;
      });
      return message;
    }

    ctx.routes((app) => {
      app.get(
        '/channels/:id/pins',
        {
          config: { scope: 'messages.read', module: 'pins', moduleScope: 'channel' },
          schema: { params: ChannelParams, response: { 200: PinsResponse } },
        },
        async (request) => {
          await ctx.channels.requireMember(request.params.id, request.user.id);
          const { reader } = ctx.messages;
          const rows = await reader
            .query()
            .where('messages.channel_id', '=', request.params.id)
            .where('messages.pinned_at', 'is not', null)
            .where('messages.deleted_at', 'is', null)
            .orderBy('messages.pinned_at', 'desc')
            .limit(MAX_PINS)
            .execute();
          return { messages: await reader.hydrate(rows) };
        },
      );

      app.put(
        '/messages/:id/pin',
        {
          config: { scope: 'messages.write', module: 'pins', moduleScope: 'message' },
          schema: { params: MessageParams, response: { 200: Message } },
        },
        (request) => setPinned(request.user, request.params.id, true),
      );

      app.delete(
        '/messages/:id/pin',
        {
          config: { scope: 'messages.write', module: 'pins', moduleScope: 'message' },
          schema: { params: MessageParams, response: { 200: Message } },
        },
        (request) => setPinned(request.user, request.params.id, false),
      );
    });
  },
});
