import { sql, type Kysely } from 'kysely';
import {
  CORE_PERMISSIONS,
  missingToGrant,
  outranks,
  type ChannelOverwrite,
  type CreateRoleBody,
  type DirectoryUser,
  type OverwriteTarget,
  type PutOverwriteBody,
  type Role,
  type UpdateRoleBody,
} from '@harmony/shared';
import type { ChannelService } from '../channels/service.js';
import type { Database } from '../db/schema.js';
import { AppError } from '../errors.js';
import type { GuildService } from '../guilds/service.js';
import {
  canModerate,
  memberRank,
  permissionsIn,
  rankOf,
  toRole,
  type GuildAccess,
} from '../permissions/access.js';
import {
  overwritesOf,
  putOverwrite,
  removeOverwrite,
  syncPrivacy,
} from '../permissions/overwrites.js';
import { reconcileAccess, type AccessDiff } from '../permissions/reconcile.js';
import type { PermissionService } from '../permissions/service.js';
import type { EventBus } from '../realtime/events.js';

type Actor = Pick<DirectoryUser, 'id' | 'isAdmin'>;

const MAX_ROLES_PER_GUILD = 250;

const roleNotFound = () => new AppError(404, 'role_not_found', 'Role not found');
const hierarchy = (what: string) =>
  new AppError(403, 'role_hierarchy', `You can only ${what} roles below your highest role`);

