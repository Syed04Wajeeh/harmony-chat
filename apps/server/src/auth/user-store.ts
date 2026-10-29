import { sql, type ExpressionBuilder, type Kysely, type Selectable } from 'kysely';
import type { DirectoryUser, Me, UserStatus } from '@harmony/shared';
import type { Database } from '../db/schema.js';
import { addGuildMember, createGuildWithGeneral } from '../guilds/membership.js';
import { AppError } from '../errors.js';
import type { DomainEvents } from '../modules/domain-events.js';
import type { Identity } from './policy.js';

interface CacheEntry {
  user: DirectoryUser;
  /** The sign-in provider's picture, which `user.avatarUrl` may differ from (uploaded avatar). */
  providerAvatar: string | null;
  expiresAt: number;
}

const MAX_CACHE_ENTRIES = 1000;
/** Serializes first-user detection so two simultaneous first logins cannot both become admin. */
const NEW_USER_LOCK = 7_301_001;

export function toDirectoryUser(row: Selectable<Database['users']>): DirectoryUser {
  return {
    id: row.id,
    login: row.login,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    isAdmin: row.is_admin,
    ...(row.kind === 'bot' && { isBot: true }),
  };
}

/**
 * Resolves a proxy-supplied identity to a user row. Results are cached in-process so
 * a request normally costs no query; the row is only written when the identity changed.
 * The user's chosen status is not cached because other instances can change it.
 */
