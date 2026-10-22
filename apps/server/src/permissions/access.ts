import { sql, type Kysely, type Transaction } from 'kysely';
import {
  computePermissions,
  topPosition,
  type OverwriteRule,
  type Permissions,
  type Role,
  type RoleGrant,
} from '@harmony/shared';
import type { Database } from '../db/schema.js';

type Executor = Kysely<Database> | Transaction<Database>;

export interface RoleRecord extends RoleGrant {
  guildId: string;
  name: string;
  color: number | null;
  hoist: boolean;
  mentionable: boolean;
  isDefault: boolean;
}

export interface MemberRecord {
  nickname: string | null;
  roleIds: string[];
  isInstanceAdmin: boolean;
}

/** Everything the permission checks of one guild need, loaded in one go. */
export interface GuildAccess {
  guildId: string;
  ownerId: string;
  everyone: RoleRecord;
  roles: ReadonlyMap<string, RoleRecord>;
  members: ReadonlyMap<string, MemberRecord>;
  /** Channel id to its overwrites; channels without any have no entry. */
  overwrites: ReadonlyMap<string, OverwriteRule[]>;
}

/** Reads the guild's roles, members and overwrites. Inside a transaction it sees its own writes. */
export async function loadGuildAccess(db: Executor, guildId: string): Promise<GuildAccess | null> {
  const guild = await db
    .selectFrom('guilds')
    .select('owner_id')
    .where('id', '=', guildId)
    .executeTakeFirst();
  if (!guild) return null;

  const roleRows = await db
    .selectFrom('roles')
    .selectAll()
    .where('guild_id', '=', guildId)
    .execute();
  const { rows: memberRows } = await sql<{
    user_id: string;
    nickname: string | null;
    is_admin: boolean;
    role_ids: string[];
  }>`
    select gm.user_id, gm.nickname, u.is_admin,
      coalesce(array_agg(mr.role_id::text) filter (where mr.role_id is not null), '{}') as role_ids
    from guild_members gm
    join users u on u.id = gm.user_id
    left join member_roles mr on mr.guild_id = gm.guild_id and mr.user_id = gm.user_id
    where gm.guild_id = ${guildId}
    group by gm.user_id, gm.nickname, u.is_admin
  `.execute(db);
  const overwriteRows = await db
    .selectFrom('channel_overwrites')
    .innerJoin('channels', 'channels.id', 'channel_overwrites.channel_id')
    .select([
      'channel_overwrites.channel_id',
      'channel_overwrites.target_type',
      'channel_overwrites.target_id',
      'channel_overwrites.allow',
      'channel_overwrites.deny',
    ])
    .where('channels.guild_id', '=', guildId)
    .execute();

  const roles = new Map<string, RoleRecord>(
    roleRows.map((row) => [
      row.id,
      {
        id: row.id,
        guildId: row.guild_id,
        name: row.name,
        color: row.color,
        position: row.position,
        hoist: row.hoist,
        mentionable: row.mentionable,
        permissions: row.permissions,
        isDefault: row.is_default,
      },
    ]),
  );
  const everyone = [...roles.values()].find((role) => role.isDefault);
  if (!everyone) throw new Error(`guild ${guildId} has no default role`);

  const overwrites = new Map<string, OverwriteRule[]>();
  for (const row of overwriteRows) {
    const list = overwrites.get(row.channel_id) ?? [];
    list.push({
      targetType: row.target_type,
      targetId: row.target_id,
      allow: row.allow,
      deny: row.deny,
    });
    overwrites.set(row.channel_id, list);
  }

  return {
    guildId,
    ownerId: guild.owner_id,
    everyone,
    roles,
    members: new Map(
      memberRows.map((row) => [
        row.user_id,
        { nickname: row.nickname, roleIds: row.role_ids, isInstanceAdmin: row.is_admin },
      ]),
    ),
    overwrites,
  };
}

/** The roles a member holds, without @everyone; role ids that no longer exist are skipped. */
export function rolesOf(access: GuildAccess, userId: string): RoleRecord[] {
  const member = access.members.get(userId);
  return (member?.roleIds ?? []).flatMap((id) => access.roles.get(id) ?? []);
}

export interface Subject {
  id: string;
  isAdmin: boolean;
}

/** A member's permissions in the guild, or in one of its channels when `channelId` is given. */
export function permissionsIn(
  access: GuildAccess,
  subject: Subject,
  channelId?: string,
): Permissions {
  return computePermissions({
    userId: subject.id,
    isOwner: access.ownerId === subject.id,
    isInstanceAdmin: subject.isAdmin,
    everyone: access.everyone,
    roles: rolesOf(access, subject.id),
    overwrites: channelId ? access.overwrites.get(channelId) : undefined,
  });
}

export function rankOf(access: GuildAccess, subject: Subject) {
  return {
    superuser: access.ownerId === subject.id || subject.isAdmin,
    top: topPosition(rolesOf(access, subject.id)),
  };
}

/** Highest role position of any member, by user id, for hierarchy checks against others. */
export function memberRank(access: GuildAccess, userId: string) {
  return {
    superuser: access.ownerId === userId || (access.members.get(userId)?.isInstanceAdmin ?? false),
    top: topPosition(rolesOf(access, userId)),
  };
}

/** Whether `actor` may moderate `target`: superusers can, and nobody can touch a superuser. */
export const canModerate = (
  actor: { superuser: boolean; top: number },
  target: { superuser: boolean; top: number },
): boolean => actor.superuser || (!target.superuser && actor.top > target.top);

export function toRole(record: RoleRecord): Role {
  return {
    id: record.id,
    guildId: record.guildId,
    name: record.name,
    color: record.color,
    position: record.position,
    hoist: record.hoist,
    mentionable: record.mentionable,
    permissions: [...record.permissions],
    isDefault: record.isDefault,
  };
}
