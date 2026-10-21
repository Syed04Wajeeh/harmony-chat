import { sql } from 'kysely';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { ListMessagesResponse, SearchQuery } from '@harmony/shared';
import type { MessageReader } from '../messages/reader.js';

export const searchRoutes: FastifyPluginCallbackZod<{ reader: MessageReader }> = (
  app,
  { reader },
  done,
) => {
  /**
   * Full-text search over channels the caller belongs to, newest first. The membership join is
   * part of the query, so a message in a channel the caller cannot read can never match.
   */
  app.get(
    '/search',
    { schema: { querystring: SearchQuery, response: { 200: ListMessagesResponse } } },
    async (request) => {
      const { q, channelId, before, limit } = request.query;
      let query = reader
        .query()
        .innerJoin('channel_members', (join) =>
          join
            .onRef('channel_members.channel_id', '=', 'messages.channel_id')
            .on('channel_members.user_id', '=', request.user.id),
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
  done();
};
