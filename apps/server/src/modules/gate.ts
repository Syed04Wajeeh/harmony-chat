import type { FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import type { GuildModuleState } from './guild-state.js';

const MAX_CACHED = 10_000;

/**
 * A `preHandler` that turns a route's `config.module` into a per-guild check. The guild comes
 * from the path: `:guildId`/`:id` for guild routes, or the guild of the channel or message
 * `:id` points at. A channel or message never changes guild, so that lookup is cached.
 */
export function moduleGate(state: GuildModuleState, db: Kysely<Database>) {
  const guildOf = new Map<string, string | null>();

  async function resolveGuild(scope: 'guild' | 'channel' | 'message', id: string) {
    if (scope === 'guild') return id;
    const key = `${scope}:${id}`;
    const cached = guildOf.get(key);
    if (cached !== undefined) return cached;
    const row =
      scope === 'channel'
        ? await db.selectFrom('channels').select('guild_id').where('id', '=', id).executeTakeFirst()
        : await db
            .selectFrom('messages')
            .innerJoin('channels', 'channels.id', 'messages.channel_id')
            .select('channels.guild_id')
            .where('messages.id', '=', id)
            .executeTakeFirst();
    // Unknown ids fall through so the handler answers with its own 404.
    if (!row) return undefined;
    if (guildOf.size >= MAX_CACHED) guildOf.clear();
    guildOf.set(key, row.guild_id);
    return row.guild_id;
  }

  return async (request: FastifyRequest): Promise<void> => {
    const { module, moduleScope } = request.routeOptions.config;
    if (!module || !moduleScope) return;
    const params = request.params as { id?: string; guildId?: string };
    const id = moduleScope === 'guild' ? (params.guildId ?? params.id) : params.id;
    if (!id) return;
    const guildId = await resolveGuild(moduleScope, id);
    if (guildId === undefined) return;
    await state.require(guildId, module);
  };
}