export class UserStore {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly ttlMs = 60_000,
    private readonly domain?: DomainEvents,
  ) {}

  async resolve(identity: Identity): Promise<DirectoryUser> {
    const cached = this.cache.get(identity.login);
    if (cached && cached.expiresAt > Date.now() && matches(cached, identity)) {
      return cached.user;
    }

    const existing = await this.db
      .selectFrom('users')
      .selectAll()
      .where('login', '=', identity.login)
      .executeTakeFirst();
    const row =
      existing?.display_name === identity.displayName &&
      existing.provider_avatar_url === identity.avatarUrl
        ? existing
        : await this.upsert(identity);

    const user = toDirectoryUser(row);
    if (this.cache.size >= MAX_CACHE_ENTRIES) this.cache.clear();
    this.cache.set(identity.login, {
      user,
      providerAvatar: identity.avatarUrl,
      expiresAt: Date.now() + this.ttlMs,
    });
    return user;
  }

  /** Drops cached identities of a user whose profile changed (other instances catch up on the TTL). */
  forget(userId: string): void {
    for (const [login, entry] of this.cache) if (entry.user.id === userId) this.cache.delete(login);
  }

  async getMe(user: DirectoryUser): Promise<Me> {
    const row = await this.db
      .selectFrom('users')
      .select('status')
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow();
    return { ...user, status: row.status as UserStatus };
  }

  async setStatus(userId: string, status: UserStatus): Promise<void> {
    await this.db.updateTable('users').set({ status }).where('id', '=', userId).execute();
  }

  /** The viewer and everyone who shares at least one guild with them. */
  async listVisibleTo(viewerId: string): Promise<DirectoryUser[]> {
    const rows = await this.db
      .selectFrom('users')
      .selectAll()
      .where((eb) =>
        eb.or([
          eb('users.id', '=', viewerId),
          eb.exists(
            eb
              .selectFrom('guild_members as theirs')
              .innerJoin('guild_members as mine', 'mine.guild_id', 'theirs.guild_id')
              .select('theirs.user_id')
              .whereRef('theirs.user_id', '=', 'users.id')
              .where('mine.user_id', '=', viewerId),
          ),
        ]),
      )
      .orderBy('display_name')
      .execute();
    return rows.map(toDirectoryUser);
  }

  /** Everyone who has signed in to this instance, a page at a time. Bots only when asked for. */
  async directory(
    viewerId: string,
    query: {
      q?: string | undefined;
      kind: 'human' | 'bot';
      notInGuild?: string | undefined;
      limit: number;
      offset: number;
    },
  ): Promise<{ users: DirectoryUser[]; total: number }> {
    // `%` and `_` are plain characters in a search box.
    const { notInGuild } = query;
    if (notInGuild) {
      const member = await this.db
        .selectFrom('guild_members')
        .select('user_id')
        .where('guild_id', '=', notInGuild)
        .where('user_id', '=', viewerId)
        .executeTakeFirst();
      if (!member) throw new AppError(403, 'forbidden', 'You are not a member of this guild');
    }
    const pattern = query.q ? `%${query.q.replace(/[\\%_]/g, '\\$&')}%` : null;
    const where = (eb: ExpressionBuilder<Database, 'users'>) =>
      eb.and([
        eb('users.kind', '=', query.kind),
        ...(notInGuild
          ? [
              eb.not(
                eb.exists(
                  eb
                    .selectFrom('guild_members')
                    .select('guild_members.user_id')
                    .whereRef('guild_members.user_id', '=', 'users.id')
                    .where('guild_members.guild_id', '=', notInGuild),
                ),
              ),
            ]
          : []),
        ...(pattern
          ? [
              eb.or([
                eb('users.display_name', 'ilike', pattern),
                eb('users.login', 'ilike', pattern),
              ]),
            ]
          : []),
      ]);
    const [rows, count] = await Promise.all([
      this.db
        .selectFrom('users')
        .selectAll()
        .where(where)
        .orderBy(sql`lower(display_name)`)
        .orderBy('id')
        .limit(query.limit)
        .offset(query.offset)
        .execute(),
      this.db
        .selectFrom('users')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where(where)
        .executeTakeFirstOrThrow(),
    ]);
    return { users: rows.map(toDirectoryUser), total: Number(count.n) };
  }

  /**
   * The first user ever created becomes admin and gets a starter guild; later users join only the
   * lobby guild (`is_default`), if an admin chose one. All of it happens in the insert transaction,
   * under an advisory lock so "no users yet" cannot be observed twice.
   */
  private async upsert(identity: Identity): Promise<Selectable<Database['users']>> {
    let joinedGuildId: string | undefined;
    const user = await this.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(${NEW_USER_LOCK})`.execute(trx);
      const { rows } = await sql<Selectable<Database['users']> & { inserted: boolean }>`
        insert into users (login, display_name, avatar_url, provider_avatar_url, is_admin)
        values (${identity.login}, ${identity.displayName}, ${identity.avatarUrl},
                ${identity.avatarUrl}, not exists (select 1 from users))
        on conflict (login) do update
          set display_name = excluded.display_name,
              provider_avatar_url = excluded.provider_avatar_url,
              avatar_url = case when users.avatar_overridden then users.avatar_url
                                else excluded.avatar_url end
        returning *, (xmax = 0) as inserted
      `.execute(trx);
      const row = rows[0];
      if (!row) throw new Error('user upsert returned no row');
      if (row.inserted) {
        const lobby = await trx
          .selectFrom('guilds')
          .select('id')
          .where('is_default', '=', true)
          .executeTakeFirst();
        if (lobby) {
          await addGuildMember(trx, lobby.id, row.id);
          joinedGuildId = lobby.id;
        } else if (row.is_admin) {
          // So a fresh install is not empty; an ordinary guild, not the lobby.
          joinedGuildId = (await createGuildWithGeneral(trx, 'Harmony', row.id)).guildId;
        }
      }
      return row;
    });
    if (joinedGuildId) {
      this.domain?.emit('member.joined', {
        guildId: joinedGuildId,
        user: {
          id: user.id,
          login: user.login,
          displayName: user.display_name,
          avatarUrl: user.avatar_url,
        },
      });
    }
    return user;
  }
}

function matches(entry: CacheEntry, identity: Identity): boolean {
  return (
    entry.user.displayName === identity.displayName && entry.providerAvatar === identity.avatarUrl
  );
}
