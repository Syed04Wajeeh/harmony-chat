import { sql, type Kysely, type Selectable } from 'kysely';
import type { DirectoryUser, Me, UserStatus } from '@harmony/shared';
import type { Database } from '../db/schema.js';
import { addGuildMember, createGuildWithGeneral } from '../guilds/membership.js';
import type { DomainEvents } from '../modules/domain-events.js';
import type { Identity } from './policy.js';

interface CacheEntry {
  user: DirectoryUser;
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
    if (cached && cached.expiresAt > Date.now() && matches(cached.user, identity)) {
      return cached.user;
    }

    const existing = await this.db
      .selectFrom('users')
      .selectAll()
      .where('login', '=', identity.login)
      .executeTakeFirst();
    const row =
      existing?.display_name === identity.displayName && existing.avatar_url === identity.avatarUrl
        ? existing
        : await this.upsert(identity);

    const user = toDirectoryUser(row);
    if (this.cache.size >= MAX_CACHE_ENTRIES) this.cache.clear();
    this.cache.set(identity.login, { user, expiresAt: Date.now() + this.ttlMs });
    return user;
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

  /**
   * The first user ever created becomes admin; new users join the default guild. Both happen in the
   * insert transaction, under an advisory lock so "no users yet" cannot be observed twice.
   */
  private async upsert(identity: Identity): Promise<Selectable<Database['users']>> {
    let joinedGuildId: string | undefined;
    const user = await this.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(${NEW_USER_LOCK})`.execute(trx);
      const { rows } = await sql<Selectable<Database['users']> & { inserted: boolean }>`
        insert into users (login, display_name, avatar_url, is_admin)
        values (${identity.login}, ${identity.displayName}, ${identity.avatarUrl},
                not exists (select 1 from users))
        on conflict (login) do update
          set display_name = excluded.display_name, avatar_url = excluded.avatar_url
        returning *, (xmax = 0) as inserted
      `.execute(trx);
      const row = rows[0];
      if (!row) throw new Error('user upsert returned no row');
      if (row.inserted) {
        // Newcomers land in the default guild. The very first user also creates it.
        const fallback = await trx
          .selectFrom('guilds')
          .select('id')
          .where('is_default', '=', true)
          .executeTakeFirst();
        if (fallback) {
          await addGuildMember(trx, fallback.id, row.id);
          joinedGuildId = fallback.id;
        } else if (row.is_admin) {
          joinedGuildId = (await createGuildWithGeneral(trx, 'Harmony', row.id, true)).guildId;
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

function matches(user: DirectoryUser, identity: Identity): boolean {
  return user.displayName === identity.displayName && user.avatarUrl === identity.avatarUrl;
}