/** Roles, who holds them, and per-channel overwrites. Every write ends by refreshing access. */
export class RoleService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly events: EventBus,
    private readonly perms: PermissionService,
    private readonly channels: ChannelService,
    private readonly guilds: GuildService,
  ) {}

  async list(actor: Actor, guildId: string): Promise<Role[]> {
    const access = await this.perms.requireAccess(guildId);
    if (!access.members.has(actor.id) && !actor.isAdmin) {
      throw new AppError(403, 'forbidden', 'You are not a member of this guild');
    }
    return [...access.roles.values()].sort((a, b) => b.position - a.position).map(toRole);
  }

  async create(actor: Actor, guildId: string, body: CreateRoleBody): Promise<Role> {
    await this.perms.require(actor, guildId, 'manage_roles');
    const access = await this.perms.requireAccess(guildId);
    if (access.roles.size >= MAX_ROLES_PER_GUILD) {
      throw new AppError(409, 'too_many_roles', 'This server has reached its role limit');
    }
    const permissions = this.checkedKeys(body.permissions ?? []);
    this.requireGrantable(access, actor, permissions);

    const row = await this.db.transaction().execute(async (trx) => {
      // New roles go just above @everyone, below everything else.
      await trx
        .updateTable('roles')
        .set({ position: sql`position + 1` })
        .where('guild_id', '=', guildId)
        .where('position', '>=', 1)
        .execute();
      return trx
        .insertInto('roles')
        .values({
          guild_id: guildId,
          name: body.name,
          color: body.color ?? null,
          position: 1,
          hoist: body.hoist ?? false,
          mentionable: body.mentionable ?? false,
          permissions,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    await this.perms.changed(guildId);
    const role = await this.roleOf(guildId, row.id);
    await this.toMembers(guildId, (userId) =>
      this.events.toUser(userId, { type: 'guild.role_created', guildId, role }),
    );
    return role;
  }

  async update(actor: Actor, guildId: string, roleId: string, body: UpdateRoleBody): Promise<Role> {
    await this.perms.require(actor, guildId, 'manage_roles');
    const access = await this.perms.requireAccess(guildId);
    const role = access.roles.get(roleId);
    if (!role) throw roleNotFound();
    const rank = rankOf(access, actor);
    if (role.isDefault) {
      if (
        body.name !== undefined ||
        body.color !== undefined ||
        body.hoist !== undefined ||
        body.mentionable !== undefined
      ) {
        throw new AppError(400, 'default_role', 'Only the permissions of @everyone can change');
      }
    } else if (!outranks(rank, role.position)) {
      throw hierarchy('edit');
    }

    let permissions: string[] | undefined;
    if (body.permissions) {
      permissions = this.checkedKeys(body.permissions);
      this.requireGrantable(
        access,
        actor,
        permissions.filter((key) => !role.permissions.includes(key)),
      );
    }
    await this.db
      .updateTable('roles')
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.color !== undefined && { color: body.color }),
        ...(body.hoist !== undefined && { hoist: body.hoist }),
        ...(body.mentionable !== undefined && { mentionable: body.mentionable }),
        ...(permissions && { permissions }),
      })
      .where('id', '=', roleId)
      .execute();

    const diff = permissions ? await this.reconcile(guildId) : undefined;
    await this.perms.changed(guildId);
    const updated = await this.roleOf(guildId, roleId);
    await this.toMembers(guildId, (userId) =>
      this.events.toUser(userId, { type: 'guild.role_updated', guildId, role: updated }),
    );
    if (diff) await this.channels.applyAccess(diff);
    return updated;
  }

  async remove(actor: Actor, guildId: string, roleId: string): Promise<void> {
    await this.perms.require(actor, guildId, 'manage_roles');
    const access = await this.perms.requireAccess(guildId);
    const role = access.roles.get(roleId);
    if (!role) throw roleNotFound();
    if (role.isDefault) throw new AppError(400, 'default_role', '@everyone cannot be deleted');
    if (!outranks(rankOf(access, actor), role.position)) throw hierarchy('delete');

    const holders = [...access.members]
      .filter(([, m]) => m.roleIds.includes(roleId))
      .map(([id]) => id);
    const diff = await this.db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('channel_overwrites')
        .where('target_type', '=', 'role')
        .where('target_id', '=', roleId)
        .execute();
      await trx.deleteFrom('roles').where('id', '=', roleId).execute();
      await this.syncPrivacyOf(trx, guildId);
      return reconcileAccess(trx, guildId, { userIds: holders });
    });
    await this.perms.changed(guildId);
    await this.toMembers(guildId, (userId) =>
      this.events.toUser(userId, { type: 'guild.role_deleted', guildId, roleId }),
    );
    await Promise.all(holders.map((userId) => this.guilds.announceMember(guildId, userId)));
    await this.channels.applyAccess(diff);
  }

  /** `roleIds` lists every role except @everyone, highest first. */
  async reorder(actor: Actor, guildId: string, roleIds: string[]): Promise<Role[]> {
    await this.perms.require(actor, guildId, 'manage_roles');
    const access = await this.perms.requireAccess(guildId);
    const movable = [...access.roles.values()].filter((role) => !role.isDefault);
    const wanted = new Set(roleIds);
    if (
      wanted.size !== roleIds.length ||
      wanted.size !== movable.length ||
      !movable.every((r) => wanted.has(r.id))
    ) {
      throw new AppError(400, 'invalid_order', 'List every role except @everyone exactly once');
    }

    const rank = rankOf(access, actor);
    const next = new Map(roleIds.map((id, index) => [id, roleIds.length - index]));
    const changed = movable.filter((role) => next.get(role.id) !== role.position);
    for (const role of changed) {
      const target = next.get(role.id) ?? 0;
      if (!outranks(rank, role.position) || !outranks(rank, target)) throw hierarchy('move');
    }
    if (changed.length === 0) return this.list(actor, guildId);

    await this.db.transaction().execute(async (trx) => {
      for (const role of changed) {
        await trx
          .updateTable('roles')
          .set({ position: next.get(role.id) ?? 0 })
          .where('id', '=', role.id)
          .execute();
      }
    });
    await this.perms.changed(guildId);
    const roles = await this.list(actor, guildId);
    for (const role of roles.filter((r) => changed.some((c) => c.id === r.id))) {
      await this.toMembers(guildId, (userId) =>
        this.events.toUser(userId, { type: 'guild.role_updated', guildId, role }),
      );
    }
    return roles;
  }

  async assign(actor: Actor, guildId: string, userId: string, roleId: string): Promise<void> {
    await this.changeHolder(actor, guildId, userId, roleId, true);
  }

  async revoke(actor: Actor, guildId: string, userId: string, roleId: string): Promise<void> {
    await this.changeHolder(actor, guildId, userId, roleId, false);
  }

  private async changeHolder(
    actor: Actor,
    guildId: string,
    userId: string,
    roleId: string,
    grant: boolean,
  ): Promise<void> {
    await this.perms.require(actor, guildId, 'manage_roles');
    const access = await this.perms.requireAccess(guildId);
    const role = access.roles.get(roleId);
    if (!role) throw roleNotFound();
    if (role.isDefault) throw new AppError(400, 'default_role', 'Everyone has @everyone already');
    if (!access.members.has(userId)) throw new AppError(404, 'user_not_found', 'Not a member');
    if (!outranks(rankOf(access, actor), role.position))
      throw hierarchy(grant ? 'assign' : 'remove');

    const diff = await this.db.transaction().execute(async (trx) => {
      if (grant) {
        await trx
          .insertInto('member_roles')
          .values({ guild_id: guildId, user_id: userId, role_id: roleId })
          .onConflict((oc) => oc.doNothing())
          .execute();
      } else {
        await trx
          .deleteFrom('member_roles')
          .where('guild_id', '=', guildId)
          .where('user_id', '=', userId)
          .where('role_id', '=', roleId)
          .execute();
      }
      return reconcileAccess(trx, guildId, { userIds: [userId] });
    });
    await this.perms.changed(guildId);
    await this.guilds.announceMember(guildId, userId);
    await this.channels.applyAccess(diff);
  }

  async overwrites(actor: Actor, channelId: string): Promise<ChannelOverwrite[]> {
    await this.guildChannel(channelId, actor, 'manage_roles');
    return overwritesOf(this.db, channelId);
  }

  async putOverwrite(
    actor: Actor,
    channelId: string,
    targetType: OverwriteTarget,
    targetId: string,
    body: PutOverwriteBody,
  ): Promise<ChannelOverwrite[]> {
    const { guildId, access } = await this.guildChannel(channelId, actor, 'manage_roles');
    const allow = [...new Set(body.allow ?? [])];
    const deny = [...new Set(body.deny ?? [])];
    if (allow.some((key) => deny.includes(key))) {
      throw new AppError(
        400,
        'invalid_overwrite',
        'A permission cannot be both allowed and denied',
      );
    }
    for (const key of [...allow, ...deny]) {
      const core = CORE_PERMISSIONS.find((permission) => permission.key === key);
      if (core ? !core.channel : !this.perms.isKnownKey(key)) {
        throw new AppError(400, 'invalid_permission', `${key} cannot be set on a channel`);
      }
    }
    this.requireGrantable(access, actor, allow, channelId);

    const rank = rankOf(access, actor);
    if (targetType === 'role') {
      const role = access.roles.get(targetId);
      if (!role) throw roleNotFound();
      if (!role.isDefault && !outranks(rank, role.position)) throw hierarchy('set overwrites for');
    } else {
      if (!access.members.has(targetId)) throw new AppError(404, 'user_not_found', 'Not a member');
      if (targetId !== actor.id && !canModerate(rank, memberRank(access, targetId))) {
        throw hierarchy('set overwrites for');
      }
    }

    const diff = await this.db.transaction().execute(async (trx) => {
      await putOverwrite(trx, channelId, targetType, targetId, allow, deny);
      await syncPrivacy(trx, channelId);
      return reconcileAccess(trx, guildId, { channelIds: [channelId] });
    });
    return this.afterOverwrite(guildId, channelId, diff);
  }

  async removeOverwrite(
    actor: Actor,
    channelId: string,
    targetType: OverwriteTarget,
    targetId: string,
  ): Promise<ChannelOverwrite[]> {
    const { guildId } = await this.guildChannel(channelId, actor, 'manage_roles');
    const diff = await this.db.transaction().execute(async (trx) => {
      await removeOverwrite(trx, channelId, targetType, targetId);
      await syncPrivacy(trx, channelId);
      return reconcileAccess(trx, guildId, { channelIds: [channelId] });
    });
    return this.afterOverwrite(guildId, channelId, diff);
  }

  private async afterOverwrite(guildId: string, channelId: string, diff: AccessDiff) {
    await this.perms.changed(guildId);
    const overwrites = await overwritesOf(this.db, channelId);
    const members = await this.channels.memberIds(channelId);
    await Promise.all(
      members.map((userId) =>
        this.events.toUser(userId, { type: 'channel.overwrites_updated', channelId, overwrites }),
      ),
    );
    await this.channels.applyAccess(diff);
    return overwrites;
  }

  private async guildChannel(channelId: string, actor: Actor, key: string) {
    const guildId = await this.perms.guildOf(channelId);
    if (guildId === undefined) throw new AppError(404, 'channel_not_found', 'Channel not found');
    if (guildId === null) {
      throw new AppError(400, 'dm_immutable', 'Direct messages have no permissions to set');
    }
    await this.perms.require(actor, guildId, key, channelId);
    return { guildId, access: await this.perms.requireAccess(guildId) };
  }

  /** Reconcile everyone in the guild, for changes that can touch any member's access. */
  private reconcile(guildId: string): Promise<AccessDiff> {
    return this.db.transaction().execute((trx) => reconcileAccess(trx, guildId));
  }

  private syncPrivacyOf(trx: Kysely<Database>, guildId: string) {
    return sql`
      update channels c set is_private = exists (
        select 1 from channel_overwrites o join roles r on r.id = o.target_id and r.is_default
        where o.channel_id = c.id and o.target_type = 'role' and 'view_channel' = any (o.deny)
      ) where c.guild_id = ${guildId} and c.kind in ('text', 'dashboard')
    `.execute(trx);
  }

  private checkedKeys(keys: readonly string[]): string[] {
    const unique = [...new Set(keys)];
    const unknown = unique.find((key) => !this.perms.isKnownKey(key));
    if (unknown) throw new AppError(400, 'invalid_permission', `Unknown permission ${unknown}`);
    return unique;
  }

  /** You cannot hand out what you do not have yourself. */
  private requireGrantable(
    access: GuildAccess,
    actor: Actor,
    keys: readonly string[],
    channelId?: string,
  ): void {
    const held = permissionsIn(access, actor, channelId);
    const missing = missingToGrant(held, keys);
    if (missing.length > 0) {
      throw new AppError(
        403,
        'missing_permission',
        `You cannot grant permissions you do not have: ${missing.join(', ')}`,
      );
    }
  }

  private async roleOf(guildId: string, roleId: string): Promise<Role> {
    const role = (await this.perms.requireAccess(guildId)).roles.get(roleId);
    if (!role) throw roleNotFound();
    return toRole(role);
  }

  private async toMembers(guildId: string, publish: (userId: string) => Promise<unknown>) {
    const access = await this.perms.requireAccess(guildId);
    await Promise.all([...access.members.keys()].map(publish));
  }
}
