import { sql } from 'kysely';
import { ListMessagesResponse, SearchQuery } from '@harmony/shared';
import { defineModule } from '../types.js';

/** Full-text search over the channels the caller belongs to. */
export const search = defineModule({
  id: 'search',
  name: 'Search',
  description: 'Find messages with full-text search.',
  optional: true,

  register(ctx) {
    ctx.permissions.define('search', 'Search messages');

    ctx.routes((app) => {
      /**
       * Newest first. The membership join is part of the query, so a message in a channel the
       * caller cannot read can never match; so is the per-guild switch, which keeps guilds that
       * turned search off out of everyone's results.
       */
      app.get(
        '/search',
        {
          config: { scope: 'messages.read' },
          schema: { querystring: SearchQuery, response: { 200: ListMessagesResponse } },
        },
        async (request) => {
          const { q, channelId, before, limit } = request.query;
          const { reader } = ctx.messages;
          let query = reader
            .query()
            .innerJoin('channel_members', (join) =>
              join
                .onRef('channel_members.channel_id', '=', 'messages.channel_id')
                .on('channel_members.user_id', '=', request.user.id),
            )
            .innerJoin('channels', 'channels.id', 'messages.channel_id')
            .where((eb) =>
              eb.not(
                eb.exists(
                  eb
                    .selectFrom('guild_modules')
                    .select('guild_modules.guild_id')
                    .whereRef('guild_modules.guild_id', '=', 'channels.guild_id')
                    .where('guild_modules.module_id', '=', ctx.id)
                    .where('guild_modules.enabled', '=', false),
                ),
              ),
            )
            .where(sql<boolean>`messages.search @@ websearch_to_tsquery('simple', ${q})`)
            .where('messages.deleted_at', 'is', null)
            .orderBy('messages.id', 'desc')
            .limit(limit + 1);
          if (channelId) query = query.where('messages.channel_id', '=', channelId);
          if (before) query = query.where('messages.id', '<', before);
          return reader.pageAsFetched(await query.execute(), limit);
        },
      );
    });
  },
});
